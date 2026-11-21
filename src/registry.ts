// SPDX-License-Identifier: AGPL-3.0-only
// One Durable Object for the whole Worker (idFromName("registry")).
// Holds pairing codes and device token hashes in SQLite. The raw token is
// returned only from POST /v1/devices/pair and is never stored.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { num } from "./env";
import { bytesToHex, sha256 } from "./auth";

export const PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const DEFAULT_TTL_S = 600;
export const MIN_TTL_S = 60;
export const MAX_TTL_S = 3600;

export type PairError = "unknown_code" | "expired" | "used" | "rate_limited" | "bad_request";

export interface PairOk {
  ok: true;
  device_id: string;
  token: string;
}

export interface PairFail {
  ok: false;
  error: PairError;
  retry_after_s?: number;
}

export function normalizePairingCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[-\s]/g, "").replace(/O/g, "0");
  if (!s || s.length !== 8) return null;
  if (![...s].every((c) => PAIR_ALPHABET.includes(c))) return null;
  return s;
}

export function formatPairingCode(norm: string): string {
  return `${norm.slice(0, 4)}-${norm.slice(4)}`;
}

export function clampTtl(ttl: unknown): number {
  const n = typeof ttl === "number" ? ttl : Number(ttl);
  if (!Number.isFinite(n)) return DEFAULT_TTL_S;
  return Math.min(MAX_TTL_S, Math.max(MIN_TTL_S, Math.round(n)));
}

function randomCode(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += PAIR_ALPHABET[b % PAIR_ALPHABET.length];
  return out;
}

function randomToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function clientKey(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export class DeviceRegistry extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pairing_codes(
      code TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL,
      consumed_ms INTEGER, device_id TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS devices(
      device_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, fw_version TEXT, paired_ms INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rate_limits(
      k TEXT PRIMARY KEY, window_start_ms INTEGER NOT NULL, n INTEGER NOT NULL)`);
    // Owner's welcome clip (PCM16 mono 16 kHz, no header). Private: never served back.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS welcome_clip(
      id INTEGER PRIMARY KEY CHECK (id = 1), pcm BLOB NOT NULL, bytes INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`);
  }

  async welcomeClipPut(pcm: Uint8Array): Promise<{ bytes: number }> {
    const copy = pcm.slice().buffer;
    this.sql.exec("INSERT OR REPLACE INTO welcome_clip(id, pcm, bytes, updated_ms) VALUES (1, ?, ?, ?)", copy, pcm.byteLength, Date.now());
    return { bytes: pcm.byteLength };
  }

  async welcomeClipGet(): Promise<Uint8Array | null> {
    const r = this.sql.exec("SELECT pcm FROM welcome_clip WHERE id = 1").toArray()[0];
    if (!r) return null;
    return new Uint8Array(r.pcm as ArrayBuffer);
  }

  async welcomeClipInfo(): Promise<{ present: boolean; bytes: number; updated_ms: number | null }> {
    const r = this.sql.exec("SELECT bytes, updated_ms FROM welcome_clip WHERE id = 1").toArray()[0];
    return r ? { present: true, bytes: r.bytes as number, updated_ms: r.updated_ms as number } : { present: false, bytes: 0, updated_ms: null };
  }

  async welcomeClipDelete(): Promise<boolean> {
    this.sql.exec("DELETE FROM welcome_clip WHERE id = 1");
    return ((this.sql.exec("SELECT changes() AS n").toArray()[0]?.n as number) ?? 0) > 0;
  }

  async issueCode(ttlS: number): Promise<{ pairing_code: string; expires_in: number; expires_at: string }> {
    const ttl = clampTtl(ttlS);
    const now = Date.now();
    this.sql.exec("DELETE FROM pairing_codes WHERE (consumed_ms IS NOT NULL OR expires_ms < ?) AND created_ms < ?", now, now - 24 * 3600 * 1000);
    let code = "";
    for (let i = 0; i < 8; i++) {
      const c = randomCode();
      const exists = this.sql.exec("SELECT 1 AS n FROM pairing_codes WHERE code = ?", c).toArray()[0];
      if (!exists) { code = c; break; }
    }
    if (!code) throw new Error("code_collision");
    const expires = now + ttl * 1000;
    this.sql.exec("INSERT INTO pairing_codes(code, created_ms, expires_ms) VALUES (?, ?, ?)", code, now, expires);
    return { pairing_code: formatPairingCode(code), expires_in: ttl, expires_at: new Date(expires).toISOString() };
  }

  async pair(rawCode: string, deviceId: string, fwVersion: string, rateKey: string): Promise<PairOk | PairFail> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return { ok: false, error: "bad_request" };
    const limited = this.hitRate(rateKey);
    if (limited) return { ok: false, error: "rate_limited", retry_after_s: limited };
    const code = normalizePairingCode(rawCode);
    if (!code) return { ok: false, error: "bad_request" };
    const now = Date.now();
    const row = this.sql.exec("SELECT expires_ms, consumed_ms FROM pairing_codes WHERE code = ?", code).toArray()[0];
    if (!row) return { ok: false, error: "unknown_code" };
    if (row.consumed_ms != null) return { ok: false, error: "used" };
    if (now > (row.expires_ms as number)) return { ok: false, error: "expired" };
    const token = randomToken();
    const hash = bytesToHex(await sha256(token));
    this.sql.exec("UPDATE pairing_codes SET consumed_ms = ?, device_id = ? WHERE code = ? AND consumed_ms IS NULL AND expires_ms >= ?", now, deviceId, code, now);
    const took = this.sql.exec("SELECT changes() AS n").toArray()[0]?.n as number;
    if (!took) {
      const again = this.sql.exec("SELECT consumed_ms, expires_ms FROM pairing_codes WHERE code = ?", code).toArray()[0];
      if (!again) return { ok: false, error: "unknown_code" };
      if (again.consumed_ms != null) return { ok: false, error: "used" };
      return { ok: false, error: "expired" };
    }
    this.sql.exec(
      "INSERT INTO devices(device_id, token_hash, fw_version, paired_ms) VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET token_hash = excluded.token_hash, fw_version = excluded.fw_version, paired_ms = excluded.paired_ms",
      deviceId, hash, fwVersion.slice(0, 40), now,
    );
    return { ok: true, device_id: deviceId, token };
  }

  /** Look up a device by the hex SHA-256 of its token. Optional claimed device id must match. */
  async lookup(tokenHashHex: string, wantId?: string): Promise<string | null> {
    if (!/^[0-9a-f]{64}$/i.test(tokenHashHex)) return null;
    const row = this.sql.exec("SELECT device_id FROM devices WHERE lower(token_hash) = lower(?)", tokenHashHex).toArray()[0];
    if (!row) return null;
    const id = String(row.device_id);
    if (wantId && wantId !== id) return null;
    return id;
  }

  async revoke(deviceId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return false;
    this.sql.exec("DELETE FROM devices WHERE device_id = ?", deviceId);
    return ((this.sql.exec("SELECT changes() AS n").toArray()[0]?.n as number) ?? 0) > 0;
  }

  private hitRate(key: string): number | null {
    const max = Math.max(1, Math.round(num(this.env.PAIR_RATE_MAX, 10)));
    const windowMs = num(this.env.PAIR_RATE_WINDOW_S, 300) * 1000;
    const now = Date.now();
    const k = `pair:${key}`.slice(0, 200);
    const row = this.sql.exec("SELECT window_start_ms, n FROM rate_limits WHERE k = ?", k).toArray()[0];
    let start = row ? (row.window_start_ms as number) : now;
    let n = row ? (row.n as number) : 0;
    if (now - start >= windowMs) { start = now; n = 0; }
    n += 1;
    this.sql.exec("INSERT OR REPLACE INTO rate_limits(k, window_start_ms, n) VALUES (?, ?, ?)", k, start, n);
    if (n > max) return Math.max(1, Math.ceil((start + windowMs - now) / 1000));
    return null;
  }
}

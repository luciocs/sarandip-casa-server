// SPDX-License-Identifier: AGPL-3.0-only
// One Durable Object for the whole Worker (idFromName("registry")).
// Holds pairing codes and device token hashes in SQLite. The raw token is
// returned only from POST /v1/devices/pair and is never stored.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { num } from "./env";
import { bytesToHex, hexToBytes, safeEqual, sha256 } from "./auth";

export const PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const DEFAULT_TTL_S = 600;
export const MIN_TTL_S = 60;
export const MAX_TTL_S = 3600;

export type PairError = "unknown_code" | "expired" | "used" | "rate_limited" | "bad_request" | "claim_closed";

/**
 * Device claim (on-device code). The device's setup portal checks the code that ships with the device locally, so
 * the person configuring it holds the device and its card. The device then sends that code with `claim: "device"`.
 * A server that has no code for it may enroll the device on first use (trust on first use) and keep only a salted
 * PBKDF2 verifier of `device_id:code`; later re-pairs of that device (after a factory reset) must present the same
 * code. The device also sends `device_secret`, a random value it generated and keeps in NVS (never shown, survives
 * a factory reset); its SHA-256 is stored at the first claim and must match on re-pairs, so someone who only knows
 * the printed code (for example by reading the card or sniffing the open setup network) cannot re-pair that device
 * id from another machine. Policy, from Worker vars:
 *   mode "first" (default): a claim is accepted only while the server has no paired device and no claim yet;
 *   mode "open": any device id that is not already paired may claim once;
 *   mode "off": no claims (admin-issued codes only).
 *   allow: CLAIM_DEVICE_IDS. When set, only those ids may claim, and a listed id may claim even after the first
 *   device ("first" no longer closes enrollment for listed ids). "off" still wins.
 */
export interface ClaimPolicy {
  mode: "first" | "open" | "off";
  allow: string[];
}

export function claimPolicy(env: Pick<Env, "CLAIM_MODE" | "CLAIM_DEVICE_IDS">): ClaimPolicy {
  const m = (env.CLAIM_MODE ?? "").trim().toLowerCase();
  const mode = m === "open" || m === "off" ? m : "first";
  const allow = (env.CLAIM_DEVICE_IDS ?? "")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x));
  return { mode, allow };
}

/** May a new device id claim this server? `enrolled` = the server already has a paired device or a claim. */
export function claimAllowed(p: ClaimPolicy, deviceId: string, enrolled: boolean): boolean {
  if (p.mode === "off") return false;
  if (p.allow.length) return p.allow.includes(deviceId);
  if (p.mode === "open") return true;
  return !enrolled;
}

export const CLAIM_PBKDF2_ITERATIONS = 100_000;   // Workers' PBKDF2 maximum

async function claimVerifier(deviceId: string, normCode: string, saltHex: string, iterations: number): Promise<Uint8Array> {
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${deviceId}:${normCode}`), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

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
    // On-device claim codes: only a salted PBKDF2 verifier of device_id:code, never the code.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS device_claims(
      device_id TEXT PRIMARY KEY, verifier TEXT NOT NULL, salt TEXT NOT NULL, iterations INTEGER NOT NULL,
      secret_hash TEXT, created_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rate_limits(
      k TEXT PRIMARY KEY, window_start_ms INTEGER NOT NULL, n INTEGER NOT NULL)`);
    // Owner's welcome clip (PCM16 mono 16 kHz, no header). Private: never served back.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS welcome_clip(
      id INTEGER PRIMARY KEY CHECK (id = 1), pcm BLOB NOT NULL, bytes INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`);
    this.migrate();
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

  private migrate(): void {
    const cols = this.sql.exec("PRAGMA table_info(pairing_codes)").toArray();
    if (!cols.some((c) => String(c.name) === "permanent")) {
      this.sql.exec("ALTER TABLE pairing_codes ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0");
    }
  }

  /** Drop expired or consumed short-lived codes older than 24 h. Claim codes are never swept. */
  async sweepExpired(now = Date.now()): Promise<void> {
    this.sql.exec(
      "DELETE FROM pairing_codes WHERE COALESCE(permanent, 0) = 0 AND (consumed_ms IS NOT NULL OR expires_ms < ?) AND created_ms < ?",
      now,
      now - 24 * 3600 * 1000,
    );
  }

  private freshCode(): string {
    for (let i = 0; i < 8; i++) {
      const c = randomCode();
      const exists = this.sql.exec("SELECT 1 AS n FROM pairing_codes WHERE code = ?", c).toArray()[0];
      if (!exists) return c;
    }
    throw new Error("code_collision");
  }

  async issueCode(ttlS: number): Promise<{ pairing_code: string; expires_in: number; expires_at: string }> {
    const ttl = clampTtl(ttlS);
    const now = Date.now();
    await this.sweepExpired(now);
    const code = this.freshCode();
    const expires = now + ttl * 1000;
    this.sql.exec("INSERT INTO pairing_codes(code, created_ms, expires_ms, permanent) VALUES (?, ?, ?, 0)", code, now, expires);
    return { pairing_code: formatPairingCode(code), expires_in: ttl, expires_at: new Date(expires).toISOString() };
  }

  /** Permanent, device-bound claim code. Re-issuing for the same device replaces the previous code. */
  async issueClaimCode(deviceId: string): Promise<{ pairing_code: string; device_id: string; permanent: true; rotated: boolean }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) throw new Error("bad_request");
    const now = Date.now();
    await this.sweepExpired(now);
    this.sql.exec("DELETE FROM pairing_codes WHERE device_id = ? AND COALESCE(permanent, 0) = 1", deviceId);
    const rotated = ((this.sql.exec("SELECT changes() AS n").toArray()[0]?.n as number) ?? 0) > 0;
    const code = this.freshCode();
    // expires_ms = 0 is a placeholder; pair() ignores expiry when permanent = 1, and sweepExpired skips these rows.
    this.sql.exec(
      "INSERT INTO pairing_codes(code, created_ms, expires_ms, consumed_ms, device_id, permanent) VALUES (?, ?, 0, NULL, ?, 1)",
      code, now, deviceId,
    );
    return { pairing_code: formatPairingCode(code), device_id: deviceId, permanent: true, rotated };
  }

  /** Revoke a claim code by device_id or by the printed code. Does not revoke the current device token. */
  async revokeClaimCode(opts: { deviceId?: string; code?: string }): Promise<{ revoked: boolean; device_id: string | null }> {
    if (opts.deviceId) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(opts.deviceId)) return { revoked: false, device_id: null };
      this.sql.exec("DELETE FROM pairing_codes WHERE device_id = ? AND COALESCE(permanent, 0) = 1", opts.deviceId);
      const n = (this.sql.exec("SELECT changes() AS n").toArray()[0]?.n as number) ?? 0;
      return { revoked: n > 0, device_id: n > 0 ? opts.deviceId : null };
    }
    const code = opts.code ? normalizePairingCode(opts.code) : null;
    if (!code) return { revoked: false, device_id: null };
    const row = this.sql.exec("SELECT device_id FROM pairing_codes WHERE code = ? AND COALESCE(permanent, 0) = 1", code).toArray()[0];
    if (!row) return { revoked: false, device_id: null };
    this.sql.exec("DELETE FROM pairing_codes WHERE code = ? AND COALESCE(permanent, 0) = 1", code);
    return { revoked: true, device_id: String(row.device_id) };
  }

  /**
   * `claim` = the device says it checked this code itself (on-device claim code). Without it, or when the server
   * already knows the code, the admin-issued code flow below runs unchanged.
   */
  async pair(rawCode: string, deviceId: string, fwVersion: string, rateKey: string, claim = false, policy?: ClaimPolicy, deviceSecret = ""): Promise<PairOk | PairFail> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return { ok: false, error: "bad_request" };
    const limited = this.hitRate(rateKey);
    if (limited) return { ok: false, error: "rate_limited", retry_after_s: limited };
    const code = normalizePairingCode(rawCode);
    if (!code) return { ok: false, error: "bad_request" };
    const now = Date.now();
    const row = this.sql.exec("SELECT expires_ms, consumed_ms, device_id, permanent FROM pairing_codes WHERE code = ?", code).toArray()[0];
    if (!row) return this.pairByClaim(code, deviceId, fwVersion, claim, policy ?? claimPolicy(this.env), now, deviceSecret);
    const permanent = Number(row.permanent) === 1;
    if (permanent) {
      // Bound to one device_id. A mismatch looks like an unknown code so the binding is not leaked.
      if (String(row.device_id) !== deviceId) return { ok: false, error: "unknown_code" };
    } else {
      if (row.consumed_ms != null) return { ok: false, error: "used" };
      if (now > (row.expires_ms as number)) return { ok: false, error: "expired" };
    }
    const token = randomToken();
    const hash = bytesToHex(await sha256(token));
    if (!permanent) {
      this.sql.exec("UPDATE pairing_codes SET consumed_ms = ?, device_id = ? WHERE code = ? AND consumed_ms IS NULL AND expires_ms >= ?", now, deviceId, code, now);
      const took = this.sql.exec("SELECT changes() AS n").toArray()[0]?.n as number;
      if (!took) {
        const again = this.sql.exec("SELECT consumed_ms, expires_ms FROM pairing_codes WHERE code = ?", code).toArray()[0];
        if (!again) return { ok: false, error: "unknown_code" };
        if (again.consumed_ms != null) return { ok: false, error: "used" };
        return { ok: false, error: "expired" };
      }
    }
    this.storeDevice(deviceId, hash, fwVersion, now);
    return { ok: true, device_id: deviceId, token };
  }

  private storeDevice(deviceId: string, hash: string, fwVersion: string, now: number): void {
    this.sql.exec(
      "INSERT INTO devices(device_id, token_hash, fw_version, paired_ms) VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET token_hash = excluded.token_hash, fw_version = excluded.fw_version, paired_ms = excluded.paired_ms",
      deviceId, hash, fwVersion.slice(0, 40), now,
    );
  }

  /** Unknown admin code: try the device's own claim code (re-pair with the stored verifier, or first claim). */
  private async pairByClaim(code: string, deviceId: string, fwVersion: string, claim: boolean, policy: ClaimPolicy, now: number, deviceSecret: string): Promise<PairOk | PairFail> {
    const secret = /^[\x21-\x7e]{32,128}$/.test(deviceSecret) ? deviceSecret : "";
    const c = this.sql.exec("SELECT verifier, salt, iterations, secret_hash FROM device_claims WHERE device_id = ?", deviceId).toArray()[0];
    if (c) {
      // Re-pair of a claimed device (e.g. after a factory reset): the same code (and, when one was stored at the
      // first claim, the same device secret) must match. Any mismatch looks like an unknown code.
      const want = hexToBytes(String(c.verifier));
      const got = await claimVerifier(deviceId, code, String(c.salt), Number(c.iterations));
      let ok = !!want && safeEqual(want, got);
      if (c.secret_hash != null) {
        const sh = hexToBytes(String(c.secret_hash));
        ok = ok && !!secret && !!sh && safeEqual(sh, await sha256(secret));
      }
      if (!ok) return { ok: false, error: "unknown_code" };
      this.sql.exec("UPDATE device_claims SET last_ms = ? WHERE device_id = ?", now, deviceId);
    } else {
      if (!claim) return { ok: false, error: "unknown_code" };
      // Never take over a device id that is already paired through an admin code.
      if (this.sql.exec("SELECT 1 AS n FROM devices WHERE device_id = ?", deviceId).toArray()[0]) return { ok: false, error: "unknown_code" };
      const enrolled = !!(this.sql.exec("SELECT 1 AS n FROM devices LIMIT 1").toArray()[0] || this.sql.exec("SELECT 1 AS n FROM device_claims LIMIT 1").toArray()[0]);
      if (!claimAllowed(policy, deviceId, enrolled)) return { ok: false, error: "claim_closed" };
      const saltB = new Uint8Array(16);
      crypto.getRandomValues(saltB);
      const salt = bytesToHex(saltB);
      const v = await claimVerifier(deviceId, code, salt, CLAIM_PBKDF2_ITERATIONS);
      this.sql.exec(
        "INSERT INTO device_claims(device_id, verifier, salt, iterations, secret_hash, created_ms, last_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        deviceId, bytesToHex(v), salt, CLAIM_PBKDF2_ITERATIONS, secret ? bytesToHex(await sha256(secret)) : null, now, now,
      );
    }
    const token = randomToken();
    this.storeDevice(deviceId, bytesToHex(await sha256(token)), fwVersion, now);
    return { ok: true, device_id: deviceId, token };
  }

  /** Forget a device's claim so it can claim again (with any code) where the policy allows. Token is kept. */
  async forgetClaim(deviceId: string): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return false;
    this.sql.exec("DELETE FROM device_claims WHERE device_id = ?", deviceId);
    return ((this.sql.exec("SELECT changes() AS n").toArray()[0]?.n as number) ?? 0) > 0;
  }

  async claimInfo(): Promise<{ claims: { device_id: string; created_at: string; last_at: string }[] }> {
    const rows = this.sql.exec("SELECT device_id, created_ms, last_ms FROM device_claims ORDER BY created_ms").toArray();
    return { claims: rows.map((r) => ({ device_id: String(r.device_id), created_at: new Date(r.created_ms as number).toISOString(), last_at: new Date(r.last_ms as number).toISOString() })) };
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

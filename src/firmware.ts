// SPDX-License-Identifier: AGPL-3.0-only
// Firmware images for HTTPS OTA. One Durable Object holds every channel's app
// binaries (chunked), assignments and status reports. The official signing key
// is a wrangler secret (PKCS#8 PEM); it never ships in this file.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { authAdmin } from "./auth";
import { publicBase } from "./config";
import { hub } from "./hubref";

export const OTA_IMAGE_MIN = 100_000;
export const OTA_IMAGE_MAX = 6 * 1024 * 1024;
const CHUNK = 64 * 1024;
export const FIRMWARE_STORE_NAME = "firmware";

const json = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

export function firmware(env: Env) {
  return env.FIRMWARE_STORE.get(env.FIRMWARE_STORE.idFromName(FIRMWARE_STORE_NAME));
}

export function channelOk(s: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(s);
}

export function versionOk(s: string): boolean {
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}([.-][A-Za-z0-9.+_-]{1,24})?$/.test(s) && s.length <= 40;
}

export function sha256HexOk(s: string): boolean {
  return /^[0-9a-f]{64}$/i.test(s);
}

export function sigHexOk(s: string): boolean {
  return /^[0-9a-f]{128}$/i.test(s);
}

export function parseVerPart(s: { v: string }): number {
  if (!s.v || s.v[0] < "0" || s.v[0] > "9") return -1;
  let n = 0;
  while (s.v && s.v[0] >= "0" && s.v[0] <= "9") {
    n = n * 10 + (s.v.charCodeAt(0) - 48);
    s.v = s.v.slice(1);
    if (n > 1_000_000) return -1;
  }
  return n;
}

/** Same rule as the firmware cmpFwVersion: suffix ignored. >0 if offered is newer. */
export function cmpFwVersion(cur: string, offered: string): number {
  let a = cur, b = offered;
  for (let i = 0; i < 3; i++) {
    const as = { v: a }, bs = { v: b };
    const av = parseVerPart(as), bv = parseVerPart(bs);
    if (av < 0 || bv < 0) return 0;
    if (av !== bv) return bv > av ? 1 : -1;
    a = as.v.startsWith(".") ? as.v.slice(1) : as.v;
    b = bs.v.startsWith(".") ? bs.v.slice(1) : bs.v;
  }
  return 0;
}

export function looksLikeFactoryImage(buf: Uint8Array): boolean {
  if (buf.byteLength < 0x11000) return false;
  let ff = 0;
  for (let i = 0x2000; i < 0x8000; i++) if (buf[i] === 0xff) ff++;
  return ff > 0x4000;
}

export function pemToPkcs8(pem: string): Uint8Array {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importSigningKey(pem: string): Promise<CryptoKey> {
  const der = pemToPkcs8(pem);
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function sha256Hex(data: BufferSource): Promise<string> {
  const dig = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...dig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signImage(key: CryptoKey, image: BufferSource): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, image));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ImageMeta = {
  channel: string;
  version: string;
  sha256: string;
  size: number;
  signature: string;
  uploaded_ms: number;
};

export type AssignRow = {
  device_id: string;
  channel: string;
  version: string;
  assigned_ms: number;
  last_fw: string;
  last_event: string;
  last_detail: string;
  last_report_ms: number;
};

export class FirmwareStore extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS images(
      channel TEXT NOT NULL, version TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
      signature TEXT NOT NULL DEFAULT '', uploaded_ms INTEGER NOT NULL,
      PRIMARY KEY(channel, version))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chunks(
      channel TEXT NOT NULL, version TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL,
      PRIMARY KEY(channel, version, seq))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS assignments(
      device_id TEXT PRIMARY KEY, channel TEXT NOT NULL, version TEXT NOT NULL, assigned_ms INTEGER NOT NULL,
      last_fw TEXT NOT NULL DEFAULT '', last_event TEXT NOT NULL DEFAULT '',
      last_detail TEXT NOT NULL DEFAULT '', last_report_ms INTEGER NOT NULL DEFAULT 0)`);
  }

  async putImage(input: { channel: string; version: string; bytes: Uint8Array; sha256?: string; signature?: string }): Promise<ImageMeta> {
    const { channel, version, bytes } = input;
    if (!channelOk(channel) || !versionOk(version)) throw new FwError("bad_request", 400);
    if (bytes.byteLength < OTA_IMAGE_MIN || bytes.byteLength > OTA_IMAGE_MAX) throw new FwError("bad_size", 413);
    if (looksLikeFactoryImage(bytes)) throw new FwError("factory_image", 400);
    const sha = await sha256Hex(bytes);
    if (input.sha256 && input.sha256.toLowerCase() !== sha) throw new FwError("sha256_mismatch", 400);
    let signature = (input.signature ?? "").toLowerCase();
    const pem = this.env.FIRMWARE_SIGNING_KEY;
    if (pem && pem.includes("BEGIN")) {
      const key = await importSigningKey(pem);
      signature = await signImage(key, bytes);
    } else if (signature && !sigHexOk(signature)) {
      throw new FwError("bad_signature", 400);
    }
    this.sql.exec("DELETE FROM chunks WHERE channel = ? AND version = ?", channel, version);
    this.sql.exec("DELETE FROM images WHERE channel = ? AND version = ?", channel, version);
    for (let off = 0, seq = 0; off < bytes.byteLength; off += CHUNK, seq++) {
      const part = bytes.subarray(off, Math.min(bytes.byteLength, off + CHUNK));
      this.sql.exec("INSERT INTO chunks(channel, version, seq, data) VALUES(?,?,?,?)", channel, version, seq, part);
    }
    const uploaded_ms = Date.now();
    this.sql.exec(
      "INSERT INTO images(channel, version, sha256, size, signature, uploaded_ms) VALUES(?,?,?,?,?,?)",
      channel, version, sha, bytes.byteLength, signature, uploaded_ms,
    );
    return { channel, version, sha256: sha, size: bytes.byteLength, signature, uploaded_ms };
  }

  async getMeta(channel: string, version: string): Promise<ImageMeta | null> {
    const r = this.sql.exec(
      "SELECT channel, version, sha256, size, signature, uploaded_ms FROM images WHERE channel = ? AND version = ?",
      channel, version,
    ).toArray()[0];
    if (!r) return null;
    return {
      channel: String(r.channel), version: String(r.version), sha256: String(r.sha256),
      size: Number(r.size), signature: String(r.signature ?? ""), uploaded_ms: Number(r.uploaded_ms),
    };
  }

  async getImage(channel: string, version: string): Promise<{ meta: ImageMeta; bytes: Uint8Array } | null> {
    const meta = await this.getMeta(channel, version);
    if (!meta) return null;
    const rows = this.sql.exec(
      "SELECT seq, data FROM chunks WHERE channel = ? AND version = ? ORDER BY seq ASC",
      channel, version,
    ).toArray();
    const out = new Uint8Array(meta.size);
    let off = 0;
    for (const row of rows) {
      const d = row.data as ArrayBuffer | Uint8Array | string;
      const part = typeof d === "string" ? Uint8Array.from(atob(d), (c) => c.charCodeAt(0))
        : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d);
      out.set(part, off);
      off += part.byteLength;
    }
    if (off !== meta.size) throw new FwError("corrupt_image", 500);
    return { meta, bytes: out };
  }

  async list(channel?: string): Promise<ImageMeta[]> {
    const rows = channel
      ? this.sql.exec("SELECT channel, version, sha256, size, signature, uploaded_ms FROM images WHERE channel = ? ORDER BY uploaded_ms DESC", channel).toArray()
      : this.sql.exec("SELECT channel, version, sha256, size, signature, uploaded_ms FROM images ORDER BY uploaded_ms DESC").toArray();
    return rows.map((r) => ({
      channel: String(r.channel), version: String(r.version), sha256: String(r.sha256),
      size: Number(r.size), signature: String(r.signature ?? ""), uploaded_ms: Number(r.uploaded_ms),
    }));
  }

  async latest(channel: string): Promise<ImageMeta | null> {
    const r = this.sql.exec(
      "SELECT channel, version, sha256, size, signature, uploaded_ms FROM images WHERE channel = ? ORDER BY uploaded_ms DESC LIMIT 1",
      channel,
    ).toArray()[0];
    if (!r) return null;
    return {
      channel: String(r.channel), version: String(r.version), sha256: String(r.sha256),
      size: Number(r.size), signature: String(r.signature ?? ""), uploaded_ms: Number(r.uploaded_ms),
    };
  }

  async remove(channel: string, version: string): Promise<boolean> {
    this.sql.exec("DELETE FROM chunks WHERE channel = ? AND version = ?", channel, version);
    this.sql.exec("DELETE FROM images WHERE channel = ? AND version = ?", channel, version);
    return true;
  }

  async assign(deviceId: string, channel: string, version?: string): Promise<AssignRow> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId) || !channelOk(channel)) throw new FwError("bad_request", 400);
    const meta = version ? await this.getMeta(channel, version) : await this.latest(channel);
    if (!meta) throw new FwError("not_found", 404);
    const now = Date.now();
    const prev = this.sql.exec("SELECT last_fw, last_event, last_detail, last_report_ms FROM assignments WHERE device_id = ?", deviceId).toArray()[0];
    this.sql.exec(
      "INSERT INTO assignments(device_id, channel, version, assigned_ms, last_fw, last_event, last_detail, last_report_ms) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET channel=excluded.channel, version=excluded.version, assigned_ms=excluded.assigned_ms",
      deviceId, meta.channel, meta.version, now,
      String(prev?.last_fw ?? ""), String(prev?.last_event ?? ""), String(prev?.last_detail ?? ""), Number(prev?.last_report_ms ?? 0),
    );
    return this.status(deviceId) as Promise<AssignRow>;
  }

  async status(deviceId: string): Promise<(AssignRow & { image?: ImageMeta }) | null> {
    const r = this.sql.exec(
      "SELECT device_id, channel, version, assigned_ms, last_fw, last_event, last_detail, last_report_ms FROM assignments WHERE device_id = ?",
      deviceId,
    ).toArray()[0];
    if (!r) return null;
    const row: AssignRow = {
      device_id: String(r.device_id), channel: String(r.channel), version: String(r.version),
      assigned_ms: Number(r.assigned_ms), last_fw: String(r.last_fw ?? ""), last_event: String(r.last_event ?? ""),
      last_detail: String(r.last_detail ?? ""), last_report_ms: Number(r.last_report_ms ?? 0),
    };
    const image = await this.getMeta(row.channel, row.version);
    return image ? { ...row, image } : row;
  }

  async manifestFor(deviceId: string, currentFw: string): Promise<(ImageMeta & { url: string }) | null> {
    const st = await this.status(deviceId);
    if (currentFw) {
      this.sql.exec("UPDATE assignments SET last_fw = ?, last_report_ms = ? WHERE device_id = ?", currentFw, Date.now(), deviceId);
    }
    if (!st) return null;
    const meta = st.image ?? await this.getMeta(st.channel, st.version);
    if (!meta) return null;
    if (currentFw && cmpFwVersion(currentFw, meta.version) <= 0) return null;
    return { ...meta, url: `/bloco/ota/image?channel=${encodeURIComponent(meta.channel)}&version=${encodeURIComponent(meta.version)}` };
  }

  async allowedImage(deviceId: string, channel: string, version: string): Promise<{ meta: ImageMeta; bytes: Uint8Array } | null> {
    const st = await this.status(deviceId);
    if (!st || st.channel !== channel || st.version !== version) return null;
    return this.getImage(channel, version);
  }

  async report(deviceId: string, ev: { event: string; version?: string; fw?: string; detail?: string }): Promise<void> {
    const event = String(ev.event ?? "").slice(0, 32);
    const detail = String(ev.detail ?? "").slice(0, 80);
    const fw = String(ev.fw ?? ev.version ?? "").slice(0, 40);
    if (!event) throw new FwError("bad_request", 400);
    const now = Date.now();
    const exists = this.sql.exec("SELECT device_id FROM assignments WHERE device_id = ?", deviceId).toArray()[0];
    if (!exists) {
      this.sql.exec(
        "INSERT INTO assignments(device_id, channel, version, assigned_ms, last_fw, last_event, last_detail, last_report_ms) VALUES(?,?,?,?,?,?,?,?)",
        deviceId, "default", ev.version || "unknown", now, fw, event, detail, now,
      );
      return;
    }
    this.sql.exec(
      "UPDATE assignments SET last_event = ?, last_detail = ?, last_report_ms = ?, last_fw = CASE WHEN ? != '' THEN ? ELSE last_fw END WHERE device_id = ?",
      event, detail, now, fw, fw, deviceId,
    );
  }
}

export class FwError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

const FW_ERRORS: Record<string, number> = {
  bad_request: 400,
  bad_size: 413,
  factory_image: 400,
  sha256_mismatch: 400,
  bad_signature: 400,
  not_found: 404,
  corrupt_image: 500,
};

async function handleFwError(e: unknown): Promise<Response> {
  if (e instanceof FwError) return json({ error: e.code }, e.status);
  // Durable Object RPC does not preserve FwError; the message is the code.
  const msg = String((e as Error)?.message ?? "");
  const status = FW_ERRORS[msg];
  if (status) return json({ error: msg }, status);
  console.error("firmware", (e as Error)?.name ?? "error");
  return json({ error: "internal" }, 500);
}

export async function adminFirmware(req: Request, env: Env): Promise<Response> {
  if (!(await authAdmin(req, env))) return json({ error: "unauthorized" }, 401);
  const url = new URL(req.url);
  const channel = (url.searchParams.get("channel") ?? "default").toLowerCase();
  try {
    if (req.method === "GET") {
      const version = url.searchParams.get("version") ?? "";
      if (version) {
        const meta = await firmware(env).getMeta(channel, version);
        if (!meta) return json({ error: "not_found" }, 404);
        return json(meta);
      }
      return json({ images: await firmware(env).list(url.searchParams.has("channel") ? channel : undefined) });
    }
    if (req.method === "DELETE") {
      const version = url.searchParams.get("version") ?? "";
      if (!channelOk(channel) || !versionOk(version)) return json({ error: "bad_request" }, 400);
      await firmware(env).remove(channel, version);
      return json({ deleted: true, channel, version });
    }
    if (req.method === "PUT") {
      const version = req.headers.get("x-sarandip-firmware-version") ?? url.searchParams.get("version") ?? "";
      if (!channelOk(channel) || !versionOk(version)) return json({ error: "bad_request" }, 400);
      const len = Number(req.headers.get("content-length") ?? "0");
      if (len > OTA_IMAGE_MAX) return json({ error: "too large" }, 413);
      const buf = new Uint8Array(await req.arrayBuffer());
      const sha = req.headers.get("x-sarandip-firmware-sha256") ?? undefined;
      const signature = req.headers.get("x-sarandip-firmware-signature") ?? undefined;
      const meta = await firmware(env).putImage({ channel, version, bytes: buf, sha256: sha, signature });
      return json(meta, 201);
    }
    return json({ error: "method" }, 405);
  } catch (e) {
    return handleFwError(e);
  }
}

export async function adminFirmwareAssign(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!(await authAdmin(req, env))) return json({ error: "unauthorized" }, 401);
  let b: { device_id?: unknown; channel?: unknown; version?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const deviceId = typeof b.device_id === "string" ? b.device_id : "";
  const channel = (typeof b.channel === "string" ? b.channel : "default").toLowerCase();
  const version = typeof b.version === "string" ? b.version : undefined;
  try {
    const row = await firmware(env).assign(deviceId, channel, version);
    return json(row);
  } catch (e) {
    return handleFwError(e);
  }
}

export async function adminFirmwarePush(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!(await authAdmin(req, env))) return json({ error: "unauthorized" }, 401);
  let b: { device_id?: unknown; channel?: unknown; version?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const deviceId = typeof b.device_id === "string" ? b.device_id : "";
  const channel = (typeof b.channel === "string" ? b.channel : "default").toLowerCase();
  const version = typeof b.version === "string" ? b.version : undefined;
  try {
    const row = await firmware(env).assign(deviceId, channel, version);
    let notified = false;
    try { notified = await hub(env, deviceId).notifyOta({ version: row.version }); } catch { notified = false; }
    return json({ ...row, notified });
  } catch (e) {
    return handleFwError(e);
  }
}

export async function adminFirmwareStatus(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method" }, 405);
  if (!(await authAdmin(req, env))) return json({ error: "unauthorized" }, 401);
  const deviceId = new URL(req.url).searchParams.get("device_id") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return json({ error: "bad_request" }, 400);
  const row = await firmware(env).status(deviceId);
  let device: { online: boolean; muted: boolean; fw: string; pending: number } | null = null;
  try { device = await hub(env, deviceId).status(); } catch { device = null; }
  return json({ assignment: row, device });
}

export async function deviceOta(req: Request, env: Env, deviceId: string, origin: string): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method" }, 405);
  const fw = new URL(req.url).searchParams.get("fw") ?? "";
  const man = await firmware(env).manifestFor(deviceId, fw);
  if (!man) return new Response(null, { status: 204 });
  const base = publicBase(env.PUBLIC_BASE_URL, origin);
  return json({
    version: man.version,
    channel: man.channel,
    url: man.url,
    sha256: man.sha256,
    size: man.size,
    signature: man.signature,
    absolute_url: `${base}${man.url}`,
  });
}

export async function deviceOtaImage(req: Request, env: Env, deviceId: string): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method" }, 405);
  const url = new URL(req.url);
  const channel = (url.searchParams.get("channel") ?? "default").toLowerCase();
  const version = url.searchParams.get("version") ?? "";
  if (!channelOk(channel) || !versionOk(version)) return json({ error: "bad_request" }, 400);
  const got = await firmware(env).allowedImage(deviceId, channel, version);
  if (!got) return json({ error: "not_found" }, 404);
  return new Response(got.bytes, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(got.bytes.byteLength),
      "cache-control": "no-store",
      "x-sarandip-ota-sha256": got.meta.sha256,
      "x-sarandip-ota-signature": got.meta.signature,
      "x-sarandip-ota-version": got.meta.version,
    },
  });
}

export async function deviceOtaStatus(req: Request, env: Env, deviceId: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: { event?: unknown; version?: unknown; fw?: unknown; detail?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  try {
    await firmware(env).report(deviceId, {
      event: String(b.event ?? ""),
      version: typeof b.version === "string" ? b.version : undefined,
      fw: typeof b.fw === "string" ? b.fw : undefined,
      detail: typeof b.detail === "string" ? b.detail : undefined,
    });
    return new Response(null, { status: 204 });
  } catch (e) {
    return handleFwError(e);
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Device, reply and admin auth. Tokens never logged. Comparison is constant time
// over SHA-256 digests (and HMAC tags), so length and content of the secret do not leak.
import type { Env } from "./env";
import { num } from "./env";
import { registry } from "./registryref";

const enc = new TextEncoder();

export async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// crypto.subtle.timingSafeEqual is a Workers extension; fallback keeps tests portable.
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let d = 0;
  for (let i = 0; i < a.byteLength; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function deviceTable(env: Env): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!env.DEVICE_TOKENS) return out;
  try {
    const raw = JSON.parse(env.DEVICE_TOKENS) as Record<string, string>;
    for (const [id, hex] of Object.entries(raw)) {
      const h = hexToBytes(String(hex));
      if (h && /^[A-Za-z0-9_-]{1,64}$/.test(id)) out.set(id, h);
    }
  } catch {
    /* malformed secret: no device is accepted from the legacy table */
  }
  return out;
}

async function matchBearer(header: string, secrets: string[]): Promise<boolean> {
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const got = await sha256(m[1].trim());
  const usable = secrets.filter((s) => s.length >= 16);
  if (!usable.length) return false;
  let ok = false;
  // Always compare against every configured secret so timing does not reveal which one matched.
  for (const s of usable) {
    if (safeEqual(got, await sha256(s))) ok = true;
  }
  return ok;
}

/** Device id for X-Device-Token (+ optional X-Device-Id), or null. */
export async function authDevice(req: Request, env: Env): Promise<string | null> {
  const token = req.headers.get("x-device-token") ?? "";
  if (!token || token.length > 256) return null;
  const want = req.headers.get("x-device-id") ?? "";
  const digest = await sha256(token);
  if (env.DEVICE_REGISTRY) {
    try {
      const id = await registry(env).lookup(bytesToHex(digest), want || undefined);
      if (id) return id;
    } catch {
      /* registry unavailable: fall through to the legacy secret */
    }
  }
  const table = deviceTable(env);
  let found: string | null = null;
  // Walk every entry so timing does not depend on which device matched.
  for (const [id, h] of table) {
    const ok = safeEqual(digest, h);
    if (ok && found === null) found = id;
  }
  if (found && want && want !== found) return null;
  return found;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s: string): Uint8Array | null {
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s) || s.length > 128) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

function replySecrets(env: Env): string[] {
  return [env.REPLY_SECRET ?? "", env.REPLY_SECRET_PREVIOUS ?? ""].filter((s) => s.length >= 16);
}

/**
 * Turn-scoped reply token: base64url(HMAC-SHA256(secret, turn_id + "." + device_id + "." + exp)) + "." + exp.
 * exp is Unix seconds, now + REPLY_TTL_S. Never log the token.
 */
export async function mintReplyToken(
  env: Env,
  turnId: string,
  deviceId: string,
  nowMs: number = Date.now(),
  ttlS?: number,
): Promise<string | null> {
  const secret = env.REPLY_SECRET ?? "";
  if (secret.length < 16) return null;
  const ttl = ttlS ?? num(env.REPLY_TTL_S, 900);
  const exp = Math.floor(nowMs / 1000) + ttl;
  const mac = await hmacSha256(secret, `${turnId}.${deviceId}.${exp}`);
  return `${b64urlEncode(mac)}.${exp}`;
}

export async function signedReplyUrl(
  env: Env,
  base: string,
  turnId: string,
  deviceId: string,
  nowMs: number = Date.now(),
): Promise<{ reply_url: string; reply_auth?: "url" }> {
  const token = await mintReplyToken(env, turnId, deviceId, nowMs);
  if (!token) return { reply_url: `${base}/bloco/reply` };
  return { reply_url: `${base}/bloco/reply?t=${token}`, reply_auth: "url" };
}

/** Verify a `t` query token against the body's turn_id and device_id. Never log `token`. */
export async function authReplyToken(
  env: Env,
  token: string,
  turnId: string,
  deviceId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const macB64 = token.slice(0, dot);
  const expStr = token.slice(dot + 1);
  if (!/^[0-9]{1,12}$/.test(expStr)) return false;
  const exp = Number(expStr);
  const mac = b64urlDecode(macB64);
  if (!mac || mac.byteLength !== 32) return false;
  const secrets = replySecrets(env);
  if (!secrets.length) return false;
  const msg = `${turnId}.${deviceId}.${exp}`;
  let macOk = false;
  // Always compare against every configured secret so timing does not reveal which one matched.
  for (const s of secrets) {
    if (safeEqual(mac, await hmacSha256(s, msg))) macOk = true;
  }
  if (!macOk) return false;
  const nowSec = Math.floor(nowMs / 1000);
  const ttl = num(env.REPLY_TTL_S, 900);
  if (exp <= nowSec || exp > nowSec + ttl + 60) return false;
  return true;
}

/**
 * Reply auth is per owner (one Worker, one secret pair), not per device.
 * Accepts Authorization: Bearer REPLY_SECRET (or REPLY_SECRET_PREVIOUS during rotation),
 * or a valid turn-scoped token in the `t` query parameter. The token must match the
 * body's turn_id and device_id. Never log the token or the request URL.
 */
export async function authReply(
  req: Request,
  env: Env,
  body?: { turn_id: string; device_id: string },
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (
    await matchBearer(req.headers.get("authorization") ?? "", [
      env.REPLY_SECRET ?? "",
      env.REPLY_SECRET_PREVIOUS ?? "",
    ])
  ) {
    return true;
  }
  if (!body) return false;
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!token) return false;
  return authReplyToken(env, token, body.turn_id, body.device_id, nowMs);
}

export async function authAdmin(req: Request, env: Env): Promise<boolean> {
  return matchBearer(req.headers.get("authorization") ?? "", [env.ADMIN_TOKEN ?? ""]);
}

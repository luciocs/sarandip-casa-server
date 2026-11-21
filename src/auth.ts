// SPDX-License-Identifier: AGPL-3.0-only
// Device, reply and admin auth. Tokens never logged. Comparison is constant time
// over SHA-256 digests, so length and content of the secret do not leak.
import type { Env } from "./env";
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

/**
 * Reply auth is per owner (one Worker, one secret pair), not per device.
 * During rotation both REPLY_SECRET and REPLY_SECRET_PREVIOUS are accepted.
 */
export async function authReply(req: Request, env: Env): Promise<boolean> {
  return matchBearer(req.headers.get("authorization") ?? "", [
    env.REPLY_SECRET ?? "",
    env.REPLY_SECRET_PREVIOUS ?? "",
  ]);
}

export async function authAdmin(req: Request, env: Env): Promise<boolean> {
  return matchBearer(req.headers.get("authorization") ?? "", [env.ADMIN_TOKEN ?? ""]);
}

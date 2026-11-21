// SPDX-License-Identifier: AGPL-3.0-only
import { wavHeader } from "../src/wav";

export const TOKEN = "test-token-casa-0123456789";
export const DEV = "dev_home01";
export const REPLY = "reply-secret-for-tests-only-0001";
export const REPLY_PREV = "reply-secret-for-tests-only-prev";
export const ADMIN = "admin-token-for-tests-only-0001";
export const BASE = "https://casa.test";

/** PCM16 mono 16 kHz: optional "STUB:<text>\0" prefix (read by the stub STT) + tone. */
export function pcm(ms: number, text?: string, amp = 2000): Uint8Array {
  const n = Math.round((ms / 1000) * 16000);
  const out = new Uint8Array(n * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, Math.round(amp * Math.sin(i / 5)), true);
  if (text) out.set(new TextEncoder().encode(`STUB:${text}\0`));
  return out;
}

export function wav(p: Uint8Array, channels = 1): Uint8Array {
  const h = wavHeader(p.byteLength);
  if (channels !== 1) new DataView(h.buffer).setUint16(22, channels, true);
  const o = new Uint8Array(44 + p.byteLength);
  o.set(h);
  o.set(p, 44);
  return o;
}

/** Same bytes the firmware writes in the turn uplink (boundary BelaTurn7f3a). */
export function multipart(audio: Uint8Array, wake?: Uint8Array): { body: Uint8Array; ctype: string } {
  const b = "BelaTurn7f3a";
  const e = new TextEncoder();
  const parts: Uint8Array[] = [];
  if (wake) {
    parts.push(e.encode(`--${b}\r\nContent-Disposition: form-data; name="wake"; filename="wake.wav"\r\nContent-Type: audio/wav\r\n\r\n`), wake);
    parts.push(e.encode(`\r\n--${b}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`), audio);
  } else {
    parts.push(e.encode(`--${b}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`), audio);
  }
  parts.push(e.encode(`\r\n--${b}--\r\n`));
  const len = parts.reduce((s, p) => s + p.byteLength, 0);
  const body = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.byteLength; }
  return { body, ctype: `multipart/form-data; boundary=${b}` };
}

export function devHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-device-token": TOKEN, ...extra };
}

export async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, ms = 3000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

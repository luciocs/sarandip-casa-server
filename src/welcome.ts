// SPDX-License-Identifier: AGPL-3.0-only
// Welcome audio, played once on the first WebSocket session after a (re)pairing.
// Server-driven: it goes out as an ordinary late reply (tts_start / binary PCM /
// tts_end), so the firmware needs no change.
//
// WELCOME_MODE:
//   "tts"   (default) speak WELCOME_TEXT (or the default line for LANGUAGE).
//   "audio" play the owner's clip: the one uploaded with PUT /v1/admin/welcome-audio
//           (stored privately in the registry Durable Object), else WELCOME_AUDIO_URL.
//           If no clip can be loaded, falls back to the "tts" line.
//   "off"   no welcome.
import type { Env } from "./env";
import { clockLang } from "./clock";
import { synthesize } from "./adapters/tts";
import { parseWav, SR, WavError } from "./wav";
import type { FetchFn } from "./adapters/types";

export type WelcomeMode = "tts" | "audio" | "off";

/** Largest welcome clip, PCM16 mono 16 kHz: 1 MiB is about 32 s. */
export const WELCOME_MAX_BYTES = 1_048_576;
export const WELCOME_DEFAULT_DELAY_MS = 2000;
/**
 * Silence appended after the welcome (clip or spoken line). A clip trimmed right at its last word, or a
 * device that powers its amp down soon after the last frame, would otherwise clip the final syllable.
 */
export const WELCOME_TAIL_MS = 300;

export function welcomeMode(env: Pick<Env, "WELCOME_MODE">): WelcomeMode {
  const s = (env.WELCOME_MODE ?? "").trim().toLowerCase();
  if (s === "audio" || s === "off") return s;
  if (["false", "0", "no", "none", "disabled"].includes(s)) return "off";
  return "tts";
}

export function defaultWelcome(language: string): string {
  return clockLang(language) === "pt-BR" ? "Boas-vindas ao seu novo Sarandip." : "Welcome to your new Sarandip.";
}

export function welcomeText(env: Pick<Env, "WELCOME_TEXT" | "LANGUAGE">): string {
  return env.WELCOME_TEXT?.trim().slice(0, 500) || defaultWelcome(env.LANGUAGE);
}

export function welcomeDelayMs(env: Pick<Env, "WELCOME_DELAY_MS">): number {
  const n = Number(env.WELCOME_DELAY_MS);
  return Number.isFinite(n) && n >= 0 && n <= 60_000 ? Math.round(n) : WELCOME_DEFAULT_DELAY_MS;
}

export class WelcomeError extends Error {}

/**
 * Accepts a WAV (PCM16, mono, 16 kHz) or headerless PCM16 mono 16 kHz (when `raw`).
 * Returns the even-length PCM bytes, capped at WELCOME_MAX_BYTES.
 */
export function welcomePcmFrom(buf: Uint8Array, raw = false): Uint8Array {
  const isRiff = buf.byteLength >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46;
  let pcm: Uint8Array;
  if (isRiff) {
    try {
      pcm = parseWav(buf).pcm;
    } catch (e) {
      throw new WelcomeError(e instanceof WavError ? e.message : "bad wav");
    }
  } else if (raw) {
    pcm = buf.subarray(0, buf.byteLength - (buf.byteLength & 1));
  } else {
    throw new WelcomeError("expected a WAV file (PCM16 mono 16 kHz)");
  }
  if (pcm.byteLength < SR / 5) throw new WelcomeError("clip too short"); // < 100 ms
  if (pcm.byteLength > WELCOME_MAX_BYTES) throw new WelcomeError("clip too long");
  return pcm;
}

/** Fetches WELCOME_AUDIO_URL (https only). Optional Bearer WELCOME_AUDIO_TOKEN for a private host. */
export async function fetchWelcomeUrl(env: Env, fetchFn: FetchFn = fetch): Promise<Uint8Array | null> {
  const url = env.WELCOME_AUDIO_URL?.trim();
  if (!url || !/^https:\/\//i.test(url)) return null;
  const headers: Record<string, string> = {};
  if (env.WELCOME_AUDIO_TOKEN) headers.authorization = `Bearer ${env.WELCOME_AUDIO_TOKEN}`;
  const r = await fetchFn(url, { headers });
  if (!r.ok) { await r.body?.cancel(); return null; }
  const len = Number(r.headers.get("content-length") ?? "0");
  if (len > WELCOME_MAX_BYTES + 1024) { await r.body?.cancel(); return null; }
  const buf = new Uint8Array(await r.arrayBuffer());
  const ctype = (r.headers.get("content-type") ?? "").toLowerCase();
  const raw = ctype.includes("audio/pcm") || ctype.includes("audio/l16") || /\.(pcm|raw)(\?|$)/i.test(url);
  try {
    return welcomePcmFrom(buf, raw);
  } catch {
    return null;
  }
}

export function pcmStream(pcm: Uint8Array, chunk = 4096): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (off >= pcm.byteLength) return c.close();
      const k = Math.min(chunk, pcm.byteLength - off);
      c.enqueue(pcm.slice(off, off + k));
      off += k;
    },
  });
}

/**
 * Audio for the welcome: the stored clip or URL in "audio" mode, else the spoken line.
 * `storedClip` is read lazily from the registry. Throws only if TTS also fails.
 */
export async function welcomeAudio(
  env: Env,
  storedClip: () => Promise<Uint8Array | null>,
  fetchFn: FetchFn = fetch,
): Promise<ReadableStream<Uint8Array>> {
  if (welcomeMode(env) === "audio") {
    let clip: Uint8Array | null = null;
    try { clip = await storedClip(); } catch { clip = null; }
    if (!clip) {
      try { clip = await fetchWelcomeUrl(env, fetchFn); } catch { clip = null; }
    }
    if (clip && clip.byteLength) return withSilenceTail(pcmStream(clip));
  }
  return withSilenceTail(await synthesize(env, welcomeText(env), fetchFn));
}

/** Passes PCM16 through (keeping sample alignment) and appends `ms` of silence at 16 kHz. */
export function withSilenceTail(body: ReadableStream<Uint8Array>, ms = WELCOME_TAIL_MS): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let odd = 0;
  let tailSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (tailSent) return c.close();
      const { value, done } = await reader.read();
      if (!done) {
        if (value.byteLength) { odd = (odd + value.byteLength) & 1; c.enqueue(value); }
        return;
      }
      // Pad an odd byte count first so the silence starts on a sample boundary.
      const n = odd + Math.round((SR * ms) / 1000) * 2;
      if (n > 0) c.enqueue(new Uint8Array(n));
      tailSent = true;
      c.close();
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

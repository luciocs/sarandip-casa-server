// SPDX-License-Identifier: AGPL-3.0-only
// ElevenLabs streaming TTS: POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm_16000
// body {text, model_id, language_code}; body is raw s16le 16 kHz mono.
// https://elevenlabs.io/docs/api-reference/text-to-speech/stream
import type { Env } from "../env";
import { SR } from "../wav";
import { ELEVEN_BASE, type FetchFn } from "./types";

export class TtsError extends Error {}

export async function synthesize(env: Env, text: string, fetchFn: FetchFn = fetch): Promise<ReadableStream<Uint8Array>> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (env.TTS_PROVIDER === "stub") return stubSpeech(clean);
  if (!env.ELEVENLABS_API_KEY) throw new TtsError("tts key unset");
  const voice = env.ELEVENLABS_VOICE_ID;
  if (!voice || voice.startsWith("<")) throw new TtsError("voice unset");
  const models = [env.ELEVENLABS_TTS_MODEL, env.ELEVENLABS_TTS_FALLBACK_MODEL].filter(Boolean);
  let last = 0;
  for (const model_id of models) {
    const body: Record<string, string> = { text: clean, model_id };
    if (env.TTS_LANGUAGE_CODE) body.language_code = env.TTS_LANGUAGE_CODE;
    const r = await fetchFn(`${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_16000`, {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/pcm" },
      body: JSON.stringify(body),
    });
    if (r.ok && r.body) return r.body; // fallback only before the first byte
    last = r.status;
    await r.body?.cancel();
  }
  throw new TtsError(`tts http ${last}`);
}

/** Test double: 440 Hz tone, 40 ms per character (min 200 ms, max 6 s), in 4 KB chunks. */
export function stubSpeech(text: string): ReadableStream<Uint8Array> {
  const samples = Math.min(SR * 6, Math.max(SR / 5, text.length * (SR / 25)));
  const pcm = new Uint8Array(samples * 2);
  const dv = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) dv.setInt16(i * 2, Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / SR)), true);
  let off = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (off >= pcm.byteLength) return c.close();
      const k = Math.min(4096, pcm.byteLength - off);
      c.enqueue(pcm.slice(off, off + k));
      off += k;
    },
  });
}

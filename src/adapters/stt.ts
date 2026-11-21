// SPDX-License-Identifier: AGPL-3.0-only
// ElevenLabs Speech to Text: POST /v1/speech-to-text (multipart: model_id, file,
// file_format=pcm_s16le_16 for raw 16 kHz mono s16le, language_code). Response JSON has `text`.
// https://elevenlabs.io/docs/api-reference/speech-to-text/convert
import type { Env } from "../env";
import { rms } from "../wav";
import { ELEVEN_BASE, type FetchFn } from "./types";

export class SttError extends Error {}

export async function transcribe(env: Env, pcm: Uint8Array, fetchFn: FetchFn = fetch): Promise<string> {
  if (env.STT_PROVIDER === "stub") return stubTranscribe(pcm);
  if (!env.ELEVENLABS_API_KEY) throw new SttError("stt key unset");
  const form = new FormData();
  form.append("model_id", env.ELEVENLABS_STT_MODEL || "scribe_v2");
  form.append("file_format", "pcm_s16le_16");
  const lang = (env.LANGUAGE || "en").split("-")[0].toLowerCase();
  if (lang) form.append("language_code", lang);
  form.append("tag_audio_events", "false");
  form.append("file", new Blob([pcm], { type: "application/octet-stream" }), "audio.pcm");
  const r = await fetchFn(`${ELEVEN_BASE}/v1/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
    body: form,
  });
  if (!r.ok) throw new SttError(`stt http ${r.status}`);
  const j = (await r.json()) as { text?: unknown };
  return typeof j.text === "string" ? j.text.trim() : "";
}

/**
 * Test double. Audio whose first bytes are ASCII "STUB:<text>\0" transcribes to <text>;
 * near-silence transcribes to "". Only active with STT_PROVIDER=stub.
 */
export function stubTranscribe(pcm: Uint8Array): string {
  const head = new TextDecoder().decode(pcm.subarray(0, Math.min(400, pcm.byteLength)));
  if (head.startsWith("STUB:")) return head.slice(5).split("\0")[0].trim();
  return rms(pcm) < 30 ? "" : "test";
}

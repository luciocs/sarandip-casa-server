// SPDX-License-Identifier: AGPL-3.0-only
// ElevenLabs Speech to Text: POST /v1/speech-to-text (multipart: model_id, file,
// file_format=pcm_s16le_16 for raw 16 kHz mono s16le, language_code). Response JSON has `text`.
// https://elevenlabs.io/docs/api-reference/speech-to-text/convert
import type { Env } from "../env";
import { rms } from "../wav";
import { ELEVEN_BASE, type FetchFn } from "./types";

export class SttError extends Error {}

function sttDetail(body: string): string {
  // Short, non-secret hint from the provider error body (status/code/message only).
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    const detail = j.detail;
    if (typeof detail === "string") return detail.slice(0, 160);
    if (detail && typeof detail === "object") {
      const d = detail as Record<string, unknown>;
      const bits = [d.status, d.code, d.message, d.msg].filter((v) => typeof v === "string") as string[];
      if (bits.length) return bits.join(" ").slice(0, 160);
    }
    const msg = j.message ?? j.error ?? j.status;
    if (typeof msg === "string") return msg.slice(0, 160);
  } catch { /* not json */ }
  return body.replace(/\s+/g, " ").trim().slice(0, 120);
}

export async function transcribe(env: Env, pcm: Uint8Array, fetchFn: FetchFn = fetch): Promise<string> {
  if (env.STT_PROVIDER === "stub") return stubTranscribe(pcm);
  if (!env.ELEVENLABS_API_KEY) throw new SttError("stt key unset");
  const model = env.ELEVENLABS_STT_MODEL || "scribe_v2";
  const form = new FormData();
  form.append("model_id", model);
  form.append("file_format", "pcm_s16le_16");
  const lang = (env.LANGUAGE || "en").split("-")[0].toLowerCase();
  if (lang) form.append("language_code", lang);
  form.append("tag_audio_events", "false");
  form.append("file", new File([pcm], "audio.pcm", { type: "application/octet-stream" }));
  let r: Response;
  try {
    r = await fetchFn(`${ELEVEN_BASE}/v1/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
      body: form,
    });
  } catch (e) {
    console.error("stt fetch", (e as Error)?.name ?? "error", "pcm", pcm.byteLength, "model", model, "key", true);
    throw new SttError("stt fetch failed");
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error("stt http", r.status, sttDetail(body), "pcm", pcm.byteLength, "model", model, "key", true);
    throw new SttError(`stt http ${r.status}`);
  }
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

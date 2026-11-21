// SPDX-License-Identifier: AGPL-3.0-only
// POST /bloco/turn: multipart (wake + audio) or a single WAV -> STT -> fast LLM
// answer or agent hand-off -> streamed WAV (or 204).
import type { Env } from "./env";
import { transcribe } from "./adapters/stt";
import { fastAnswer } from "./adapters/llm";
import { synthesize } from "./adapters/tts";
import { buildRoutinePayload, completeNativeRoutine, isNativeRoutine, triggerRoutine } from "./adapters/routine";
import { getMemory, THEME_ASK, type MemoryStore, type MemoryResult } from "./memory";
import { localClock } from "./clock";
import { parseWav, WavError, wavHeader, SR } from "./wav";
import { publicBase } from "./config";
import { signedReplyUrl } from "./auth";
import { ackText, assistantName, deviceKind, failText } from "./i18n";
import { hub } from "./hubref";

const MAX_QUESTION_MS = 15_000;

const err = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

export function newTurnId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return "t_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function readAudio(req: Request): Promise<{ audio: Uint8Array; wake: Uint8Array | null } | Response> {
  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
  if (ctype.startsWith("multipart/form-data")) {
    let fd: FormData;
    try { fd = await req.formData(); } catch { return err(400, "bad multipart"); }
    const a = fd.get("audio");
    const w = fd.get("wake");
    if (!a || typeof a === "string") return err(400, "audio part missing");
    const wake = w && typeof w !== "string" ? new Uint8Array(await w.arrayBuffer()) : null;
    return { audio: new Uint8Array(await a.arrayBuffer()), wake };
  }
  if (ctype.startsWith("audio/wav") || ctype.startsWith("audio/x-wav")) {
    return { audio: new Uint8Array(await req.arrayBuffer()), wake: null };
  }
  return err(415, "multipart/form-data or audio/wav");
}

function speak(tts: ReadableStream<Uint8Array>, headers: Record<string, string>): Response {
  const reader = tts.getReader();
  let headerSent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (!headerSent) { headerSent = true; c.enqueue(wavHeader()); return; }
      const { value, done } = await reader.read();
      if (done) c.close();
      else c.enqueue(value);
    },
    cancel(r) { return reader.cancel(r); },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "audio/wav",
      "cache-control": "no-store",
      "x-sarandip-led": "speaking",
      "x-sarandip-sample-rate": String(SR),
      ...headers,
    },
  });
}

export async function handleTurn(req: Request, env: Env, ctx: ExecutionContext, deviceId: string, origin: string): Promise<Response> {
  const trigger = (req.headers.get("x-sarandip-trigger") ?? req.headers.get("x-bela-trigger") ?? "").toLowerCase();
  const got = await readAudio(req);
  if (got instanceof Response) return got;
  if (trigger === "wake" && !got.wake) return err(400, "wake part missing");
  let pcm: Uint8Array;
  try {
    pcm = parseWav(got.audio).pcm;
    if (got.wake) parseWav(got.wake);
  } catch (e) {
    return err(400, e instanceof WavError ? e.message : "bad wav");
  }
  if (pcm.byteLength / 2 / SR * 1000 > MAX_QUESTION_MS + 250) return err(413, "question longer than 15 s");

  const h = hub(env, deviceId);
  const store: MemoryStore = { get: (k) => h.memoryGet(k), put: (p) => h.memoryPut(p) };
  const memory: Promise<MemoryResult> = getMemory(env, store, { waitUntil: (p) => ctx.waitUntil(p) })
    .catch((): MemoryResult => ({ text: "", state: "unavailable" }));
  const text = await transcribe(env, pcm).catch((e) => {
    console.error("turn stt", (e as Error)?.message ?? "error", "pcm", pcm.byteLength);
    return null;
  });
  if (text === null) return err(502, "stt failed");
  const silent = { "x-sarandip-route": "silent" };
  if (text.replace(/[\s.,!?…]+/g, "").length < 2) {
    console.log("turn silent", "chars", text.length);
    return new Response(null, { status: 204, headers: silent });
  }
  console.log("turn transcript", text.slice(0, 300));

  const history = await h.history().catch(() => []);
  const mem = await memory;
  const clock = localClock(new Date(), env.TZ, env.LANGUAGE);
  const fast = THEME_ASK.test(text)
    ? ({ kind: "escalate", pedido: text, reason: "theme" } as const)
    : await fastAnswer(env, text, history, fetch, { clock, memory: mem.text });

  if (fast.kind === "answer") {
    console.log("turn reply", "route", "fast", fast.text.slice(0, 300));
    await h.remember(text, fast.text).catch(() => undefined);
    const tts = await synthesize(env, fast.text).catch((e) => {
      console.error("turn tts", (e as Error)?.message ?? "error");
      return null;
    });
    if (!tts) return err(502, "tts failed");
    return speak(tts, { "x-sarandip-route": "fast", "x-sarandip-late-reply": "0" });
  }

  const turnId = newTurnId();
  const now = new Date();
  const signed = await signedReplyUrl(env, publicBase(env.PUBLIC_BASE_URL, origin), turnId, deviceId, now.getTime());
  const payload = buildRoutinePayload({
    text, turnId, deviceId, pedido: fast.pedido, history,
    replyUrl: signed.reply_url, replyAuth: signed.reply_auth,
    clock: localClock(now, env.TZ, env.LANGUAGE), now,
    source: deviceKind(env), assistant: assistantName(env), language: env.LANGUAGE,
  });
  const accepted = await triggerRoutine(env, payload);
  if (accepted) await h.registerTurn(turnId, text);
  if (accepted && isNativeRoutine(env)) {
    ctx.waitUntil((async () => {
      const spoken = await completeNativeRoutine(env, payload);
      if (spoken) await h.deliverReply(turnId, spoken.slice(0, 500)).catch(() => undefined);
    })());
  }
  const sayOk = ackText(env);
  const sayFail = failText(env);
  const say = accepted ? sayOk : sayFail;
  await h.remember(text, say).catch(() => undefined);
  console.log("turn reply", "route", accepted ? "routine" : "routine_failed", "reason", fast.kind === "escalate" ? fast.reason : "", say.slice(0, 300));
  const tts = await synthesize(env, say).catch((e) => {
    console.error("turn tts", (e as Error)?.message ?? "error");
    return null;
  });
  if (!tts) return err(502, "tts failed");
  return speak(tts, {
    "x-sarandip-route": accepted ? "routine" : "routine_failed",
    ...(accepted ? { "x-sarandip-turn-id": turnId } : {}),
    "x-sarandip-late-reply": accepted ? "1" : "0",
  });
}

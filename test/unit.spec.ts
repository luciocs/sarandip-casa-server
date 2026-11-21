// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "vitest";
import { parseWav, wavHeader, guardPcmFrame, evenFrames, WavError } from "../src/wav";
import { safeEqual, hexToBytes, authDevice, authReply, sha256, bytesToHex } from "../src/auth";
import { stubTranscribe, transcribe } from "../src/adapters/stt";
import { fastAnswer, systemPrompt } from "../src/adapters/llm";
import { synthesize } from "../src/adapters/tts";
import { triggerRoutine, completeNativeRoutine } from "../src/adapters/routine";
import type { Env } from "../src/env";
import { pcm, wav, TOKEN, DEV } from "./helpers";

const baseEnv = (over: Partial<Env> = {}): Env => ({
  ASSISTANT_NAME: "Sarandip", DEVICE_KIND: "device", WAKE_WORD: "hey_jarvis", WAKE_DISPLAY: "Hey Jarvis",
  LANGUAGE: "pt-BR", TZ: "America/Sao_Paulo",
  STT_PROVIDER: "elevenlabs", ELEVENLABS_STT_MODEL: "scribe_v2", LLM_PROVIDER: "xai", XAI_MODEL: "grok-test",
  XAI_MAX_TOKENS: "160", XAI_TIMEOUT_MS: "4000", ESCALATE_MARK: "<<AGENT>>", TTS_PROVIDER: "elevenlabs",
  ELEVENLABS_TTS_MODEL: "eleven_v4_turbo", ELEVENLABS_TTS_FALLBACK_MODEL: "eleven_flash_v2_5", ELEVENLABS_VOICE_ID: "voice123",
  TTS_LANGUAGE_CODE: "pt", ROUTINE_PROVIDER: "webhook", ROUTINE_TIMEOUT_MS: "5000", ACK_TEXT: "ok", ROUTINE_FAIL_TEXT: "falhou",
  PUBLIC_BASE_URL: "", REPLY_TTL_S: "900", REPLY_RETRY_MAX: "3",
  MEMORY_ENABLED: "true", MEMORY_REPO: "luciocs/jarvis-memory-demo", MEMORY_PATH: "Agent.md", MEMORY_REF: "main",
  MEMORY_SECTIONS: "", MEMORY_MAX_CHARS: "1400", MEMORY_TTL_S: "600", MEMORY_FETCH_TIMEOUT_MS: "800",
  OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_MODEL: "gpt-4o-mini",
  ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_MODEL: "claude-sonnet-4-5",
  PAIR_RATE_MAX: "10", PAIR_RATE_WINDOW_S: "300",
  DEVICE_HUB: undefined as never, DEVICE_REGISTRY: undefined as never,
  XAI_API_KEY: "xai-k", ELEVENLABS_API_KEY: "el-k", WEBHOOK_URL: "https://hook.example/run", WEBHOOK_TOKEN: "wh-k",
  ...over,
});

type Call = { url: string; init: RequestInit };
const fakeFetch = (resp: () => Response, calls: Call[]) =>
  (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init: init ?? {} }); return resp(); }) as typeof fetch;

describe("wav", () => {
  it("parses PCM16 mono 16k and rejects others", () => {
    const p = pcm(100);
    expect(parseWav(wav(p)).pcm.byteLength).toBe(p.byteLength);
    expect(() => parseWav(wav(p, 2))).toThrow(WavError);
    expect(() => parseWav(new Uint8Array(10))).toThrow(WavError);
  });
  it("streaming header uses 0xFFFFFFFF sizes", () => {
    const dv = new DataView(wavHeader().buffer);
    expect(dv.getUint32(4, true)).toBe(0xffffffff);
    expect(dv.getUint32(40, true)).toBe(0xffffffff);
    expect(dv.getUint32(24, true)).toBe(16000);
  });
  it("guards frames that the firmware would sniff as ADPCM/S1", () => {
    expect(guardPcmFrame(new Uint8Array([0x53, 0x41, 1, 2]))[0]).toBe(0x52);
    expect(guardPcmFrame(new Uint8Array([0x53, 0x31, 1, 2]))[0]).toBe(0x52);
    expect(guardPcmFrame(new Uint8Array([0x53, 0x42, 1, 2]))[0]).toBe(0x53);
  });
  it("re-chunks into even frames", async () => {
    const src = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5)); c.enqueue(new Uint8Array(20001)); c.close(); } });
    const sizes: number[] = [];
    for await (const f of evenFrames(src, 8192)) sizes.push(f.byteLength);
    expect(sizes).toEqual([8192, 8192, 3622]);
    expect(sizes.every((s) => s % 2 === 0)).toBe(true);
  });
});

describe("auth", () => {
  it("constant-time compare and hex", () => {
    expect(safeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(safeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(safeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(hexToBytes("zz")).toBeNull();
  });
  it("device token maps to its device id; mismatched X-Device-Id is rejected", async () => {
    const env = baseEnv({ DEVICE_TOKENS: JSON.stringify({ [DEV]: bytesToHex(await sha256(TOKEN)) }) });
    const r = (h: Record<string, string>) => new Request("https://x/", { headers: h });
    expect(await authDevice(r({ "x-device-token": TOKEN }), env)).toBe(DEV);
    expect(await authDevice(r({ "x-device-token": TOKEN, "x-device-id": DEV }), env)).toBe(DEV);
    expect(await authDevice(r({ "x-device-token": TOKEN, "x-device-id": "dev_x" }), env)).toBeNull();
    expect(await authDevice(r({ "x-device-token": "nope" }), env)).toBeNull();
    expect(await authDevice(r({}), env)).toBeNull();
    expect(await authDevice(r({ "x-device-token": TOKEN }), baseEnv({ DEVICE_TOKENS: "not json" }))).toBeNull();
  });
  it("reply secret: closed when unset or short; accepts current or previous during rotation", async () => {
    const r = new Request("https://x/", { headers: { authorization: "Bearer abc" } });
    expect(await authReply(r, baseEnv({ REPLY_SECRET: "abc" }))).toBe(false);
    const current = "0123456789abcdef";
    const previous = "fedcba9876543210";
    const ok = (s: string) => new Request("https://x/", { headers: { authorization: `Bearer ${s}` } });
    expect(await authReply(ok(current), baseEnv({ REPLY_SECRET: current }))).toBe(true);
    const rotating = baseEnv({ REPLY_SECRET: current, REPLY_SECRET_PREVIOUS: previous });
    expect(await authReply(ok(current), rotating)).toBe(true);
    expect(await authReply(ok(previous), rotating)).toBe(true);
    expect(await authReply(ok("not-a-valid-secret-xx"), rotating)).toBe(false);
  });
});

describe("adapters (real request shapes, fake network)", () => {
  it("ElevenLabs STT: multipart with model_id, pcm_s16le_16, language_code, xi-api-key", async () => {
    const calls: Call[] = [];
    const t = await transcribe(baseEnv(), pcm(200), fakeFetch(() => Response.json({ text: " olá " }), calls));
    expect(t).toBe("olá");
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect((calls[0].init.headers as Record<string, string>)["xi-api-key"]).toBe("el-k");
    const fd = calls[0].init.body as FormData;
    expect(fd.get("model_id")).toBe("scribe_v2");
    expect(fd.get("file_format")).toBe("pcm_s16le_16");
    expect(fd.get("language_code")).toBe("pt");
    expect(fd.get("file")).toBeInstanceOf(File);
  });
  it("stub STT reads the STUB: prefix and treats silence as empty", () => {
    expect(stubTranscribe(pcm(100, "que horas são"))).toBe("que horas são");
    expect(stubTranscribe(new Uint8Array(3200))).toBe("");
  });
  it("xAI: chat completions body, answer and escalation mark", async () => {
    const calls: Call[] = [];
    const a = await fastAnswer(baseEnv(), "oi", [], fakeFetch(() => Response.json({ choices: [{ message: { content: "Olá!" } }] }), calls));
    expect(a).toEqual({ kind: "answer", text: "Olá!" });
    expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("grok-test");
    expect(body.max_tokens).toBe(160);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Sarandip");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer xai-k");
    const e = await fastAnswer(baseEnv(), "agenda", [], fakeFetch(() => Response.json({ choices: [{ message: { content: "<<AGENT>> ver agenda" } }] }), []));
    expect(e).toEqual({ kind: "escalate", pedido: "ver agenda", reason: "mark" });
    const f = await fastAnswer(baseEnv(), "x", [], fakeFetch(() => new Response("no", { status: 500 }), []));
    expect(f.kind).toBe("escalate");
  });
  it("English system prompt when LANGUAGE=en", () => {
    const sys = systemPrompt(baseEnv({ LANGUAGE: "en", ASSISTANT_NAME: "Sarandip" }));
    expect(sys).toMatch(/You are Sarandip/);
    expect(sys).toMatch(/Answer in English/);
    expect(sys).not.toMatch(/português do Brasil/);
  });
  it("ElevenLabs TTS: /stream?output_format=pcm_16000, fallback model on error before first byte", async () => {
    const calls: Call[] = [];
    let n = 0;
    const s = await synthesize(baseEnv(), "Olá", fakeFetch(() => (n++ === 0 ? new Response("busy", { status: 503 }) : new Response(new Uint8Array(4))), calls));
    expect(s).toBeInstanceOf(ReadableStream);
    expect(calls[0].url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice123/stream?output_format=pcm_16000");
    expect(JSON.parse(String(calls[0].init.body)).model_id).toBe("eleven_v4_turbo");
    expect(JSON.parse(String(calls[1].init.body)).model_id).toBe("eleven_flash_v2_5");
    expect(JSON.parse(String(calls[1].init.body)).language_code).toBe("pt");
  });
  it("routine webhook: Bearer + JSON, accepted on any 2xx, https only", async () => {
    const calls: Call[] = [];
    const p = { text: "t", turn_id: "t_0123456789abcdef", device_id: DEV, spoken_at: "2026-11-20T00:00:00Z", timezone: "America/Sao_Paulo", local_date: "19/11/2026", weekday: "quinta-feira", local_time: "21:00", utc_offset: "-03:00", local_datetime: "quinta-feira, 19 de novembro de 2026, 21:00", source: "device", context: "", reply_url: "https://x/bloco/reply" };
    expect(await triggerRoutine(baseEnv(), p, fakeFetch(() => Response.json({ success: true, runUuid: "r1" }), calls))).toBe(true);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer wh-k");
    expect(JSON.parse(String(calls[0].init.body)).turn_id).toBe(p.turn_id);
    expect(JSON.parse(String(calls[0].init.body)).source).toBe("device");
    expect(await triggerRoutine(baseEnv(), p, fakeFetch(() => new Response("", { status: 204 }), []))).toBe(true);
    expect(await triggerRoutine(baseEnv(), p, fakeFetch(() => Response.json({}), []))).toBe(true);
    expect(await triggerRoutine(baseEnv(), p, fakeFetch(() => new Response("", { status: 302 }), []))).toBe(false);
    expect(await triggerRoutine(baseEnv({ WEBHOOK_URL: "http://insecure" }), p, fakeFetch(() => Response.json({ success: true }), []))).toBe(false);
  });
  it("OpenAI-compatible and Anthropic connectors send the documented request shapes", async () => {
    const p = { text: "t", turn_id: "t_0123456789abcdef", device_id: DEV, spoken_at: "2026-11-20T00:00:00Z", timezone: "UTC", local_date: "2026-11-20", weekday: "Friday", local_time: "22:00", utc_offset: "+00:00", local_datetime: "Friday, 20 November 2026, 22:00", source: "device", context: "", reply_url: "https://x/bloco/reply" };
    const oai: Call[] = [];
    const envO = baseEnv({ ROUTINE_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", LANGUAGE: "en" });
    expect(await triggerRoutine(envO, p)).toBe(true);
    const ans = await completeNativeRoutine(envO, p, fakeFetch(() => Response.json({ choices: [{ message: { content: " Done. " } }] }), oai));
    expect(ans).toBe("Done.");
    expect(oai[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect((oai[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const ant: Call[] = [];
    const envA = baseEnv({ ROUTINE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "ant-test" });
    expect(await triggerRoutine(envA, p)).toBe(true);
    const ansA = await completeNativeRoutine(envA, p, fakeFetch(() => Response.json({ content: [{ type: "text", text: "Ok." }] }), ant));
    expect(ansA).toBe("Ok.");
    expect(ant[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect((ant[0].init.headers as Record<string, string>)["x-api-key"]).toBe("ant-test");
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { exports as rawExports, env as rawEnv } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { localClock } from "../src/clock";
import type { Env } from "../src/env";
import { describe, it, expect } from "vitest";
import { pcm, wav, multipart, devHeaders, waitFor, DEV, REPLY, BASE, TOKEN } from "./helpers";

const exports = rawExports as unknown as { default: { fetch(r: Request): Promise<Response> } };
const env = rawEnv as unknown as Env;

const call = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(BASE + path, init));

async function turn(text: string | null, opts: { wake?: boolean; ms?: number; channels?: number } = {}) {
  const audio = wav(text === null ? new Uint8Array(Math.round(((opts.ms ?? 500) / 1000) * 32000)) : pcm(opts.ms ?? 800, text), opts.channels ?? 1);
  const wake = opts.wake === false ? undefined : wav(pcm(600));
  const m = multipart(audio, wake);
  return call("/bloco/turn", {
    method: "POST",
    headers: devHeaders({ "content-type": m.ctype, "x-sarandip-trigger": wake ? "wake" : "button", "x-sarandip-wake-score": "0.97" }),
    body: m.body,
  });
}

type Rx = { texts: Record<string, unknown>[]; bins: Uint8Array[]; closed?: number };
async function openSocket(token = TOKEN, helloId = DEV): Promise<{ ws: WebSocket; rx: Rx; res: Response }> {
  const res = await call("/v1/devices/stream", { headers: { upgrade: "websocket", "x-device-token": token } });
  const ws = res.webSocket!;
  const rx: Rx = { texts: [], bins: [] };
  if (!ws) return { ws, rx, res };
  ws.accept();
  ws.addEventListener("message", (e: MessageEvent) => {
    if (typeof e.data === "string") rx.texts.push(JSON.parse(e.data));
    else rx.bins.push(new Uint8Array(e.data as ArrayBuffer));
  });
  ws.addEventListener("close", (e: CloseEvent) => { rx.closed = e.code; });
  ws.send(JSON.stringify({ v: 1, type: "hello", device_id: helloId, seq: 1, ts: 1, fw_version: "0.7.7-test" }));
  return { ws, rx, res };
}
const hubFor = (id: string) => env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(id));
const reply = (body: unknown, secret = REPLY) =>
  call("/bloco/reply", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("auth and config", () => {
  it("health is open, everything else needs the device token", async () => {
    const h = await call("/health");
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true, memory: "off" }); // no GITHUB_TOKEN in tests
    expect((await call("/bloco/config")).status).toBe(401);
    expect((await call("/bloco/config", { headers: { "x-device-token": "wrong" } })).status).toBe(401);
    expect((await call("/bloco/config", { headers: devHeaders({ "x-device-id": "dev_other" }) })).status).toBe(401);
  });
  it("config keeps ambient off and turns the socket on", async () => {
    const r = await call("/bloco/config", { headers: devHeaders({ "x-device-id": DEV }) });
    expect(r.status).toBe(200);
    const c = (await r.json()) as Record<string, unknown>;
    expect(c.ambient_listen).toBe("off");
    expect(c.ambient_enabled).toBe(0);
    expect(c.ws_enabled).toBe(1);
    expect(c.turn_uplink).toBe("http");
    expect(c.wake_word).toBe("hey_jarvis");
    expect(c.wake_display).toBe("Hey Jarvis");
    expect(c.ws_url).toBe("wss://casa.test/v1/devices/stream");
    expect(c).not.toHaveProperty("sarandip_base");
  });
  it("wake-log is stored and answers 204", async () => {
    const r = await call("/bloco/wake-log", {
      method: "POST", headers: devHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ keyword: "hey_jarvis", score: 0.97, max: 0.99, window: 3, fw: "0.7.7-test" }),
    });
    expect(r.status).toBe(204);
    expect(await hubFor(DEV).wakeCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /bloco/turn", () => {
  it("multipart from the firmware -> fast answer as a streaming WAV", async () => {
    const r = await turn("que horas são em Tóquio");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/wav");
    expect(r.headers.get("x-sarandip-route")).toBe("fast");
    expect(r.headers.get("x-sarandip-led")).toBe("speaking");
    const b = new Uint8Array(await r.arrayBuffer());
    expect(new TextDecoder().decode(b.subarray(0, 4))).toBe("RIFF");
    expect(new DataView(b.buffer).getUint32(40, true)).toBe(0xffffffff);
    expect(b.byteLength).toBeGreaterThan(44 + 3200);
  });
  it("silence -> 204, no body", async () => {
    const r = await turn(null);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
  });
  it("wake trigger without the wake part -> 400; stereo -> 400; > 15 s -> 413; no token -> 401", async () => {
    const m = multipart(wav(pcm(500, "oi")));
    const r = await call("/bloco/turn", { method: "POST", headers: devHeaders({ "content-type": m.ctype, "x-sarandip-trigger": "wake" }), body: m.body });
    expect(r.status).toBe(400);
    expect((await turn("oi", { channels: 2 })).status).toBe(400);
    expect((await turn("oi", { ms: 16000 })).status).toBe(413);
    expect((await call("/bloco/turn", { method: "POST", body: "x" })).status).toBe(401);
  });
  it("button turn as a single WAV works too", async () => {
    const r = await call("/bloco/turn", { method: "POST", headers: devHeaders({ "content-type": "audio/wav", "x-sarandip-trigger": "button" }), body: wav(pcm(600, "qual a capital do Peru")) });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-sarandip-route")).toBe("fast");
    await r.arrayBuffer();
  });
});

describe("WebSocket + late routine reply", () => {
  it("upgrade needs the token; hello -> hello_ack; app ping -> pong", async () => {
    const bad = await call("/v1/devices/stream", { headers: { upgrade: "websocket" } });
    expect(bad.status).toBe(401);
    const { ws, rx, res } = await openSocket();
    expect(res.status).toBe(101);
    const ack = await waitFor(() => rx.texts.find((t) => t.type === "hello_ack"));
    expect(ack.filter_version).toBe("casa-1");
    expect(ack.protocol).toBe("sarandip-ws-1");
    expect(ack.server).toBe("sarandip-casa/0.1");
    ws.send(JSON.stringify({ v: 1, type: "ping", device_id: DEV, seq: 2, ts: 2 }));
    await waitFor(() => rx.texts.find((t) => t.type === "pong"));
    ws.send('{"v":1,"type":"ping"}'); // auto-response path (no wake of the object)
    await waitFor(() => rx.texts.filter((t) => t.type === "pong").length >= 2);
    ws.close(1000, "done");
  });
  it("hello with another device id is closed 4403", async () => {
    const { rx } = await openSocket(TOKEN, "dev_other");
    expect(await waitFor(() => rx.closed)).toBe(4403);
  });
  it("routine turn: ack over HTTP, then /bloco/reply arrives over the open socket", async () => {
    const { ws, rx } = await openSocket();
    await waitFor(() => rx.texts.find((t) => t.type === "hello_ack"));
    const r = await turn("lembra de comprar pão amanhã");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-sarandip-route")).toBe("routine");
    expect(r.headers.get("x-sarandip-late-reply")).toBe("1");
    const turnId = r.headers.get("x-sarandip-turn-id")!;
    expect(turnId).toMatch(/^t_[0-9a-f]{16}$/);
    await r.arrayBuffer();

    expect((await reply({ turn_id: turnId, device_id: DEV, text: "x" }, "wrong-secret-0000000000")).status).toBe(401);
    expect((await reply({ turn_id: "t_00000000000000ff", device_id: DEV, text: "x" })).status).toBe(404);
    expect((await reply({ turn_id: turnId, device_id: DEV })).status).toBe(400);

    const ok = await reply({ turn_id: turnId, device_id: DEV, text: "Anotei: comprar pão amanhã cedo." });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("delivered");
    const start = await waitFor(() => rx.texts.find((t) => t.type === "tts_start"));
    expect(start).toMatchObject({ phase: "final", turn_id: turnId, format: "pcm_s16le", sample_rate: 16000 });
    const end = await waitFor(() => rx.texts.find((t) => t.type === "tts_end"));
    expect(end.stream).toBe(start.stream);
    expect(rx.bins.length).toBeGreaterThan(0);
    expect(rx.bins.every((b) => b.byteLength % 2 === 0 && b.byteLength <= 8192)).toBe(true);
    expect(rx.bins.some((b) => b[0] === 0x53 && (b[1] === 0x41 || b[1] === 0x31))).toBe(false);

    expect((await reply({ turn_id: turnId, device_id: DEV, text: "de novo" })).status).toBe(409);
    ws.close(1000, "done");
  });
  it("muted device -> 409; no socket -> 503; failed routine -> spoken failure, no late reply", async () => {
    const { ws, rx } = await openSocket();
    await waitFor(() => rx.texts.find((t) => t.type === "hello_ack"));
    ws.send(JSON.stringify({ v: 1, type: "mute", device_id: DEV, seq: 3, ts: 3, source: "button" }));
    const r = await turn("lembra da agenda de amanhã");
    const id = r.headers.get("x-sarandip-turn-id")!;
    await r.arrayBuffer();
    await waitFor(async () => (await hubFor(DEV).status()).muted || undefined);
    expect((await reply({ turn_id: id, device_id: DEV, text: "Amanhã nada." })).status).toBe(409);
    ws.close(1000, "done");
    await waitFor(async () => !(await hubFor(DEV).status()).online || undefined);
    expect((await reply({ turn_id: id, device_id: DEV, text: "Amanhã nada." })).status).toBe(503);

    const f = await turn("lembra de falha no agente");
    expect(f.headers.get("x-sarandip-route")).toBe("routine_failed");
    expect(f.headers.get("x-sarandip-late-reply")).toBe("0");
    await f.arrayBuffer();
  });
  it("concurrent /bloco/reply calls are serialized: streams never interleave", async () => {
    const { ws, rx } = await openSocket();
    await waitFor(() => rx.texts.find((t) => t.type === "hello_ack"));
    const ids: string[] = [];
    for (const q of ["lembra do dentista", "lembra do mercado"]) {
      const r = await turn(q);
      ids.push(r.headers.get("x-sarandip-turn-id")!);
      await r.arrayBuffer();
    }
    const rs = await Promise.all(ids.map((id, i) => reply({ turn_id: id, device_id: DEV, text: `Resposta número ${i} com algum texto.` })));
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    await waitFor(() => rx.texts.filter((t) => t.type === "tts_end").length >= 2 || undefined);
    const seq = rx.texts.filter((t) => t.type === "tts_start" || t.type === "tts_end").map((t) => `${t.type}:${t.stream}`);
    expect(seq[0].startsWith("tts_start")).toBe(true);
    expect(seq[1]).toBe(seq[0].replace("start", "end"));
    expect(seq[2].startsWith("tts_start")).toBe(true);
    expect(seq[3]).toBe(seq[2].replace("start", "end"));
    // Same reply twice at once: exactly one goes out.
    const r3 = await turn("lembra da reunião");
    const id3 = r3.headers.get("x-sarandip-turn-id")!;
    await r3.arrayBuffer();
    const dup = await Promise.all([1, 2].map(() => reply({ turn_id: id3, device_id: DEV, text: "Uma vez só." })));
    expect(dup.map((r) => r.status).sort()).toEqual([200, 409]);
    ws.close(1000, "done");
  });
  it("tts_dropped busy_turn -> resent by alarm; tts_played -> played; muted drop -> final", async () => {
    const { ws, rx } = await openSocket();
    await waitFor(() => rx.texts.find((t) => t.type === "hello_ack"));
    const r = await turn("lembra de ligar pro pedreiro");
    const id = r.headers.get("x-sarandip-turn-id")!;
    await r.arrayBuffer();
    expect((await reply({ turn_id: id, device_id: DEV, text: "Lembrete criado." })).status).toBe(200);
    const s1 = await waitFor(() => rx.texts.find((t) => t.type === "tts_start" && t.turn_id === id));
    ws.send(JSON.stringify({ v: 1, type: "tts_dropped", stream: s1.stream, turn_id: id, reason: "busy_turn" }));
    await waitFor(async () => (await hubFor(DEV).turnInfo(id))?.status === "retry" || undefined);
    expect(await runDurableObjectAlarm(hubFor(DEV))).toBe(true);
    await waitFor(() => rx.texts.filter((t) => t.type === "tts_start" && t.turn_id === id).length >= 2 || undefined);
    const s2 = rx.texts.filter((t) => t.type === "tts_start" && t.turn_id === id)[1];
    expect(s2.stream).not.toBe(s1.stream);
    expect((await hubFor(DEV).turnInfo(id))).toMatchObject({ status: "delivered", attempts: 2 });
    ws.send(JSON.stringify({ v: 1, type: "tts_played", stream: s2.stream, turn_id: id, played_ms: 900, result: "done" }));
    await waitFor(async () => (await hubFor(DEV).turnInfo(id))?.status === "played" || undefined);
    expect((await reply({ turn_id: id, device_id: DEV, text: "de novo" })).status).toBe(409);

    const r2 = await turn("lembra de pagar a conta");
    const id2 = r2.headers.get("x-sarandip-turn-id")!;
    await r2.arrayBuffer();
    await reply({ turn_id: id2, device_id: DEV, text: "Ok." });
    await waitFor(() => rx.texts.find((t) => t.type === "tts_end" && t.turn_id === id2));
    ws.send(JSON.stringify({ v: 1, type: "tts_dropped", stream: 0, turn_id: id2, reason: "muted" }));
    await waitFor(async () => (await hubFor(DEV).turnInfo(id2))?.status === "dropped" || undefined);
    ws.close(1000, "done");
  });
  it('fast turn "que dia é hoje e que horas são?" answers with the São Paulo clock of that turn', async () => {
    const tz = "America/Sao_Paulo";
    const before = localClock(new Date(), tz, "pt-BR");
    const r = await turn("que dia é hoje e que horas são?");
    expect(r.headers.get("x-sarandip-route")).toBe("fast");
    expect(r.headers.get("x-sarandip-late-reply")).toBe("0");
    await r.arrayBuffer();
    const after = localClock(new Date(), tz, "pt-BR");
    const h = await hubFor(DEV).history();
    const last = h.at(-1)!.content;
    expect([`Hoje é ${before.local_datetime}.`, `Hoje é ${after.local_datetime}.`]).toContain(last);
  });
  it("diary/theme questions escalate to the agent", async () => {
    const r = await turn("o que eu escrevi no diário ontem?");
    expect(r.headers.get("x-sarandip-route")).toBe("routine");
    await r.arrayBuffer();
  });
});

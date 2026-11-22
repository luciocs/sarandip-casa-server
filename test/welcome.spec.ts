// SPDX-License-Identifier: AGPL-3.0-only
import { exports as rawExports, env as rawEnv } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import type { Env } from "../src/env";
import { describe, it, expect } from "vitest";
import { welcomeMode, welcomeText, welcomeDelayMs, welcomePcmFrom, fetchWelcomeUrl, WelcomeError } from "../src/welcome";
import { pcm, wav, waitFor, ADMIN, BASE } from "./helpers";

const exports = rawExports as unknown as { default: { fetch(r: Request): Promise<Response> } };
const env = rawEnv as unknown as Env;
const call = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(BASE + path, init));
const adminH = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
const hubFor = (id: string) => env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(id));

// Binary frames arrive as Blob in the test runtime; keep their order with a promise chain.
type Rx = { texts: Record<string, unknown>[]; bins: Uint8Array[]; pending: Promise<void>[] };

async function pairNew(deviceId: string): Promise<string> {
  const c = (await (await call("/v1/admin/pairing-codes", { method: "POST", headers: adminH, body: "{}" })).json()) as { pairing_code: string };
  const r = await call("/v1/devices/pair", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 200)}` },
    body: JSON.stringify({ pairing_code: c.pairing_code, device_id: deviceId, fw_version: "0.1.0-test" }),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { token: string }).token;
}

async function connect(token: string, deviceId: string, muted = false): Promise<{ ws: WebSocket; rx: Rx }> {
  const res = await call("/v1/devices/stream", { headers: { upgrade: "websocket", "x-device-token": token, "x-device-id": deviceId } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const rx: Rx = { texts: [], bins: [], pending: [] };
  ws.accept();
  ws.addEventListener("message", (e: MessageEvent) => {
    if (typeof e.data === "string") rx.texts.push(JSON.parse(e.data));
    else { const i = rx.pending.length; rx.pending.push((e.data as Blob).arrayBuffer().then((b) => { rx.bins[i] = new Uint8Array(b); })); }
  });
  ws.send(JSON.stringify({ v: 1, type: "hello", device_id: deviceId, seq: 1, ts: 1, fw_version: "0.1.0-test" }));
  await waitFor(() => rx.texts.find((t) => t.type === "hello_ack"));
  if (muted) ws.send(JSON.stringify({ v: 1, type: "heartbeat", device_id: deviceId, seq: 2, ts: 2, muted: true }));
  return { ws, rx };
}

/** Runs a pending alarm (if the runtime has not fired it already) and waits for a full welcome. */
async function welcomeOn(deviceId: string, rx: Rx): Promise<{ start: Record<string, unknown>; end: Record<string, unknown>; bytes: number }> {
  await new Promise((r) => setTimeout(r, 20));
  await runDurableObjectAlarm(hubFor(deviceId));
  const end = await waitFor(() => rx.texts.find((t) => t.type === "tts_end"));
  await Promise.all(rx.pending);
  const start = rx.texts.find((t) => t.type === "tts_start")!;
  return { start, end, bytes: rx.bins.reduce((s, b) => s + b.byteLength, 0) };
}

describe("welcome config", () => {
  it("modes, default text per language, delay", () => {
    expect(welcomeMode({ WELCOME_MODE: undefined })).toBe("tts");
    expect(welcomeMode({ WELCOME_MODE: "AUDIO" })).toBe("audio");
    expect(welcomeMode({ WELCOME_MODE: "off" })).toBe("off");
    expect(welcomeMode({ WELCOME_MODE: "false" })).toBe("off");
    expect(welcomeText({ LANGUAGE: "pt-BR", WELCOME_TEXT: "" })).toBe("Boas-vindas ao seu novo Sarandip.");
    expect(welcomeText({ LANGUAGE: "en", WELCOME_TEXT: undefined })).toBe("Welcome to your new Sarandip.");
    expect(welcomeText({ LANGUAGE: "en", WELCOME_TEXT: " Olá! " })).toBe("Olá!");
    expect(welcomeDelayMs({ WELCOME_DELAY_MS: undefined })).toBe(2000);
    expect(welcomeDelayMs({ WELCOME_DELAY_MS: "0" })).toBe(0);
    expect(welcomeDelayMs({ WELCOME_DELAY_MS: "999999" })).toBe(2000);
  });
  it("clip parsing: WAV 16 kHz mono PCM16 or raw PCM; rejects others", () => {
    const p = pcm(500);
    expect(welcomePcmFrom(wav(p)).byteLength).toBe(p.byteLength);
    expect(welcomePcmFrom(p, true).byteLength).toBe(p.byteLength);
    expect(() => welcomePcmFrom(p)).toThrow(WelcomeError);
    expect(() => welcomePcmFrom(wav(p, 2))).toThrow(WelcomeError);
    expect(() => welcomePcmFrom(wav(pcm(50)))).toThrow("clip too short");
    expect(() => welcomePcmFrom(new Uint8Array(1_048_578), true)).toThrow("clip too long");
  });
  it("WELCOME_AUDIO_URL: https only, optional bearer, WAV or raw", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const f = async (u: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(u), auth: new Headers(init?.headers).get("authorization") });
      return new Response(wav(pcm(400)), { headers: { "content-type": "audio/wav" } });
    };
    const e = { ...env, WELCOME_AUDIO_URL: "https://assets.example/w.wav", WELCOME_AUDIO_TOKEN: "tok-tok-tok" } as Env;
    expect((await fetchWelcomeUrl(e, f))!.byteLength).toBe(400 * 32);
    expect(seen[0]).toEqual({ url: "https://assets.example/w.wav", auth: "Bearer tok-tok-tok" });
    expect(await fetchWelcomeUrl({ ...env, WELCOME_AUDIO_URL: "http://insecure.example/w.wav" } as Env, f)).toBeNull();
    const bad = async () => new Response("nope", { status: 404 });
    expect(await fetchWelcomeUrl(e, bad)).toBeNull();
  });
});

describe("welcome admin clip", () => {
  it("is admin only, validates format, reports metadata only", async () => {
    expect((await call("/v1/admin/welcome-audio", { method: "PUT", body: wav(pcm(300)) })).status).toBe(401);
    const bad = await call("/v1/admin/welcome-audio", { method: "PUT", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "audio/wav" }, body: wav(pcm(300), 2) });
    expect(bad.status).toBe(400);
    const big = await call("/v1/admin/welcome-audio", { method: "PUT", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "audio/pcm" }, body: new Uint8Array(1_100_000) });
    expect(big.status).toBe(413);
    const info0 = (await (await call("/v1/admin/welcome-audio", { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { present: boolean };
    expect(info0.present).toBe(false);
  });
});

describe("welcome on first connection after pairing", () => {
  it("speaks the fallback line once when no clip is stored; not again on reconnect", async () => {
    const id = "dev_welcome_tts";
    const token = await pairNew(id);
    const { ws, rx } = await connect(token, id);
    const w = await welcomeOn(id, rx);
    expect(w.start).toMatchObject({ format: "pcm_s16le", sample_rate: 16000, phase: "final" });
    expect(String(w.start.turn_id)).toMatch(/^t_[0-9a-f]{16}$/);
    expect(w.end.turn_id).toBe(w.start.turn_id);
    expect(w.bytes).toBeGreaterThan(0);
    expect(rx.bins.every((b) => b.byteLength <= 8192 && b.byteLength % 2 === 0)).toBe(true);
    ws.send(JSON.stringify({ v: 1, type: "tts_played", stream: w.start.stream, turn_id: w.start.turn_id, played_ms: 900, result: "done" }));
    await waitFor(async () => (await hubFor(id).turnInfo(String(w.start.turn_id)))?.status === "played" || undefined);
    expect((await hubFor(id).welcomeInfo()).state).toMatch(/^done:/);
    ws.close(1000, "done");

    const again = await connect(token, id);
    await new Promise((r) => setTimeout(r, 50));
    await runDurableObjectAlarm(hubFor(id));
    await new Promise((r) => setTimeout(r, 50));
    expect(again.rx.texts.some((t) => t.type === "tts_start")).toBe(false);
    again.ws.close(1000, "done");
  });

  it("plays the uploaded clip byte-exact; muted waits for unmute; admin re-arm plays again", async () => {
    const clip = pcm(700, undefined, 1234);
    const put = await call("/v1/admin/welcome-audio", { method: "PUT", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "audio/wav" }, body: wav(clip) });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ stored: true, bytes: clip.byteLength, audio_ms: 700 });

    const id = "dev_welcome_clip";
    const token = await pairNew(id);
    const { ws, rx } = await connect(token, id, true);
    await new Promise((r) => setTimeout(r, 30));
    await runDurableObjectAlarm(hubFor(id));
    await new Promise((r) => setTimeout(r, 30));
    expect(rx.texts.some((t) => t.type === "tts_start")).toBe(false);
    expect((await hubFor(id).welcomeInfo()).state).toBe("armed");

    ws.send(JSON.stringify({ v: 1, type: "unmute", device_id: id, seq: 3, ts: 3 }));
    const w = await welcomeOn(id, rx);
    const got = new Uint8Array(w.bytes);
    let off = 0;
    for (const b of rx.bins) { got.set(b, off); off += b.byteLength; }
    expect(got.byteLength).toBe(clip.byteLength);
    // guardPcmFrame may nudge the first byte of a frame; everything else is byte-exact.
    let diff = 0;
    for (let i = 0; i < clip.byteLength; i++) if (got[i] !== clip[i]) diff++;
    expect(diff).toBeLessThanOrEqual(Math.ceil(clip.byteLength / 8192));
    expect(w.end.audio_ms).toBe(700);

    expect((await call("/v1/admin/devices/welcome", { method: "POST", body: JSON.stringify({ device_id: id }) })).status).toBe(401);
    const re = await call("/v1/admin/devices/welcome", { method: "POST", headers: adminH, body: JSON.stringify({ device_id: id }) });
    expect(await re.json()).toMatchObject({ device_id: id, armed: true, online: true });
    await new Promise((r) => setTimeout(r, 20));
    await runDurableObjectAlarm(hubFor(id));
    await waitFor(() => rx.texts.filter((t) => t.type === "tts_end").length >= 2 || undefined);
    ws.close(1000, "done");

    const info = (await (await call("/v1/admin/welcome-audio", { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ present: true, bytes: clip.byteLength, audio_ms: 700 });
    expect(Object.keys(info)).not.toContain("pcm");
    expect((await (await call("/v1/admin/welcome-audio", { method: "DELETE", headers: { authorization: `Bearer ${ADMIN}` } })).json())).toEqual({ deleted: true });
  });

  it("re-pairing closes a leftover socket instead of sending the welcome into it (welcome lost after a reset)", async () => {
    const id = "dev_welcome_stale";
    const token1 = await pairNew(id);
    const first = await connect(token1, id);
    const w1 = await welcomeOn(id, first.rx);
    first.ws.send(JSON.stringify({ v: 1, type: "tts_played", stream: w1.start.stream, turn_id: w1.start.turn_id, played_ms: 900, result: "done" }));
    await waitFor(async () => (await hubFor(id).welcomeInfo()).state.startsWith("done:") || undefined);

    // Factory reset + setup portal: the old socket is never closed by the device (half-open on the edge).
    const closed = new Promise<number>((r) => first.ws.addEventListener("close", (e: CloseEvent) => r(e.code)));
    const startsBefore = first.rx.texts.filter((t) => t.type === "tts_start").length;
    const token2 = await pairNew(id);
    expect(await closed).toBe(4000);
    expect((await hubFor(id).welcomeInfo()).state).toBe("armed");
    expect((await hubFor(id).status()).online).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    await runDurableObjectAlarm(hubFor(id));
    expect(first.rx.texts.filter((t) => t.type === "tts_start").length).toBe(startsBefore);

    // The device's real first connection after setup gets the welcome.
    const second = await connect(token2, id);
    const w2 = await welcomeOn(id, second.rx);
    expect(w2.bytes).toBeGreaterThan(0);
    expect(w2.start.turn_id).not.toBe(w1.start.turn_id);
    second.ws.send(JSON.stringify({ v: 1, type: "tts_played", stream: w2.start.stream, turn_id: w2.start.turn_id, played_ms: 900, result: "done" }));
    await waitFor(async () => (await hubFor(id).welcomeInfo()).state === `done:${w2.start.turn_id}` || undefined);
    second.ws.close(1000, "done");
  });

  it("an unconfirmed welcome is sent again on the next hello, at most 3 times per pairing", async () => {
    const id = "dev_welcome_noack";
    const token = await pairNew(id);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await connect(token, id);
      await new Promise((r) => setTimeout(r, 20));
      await runDurableObjectAlarm(hubFor(id));
      await new Promise((r) => setTimeout(r, 50));
      await Promise.all(c.rx.pending);
      const st = c.rx.texts.find((t) => t.type === "tts_start");
      if (st) {
        await waitFor(() => c.rx.texts.find((t) => t.type === "tts_end"));
        ids.push(String(st.turn_id));
      }
      c.ws.close(1000, "no ack"); // never sends tts_played
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);
    expect((await hubFor(id).turnInfo(ids[0]))).toMatchObject({ status: "dropped", result: "no_ack" });
    expect((await hubFor(id).welcomeInfo()).state).toBe(`done:${ids[2]}`);
  });

  it("a welcome dropped as muted by the device is armed again", async () => {
    const id = "dev_welcome_dropmuted";
    const token = await pairNew(id);
    const { ws, rx } = await connect(token, id);
    const w = await welcomeOn(id, rx);
    ws.send(JSON.stringify({ v: 1, type: "tts_dropped", stream: w.start.stream, turn_id: w.start.turn_id, reason: "muted" }));
    await waitFor(async () => (await hubFor(id).welcomeInfo()).state === "armed" || undefined);
    ws.close(1000, "done");
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// One Durable Object per device (idFromName(device_id)), SQLite-backed.
// Holds the device's outbound WebSocket (Hibernation API), the pending routine
// turns, a short conversation history, the wake log and the memory cache (L2).
//
// Late replies: one at a time (promise chain), so two /bloco/reply calls never
// interleave frames. Turn status: pending -> sending -> delivered (sent, waiting
// for tts_played) -> played | retry (tts_dropped busy_turn, resent by alarm) | dropped.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { num } from "./env";
import { synthesize } from "./adapters/tts";
import type { Turn } from "./adapters/llm";
import { evenFrames, guardPcmFrame, pcmMs, SR } from "./wav";
import type { MemoryPack } from "./memory";
import { welcomeAudio, welcomeDelayMs, welcomeMode } from "./welcome";
import { registry } from "./registryref";

export const WS_FRAME_BYTES = 8192; // 256 ms of PCM16 16 kHz; device cap TTS_BIN_MAX is 32768
export const WS_MAX_IN = 64 * 1024; // control JSON from the device is < 1 KB
const HISTORY_KEEP = 8;
export const RETRY_DELAYS_MS = [10_000, 20_000, 30_000]; // after tts_dropped busy_turn

interface Attach {
  deviceId: string;
  hello: boolean;
  muted: boolean;
  fw: string;
  since: number;
  lastHb: number;
}

export type DeliverStatus = "delivered" | "offline" | "muted" | "unknown_turn" | "expired" | "already_delivered" | "tts_error";

export class DeviceHub extends DurableObject<Env> {
  private sql: SqlStorage;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS turns(
      turn_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', delivered_ms INTEGER, bytes INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS history(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wake_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, keyword TEXT, score REAL, max REAL, win INTEGER, fw TEXT)`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const cols = new Set(this.sql.exec("PRAGMA table_info(turns)").toArray().map((r) => String(r.name)));
    for (const [c, def] of [["kind", "TEXT"], ["reply_text", "TEXT"], ["attempts", "INTEGER NOT NULL DEFAULT 0"], ["stream", "INTEGER"], ["played_ms", "INTEGER"], ["result", "TEXT"]]) {
      if (!cols.has(c)) this.sql.exec(`ALTER TABLE turns ADD COLUMN ${c} ${def}`);
    }
    // Bare app ping is answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"v":1,"type":"ping"}', '{"v":1,"type":"pong"}'));
  }

  // ---------- WebSocket ----------
  async fetch(req: Request): Promise<Response> {
    const deviceId = req.headers.get("x-sarandip-device") ?? "";
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !deviceId) return new Response("bad upgrade", { status: 400 });
    for (const old of this.ctx.getWebSockets()) {
      try { old.close(4000, "replaced"); } catch { /* already closed */ }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [deviceId]);
    const a: Attach = { deviceId, hello: false, muted: false, fw: "", since: Date.now(), lastHb: Date.now() };
    server.serializeAttachment(a);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== "string") {
      // Turn uplink over the socket is not part of this protocol (turns are POST /bloco/turn).
      this.send(ws, { v: 1, type: "error", code: "binary_unsupported" });
      return;
    }
    if (msg.length > WS_MAX_IN) { ws.close(1009, "too big"); return; }
    let j: Record<string, unknown>;
    try { j = JSON.parse(msg); } catch { this.send(ws, { v: 1, type: "error", code: "bad_json" }); return; }
    const a = (ws.deserializeAttachment() as Attach) ?? null;
    if (!a) { ws.close(1011, "state"); return; }
    const type = String(j.type ?? "");
    if (type === "hello") {
      const claimed = typeof j.device_id === "string" ? j.device_id : "";
      if (claimed && claimed !== a.deviceId) { ws.close(4403, "device id mismatch"); return; }
      a.hello = true;
      a.fw = String(j.fw_version ?? "").slice(0, 40);
      ws.serializeAttachment(a);
      // Hello stays backward compatible: protocol is optional. The current name is
      // advertised here; the legacy alias is still accepted if a client sends it.
      this.send(ws, { v: 1, type: "hello_ack", session_id: crypto.randomUUID(), filter_version: "casa-1", server: "sarandip-casa/0.1", protocol: "sarandip-ws-1", reply_audio: "pcm_s16le_16000" });
      await this.scheduleWelcome();
      return;
    }
    if (!a.hello) { ws.close(4400, "hello first"); return; }
    if (type === "ping") { this.send(ws, { v: 1, type: "pong" }); return; }
    if (type === "pong") return;
    if (type === "heartbeat") {
      const was = a.muted;
      a.lastHb = Date.now();
      if (typeof j.muted === "boolean") a.muted = j.muted;
      ws.serializeAttachment(a);
      if (was && !a.muted) await this.scheduleWelcome();
      return;
    }
    if (type === "mute" || type === "unmute") {
      a.muted = type === "mute";
      ws.serializeAttachment(a);
      if (!a.muted) await this.scheduleWelcome();
      return;
    }
    if (type === "tts_played" || type === "tts_dropped") {
      const turnId = typeof j.turn_id === "string" ? j.turn_id : "";
      if (/^t_[0-9a-f]{16,32}$/.test(turnId)) await this.serial(() => this.onDeviceResult(type, turnId, String(j.result ?? j.reason ?? "")));
      return;
    }
    // Unknown control: ignored (forward compatible).
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch { /* closed */ }
  }

  async webSocketError(): Promise<void> {}

  private send(ws: WebSocket, obj: unknown): void {
    try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ }
  }

  private socket(): { ws: WebSocket; a: Attach } | null {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attach | null;
      if (a?.hello && ws.readyState === WebSocket.OPEN) return { ws, a };
    }
    return null;
  }

  // ---------- RPC from the Worker ----------
  async status(): Promise<{ online: boolean; muted: boolean; fw: string; pending: number }> {
    const s = this.socket();
    const pending = this.sql.exec("SELECT COUNT(*) AS n FROM turns WHERE status='pending'").one().n as number;
    return { online: !!s, muted: !!s?.a.muted, fw: s?.a.fw ?? "", pending };
  }

  async history(): Promise<Turn[]> {
    const rows = this.sql.exec("SELECT role, content FROM history ORDER BY id DESC LIMIT ?", HISTORY_KEEP).toArray();
    return rows.reverse().map((r) => ({ role: r.role as Turn["role"], content: String(r.content) }));
  }

  async remember(user: string, assistant: string): Promise<void> {
    const now = Date.now();
    if (user) this.sql.exec("INSERT INTO history(ts, role, content) VALUES (?, 'user', ?)", now, user.slice(0, 300));
    if (assistant) this.sql.exec("INSERT INTO history(ts, role, content) VALUES (?, 'assistant', ?)", now, assistant.slice(0, 300));
    this.sql.exec("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ?)", HISTORY_KEEP);
  }

  async registerTurn(turnId: string, text: string): Promise<void> {
    const ttl = num(this.env.REPLY_TTL_S, 900) * 1000;
    this.sql.exec("DELETE FROM turns WHERE created_ms < ?", Date.now() - 24 * 3600 * 1000 - ttl);
    this.sql.exec("INSERT OR REPLACE INTO turns(turn_id, created_ms, text) VALUES (?, ?, ?)", turnId, Date.now(), text.slice(0, 300));
  }

  async logWake(e: { keyword: string; score: number; max: number; window: number; fw: string }): Promise<void> {
    this.sql.exec("INSERT INTO wake_log(ts, keyword, score, max, win, fw) VALUES (?, ?, ?, ?, ?, ?)",
      Date.now(), e.keyword.slice(0, 40), e.score, e.max, e.window, e.fw.slice(0, 40));
    this.sql.exec("DELETE FROM wake_log WHERE id NOT IN (SELECT id FROM wake_log ORDER BY id DESC LIMIT 2000)");
  }

  async wakeCount(): Promise<number> {
    return this.sql.exec("SELECT COUNT(*) AS n FROM wake_log").one().n as number;
  }

  /** Recent wake-log rows, remembered turns and late-reply turn records. Admin diagnostics only. */
  async activity(limit = 50): Promise<{
    wake: { ts: number; keyword: string; score: number; max: number; window: number; fw: string }[];
    history: { ts: number; role: string; content: string }[];
    turns: { turn_id: string; created_ms: number; text: string; status: string }[];
  }> {
    const n = Math.min(200, Math.max(1, Math.floor(limit)));
    const wake = this.sql.exec("SELECT ts, keyword, score, max, win, fw FROM wake_log ORDER BY id DESC LIMIT ?", n).toArray()
      .map((r) => ({ ts: Number(r.ts), keyword: String(r.keyword ?? ""), score: Number(r.score), max: Number(r.max), window: Number(r.win), fw: String(r.fw ?? "") }));
    const history = this.sql.exec("SELECT ts, role, content FROM history ORDER BY id DESC LIMIT ?", n).toArray()
      .map((r) => ({ ts: Number(r.ts), role: String(r.role), content: String(r.content ?? "") }));
    const turns = this.sql.exec("SELECT turn_id, created_ms, text, status FROM turns ORDER BY created_ms DESC LIMIT ?", n).toArray()
      .map((r) => ({ turn_id: String(r.turn_id), created_ms: Number(r.created_ms), text: String(r.text ?? ""), status: String(r.status ?? "") }));
    return { wake, history, turns };
  }

  /** Delivery state of one turn (no text). */
  async turnInfo(turnId: string): Promise<{ status: string; attempts: number; result: string | null } | null> {
    const r = this.sql.exec("SELECT status, attempts, result FROM turns WHERE turn_id = ?", turnId).toArray()[0];
    return r ? { status: String(r.status), attempts: r.attempts as number, result: (r.result as string | null) ?? null } : null;
  }

  // ---------- memory cache (L2, survives isolate recycling) ----------
  async memoryGet(key: string): Promise<MemoryPack | null> {
    const r = this.sql.exec("SELECT v FROM kv WHERE k = 'memory'").toArray()[0];
    if (!r) return null;
    try {
      const p = JSON.parse(String(r.v)) as MemoryPack;
      return p.key === key ? p : null;
    } catch {
      return null;
    }
  }

  async memoryPut(p: MemoryPack): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO kv(k, v) VALUES ('memory', ?)", JSON.stringify(p));
  }

  // ---------- welcome (once per pairing) ----------
  private welcomeState(): string {
    const r = this.sql.exec("SELECT v FROM kv WHERE k = 'welcome'").toArray()[0];
    return r ? String(r.v) : "";
  }

  private setWelcomeState(v: string): void {
    this.sql.exec("INSERT OR REPLACE INTO kv(k, v) VALUES ('welcome', ?)", v);
  }

  /** Called by the Worker right after a successful pairing (or by the admin re-arm route). */
  async armWelcome(): Promise<{ armed: boolean; online: boolean }> {
    if (welcomeMode(this.env) === "off") return { armed: false, online: !!this.socket() };
    this.setWelcomeState("armed");
    const online = !!this.socket();
    if (online) await this.scheduleWelcome();
    return { armed: true, online };
  }

  async welcomeInfo(): Promise<{ state: string; mode: string }> {
    return { state: this.welcomeState() || "none", mode: welcomeMode(this.env) };
  }

  /** After hello or unmute: if a welcome is armed, play it shortly (alarm), so hello_ack is never delayed. */
  private async scheduleWelcome(): Promise<void> {
    if (this.welcomeState() !== "armed" || welcomeMode(this.env) === "off") return;
    const at = Date.now() + welcomeDelayMs(this.env);
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  private welcomeStream(): Promise<ReadableStream<Uint8Array>> {
    return welcomeAudio(this.env, () => registry(this.env).welcomeClipGet());
  }

  /** Caller holds the chain. Offline or muted: stays armed (next hello / unmute). Delivered: done. */
  private async sendWelcome(): Promise<DeliverStatus | "off"> {
    if (welcomeMode(this.env) === "off") { this.setWelcomeState("off"); return "off"; }
    const s = this.socket();
    if (!s) return "offline";
    if (s.a.muted) return "muted";
    const hex = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const turnId = `t_${hex}`;
    this.sql.exec("INSERT INTO turns(turn_id, created_ms, text, kind) VALUES (?, ?, '', 'welcome')", turnId, Date.now());
    const r = await this.push(turnId, () => this.welcomeStream());
    if (r.status === "delivered") this.setWelcomeState(`done:${turnId}`);
    else this.sql.exec("DELETE FROM turns WHERE turn_id = ? AND status = 'pending'", turnId);
    return r.status;
  }

  // ---------- late replies ----------
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private ttlMs(): number {
    return num(this.env.REPLY_TTL_S, 900) * 1000;
  }

  private nextStream(): number {
    const r = this.sql.exec("SELECT v FROM kv WHERE k = 'stream_seq'").toArray()[0];
    const base = r ? Number(r.v) : (this.sql.exec("SELECT COUNT(*) AS n FROM turns WHERE stream IS NOT NULL OR status='delivered'").one().n as number);
    const n = base + 1;
    this.sql.exec("INSERT OR REPLACE INTO kv(k, v) VALUES ('stream_seq', ?)", String(n));
    return n;
  }

  /** Late routine reply: TTS, then tts_start / binary PCM frames / tts_end on the open socket. Serialized. */
  async deliverReply(turnId: string, text: string): Promise<{ status: DeliverStatus; audio_ms?: number }> {
    return this.serial(async () => {
      const row = this.sql.exec("SELECT created_ms, status FROM turns WHERE turn_id = ?", turnId).toArray()[0];
      if (!row) return { status: "unknown_turn" as const };
      if (row.status !== "pending") return { status: "already_delivered" as const };
      if (Date.now() - (row.created_ms as number) > this.ttlMs()) return { status: "expired" as const };
      this.sql.exec("UPDATE turns SET reply_text = ? WHERE turn_id = ?", text, turnId);
      const r = await this.push(turnId, () => synthesize(this.env, text));
      if (r.status === "delivered") await this.remember("", text).catch(() => undefined);
      return r;
    });
  }

  /** Sends one reply on the socket. Caller holds the chain. Offline/muted/tts_error leave the status as it was. */
  private async push(turnId: string, audio: () => Promise<ReadableStream<Uint8Array>>): Promise<{ status: DeliverStatus; audio_ms?: number }> {
    const s = this.socket();
    if (!s) return { status: "offline" };
    if (s.a.muted) return { status: "muted" };
    const prev = String(this.sql.exec("SELECT status FROM turns WHERE turn_id = ?", turnId).one().status);
    this.sql.exec("UPDATE turns SET status='sending' WHERE turn_id=?", turnId);
    let body: ReadableStream<Uint8Array>;
    try {
      body = await audio();
    } catch {
      this.sql.exec("UPDATE turns SET status=? WHERE turn_id=?", prev, turnId);
      return { status: "tts_error" };
    }
    const stream = this.nextStream();
    this.send(s.ws, { v: 1, type: "tts_start", stream, phase: "final", turn_id: turnId, format: "pcm_s16le", sample_rate: SR });
    let bytes = 0;
    try {
      for await (const f of evenFrames(body, WS_FRAME_BYTES)) {
        s.ws.send(guardPcmFrame(f));
        bytes += f.byteLength;
      }
    } catch {
      /* socket closed mid-stream: tts_end below is best effort */
    }
    this.send(s.ws, { v: 1, type: "tts_end", stream, phase: "final", turn_id: turnId, audio_ms: pcmMs(bytes) });
    this.sql.exec("UPDATE turns SET status='delivered', delivered_ms=?, bytes=?, stream=?, attempts=attempts+1 WHERE turn_id=?",
      Date.now(), bytes, stream, turnId);
    return { status: "delivered", audio_ms: pcmMs(bytes) };
  }

  private async onDeviceResult(type: string, turnId: string, why: string): Promise<void> {
    const row = this.sql.exec("SELECT created_ms, status, attempts FROM turns WHERE turn_id = ?", turnId).toArray()[0];
    if (!row || row.status !== "delivered") return;
    if (type === "tts_played") {
      // Played (done/button/muted/timeout): final. The reply text is no longer needed.
      this.sql.exec("UPDATE turns SET status='played', played_ms=?, result=?, reply_text=NULL WHERE turn_id=?", Date.now(), why.slice(0, 20), turnId);
      return;
    }
    const attempts = row.attempts as number;
    const max = Math.min(num(this.env.REPLY_RETRY_MAX, 3), RETRY_DELAYS_MS.length);
    const at = Date.now() + (RETRY_DELAYS_MS[Math.max(0, attempts - 1)] ?? RETRY_DELAYS_MS[0]);
    if (why === "busy_turn" && attempts <= max && at - (row.created_ms as number) < this.ttlMs()) {
      this.sql.exec("UPDATE turns SET status='retry', result=? WHERE turn_id=?", why, turnId);
      const cur = await this.ctx.storage.getAlarm();
      if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
      return;
    }
    // muted, format, or out of attempts/TTL: give up.
    this.sql.exec("UPDATE turns SET status='dropped', result=?, reply_text=NULL WHERE turn_id=?", why.slice(0, 20), turnId);
  }

  /** Resends replies the device dropped because it was busy with a turn. */
  async alarm(): Promise<void> {
    await this.serial(async () => {
      const rows = this.sql.exec("SELECT turn_id, created_ms, reply_text, kind FROM turns WHERE status='retry' ORDER BY created_ms").toArray();
      let again = false;
      for (const r of rows) {
        const id = String(r.turn_id);
        const isWelcome = r.kind === "welcome";
        if (Date.now() - (r.created_ms as number) > this.ttlMs() || (!r.reply_text && !isWelcome)) {
          this.sql.exec("UPDATE turns SET status='dropped', result='expired', reply_text=NULL WHERE turn_id=?", id);
          continue;
        }
        const res = await this.push(id, isWelcome ? () => this.welcomeStream() : () => synthesize(this.env, String(r.reply_text)));
        if (res.status !== "delivered") again = true; // offline/muted/tts_error: stays 'retry'
      }
      if (this.welcomeState() === "armed") {
        // Offline, muted or audio failure: stays armed and is tried again on the next hello / unmute.
        await this.sendWelcome();
      }
      if (again) await this.ctx.storage.setAlarm(Date.now() + RETRY_DELAYS_MS[1]);
    });
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Sarandip Casa voice server: Cloudflare Worker + Durable Objects.
// Contract: PROTOCOL.md. Pairing contract in that document is frozen.
import type { Env } from "./env";
import { authAdmin, authDevice, authReply } from "./auth";
import { handleTurn } from "./turn";
import { hub } from "./hubref";
import { registry } from "./registryref";
import { memoryConfigured } from "./memory";
import { clampTtl, clientKey } from "./registry";
import { PROTOCOL, publicBase, wsUrl } from "./config";
import { resolveTz } from "./clock";
import { WELCOME_MAX_BYTES, WelcomeError, welcomePcmFrom } from "./welcome";
import {
  adminFirmware, adminFirmwareAssign, adminFirmwarePush, adminFirmwareStatus,
  deviceOta, deviceOtaImage, deviceOtaStatus,
} from "./firmware";

export { DeviceHub } from "./hub";
export { DeviceRegistry } from "./registry";
export { FirmwareStore } from "./firmware";

const MAX_TURN_BYTES = 1_048_576;

const json = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

export function deviceConfig(env: Env, origin: string) {
  const base = publicBase(env.PUBLIC_BASE_URL, origin);
  return {
    backend: "sarandip",
    wake_word: env.WAKE_WORD,
    wake_display: env.WAKE_DISPLAY,
    sample_rate: 16000,
    channels: 1,
    bits: 16,
    turn_url: `${base}/bloco/turn`,
    wake_log_url: `${base}/bloco/wake-log`,
    ws_url: wsUrl(base),
    token_header: "X-Device-Token",
    device_id_header: "X-Device-Id",
    auth_required: true,
    ws_enabled: 1,
    ws_mute_events: 1,
    ws_wake: 0,
    turn_uplink: "http",
    ambient_listen: "off",
    ambient_enabled: 0,
    follow_up_enabled: false,
    barge_in: "off",
    late_reply: "ws",
    reply_audio: { format: "pcm_s16le", sample_rate: 16000, frame_bytes: 8192 },
    protocol: PROTOCOL,
    tz: resolveTz(env.TZ),
    ota_auto: "on",
    ota_url: `${base}/bloco/ota`,
  };
}

async function issuePairingCode(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST" && req.method !== "DELETE") return json({ error: "method" }, 405);
  if (!(await authAdmin(req, env))) return json({ error: "unauthorized" }, 401);

  if (req.method === "DELETE") {
    let b: { device_id?: unknown; pairing_code?: unknown };
    try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    const deviceId = typeof b.device_id === "string" ? b.device_id : undefined;
    const code = typeof b.pairing_code === "string" ? b.pairing_code : undefined;
    if (!deviceId && !code) return json({ error: "bad_request" }, 400);
    const r = await registry(env).revokeClaimCode({ deviceId, code });
    return json({ revoked: r.revoked, device_id: r.device_id }, r.revoked ? 200 : 404);
  }

  let ttl: unknown = undefined;
  let permanent = false;
  let deviceId: string | undefined;
  const ctype = req.headers.get("content-type") ?? "";
  if (req.headers.get("content-length") && !ctype) return json({ error: "bad_json" }, 400);
  if (ctype.includes("application/json")) {
    try {
      const b = (await req.json()) as { ttl_s?: unknown; permanent?: unknown; device_id?: unknown };
      ttl = b.ttl_s;
      permanent = b.permanent === true;
      if (typeof b.device_id === "string") deviceId = b.device_id;
    } catch {
      return json({ error: "bad_json" }, 400);
    }
  }
  if (permanent) {
    if (!deviceId || !/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return json({ error: "bad_request" }, 400);
    return json(await registry(env).issueClaimCode(deviceId));
  }
  const issued = await registry(env).issueCode(clampTtl(ttl));
  return json(issued);
}

async function pairDevice(req: Request, env: Env, origin: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let b: { pairing_code?: unknown; device_id?: unknown; fw_version?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const pairingCode = typeof b.pairing_code === "string" ? b.pairing_code : "";
  const deviceId = typeof b.device_id === "string" ? b.device_id : "";
  const fw = typeof b.fw_version === "string" ? b.fw_version : "";
  if (!pairingCode || !deviceId) return json({ error: "bad_request" }, 400);
  const r = await registry(env).pair(pairingCode, deviceId, fw, clientKey(req));
  if (!r.ok) {
    const status = r.error === "unknown_code" ? 404 : r.error === "rate_limited" ? 429 : r.error === "bad_request" ? 400 : 410;
    const extra: Record<string, string> = {};
    if (r.retry_after_s) extra["retry-after"] = String(r.retry_after_s);
    return json({ error: r.error }, status, extra);
  }
  // Welcome audio on the first WebSocket session after this pairing. Never blocks pairing.
  try { await hub(env, r.device_id).armWelcome(); } catch { /* best effort */ }
  const base = publicBase(env.PUBLIC_BASE_URL, origin);
  return json({
    device_id: r.device_id,
    token: r.token,
    base_url: base,
    ws_url: wsUrl(base),
    tz: resolveTz(env.TZ),
  });
}

async function revokeDevice(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!(await authAdmin(req, env))) return json({ error: "unauthorized" }, 401);
  let b: { device_id?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const deviceId = typeof b.device_id === "string" ? b.device_id : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return json({ error: "bad_request" }, 400);
  const ok = await registry(env).revoke(deviceId);
  return json({ revoked: ok, device_id: deviceId }, ok ? 200 : 404);
}

/** PUT a WAV (PCM16 mono 16 kHz, <= 1 MiB) / GET metadata only / DELETE. Admin only. The clip is never served back. */
async function welcomeAudioAdmin(req: Request, env: Env): Promise<Response> {
  if (!(await authAdmin(req, env))) return json({ error: "unauthorized" }, 401);
  const reg = registry(env);
  if (req.method === "GET") {
    const i = await reg.welcomeClipInfo();
    return json({ present: i.present, bytes: i.bytes, audio_ms: Math.round(i.bytes / 32), updated_at: i.updated_ms ? new Date(i.updated_ms).toISOString() : null });
  }
  if (req.method === "DELETE") return json({ deleted: await reg.welcomeClipDelete() });
  if (req.method !== "PUT" && req.method !== "POST") return json({ error: "method" }, 405);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > WELCOME_MAX_BYTES + 1024) return json({ error: "too large" }, 413);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > WELCOME_MAX_BYTES + 1024) return json({ error: "too large" }, 413);
  const ctype = (req.headers.get("content-type") ?? "").toLowerCase();
  let pcm: Uint8Array;
  try {
    pcm = welcomePcmFrom(buf, ctype.includes("audio/pcm") || ctype.includes("audio/l16"));
  } catch (e) {
    const msg = e instanceof WelcomeError ? e.message : "bad audio";
    return json({ error: "bad_audio", detail: msg }, msg === "clip too long" ? 413 : 400);
  }
  const r = await reg.welcomeClipPut(pcm);
  return json({ stored: true, bytes: r.bytes, audio_ms: Math.round(r.bytes / 32) });
}


async function deviceActivity(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method" }, 405);
  if (!(await authAdmin(req, env))) return json({ error: "unauthorized" }, 401);
  const deviceId = new URL(req.url).searchParams.get("device_id") ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return json({ error: "bad_request" }, 400);
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "80");
  return json({ device_id: deviceId, ...(await hub(env, deviceId).activity(limit)) });
}

/** Re-arm the welcome for one device (plays now if it is online, else on its next connection). */
async function rearmWelcome(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method" }, 405);
  if (!(await authAdmin(req, env))) return json({ error: "unauthorized" }, 401);
  let b: { device_id?: unknown };
  try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const deviceId = typeof b.device_id === "string" ? b.device_id : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return json({ error: "bad_request" }, 400);
  const r = await hub(env, deviceId).armWelcome();
  return json({ device_id: deviceId, ...r });
}

async function deviceStatus(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") return json({ error: "method" }, 405);
  let deviceId: string | null = null;
  if (await authAdmin(req, env)) {
    deviceId = new URL(req.url).searchParams.get("device_id") ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) return json({ error: "bad_request" }, 400);
  } else {
    deviceId = await authDevice(req, env);
    if (!deviceId) return json({ error: "unauthorized" }, 401);
  }
  const s = await hub(env, deviceId).status();
  return json({ device_id: deviceId, online: s.online, muted: s.muted, fw: s.fw, pending: s.pending });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      // Health: only booleans. Nothing about the memory content, repo or token.
      if (path === "/health") return json({ ok: true, memory: memoryConfigured(env) ? "configured" : "off" });

      if (path === "/v1/admin/pairing-codes") return issuePairingCode(req, env);
      if (path === "/v1/admin/devices/revoke") return revokeDevice(req, env);
      if (path === "/v1/devices/pair") return pairDevice(req, env, url.origin);
      if (path === "/v1/devices/status") return deviceStatus(req, env);
      if (path === "/v1/admin/welcome-audio") return welcomeAudioAdmin(req, env);
      if (path === "/v1/admin/devices/welcome") return rearmWelcome(req, env);
      if (path === "/v1/admin/devices/activity") return deviceActivity(req, env);
      if (path === "/v1/admin/firmware") return adminFirmware(req, env);
      if (path === "/v1/admin/firmware/assign") return adminFirmwareAssign(req, env);
      if (path === "/v1/admin/firmware/push") return adminFirmwarePush(req, env);
      if (path === "/v1/admin/firmware/status") return adminFirmwareStatus(req, env);

      if (path === "/bloco/reply") {
        if (req.method !== "POST") return json({ error: "method" }, 405);
        if (!(await authReply(req, env))) return json({ error: "unauthorized" }, 401);
        let b: { turn_id?: unknown; device_id?: unknown; text?: unknown };
        try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
        const turnId = typeof b.turn_id === "string" ? b.turn_id : "";
        const deviceId = typeof b.device_id === "string" ? b.device_id : "";
        const text = typeof b.text === "string" ? b.text.trim() : "";
        if (!/^t_[0-9a-f]{16,32}$/.test(turnId) || !/^[A-Za-z0-9_-]{1,64}$/.test(deviceId) || !text) return json({ error: "bad_request" }, 400);
        const r = await hub(env, deviceId).deliverReply(turnId, text.slice(0, 500));
        const code = { delivered: 200, offline: 503, muted: 409, unknown_turn: 404, expired: 410, already_delivered: 409, tts_error: 502 }[r.status];
        return json(r, code);
      }

      // Everything below is device-authenticated.
      const deviceId = await authDevice(req, env);
      if (!deviceId) return json({ error: "device token rejected" }, 401);

      if (path === "/v1/devices/stream") {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "upgrade required" }, 426);
        const h = new Headers(req.headers);
        h.delete("x-device-token");
        h.set("x-sarandip-device", deviceId);
        return hub(env, deviceId).fetch(new Request("https://hub/ws", { headers: h }));
      }

      if (path === "/bloco/config" && req.method === "GET") return json(deviceConfig(env, url.origin));
      if (path === "/bloco/ota" && req.method === "GET") return deviceOta(req, env, deviceId, url.origin);
      if (path === "/bloco/ota/image" && req.method === "GET") return deviceOtaImage(req, env, deviceId);
      if (path === "/bloco/ota/status" && req.method === "POST") return deviceOtaStatus(req, env, deviceId);

      if (path === "/bloco/wake-log" && req.method === "POST") {
        let b: Record<string, unknown> = {};
        try { b = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        await hub(env, deviceId).logWake({
          keyword: String(b.keyword ?? ""), score: n(b.score), max: n(b.max), window: n(b.window), fw: String(b.fw ?? ""),
        });
        return new Response(null, { status: 204 });
      }

      if (path === "/bloco/turn" && req.method === "POST") {
        const len = Number(req.headers.get("content-length") ?? "0");
        if (len > MAX_TURN_BYTES) return json({ error: "too large" }, 413);
        return await handleTurn(req, env, ctx, deviceId, url.origin);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      // No token, transcript or key in logs: only the error class.
      console.error("unhandled", (e as Error)?.name ?? "error");
      return json({ error: "internal" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// SPDX-License-Identifier: AGPL-3.0-only
import { exports as rawExports, env as rawEnv } from "cloudflare:workers";
import type { Env } from "../src/env";
import { describe, it, expect } from "vitest";
import { sha256, bytesToHex, mintReplyToken } from "../src/auth";
import { normalizePairingCode, formatPairingCode } from "../src/registry";
import { registry } from "../src/registryref";
import { devHeaders, waitFor, DEV, REPLY, REPLY_PREV, ADMIN, BASE, TOKEN } from "./helpers";

const exports = rawExports as unknown as { default: { fetch(r: Request): Promise<Response> } };
const env = rawEnv as unknown as Env;
const call = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(BASE + path, init));
const adminH = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };

describe("pairing codes", () => {
  it("normalizes display form and alphabet", () => {
    expect(normalizePairingCode("ab3d-ef7h")).toBe("AB3DEF7H");
    expect(normalizePairingCode("AB3DEF7H")).toBe("AB3DEF7H");
    expect(normalizePairingCode("short")).toBeNull();
    expect(formatPairingCode("AB3DEF7H")).toBe("AB3D-EF7H");
  });

  it("admin issue is closed without ADMIN_TOKEN and open with it", async () => {
    expect((await call("/v1/admin/pairing-codes", { method: "POST" })).status).toBe(401);
    expect((await call("/v1/admin/pairing-codes", { method: "POST", headers: { authorization: "Bearer nope-nope-nope-nope" } })).status).toBe(401);
    const r = await call("/v1/admin/pairing-codes", { method: "POST", headers: adminH, body: JSON.stringify({ ttl_s: 120 }) });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { pairing_code: string; expires_in: number; expires_at: string };
    expect(j.pairing_code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(j.expires_in).toBe(120);
    expect(Date.parse(j.expires_at)).toBeGreaterThan(Date.now());
  });

  it("pair consumes the code once, returns the token only then, and authenticates the device", async () => {
    const issued = await (await call("/v1/admin/pairing-codes", { method: "POST", headers: adminH, body: "{}" })).json() as { pairing_code: string };
    const id = "dev_pair01";
    const res = await call("/v1/devices/pair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: issued.pairing_code, device_id: id, fw_version: "0.7.7-test" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device_id: string; token: string; base_url: string; ws_url: string; tz: string };
    expect(body.device_id).toBe(id);
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.base_url).toBe(BASE);
    expect(body.ws_url).toBe("wss://casa.test/v1/devices/stream");
    expect(body.tz).toBe("America/Sao_Paulo");
    const token = body.token;

    const again = await call("/v1/devices/pair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: issued.pairing_code, device_id: id, fw_version: "0.7.7-test" }),
    });
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: string }).error).toBe("used");

    const cfg = await call("/bloco/config", { headers: { "x-device-token": token, "x-device-id": id } });
    expect(cfg.status).toBe(200);
    expect(((await cfg.json()) as { protocol: string }).protocol).toBe("sarandip-ws-1");

    const unknown = await call("/v1/devices/pair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: "XXXX-XXXX", device_id: "dev_x", fw_version: "1" }),
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown_code");

    const bad = await call("/v1/devices/pair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: issued.pairing_code }),
    });
    expect(bad.status).toBe(400);
  });

  it("re-pairing the same device_id issues a new token and invalidates the old one", async () => {
    const a = await (await call("/v1/admin/pairing-codes", { method: "POST", headers: adminH, body: "{}" })).json() as { pairing_code: string };
    const first = await (await call("/v1/devices/pair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: a.pairing_code, device_id: "dev_re01", fw_version: "1" }),
    })).json() as { token: string };
    const b = await (await call("/v1/admin/pairing-codes", { method: "POST", headers: adminH, body: "{}" })).json() as { pairing_code: string };
    const second = await (await call("/v1/devices/pair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: b.pairing_code, device_id: "dev_re01", fw_version: "2" }),
    })).json() as { token: string };
    expect(second.token).not.toBe(first.token);
    expect((await call("/bloco/config", { headers: { "x-device-token": first.token, "x-device-id": "dev_re01" } })).status).toBe(401);
    expect((await call("/bloco/config", { headers: { "x-device-token": second.token, "x-device-id": "dev_re01" } })).status).toBe(200);
  });

  it("rate-limits repeated pair attempts", async () => {
    // PAIR_RATE_MAX is 10 in test bindings; unused codes still count.
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await call("/v1/devices/pair", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
        body: JSON.stringify({ pairing_code: "ZZZZ-ZZZZ", device_id: "dev_rl", fw_version: "1" }),
      });
      statuses.push(r.status);
    }
    expect(statuses.some((s) => s === 429)).toBe(true);
    const limited = await call("/v1/devices/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
      body: JSON.stringify({ pairing_code: "ZZZZ-ZZZZ", device_id: "dev_rl", fw_version: "1" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");
  });
});

describe("device claim codes", () => {
  const pair = (code: string, deviceId: string, ip = "198.51.100.80") =>
    call("/v1/devices/pair", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ pairing_code: code, device_id: deviceId, fw_version: "0.7.7-test" }),
    });

  it("issues a permanent code bound to one device_id", async () => {
    expect((await call("/v1/admin/pairing-codes", {
      method: "POST", headers: adminH, body: JSON.stringify({ permanent: true }),
    })).status).toBe(400);
    expect((await call("/v1/admin/pairing-codes", {
      method: "POST", headers: adminH, body: JSON.stringify({ permanent: true, device_id: "bad id" }),
    })).status).toBe(400);
    const r = await call("/v1/admin/pairing-codes", {
      method: "POST", headers: adminH, body: JSON.stringify({ permanent: true, device_id: "sc-claim000001" }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { pairing_code: string; device_id: string; permanent: boolean; rotated: boolean; expires_in?: number };
    expect(j.pairing_code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(j.device_id).toBe("sc-claim000001");
    expect(j.permanent).toBe(true);
    expect(j.rotated).toBe(false);
    expect(j.expires_in).toBeUndefined();
  });

  it("is reusable only by the bound device and rotates the token", async () => {
    const issued = await (await call("/v1/admin/pairing-codes", {
      method: "POST", headers: adminH, body: JSON.stringify({ permanent: true, device_id: "sc-claim000002" }),
    })).json() as { pairing_code: string };
    const other = await pair(issued.pairing_code, "sc-claim999999", "198.51.100.81");
    expect(other.status).toBe(404);
    expect(((await other.json()) as { error: string }).error).toBe("unknown_code");

    const first = await pair(issued.pairing_code, "sc-claim000002", "198.51.100.82");
    expect(first.status).toBe(200);
    const t1 = ((await first.json()) as { token: string }).token;
    expect((await call("/bloco/config", { headers: { "x-device-token": t1, "x-device-id": "sc-claim000002" } })).status).toBe(200);

    const second = await pair(issued.pairing_code, "sc-claim000002", "198.51.100.83");
    expect(second.status).toBe(200);
    const t2 = ((await second.json()) as { token: string }).token;
    expect(t2).not.toBe(t1);
    expect((await call("/bloco/config", { headers: { "x-device-token": t1, "x-device-id": "sc-claim000002" } })).status).toBe(401);
    expect((await call("/bloco/config", { headers: { "x-device-token": t2, "x-device-id": "sc-claim000002" } })).status).toBe(200);
  });

  it("reissue replaces the previous claim code; DELETE revokes it", async () => {
    const a = await (await call("/v1/admin/pairing-codes", {
      method: "POST", headers: adminH, body: JSON.stringify({ permanent: true, device_id: "sc-claim000003" }),
    })).json() as { pairing_code: string; rotated: boolean };
    expect(a.rotated).toBe(false);
    const b = await (await call("/v1/admin/pairing-codes", {
      method: "POST", headers: adminH, body: JSON.stringify({ permanent: true, device_id: "sc-claim000003" }),
    })).json() as { pairing_code: string; rotated: boolean };
    expect(b.rotated).toBe(true);
    expect(b.pairing_code).not.toBe(a.pairing_code);
    expect((await pair(a.pairing_code, "sc-claim000003", "198.51.100.84")).status).toBe(404);
    expect((await pair(b.pairing_code, "sc-claim000003", "198.51.100.85")).status).toBe(200);

    const del = await call("/v1/admin/pairing-codes", {
      method: "DELETE", headers: adminH, body: JSON.stringify({ device_id: "sc-claim000003" }),
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ revoked: true, device_id: "sc-claim000003" });
    expect((await pair(b.pairing_code, "sc-claim000003", "198.51.100.86")).status).toBe(404);
    expect((await call("/v1/admin/pairing-codes", {
      method: "DELETE", headers: adminH, body: JSON.stringify({ device_id: "sc-claim000003" }),
    })).status).toBe(404);
  });

  it("DELETE by pairing_code revokes only that claim code", async () => {
    const issued = await (await call("/v1/admin/pairing-codes", {
      method: "POST", headers: adminH, body: JSON.stringify({ permanent: true, device_id: "sc-claim000004" }),
    })).json() as { pairing_code: string };
    expect((await call("/v1/admin/pairing-codes", { method: "DELETE", headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(400);
    const del = await call("/v1/admin/pairing-codes", {
      method: "DELETE", headers: adminH, body: JSON.stringify({ pairing_code: issued.pairing_code }),
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ revoked: true, device_id: "sc-claim000004" });
    expect((await pair(issued.pairing_code, "sc-claim000004", "198.51.100.87")).status).toBe(404);
  });

  it("is not removed by the 24h short-lived cleanup", async () => {
    const issued = await (await call("/v1/admin/pairing-codes", {
      method: "POST", headers: adminH, body: JSON.stringify({ permanent: true, device_id: "sc-claim000005" }),
    })).json() as { pairing_code: string };
    await registry(env).sweepExpired(Date.now() + 48 * 3600 * 1000);
    const r = await pair(issued.pairing_code, "sc-claim000005", "198.51.100.88");
    expect(r.status).toBe(200);
  });
});

describe("device status", () => {
  it("is online only after a WebSocket hello, and accepts device or admin auth", async () => {
    const no = await call("/v1/devices/status");
    expect(no.status).toBe(401);
    const off = await call("/v1/devices/status", { headers: devHeaders() });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ device_id: DEV, online: false });

    const res = await call("/v1/devices/stream", { headers: { upgrade: "websocket", "x-device-token": TOKEN } });
    const ws = res.webSocket!;
    const rx: Record<string, unknown>[] = [];
    ws.accept();
    ws.addEventListener("message", (e: MessageEvent) => { if (typeof e.data === "string") rx.push(JSON.parse(e.data)); });
    ws.send(JSON.stringify({ v: 1, type: "hello", device_id: DEV, seq: 1, ts: 1, fw_version: "0.7.7-test" }));
    await waitFor(() => rx.find((t) => t.type === "hello_ack"));

    const on = await call("/v1/devices/status", { headers: devHeaders() });
    expect(await on.json()).toMatchObject({ device_id: DEV, online: true, fw: "0.7.7-test" });

    const admin = await call(`/v1/devices/status?device_id=${DEV}`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(admin.status).toBe(200);
    expect(((await admin.json()) as { online: boolean }).online).toBe(true);
    ws.close(1000, "done");
  });
});

describe("REPLY_SECRET rotation (integration)", () => {
  it("accepts the previous secret while it is configured", async () => {
    const pending = await call("/bloco/reply", {
      method: "POST",
      headers: { authorization: `Bearer ${REPLY_PREV}`, "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "t_00000000000000aa", device_id: DEV, text: "oi" }),
    });
    // Auth passed (not 401); the turn itself is unknown.
    expect(pending.status).toBe(404);
    const cur = await call("/bloco/reply", {
      method: "POST",
      headers: { authorization: `Bearer ${REPLY}`, "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "t_00000000000000aa", device_id: DEV, text: "oi" }),
    });
    expect(cur.status).toBe(404);
    expect((await call("/bloco/reply", {
      method: "POST",
      headers: { authorization: "Bearer totally-wrong-secret-xx", "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "t_00000000000000aa", device_id: DEV, text: "oi" }),
    })).status).toBe(401);
  });
});

describe("turn-scoped reply token (integration)", () => {
  it("accepts a valid t query token without a Bearer header", async () => {
    const token = await mintReplyToken(env, "t_00000000000000aa", DEV);
    expect(token).toBeTruthy();
    const ok = await call(`/bloco/reply?t=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "t_00000000000000aa", device_id: DEV, text: "oi" }),
    });
    // Auth passed (not 401); the turn itself is unknown.
    expect(ok.status).toBe(404);
    const wrongTurn = await call(`/bloco/reply?t=${token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "t_00000000000000bb", device_id: DEV, text: "oi" }),
    });
    expect(wrongTurn.status).toBe(401);
    const tampered = await call("/bloco/reply?t=AAAA.1737072000", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "t_00000000000000aa", device_id: DEV, text: "oi" }),
    });
    expect(tampered.status).toBe(401);
  });
});

describe("legacy DEVICE_TOKENS still work", () => {
  it("hash of the built-in test token matches", async () => {
    expect(bytesToHex(await sha256(TOKEN))).toBe("7704685303b2132fd42cc33272a38a6dd85174c94fcb99fb36243269a75d0009");
    expect((await call("/bloco/config", { headers: devHeaders({ "x-device-id": DEV }) })).status).toBe(200);
  });
});

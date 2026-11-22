// SPDX-License-Identifier: AGPL-3.0-only
// On-device claim codes: the device checks its own code in the setup portal and the owner's server enrolls it on
// first use (no admin-issued code), keeping only a PBKDF2 verifier for later re-pairs.
import { exports as rawExports, env as rawEnv } from "cloudflare:workers";
import type { Env } from "../src/env";
import { describe, it, expect } from "vitest";
import { claimAllowed, claimPolicy, type ClaimPolicy } from "../src/registry";
import { ADMIN, BASE } from "./helpers";

const exports = rawExports as unknown as { default: { fetch(r: Request): Promise<Response> } };
const env = rawEnv as unknown as Env;
const call = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(BASE + path, init));
const adminH = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
let ipN = 10;
const pair = (body: Record<string, unknown>) =>
  call("/v1/devices/pair", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `198.51.100.${ipN++}` },
    body: JSON.stringify(body),
  });

// A registry instance of its own, so "first device" can be tested on an empty server.
function freshRegistry(name: string) {
  return env.DEVICE_REGISTRY.get(env.DEVICE_REGISTRY.idFromName(name));
}

describe("claim policy", () => {
  it("parses vars with safe defaults", () => {
    expect(claimPolicy({})).toEqual({ mode: "first", allow: [] });
    expect(claimPolicy({ CLAIM_MODE: "OPEN" }).mode).toBe("open");
    expect(claimPolicy({ CLAIM_MODE: "off" }).mode).toBe("off");
    expect(claimPolicy({ CLAIM_MODE: "weird" }).mode).toBe("first");
    expect(claimPolicy({ CLAIM_DEVICE_IDS: " sc-a, sc-b ,bad!,," }).allow).toEqual(["sc-a", "sc-b"]);
  });

  it("decides who may claim", () => {
    const first: ClaimPolicy = { mode: "first", allow: [] };
    expect(claimAllowed(first, "sc-x", false)).toBe(true);
    expect(claimAllowed(first, "sc-x", true)).toBe(false);
    expect(claimAllowed({ mode: "open", allow: [] }, "sc-x", true)).toBe(true);
    expect(claimAllowed({ mode: "off", allow: ["sc-x"] }, "sc-x", false)).toBe(false);
    expect(claimAllowed({ mode: "first", allow: ["sc-x"] }, "sc-x", true)).toBe(true);
    expect(claimAllowed({ mode: "open", allow: ["sc-x"] }, "sc-y", false)).toBe(false);
  });
});

describe("first-use claim on an empty server", () => {
  const first: ClaimPolicy = { mode: "first", allow: [] };

  it("enrolls the first device, then closes, and re-pairs only with the same code", async () => {
    const reg = freshRegistry("claim-first-a");
    const a = await reg.pair("K7MP-2Q0D", "sc-aaaaaaaaaaaa", "0.1.3", "k1", true, first);
    expect(a.ok).toBe(true);
    // A second device cannot claim this server any more.
    const b = await reg.pair("AB3D-EF7H", "sc-bbbbbbbbbbbb", "0.1.3", "k2", true, first);
    expect(b).toMatchObject({ ok: false, error: "claim_closed" });
    // Same device after a factory reset: same code works and rotates the token; a wrong code does not.
    const again = await reg.pair("k7mp 2q0d", "sc-aaaaaaaaaaaa", "0.1.3", "k3", true, first);
    expect(again.ok).toBe(true);
    if (a.ok && again.ok) expect(again.token).not.toBe(a.token);
    const wrong = await reg.pair("AB3D-EF7H", "sc-aaaaaaaaaaaa", "0.1.3", "k4", true, first);
    expect(wrong).toMatchObject({ ok: false, error: "unknown_code" });
    // The re-pair check does not need the claim flag (the stored verifier is the proof).
    const noFlag = await reg.pair("K7MP-2Q0D", "sc-aaaaaaaaaaaa", "0.1.3", "k5", false, first);
    expect(noFlag.ok).toBe(true);
    const info = await reg.claimInfo();
    expect(info.claims.map((c) => c.device_id)).toEqual(["sc-aaaaaaaaaaaa"]);
  });

  it("never claims without the device flag, nor over an admin-paired device id", async () => {
    const reg = freshRegistry("claim-first-b");
    expect(await reg.pair("K7MP-2Q0D", "sc-cccccccccccc", "1", "k1", false, first)).toMatchObject({ ok: false, error: "unknown_code" });
    // Pair one device through an admin code, then try to claim that id with another code.
    const issued = await reg.issueCode(600);
    expect((await reg.pair(issued.pairing_code, "sc-dddddddddddd", "1", "k2", false, first)).ok).toBe(true);
    const hijack = await reg.pair("AB3D-EF7H", "sc-dddddddddddd", "1", "k3", true, { mode: "open", allow: [] });
    expect(hijack).toMatchObject({ ok: false, error: "unknown_code" });
    // "first" is closed now that the server has a device.
    expect(await reg.pair("AB3D-EF7H", "sc-eeeeeeeeeeee", "1", "k4", true, first)).toMatchObject({ ok: false, error: "claim_closed" });
  });

  it("an admin claim code for the device still wins (backward compatible)", async () => {
    const reg = freshRegistry("claim-first-c");
    const claimCode = await reg.issueClaimCode("sc-ffffffffffff");
    const r = await reg.pair(claimCode.pairing_code, "sc-ffffffffffff", "1", "k1", true, { mode: "off", allow: [] });
    expect(r.ok).toBe(true);
    expect((await reg.claimInfo()).claims).toEqual([]);
  });

  it("a device secret stored at the first claim is required on re-pairs", async () => {
    const reg = freshRegistry("claim-first-e");
    const sec = "a".repeat(64);
    expect((await reg.pair("K7MP-2Q0D", "sc-222222222222", "1", "k1", true, first, sec)).ok).toBe(true);
    // Code alone (e.g. read from the card, or sniffed on the open setup network) is not enough.
    expect(await reg.pair("K7MP-2Q0D", "sc-222222222222", "1", "k2", true, first)).toMatchObject({ ok: false, error: "unknown_code" });
    expect(await reg.pair("K7MP-2Q0D", "sc-222222222222", "1", "k3", true, first, "b".repeat(64))).toMatchObject({ ok: false, error: "unknown_code" });
    expect(await reg.pair("AB3D-EF7H", "sc-222222222222", "1", "k4", true, first, sec)).toMatchObject({ ok: false, error: "unknown_code" });
    expect((await reg.pair("k7mp-2q0d", "sc-222222222222", "1", "k5", true, first, sec)).ok).toBe(true);
    // Too short a secret is ignored (treated as none).
    const reg2 = freshRegistry("claim-first-f");
    expect((await reg2.pair("K7MP-2Q0D", "sc-333333333333", "1", "k1", true, first, "short")).ok).toBe(true);
    expect((await reg2.pair("K7MP-2Q0D", "sc-333333333333", "1", "k2", true, first)).ok).toBe(true);
  });

  it("forgetting a claim lets the device claim again with a new code", async () => {
    const reg = freshRegistry("claim-first-d");
    expect((await reg.pair("K7MP-2Q0D", "sc-111111111111", "1", "k1", true, first)).ok).toBe(true);
    expect(await reg.forgetClaim("sc-111111111111")).toBe(true);
    // Still enrolled (device row exists) and the id is already paired: no silent re-claim with another code.
    expect((await reg.pair("AB3D-EF7H", "sc-111111111111", "1", "k2", true, { mode: "open", allow: [] })).ok).toBe(false);
    expect(await reg.revoke("sc-111111111111")).toBe(true);
    expect((await reg.pair("AB3D-EF7H", "sc-111111111111", "1", "k3", true, first)).ok).toBe(true);
  });
});

describe("POST /v1/devices/pair with claim: device", () => {
  it("allow-listed device claims, authenticates, and wrong codes or other ids are refused", async () => {
    const id = "sc-c1a100000001";
    const sec = "0123456789abcdef".repeat(4);
    const res = await pair({ pairing_code: "K7MP-2Q0D", device_id: id, fw_version: "0.1.3-dev", claim: "device", device_secret: sec });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { device_id: string; token: string; base_url: string };
    expect(body.device_id).toBe(id);
    expect(body.base_url).toBe(BASE);
    expect((await call("/bloco/config", { headers: { "x-device-token": body.token, "x-device-id": id } })).status).toBe(200);

    const wrong = await pair({ pairing_code: "AB3D-EF7H", device_id: id, fw_version: "0.1.3-dev", claim: "device", device_secret: sec });
    expect(wrong.status).toBe(404);
    const noSecret = await pair({ pairing_code: "K7MP-2Q0D", device_id: id, fw_version: "0.1.3-dev", claim: "device" });
    expect(noSecret.status).toBe(404);
    const again = await pair({ pairing_code: "K7MP 2Q0D", device_id: id, fw_version: "0.1.3-dev", claim: "device", device_secret: sec });
    expect(again.status).toBe(200);

    const other = await pair({ pairing_code: "AB3D-EF7H", device_id: "sc-notlisted0001", fw_version: "0.1.3-dev", claim: "device" });
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toBe("claim_closed");

    const legacy = await pair({ pairing_code: "AB3D-EF7H", device_id: "sc-notlisted0002", fw_version: "0.1.2-dev" });
    expect(legacy.status).toBe(404);

    const list = await call("/v1/admin/claims", { headers: adminH });
    expect(list.status).toBe(200);
    const j = (await list.json()) as { claims: { device_id: string }[] };
    expect(j.claims.some((c) => c.device_id === id)).toBe(true);
    expect(JSON.stringify(j)).not.toMatch(/K7MP|verifier|salt/);
    expect((await call("/v1/admin/claims")).status).toBe(401);
    const del = await call("/v1/admin/claims", { method: "DELETE", headers: adminH, body: JSON.stringify({ device_id: id }) });
    expect(del.status).toBe(200);
  });
});

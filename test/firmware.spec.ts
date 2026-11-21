// SPDX-License-Identifier: AGPL-3.0-only
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN, BASE, DEV, TOKEN, devHeaders } from "./helpers";
import { cmpFwVersion, looksLikeFactoryImage, OTA_IMAGE_MIN, sha256Hex, sigHexOk } from "../src/firmware";

const admin = { authorization: `Bearer ${ADMIN}` };

function appImage(n = OTA_IMAGE_MIN, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  b[0] = 0xe9; // ESP image magic
  for (let i = 1; i < n; i++) b[i] = (i * seed) & 0xff;
  return b;
}

function factoryLike(): Uint8Array {
  const b = new Uint8Array(OTA_IMAGE_MIN);
  b[0] = 0xe9;
  b.fill(0xff, 0x2000, 0x8000);
  b[0x8000] = 0xaa;
  return b;
}

async function putFw(version: string, bytes: Uint8Array, channel = "default", extra: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}/v1/admin/firmware?channel=${channel}`, {
    method: "PUT",
    headers: { ...admin, "x-sarandip-firmware-version": version, "content-type": "application/octet-stream", ...extra },
    body: bytes,
  });
}

describe("firmware helpers", () => {
  it("compares versions the way the device does", () => {
    expect(cmpFwVersion("0.1.1-dev", "0.1.2-dev")).toBeGreaterThan(0);
    expect(cmpFwVersion("0.1.2-dev", "0.1.2")).toBe(0);
    expect(cmpFwVersion("0.1.2-dev", "0.1.1-dev")).toBeLessThan(0);
  });

  it("rejects a combined factory image", () => {
    expect(looksLikeFactoryImage(appImage())).toBe(false);
    expect(looksLikeFactoryImage(factoryLike())).toBe(true);
  });
});

describe("admin firmware routes", () => {
  it("rejects unauthenticated uploads", async () => {
    const r = await SELF.fetch(`${BASE}/v1/admin/firmware?channel=default`, {
      method: "PUT",
      headers: { "x-sarandip-firmware-version": "0.1.2-dev" },
      body: appImage(),
    });
    expect(r.status).toBe(401);
  });

  it("rejects a factory image and a short blob", async () => {
    expect((await putFw("0.1.2-dev", factoryLike())).status).toBe(400);
    expect((await putFw("0.1.2-dev", appImage(99))).status).toBe(413);
  });

  it("rejects a sha256 mismatch", async () => {
    const r = await putFw("0.1.2-dev", appImage(), "default", { "x-sarandip-firmware-sha256": "ab".repeat(32) });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "sha256_mismatch" });
  });

  it("uploads, lists, assigns and reports status", async () => {
    const bytes = appImage();
    const sha = await sha256Hex(bytes);
    const up = await putFw("0.1.2-dev", bytes, "luva-gui", { "x-sarandip-firmware-sha256": sha });
    expect(up.status).toBe(201);
    const meta = (await up.json()) as { version: string; sha256: string; size: number; signature: string; channel: string };
    expect(meta).toMatchObject({ version: "0.1.2-dev", sha256: sha, size: bytes.byteLength, channel: "luva-gui" });
    expect(sigHexOk(meta.signature)).toBe(true);

    const list = (await (await SELF.fetch(`${BASE}/v1/admin/firmware?channel=luva-gui`, { headers: admin })).json()) as { images: { version: string }[] };
    expect(list.images.some((i) => i.version === "0.1.2-dev")).toBe(true);
  });
});

describe("simulated device OTA fetch", () => {
  it("returns 204 when nothing is assigned, then serves a signed image after assign", async () => {
    const empty = await SELF.fetch(`${BASE}/bloco/ota?fw=0.1.1-dev`, { headers: devHeaders() });
    expect(empty.status).toBe(204);

    const bytes = appImage(OTA_IMAGE_MIN, 11);
    const sha = await sha256Hex(bytes);
    expect((await putFw("0.2.0-dev", bytes, "default", { "x-sarandip-firmware-sha256": sha })).status).toBe(201);
    expect((await SELF.fetch(`${BASE}/v1/admin/firmware/assign`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ device_id: DEV, channel: "default", version: "0.2.0-dev" }),
    })).status).toBe(200);

    const man = await SELF.fetch(`${BASE}/bloco/ota?fw=0.1.1-dev`, { headers: devHeaders() });
    expect(man.status).toBe(200);
    const j = (await man.json()) as { version: string; url: string; sha256: string; size: number; signature: string };
    expect(j).toMatchObject({ version: "0.2.0-dev", sha256: sha, size: bytes.byteLength });
    expect(j.url).toContain("/bloco/ota/image");
    expect(sigHexOk(j.signature)).toBe(true);

    const same = await SELF.fetch(`${BASE}/bloco/ota?fw=0.2.0-dev`, { headers: devHeaders() });
    expect(same.status).toBe(204);

    const img = await SELF.fetch(`${BASE}${j.url}`, { headers: devHeaders() });
    expect(img.status).toBe(200);
    expect(img.headers.get("x-sarandip-ota-sha256")).toBe(sha);
    expect(img.headers.get("x-sarandip-ota-signature")).toBe(j.signature);
    const got = new Uint8Array(await img.arrayBuffer());
    expect(got.byteLength).toBe(bytes.byteLength);
    expect(await sha256Hex(got)).toBe(sha);
    expect(got[0]).toBe(0xe9);

    const other = await SELF.fetch(`${BASE}${j.url}`, { headers: { "x-device-token": "no-such-token-at-all-000" } });
    expect(other.status).toBe(401);

    const report = await SELF.fetch(`${BASE}/bloco/ota/status`, {
      method: "POST",
      headers: { ...devHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ event: "applied", version: "0.2.0-dev", fw: "0.2.0-dev" }),
    });
    expect(report.status).toBe(204);
    const st = (await (await SELF.fetch(`${BASE}/v1/admin/firmware/status?device_id=${DEV}`, { headers: admin })).json()) as { assignment: { last_event: string; last_fw: string } };
    expect(st.assignment.last_event).toBe("applied");
    expect(st.assignment.last_fw).toBe("0.2.0-dev");
  });

  it("does not let a device fetch an image that was not assigned to it", async () => {
    const bytes = appImage(OTA_IMAGE_MIN, 13);
    expect((await putFw("0.3.0-dev", bytes, "hidden")).status).toBe(201);
    const img = await SELF.fetch(`${BASE}/bloco/ota/image?channel=hidden&version=0.3.0-dev`, { headers: devHeaders() });
    expect(img.status).toBe(404);
  });
});

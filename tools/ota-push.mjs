#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Upload an app firmware.bin and optionally assign/push it to a device.
// Usage:
//   node tools/ota-push.mjs --base https://example.workers.dev \
//     --bin firmware.bin --version 0.1.2-dev --channel luva-gui \
//     [--device sc-…] [--push]
// ADMIN_TOKEN is read from the environment (never printed). If
// FIRMWARE_SIGNING_KEY or --key points at a PKCS#8 PEM, the Worker will also
// sign when that secret is configured on the account; this script always
// sends the raw bytes and the SHA-256.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const get = (name, d) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : d;
};
const flag = (name) => args.includes(name);

const base = (get("--base") || process.env.BASE_URL || "").replace(/\/$/, "");
const binPath = get("--bin");
const version = get("--version");
const channel = get("--channel") || "default";
const device = get("--device") || "";
const token = process.env.ADMIN_TOKEN || "";
if (!base || !binPath || !version || !token) {
  console.error("usage: ADMIN_TOKEN=… node tools/ota-push.mjs --base <url> --bin firmware.bin --version 0.1.2-dev [--channel default] [--device sc-…] [--push]");
  process.exit(2);
}
const bytes = readFileSync(binPath);
const sha = createHash("sha256").update(bytes).digest("hex");
console.log("uploading", { version, channel, size: bytes.length, sha256: sha, push: flag("--push") && !!device });

const put = await fetch(`${base}/v1/admin/firmware?channel=${encodeURIComponent(channel)}`, {
  method: "PUT",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/octet-stream",
    "x-sarandip-firmware-version": version,
    "x-sarandip-firmware-sha256": sha,
  },
  body: bytes,
});
const putBody = await put.text();
if (!put.ok) {
  console.error("upload failed", put.status, putBody.slice(0, 500));
  process.exit(1);
}
console.log("uploaded", putBody);

if (!device) process.exit(0);
const path = flag("--push") ? "push" : "assign";
const asg = await fetch(`${base}/v1/admin/firmware/${path}`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ device_id: device, channel, version }),
});
const asgBody = await asg.text();
if (!asg.ok) {
  console.error(`${path} failed`, asg.status, asgBody.slice(0, 500));
  process.exit(1);
}
console.log(path, asgBody);

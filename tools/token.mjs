// SPDX-License-Identifier: AGPL-3.0-only
// Hash helper for the legacy DEVICE_TOKENS secret. Prefer pairing
// (POST /v1/admin/pairing-codes + POST /v1/devices/pair): the raw token is
// delivered only in the pairing response and is never printed here.
//
//   node tools/token.mjs --hash-stdin <device_id>   # token on stdin, hash on stdout
//
// Stdout is JSON with device_id and token_sha256 only. The raw token is never
// written to stdout, stderr or disk.
import { createHash } from "node:crypto";

function usage(code = 2) {
  console.error("usage: node tools/token.mjs --hash-stdin <device_id>");
  console.error("Read the device token from stdin (it is not echoed). Print only the SHA-256 hash JSON.");
  console.error("To give a device a token, use pairing instead of this tool.");
  process.exit(code);
}

const args = process.argv.slice(2);
if (args[0] === "-h" || args[0] === "--help") usage(0);
if (args[0] !== "--hash-stdin" || !args[1] || args.length !== 2) usage(2);
const id = args[1];
if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) usage(2);

const token = (await new Response(process.stdin).text()).trim();
if (!token || token.length > 256) {
  console.error("error: empty or too-long token on stdin");
  process.exit(2);
}
const hash = createHash("sha256").update(token).digest("hex");
// Only the hash is printed. The map shape matches the legacy DEVICE_TOKENS secret.
process.stdout.write(JSON.stringify({ device_id: id, token_sha256: hash, DEVICE_TOKENS: { [id]: hash } }) + "\n");

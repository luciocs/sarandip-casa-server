// SPDX-License-Identifier: AGPL-3.0-only
// Node-only check: tools/token.mjs never prints the raw token.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const tool = join(root, "tools", "token.mjs");
const token = "unit-test-only-token-value-xxx";
const r = spawnSync(process.execPath, [tool, "--hash-stdin", "dev_home01"], {
  input: token + "\n",
  encoding: "utf8",
});
if (r.status !== 0) {
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}
if (r.stdout.includes(token) || r.stderr.includes(token)) {
  console.error("FAIL: raw token appeared in tool output");
  process.exit(1);
}
const j = JSON.parse(r.stdout);
const want = createHash("sha256").update(token).digest("hex");
if (j.device_id !== "dev_home01" || j.token_sha256 !== want || j.DEVICE_TOKENS.dev_home01 !== want) {
  console.error("FAIL: unexpected hash JSON", j);
  process.exit(1);
}
const help = spawnSync(process.execPath, [tool], { encoding: "utf8" });
if (help.status === 0) {
  console.error("FAIL: tool should exit 2 without --hash-stdin");
  process.exit(1);
}
const combined = (help.stdout + help.stderr);
if (/token[^\n]{20,}/i.test(combined) && combined.includes("unit-test-only")) {
  console.error("FAIL: help printed a token");
  process.exit(1);
}
console.log("token-tool: ok (hash only, no plaintext token)");

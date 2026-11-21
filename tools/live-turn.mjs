// SPDX-License-Identifier: AGPL-3.0-only
// Live turn against the deployed Worker, like the firmware's button turn (single WAV, PCM16 mono 16 kHz).
// Usage: DEVICE_TOKEN=<token> node tools/live-turn.mjs <base_url> <question.wav> [out.wav]
// Prints only status and route headers (never the token). The reply audio goes to the output file.
import { readFileSync, writeFileSync } from "node:fs";
const [base, wavPath, out = "/tmp/sarandip-live-reply.wav"] = process.argv.slice(2);
const token = process.env.DEVICE_TOKEN || process.env.SARANDIP_TOKEN;
if (!base || !wavPath || !token) { console.error("usage: DEVICE_TOKEN=… node tools/live-turn.mjs <base_url> <question.wav> [out.wav]"); process.exit(2); }
const tz = process.env.TZ || "UTC";
const lang = process.env.LANGUAGE || "en";
const t0 = Date.now();
const r = await fetch(base.replace(/\/$/, "") + "/bloco/turn", {
  method: "POST",
  headers: { "content-type": "audio/wav", "x-device-token": token, "x-sarandip-trigger": "button" },
  body: readFileSync(wavPath),
});
const buf = Buffer.from(await r.arrayBuffer());
console.log(JSON.stringify({
  status: r.status, route: r.headers.get("x-sarandip-route"), late_reply: r.headers.get("x-sarandip-late-reply"),
  turn_id: r.headers.get("x-sarandip-turn-id"), bytes: buf.length, ms: Date.now() - t0,
  local_now: new Intl.DateTimeFormat(lang, { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(new Date()),
  timezone: tz,
}));
if (r.status === 200) writeFileSync(out, buf);

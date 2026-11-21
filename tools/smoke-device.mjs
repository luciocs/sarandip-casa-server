// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test against `wrangler dev --local` with raw sockets, byte-for-byte like the
// firmware: hand-written WS upgrade with X-Device-Token, masked client frames, multipart
// POST with Connection: close, then a late reply over the open socket.
// Uso: node tools/smoke-device.mjs <host> <port> <token> <reply_secret>
import net from "node:net";
import crypto from "node:crypto";
const [host = "127.0.0.1", port = "8799", token, secret] = process.argv.slice(2);
const P = Number(port);

function wavPcm(ms, text) {
  const n = Math.round(ms * 16); const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(2000 * Math.sin(i / 5)), i * 2);
  if (text) Buffer.from(`STUB:${text}\0`).copy(pcm);
  const h = Buffer.alloc(44); h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function wsFrame(op, payload) {
  const mask = crypto.randomBytes(4); const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : Buffer.from([0x80 | op, 0x80 | 126, len >> 8, len & 255]);
  const body = Buffer.from(payload); for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}
function parseFrames(buf, out) {
  let off = 0;
  while (buf.length - off >= 2) {
    const op = buf[off] & 15; let len = buf[off + 1] & 127; let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    if (buf.length - p < len) break;
    out.push({ op, data: buf.subarray(p, p + len) }); off = p + len;
  }
  return buf.subarray(off);
}
function openWs() {
  return new Promise((res, rej) => {
    const s = net.connect(P, host); const key = crypto.randomBytes(16).toString("base64");
    let buf = Buffer.alloc(0), up = false; const frames = [];
    s.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!up) {
        const i = buf.indexOf("\r\n\r\n"); if (i < 0) return;
        const head = buf.subarray(0, i).toString(); buf = buf.subarray(i + 4);
        if (!head.startsWith("HTTP/1.1 101")) return rej(new Error("upgrade: " + head.split("\r\n")[0]));
        const acc = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
        const want = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        if (acc !== want) return rej(new Error("bad accept"));
        up = true; res({ s, frames });
      }
      buf = parseFrames(buf, frames);
    });
    s.on("error", rej);
    s.write(`GET /v1/devices/stream HTTP/1.1\r\nHost: ${host}:${P}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: sarandip-fw\r\nX-Device-Token: ${token}\r\n\r\n`);
  });
}
function turn(text) {
  return new Promise((res, rej) => {
    const b = "BelaTurn7f3a"; const wake = wavPcm(600), audio = wavPcm(900, text);
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="wake"; filename="wake.wav"\r\nContent-Type: audio/wav\r\n\r\n`), wake,
      Buffer.from(`\r\n--${b}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`), audio,
      Buffer.from(`\r\n--${b}--\r\n`)]);
    const s = net.connect(P, host); const chunks = [];
    s.on("data", (d) => chunks.push(d)); s.on("end", () => res(Buffer.concat(chunks))); s.on("error", rej);
    s.write(`POST /bloco/turn HTTP/1.1\r\nHost: ${host}:${P}\r\nUser-Agent: sarandip-fw\r\nAccept: */*\r\nX-Device-Token: ${token}\r\nX-Device-Id: dev_home01\r\nX-Bela-Firmware: 0.7.7-test\r\nX-Sarandip-Wake-Score: 0.970\r\nX-Sarandip-Wake-Hi: 3\r\nX-Sarandip-Wake-Cut: 0.850\r\nX-Sarandip-Trigger: wake\r\nContent-Type: multipart/form-data; boundary=${b}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
    s.write(body);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { s, frames } = await openWs();
s.write(wsFrame(1, JSON.stringify({ v: 1, type: "hello", device_id: "dev_home01", seq: 1, ts: 1, fw_version: "0.7.7-test" })));
s.write(wsFrame(9, "")); // protocol ping, like the firmware every 15 s
await sleep(400);
const texts = () => frames.filter((f) => f.op === 1).map((f) => JSON.parse(f.data.toString()));
console.log("hello_ack:", texts().some((t) => t.type === "hello_ack"), "| protocol pong:", frames.some((f) => f.op === 10));
const fast = await turn("quanto é dois mais dois");
const fh = fast.subarray(0, fast.indexOf("\r\n\r\n")).toString();
console.log("fast turn:", fh.split("\r\n")[0], "| route", /x-sarandip-route: (\S+)/i.exec(fh)?.[1], "| bytes", fast.length, "| chunked", /transfer-encoding: chunked/i.test(fh));
const slow = await turn("lembra de ligar para o dentista");
const sh = slow.subarray(0, slow.indexOf("\r\n\r\n")).toString();
const turnId = /x-sarandip-turn-id: (\S+)/i.exec(sh)?.[1];
console.log("routine turn:", sh.split("\r\n")[0], "| route", /x-sarandip-route: (\S+)/i.exec(sh)?.[1], "| turn", turnId);
const t0 = Date.now();
const r = await fetch(`http://${host}:${P}/bloco/reply`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify({ turn_id: turnId, device_id: "dev_home01", text: "Pronto, lembrete do dentista criado para amanhã às nove." }) });
console.log("reply:", r.status, JSON.stringify(await r.json()), `${Date.now() - t0} ms`);
await sleep(300);
const bins = frames.filter((f) => f.op === 2);
console.log("ws:", texts().map((t) => t.type).join(","), "| binary frames", bins.length, "| bytes", bins.reduce((a, f) => a + f.data.length, 0), "| max frame", Math.max(...bins.map((f) => f.data.length)));
s.end();

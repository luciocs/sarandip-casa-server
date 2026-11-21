// SPDX-License-Identifier: AGPL-3.0-only
// PCM16 mono 16 kHz helpers. The device plays a WAV with RIFF/data sizes
// 0xFFFFFFFF until the connection closes.

export const SR = 16000;

export class WavError extends Error {}

export interface Pcm {
  rate: number;
  channels: number;
  pcm: Uint8Array; // s16le
}

export function parseWav(buf: Uint8Array): Pcm {
  if (buf.byteLength < 44) throw new WavError("wav too short");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new WavError("not a RIFF/WAVE file");
  let off = 12;
  let rate = 0, channels = 0, bits = 0, fmt = 0;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = dv.getUint16(body, true);
      channels = dv.getUint16(body + 2, true);
      rate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
    } else if (id === "data") {
      if (fmt !== 1 || bits !== 16) throw new WavError("only PCM16 is accepted");
      if (channels !== 1) throw new WavError("only mono is accepted");
      if (rate !== SR) throw new WavError("only 16 kHz is accepted");
      // Firmware may send 0xFFFFFFFF or a size past the end: take what is there.
      if (size === 0xffffffff || body + size > buf.byteLength) size = buf.byteLength - body;
      size -= size & 1;
      return { rate, channels, pcm: buf.subarray(body, body + size) };
    }
    off = body + size + (size & 1);
  }
  throw new WavError("no data chunk");
}

export function wavHeader(dataBytes = 0xffffffff, rate = SR): Uint8Array {
  const h = new Uint8Array(44);
  const dv = new DataView(h.buffer);
  const put = (o: number, s: string) => { for (let i = 0; i < 4; i++) h[o + i] = s.charCodeAt(i); };
  put(0, "RIFF");
  dv.setUint32(4, dataBytes === 0xffffffff ? 0xffffffff : 36 + dataBytes, true);
  put(8, "WAVE");
  put(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  put(36, "data");
  dv.setUint32(40, dataBytes, true);
  return h;
}

export function pcmMs(bytes: number, rate = SR): number {
  return Math.round((bytes / 2 / rate) * 1000);
}

export function rms(pcm: Uint8Array): number {
  const n = pcm.byteLength >> 1;
  if (!n) return 0;
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let s = 0;
  const step = n > 4000 ? Math.floor(n / 4000) : 1; // sampled: keeps CPU flat
  let k = 0;
  for (let i = 0; i < n; i += step) { const v = dv.getInt16(i * 2, true); s += v * v; k++; }
  return Math.sqrt(s / k);
}

/**
 * The firmware decoder sniffs each binary WS message: "SA" = ADPCM frame,
 * 0x53 0x31 = S1 header. Raw PCM that happens to start with those bytes would be
 * misread, so the first byte is nudged by one LSB (inaudible).
 */
export function guardPcmFrame(frame: Uint8Array): Uint8Array {
  if (frame.byteLength >= 2 && frame[0] === 0x53 && (frame[1] === 0x41 || frame[1] === 0x31)) frame[0] = 0x52;
  return frame;
}

/** Re-chunks a byte stream into even-sized frames of `size` bytes (last may be shorter, still even). */
export async function* evenFrames(body: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  let buf = new Uint8Array(size);
  let n = 0;
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    let off = 0;
    while (off < value.byteLength) {
      const k = Math.min(size - n, value.byteLength - off);
      buf.set(value.subarray(off, off + k), n);
      n += k; off += k;
      if (n === size) { yield buf; buf = new Uint8Array(size); n = 0; }
    }
  }
  n -= n & 1;
  if (n > 0) yield buf.subarray(0, n);
}

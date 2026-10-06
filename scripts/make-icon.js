'use strict';
// Generates build/icon.png (512x512): dark tile with a red step-trend line. electron-builder derives icon.ico from it.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const N = 512; const SS = 3;
const px = Buffer.alloc(N * N * 4);
const BG = [10, 10, 9]; const PANEL = [29, 27, 25]; const RED = [220, 38, 38]; const GRID = [56, 52, 45];

function distSeg(x, y, a, b) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}
function inRound(x, y, m, r) {
  const lo = m + r; const hi = N - m - r;
  if (x < m || x > N - m || y < m || y > N - m) return false;
  const cx = Math.max(lo, Math.min(hi, x)); const cy = Math.max(lo, Math.min(hi, y));
  return Math.hypot(x - cx, y - cy) <= r;
}
const steps = [[96, 352], [190, 352], [190, 268], [286, 268], [286, 300], [352, 300], [352, 176], [416, 176]];

for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = i + (sx + 0.5) / SS; const y = j + (sy + 0.5) / SS;
      let c = null;
      if (inRound(x, y, 8, 96)) {
        c = inRound(x, y, 8, 96) && !inRound(x, y, 20, 84) ? GRID : PANEL;
        if (c === PANEL) c = BG;
        for (const gy of [176, 268, 352]) if (Math.abs(y - gy) < 1.5 && x > 80 && x < 432) c = GRID;
        let d = 1e9;
        for (let k = 0; k < steps.length - 1; k++) d = Math.min(d, distSeg(x, y, steps[k], steps[k + 1]));
        if (d <= 12) c = RED;
        if (Math.hypot(x - 416, y - 176) <= 24) c = RED;
      }
      if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
    }
    const o = (j * N + i) * 4; const n = SS * SS;
    px[o] = a ? r / a : 0; px[o + 1] = a ? g / a : 0; px[o + 2] = a ? b / a : 0; px[o + 3] = Math.round((a / n) * 255);
  }
}

function crc32(buf) {
  let c; let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');

// Generates the source app icon (1024x1024 RGBA PNG) without any npm dependencies.
// Usage: node scripts/gen-icon.mjs [out.png]  then  npx tauri icon <out.png>  (from apps/desktop)
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 1024;
const out = process.argv[2] ?? "app-icon.png";

// Pixel-art "P" + a little play triangle, on a 16x16 grid.
const GLYPH = [
  "................",
  "................",
  "...XXXXXXX......",
  "...XXXXXXXX.....",
  "...XX....XXX....",
  "...XX.....XX....",
  "...XX....XXX....",
  "...XXXXXXXX.....",
  "...XXXXXXX......",
  "...XX.....X.....",
  "...XX.....XXX...",
  "...XX.....XXXX..",
  "...XX.....XXX...",
  "...XX.....X.....",
  "................",
  "................",
];

const lerp = (a, b, t) => a + (b - a) * t;
const stops = [
  [0xff, 0x7a, 0x3d],
  [0xff, 0x4f, 0x8b],
  [0x8b, 0x6c, 0xff],
];
function gradient(t) {
  const seg = t < 0.5 ? 0 : 1;
  const lt = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  return stops[seg].map((c, i) => Math.round(lerp(c, stops[seg + 1][i], lt)));
}

const margin = 64;
const radius = 200;
const cell = (SIZE - margin * 2) / 16;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const o = row + 1 + x * 4;
    // Rounded-rect coverage with 1px anti-aliasing.
    const cx = Math.min(Math.max(x + 0.5, margin + radius), SIZE - margin - radius);
    const cy = Math.min(Math.max(y + 0.5, margin + radius), SIZE - margin - radius);
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const inside = x >= margin && x < SIZE - margin && y >= margin && y < SIZE - margin;
    const alpha = inside ? Math.max(0, Math.min(1, radius - d + 0.5)) : 0;
    if (alpha === 0) continue;
    let [r, g, b] = gradient((x + y) / (2 * SIZE));
    const gx = Math.floor((x - margin) / cell);
    const gy = Math.floor((y - margin) / cell);
    if (GLYPH[gy]?.[gx] === "X") [r, g, b] = [0xff, 0xff, 0xff];
    raw[o] = r;
    raw[o + 1] = g;
    raw[o + 2] = b;
    raw[o + 3] = Math.round(alpha * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);

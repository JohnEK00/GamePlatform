#!/usr/bin/env node
// Generates the Pixel Peaks F012 assets from the engine's built-in `pixel` glyph table:
//   examples/pixel-peaks/assets/fonts/peaks.fnt   BMFont text descriptor (with kerning pairs)
//   examples/pixel-peaks/assets/fonts/peaks_0.png 1-px-outlined, two-tone variant of the pixel glyphs
//   examples/pixel-peaks/assets/ui/panel.png      12×12 9-slice frame with 4-px borders
// Dependency-free (Node zlib for PNG). Usage (repo root): node packages/engine/scripts/gen-bitmap-font.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const outFonts = join(root, 'examples/pixel-peaks/assets/fonts');
const outUi = join(root, 'examples/pixel-peaks/assets/ui');

// ------------------------------------------------------------------ glyph table (from src/pixelfont.ts)
const src = readFileSync(join(here, '../src/pixelfont.ts'), 'utf8');
const table = /PIXEL_GLYPHS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src);
if (!table) throw new Error('PIXEL_GLYPHS not found in src/pixelfont.ts');
const GLYPHS = [...table[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([0-9a-v]*)'/g)].map((m) => m[1]);
if (GLYPHS.length !== 95) throw new Error(`expected 95 glyphs, got ${GLYPHS.length}`);
const rowsOf = (i) => Array.from({ length: 9 }, (_, r) => (r < GLYPHS[i].length ? parseInt(GLYPHS[i][r], 32) : 0));

// ------------------------------------------------------------------ PNG
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGBA (Uint8Array, w*h*4) → PNG bytes. */
function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const hex = (s, a = 255) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), a];

// ------------------------------------------------------------------ peaks font
// White top / light-grey bottom fill (so drawText's color tints it into two tones) + dark outline.
const TOP = hex('#ffffff');
const BOTTOM = hex('#c0cbdc');
const OUTLINE = hex('#1a1c2c');
const PAGE_W = 128;
const SIZE = 12;
const LINE_HEIGHT = 12;
const BASE = 8; // pixel baseline row 7, shifted down 1 by the outline

const glyphs = [];
for (let i = 0; i < 95; i++) {
  const rows = rowsOf(i);
  let minC = 5, maxC = -1, minR = 9, maxR = -1;
  rows.forEach((bits, r) => {
    for (let c = 0; c < 5; c++)
      if (bits & (16 >> c)) {
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      }
  });
  if (maxC < 0) {
    glyphs.push({ id: 32 + i, w: 0, h: 0, xoffset: 0, yoffset: 0, xadvance: 4, img: null });
    continue;
  }
  const gw = maxC - minC + 1;
  const gh = maxR - minR + 1;
  const w = gw + 2;
  const h = gh + 2;
  const fill = (x, y) => x >= 0 && y >= 0 && x < gw && y < gh && (rows[minR + y] & (16 >> (minC + x))) !== 0;
  const img = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = x - 1, fy = y - 1;
      let px = null;
      if (fill(fx, fy)) px = minR + fy <= 3 ? TOP : BOTTOM;
      else {
        for (let dy = -1; dy <= 1 && !px; dy++) for (let dx = -1; dx <= 1 && !px; dx++) if (fill(fx + dx, fy + dy)) px = OUTLINE;
      }
      img.push(px);
    }
  // Proportional: the glyph box starts at the pen, fills are 2 outline px apart.
  glyphs.push({ id: 32 + i, w, h, xoffset: 0, yoffset: minR, xadvance: gw + 2, img });
}

// Shelf-pack with a 1-px gap.
let x = 1, y = 1, rowH = 0;
for (const g of glyphs) {
  if (!g.img) { g.x = 0; g.y = 0; continue; }
  if (x + g.w + 1 > PAGE_W) { x = 1; y += rowH + 1; rowH = 0; }
  g.x = x; g.y = y;
  x += g.w + 1;
  rowH = Math.max(rowH, g.h);
}
const PAGE_H = y + rowH + 1;
const page = new Uint8Array(PAGE_W * PAGE_H * 4);
for (const g of glyphs) {
  if (!g.img) continue;
  g.img.forEach((px, k) => {
    if (px) page.set(px, ((g.y + Math.floor(k / g.w)) * PAGE_W + g.x + (k % g.w)) * 4);
  });
}

// Kerning (only pairs whose shapes leave room; outlines may overlap, fills never do).
const KERN = { AV: -1, VA: -1, AW: -1, WA: -1, AY: -1, YA: -1, AT: -1, TA: -1, LT: -2, LV: -1, LY: -1, LW: -1, PA: -1, FA: -1, 'P.': -1, 'T.': -1, 'Y.': -1 };

const lines = [
  'info face="Pixelforge Peaks" size=12 bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=0 aa=1 padding=0,0,0,0 spacing=1,1 outline=1',
  `common lineHeight=${LINE_HEIGHT} base=${BASE} scaleW=${PAGE_W} scaleH=${PAGE_H} pages=1 packed=0 alphaChnl=0 redChnl=0 greenChnl=0 blueChnl=0`,
  'page id=0 file="peaks_0.png"',
  `chars count=${glyphs.length}`,
  ...glyphs.map((g) => `char id=${g.id} x=${g.x} y=${g.y} width=${g.w} height=${g.h} xoffset=${g.xoffset} yoffset=${g.yoffset} xadvance=${g.xadvance} page=0 chnl=15`),
  `kernings count=${Object.keys(KERN).length}`,
  ...Object.entries(KERN).map(([p, a]) => `kerning first=${p.codePointAt(0)} second=${p.codePointAt(1)} amount=${a}`),
];
mkdirSync(outFonts, { recursive: true });
writeFileSync(join(outFonts, 'peaks.fnt'), lines.join('\n') + '\n');
writeFileSync(join(outFonts, 'peaks_0.png'), png(PAGE_W, PAGE_H, page));

// ------------------------------------------------------------------ 9-slice panel (12×12, 4-px frame)
const P = 12;
const panel = new Uint8Array(P * P * 4);
const ring = [hex('#1a1c2c'), hex('#c0cbdc'), hex('#5a6988'), hex('#3a4466')];
const CENTER = hex('#29366f', 235);
for (let py = 0; py < P; py++)
  for (let px = 0; px < P; px++) {
    const d = Math.min(px, py, P - 1 - px, P - 1 - py);
    const corner = (px === 0 || px === P - 1) && (py === 0 || py === P - 1);
    const inner = (px === 1 || px === P - 2) && (py === 1 || py === P - 2);
    const c = corner ? null : inner ? ring[0] : d < 4 ? ring[d] : CENTER;
    if (c) panel.set(c, (py * P + px) * 4);
  }
mkdirSync(outUi, { recursive: true });
writeFileSync(join(outUi, 'panel.png'), png(P, P, panel));

console.log(`peaks.fnt: ${glyphs.length} chars, ${Object.keys(KERN).length} kernings, page ${PAGE_W}×${PAGE_H}; panel.png ${P}×${P}`);

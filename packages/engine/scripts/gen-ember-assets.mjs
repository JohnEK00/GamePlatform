#!/usr/bin/env node
// Generates the Ember Garden assets (examples/ember-garden/assets/):
//   fonts/ember.fnt + fonts/ember_0.png  BMFont text descriptor (with kerning) and its page: an italic,
//                                        2x, outlined two-tone face built from the engine's `pixel` glyph table
//   ui/panel.png                         12x12 9-slice dialog frame, 4-px borders
//   ui/button.png, ui/button_hover.png, ui/button_down.png   8x8 9-slice button states, 3-px borders
//   icons/ach_*.png                      32x32 achievement badges (referenced from game.json)
// Dependency-free (Node zlib for PNG). Usage (repo root): node packages/engine/scripts/gen-ember-assets.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const out = join(root, 'examples/ember-garden/assets');

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

/** A tiny RGBA canvas for the procedural images. */
class Img {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 4);
  }
  set(x, y, c) {
    if (!c || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px.set(c, (y * this.w + x) * 4);
  }
  rect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  }
  disc(cx, cy, r, c) {
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.set(x, y, c);
  }
  png() {
    return png(this.w, this.h, this.px);
  }
}

// ------------------------------------------------------------------ ember font
// Each pixel-font texel becomes 2×2, rows lean right (italic), and the fill gets a 1-px dark outline.
// White upper half / warm-grey lower half, so drawText's color tints it into two tones.
const TOP = hex('#ffffff');
const BOTTOM = hex('#d8c3a5');
const OUTLINE = hex('#140d1f');
const PAGE_W = 256;
const SIZE = 20;
const LINE_HEIGHT = 22;
const BASE = 16; // pixel baseline row 7 → 2x rows 14–15, +1 for the outline
const SHEAR = (y2) => Math.floor((17 - y2) / 6); // 0..2 px lean

const glyphs = [];
for (let i = 0; i < 95; i++) {
  const rows = rowsOf(i);
  const filled = new Set();
  rows.forEach((bits, r) => {
    for (let c = 0; c < 5; c++)
      if (bits & (16 >> c))
        for (let dy = 0; dy < 2; dy++) {
          const y2 = r * 2 + dy;
          for (let dx = 0; dx < 2; dx++) filled.add(`${c * 2 + dx + SHEAR(y2)},${y2}`);
        }
  });
  if (!filled.size) {
    glyphs.push({ id: 32 + i, w: 0, h: 0, xoffset: 0, yoffset: 0, xadvance: 8, img: null });
    continue;
  }
  const pts = [...filled].map((k) => k.split(',').map(Number));
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  const gw = maxX - minX + 1;
  const gh = maxY - minY + 1;
  const w = gw + 2;
  const h = gh + 2;
  const fill = (x, y) => filled.has(`${minX + x},${minY + y}`);
  const img = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = x - 1, fy = y - 1;
      let px = null;
      if (fill(fx, fy)) px = minY + fy <= 7 ? TOP : BOTTOM;
      else for (let dy = -1; dy <= 1 && !px; dy++) for (let dx = -1; dx <= 1 && !px; dx++) if (fill(fx + dx, fy + dy)) px = OUTLINE;
      img.push(px);
    }
  // Proportional: the glyph box starts at the pen (the lean lives inside the image), fills 2 px apart.
  glyphs.push({ id: 32 + i, w, h, xoffset: 0, yoffset: minY, xadvance: gw + 2, img });
}

// Shelf-pack with a 1-px gap.
let px0 = 1, py0 = 1, rowH = 0;
for (const g of glyphs) {
  if (!g.img) { g.x = 0; g.y = 0; continue; }
  if (px0 + g.w + 1 > PAGE_W) { px0 = 1; py0 += rowH + 1; rowH = 0; }
  g.x = px0; g.y = py0;
  px0 += g.w + 1;
  rowH = Math.max(rowH, g.h);
}
const PAGE_H = py0 + rowH + 1;
const page = new Uint8Array(PAGE_W * PAGE_H * 4);
for (const g of glyphs) {
  if (!g.img) continue;
  g.img.forEach((c, k) => {
    if (c) page.set(c, ((g.y + Math.floor(k / g.w)) * PAGE_W + g.x + (k % g.w)) * 4);
  });
}

// Kerning: the lean leaves room after tall-left/short-right pairs.
const KERN = { AV: -2, VA: -2, AW: -2, WA: -2, AY: -2, YA: -2, AT: -2, TA: -2, LT: -3, LV: -2, LY: -2, PA: -2, FA: -2, 'T.': -2, 'Y.': -2, 'F.': -2, To: -2, Te: -2, Ta: -2 };

const lines = [
  'info face="Pixelforge Ember Italic" size=20 bold=1 italic=1 charset="" unicode=1 stretchH=100 smooth=0 aa=1 padding=0,0,0,0 spacing=1,1 outline=1',
  `common lineHeight=${LINE_HEIGHT} base=${BASE} scaleW=${PAGE_W} scaleH=${PAGE_H} pages=1 packed=0 alphaChnl=0 redChnl=0 greenChnl=0 blueChnl=0`,
  'page id=0 file="ember_0.png"',
  `chars count=${glyphs.length}`,
  ...glyphs.map((g) => `char id=${g.id} x=${g.x} y=${g.y} width=${g.w} height=${g.h} xoffset=${g.xoffset} yoffset=${g.yoffset} xadvance=${g.xadvance} page=0 chnl=15`),
  `kernings count=${Object.keys(KERN).length}`,
  ...Object.entries(KERN).map(([p, a]) => `kerning first=${p.codePointAt(0)} second=${p.codePointAt(1)} amount=${a}`),
];
mkdirSync(join(out, 'fonts'), { recursive: true });
writeFileSync(join(out, 'fonts/ember.fnt'), lines.join('\n') + '\n');
writeFileSync(join(out, 'fonts/ember_0.png'), png(PAGE_W, PAGE_H, page));

// ------------------------------------------------------------------ 9-slices
mkdirSync(join(out, 'ui'), { recursive: true });
{
  // Dialog: 12×12, 4-px frame — night-blue core, amber lamp-glass ring.
  const P = 12;
  const img = new Img(P, P);
  const ring = [hex('#0b0816'), hex('#f4a340'), hex('#9c4a1a'), hex('#2a1d45')];
  for (let y = 0; y < P; y++)
    for (let x = 0; x < P; x++) {
      const d = Math.min(x, y, P - 1 - x, P - 1 - y);
      const corner = (x === 0 || x === P - 1) && (y === 0 || y === P - 1);
      const inner = (x === 1 || x === P - 2) && (y === 1 || y === P - 2);
      img.set(x, y, corner ? null : inner ? ring[0] : d < 4 ? ring[d] : hex('#1b1430', 238));
    }
  writeFileSync(join(out, 'ui/panel.png'), img.png());
}
function button(file, border, fill, light, shade) {
  const B = 8;
  const img = new Img(B, B);
  for (let y = 0; y < B; y++)
    for (let x = 0; x < B; x++) {
      const corner = (x === 0 || x === B - 1) && (y === 0 || y === B - 1);
      if (corner) continue;
      const edge = x === 0 || y === 0 || x === B - 1 || y === B - 1;
      img.set(x, y, edge ? border : y === 1 ? light : y === B - 2 ? shade : fill);
    }
  writeFileSync(join(out, `ui/${file}`), img.png());
}
button('button.png', hex('#7a4422'), hex('#2b1f3d'), hex('#4a3560'), hex('#1a1226'));
button('button_hover.png', hex('#f4a340'), hex('#4a2f52'), hex('#6e4778'), hex('#2b1f3d'));
button('button_down.png', hex('#c46a28'), hex('#1a1226'), hex('#140d1f'), hex('#2b1f3d'));

// ------------------------------------------------------------------ achievement badges (32×32)
mkdirSync(join(out, 'icons'), { recursive: true });
function badge(file, draw) {
  const img = new Img(32, 32);
  img.disc(16, 16, 15.5, hex('#f4a340'));
  img.disc(16, 16, 14, hex('#9c4a1a'));
  img.disc(16, 16, 13, hex('#1b1430'));
  draw(img);
  writeFileSync(join(out, `icons/${file}`), img.png());
}
const FLAME = [hex('#fff3b0'), hex('#ffd166'), hex('#f4a340'), hex('#e0592a')];
const flame = (img, cx, cy, s) => {
  img.disc(cx, cy + 2 * s, 4 * s, FLAME[3]);
  img.disc(cx, cy + 1 * s, 3 * s, FLAME[2]);
  img.rect(cx - 1 * s, cy - 4 * s, 2 * s, 4 * s, FLAME[2]);
  img.disc(cx, cy + 2 * s, 2 * s, FLAME[1]);
  img.rect(cx - Math.max(1, s / 2), cy - 2 * s, Math.max(1, s), 3 * s, FLAME[0]);
};
badge('ach_first_light.png', (img) => {
  img.rect(14, 22, 4, 4, hex('#5a4a6a'));
  img.rect(11, 25, 10, 2, hex('#3a2d4a'));
  flame(img, 16, 13, 2);
});
badge('ach_moth_catcher.png', (img) => {
  const wing = hex('#c9b8e8');
  const dark = hex('#7d6aa3');
  img.disc(10, 12, 5, wing); img.disc(22, 12, 5, wing);
  img.disc(11, 20, 4, dark); img.disc(21, 20, 4, dark);
  img.rect(15, 9, 2, 14, hex('#3a2d4a'));
  img.set(14, 8, hex('#c9b8e8')); img.set(17, 8, hex('#c9b8e8'));
  // net rim
  for (let a = 0; a < 40; a++) {
    const t = (a / 40) * Math.PI * 2;
    img.set(Math.round(16 + Math.cos(t) * 11), Math.round(16 + Math.sin(t) * 11), hex('#e8e0d0'));
  }
});
badge('ach_full_bloom.png', (img) => {
  const pos = [[9, 11], [23, 11], [9, 22], [23, 22], [16, 16]];
  for (const [x, y] of pos) {
    img.disc(x, y, 4, hex('#f4a340', 140));
    img.disc(x, y, 2, hex('#fff3b0'));
  }
});
badge('ach_night_owl.png', (img) => {
  img.disc(16, 16, 8, hex('#fff3b0'));
  img.disc(19, 13, 7, hex('#1b1430'));
  for (const [x, y] of [[8, 9], [24, 22], [11, 24], [23, 8]]) img.set(x, y, hex('#ffffff'));
});
badge('ach_ember_master.png', (img) => {
  const c = hex('#ffd166');
  // five-point star by polygon test
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? 4.5 : 11;
    const t = -Math.PI / 2 + (k * Math.PI) / 5;
    pts.push([16 + Math.cos(t) * r, 16.5 + Math.sin(t) * r]);
  }
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > y + 0.5 !== yj > y + 0.5 && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) img.set(x, y, c);
    }
  img.disc(16, 16, 2, hex('#fff3b0'));
});

console.log(`ember.fnt: ${glyphs.length} chars, ${Object.keys(KERN).length} kernings, page ${PAGE_W}×${PAGE_H}; ui 9-slices: panel, button ×3; 5 badges`);

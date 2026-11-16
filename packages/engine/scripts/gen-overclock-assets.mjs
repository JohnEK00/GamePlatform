#!/usr/bin/env node
// Generates the Overclock assets (examples/overclock/assets/):
//   fonts/overclock.fnt + fonts/overclock_0.png  BMFont text descriptor (with kerning) and its page: an upright,
//                                                2x, block face with a dark outline and a 1-px extruded underside,
//                                                built from the engine's `pixel` glyph table
//   ui/panel.png                                 12x12 9-slice dialog frame with chamfered corners, 4-px borders
//   ui/button.png, ui/button_hover.png, ui/button_down.png   8x8 9-slice button states, 3-px borders
//   icons/ach_*.png                              32x32 hex-nut achievement badges (referenced from game.json)
// The floors (assets/floors.json) are hand-authored, not generated.
// Dependency-free (Node zlib for PNG). Usage (repo root): node packages/engine/scripts/gen-overclock-assets.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const out = join(root, 'examples/overclock/assets');

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
  /** Fills a polygon (even-odd rule, pixel centres). */
  poly(pts, c) {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i];
          const [xj, yj] = pts[j];
          if (yi > y + 0.5 !== yj > y + 0.5 && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) this.set(x, y, c);
      }
  }
  line(x0, y0, x1, y1, c) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
    for (let i = 0; i <= n; i++) this.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c);
  }
  png() {
    return png(this.w, this.h, this.px);
  }
}

// ------------------------------------------------------------------ overclock font
// Each pixel-font texel becomes 2×2 and upright; the fill gets a 1-px dark outline plus one extra dark row
// under every filled column (an extruded "stamped metal" underside). White upper half, cool grey lower half,
// so drawText's color tints it into two tones.
const TOP = hex('#ffffff');
const BOTTOM = hex('#b8c7cf');
const OUTLINE = hex('#0b1016');
const PAGE_W = 256;
const SIZE = 20;
const LINE_HEIGHT = 22;
const BASE = 16; // pixel baseline row 7 → 2x rows 14–15, +1 for the outline

const glyphs = [];
for (let i = 0; i < 95; i++) {
  const rows = rowsOf(i);
  const filled = new Set();
  rows.forEach((bits, r) => {
    for (let c = 0; c < 5; c++)
      if (bits & (16 >> c))
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) filled.add(`${c * 2 + dx},${r * 2 + dy}`);
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
  const h = gh + 3; // outline top/bottom + one extruded row
  const fill = (x, y) => filled.has(`${minX + x},${minY + y}`);
  const img = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = x - 1, fy = y - 1;
      let px = null;
      if (fill(fx, fy)) px = minY + fy <= 7 ? TOP : BOTTOM;
      else {
        for (let dy = -1; dy <= 1 && !px; dy++) for (let dx = -1; dx <= 1 && !px; dx++) if (fill(fx + dx, fy + dy)) px = OUTLINE;
        if (!px && fill(fx, fy - 2)) px = OUTLINE; // extrusion
      }
      img.push(px);
    }
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

// Kerning: a few open pairs.
const KERN = { AV: -2, VA: -2, AT: -2, TA: -2, LT: -2, LV: -2, LY: -2, YA: -2, PA: -1, FA: -1, 'T.': -2, 'Y.': -2, 'F.': -2, 'L ': -1 };

const lines = [
  'info face="Pixelforge Overclock Block" size=20 bold=1 italic=0 charset="" unicode=1 stretchH=100 smooth=0 aa=1 padding=0,0,0,0 spacing=1,1 outline=1',
  `common lineHeight=${LINE_HEIGHT} base=${BASE} scaleW=${PAGE_W} scaleH=${PAGE_H} pages=1 packed=0 alphaChnl=0 redChnl=0 greenChnl=0 blueChnl=0`,
  'page id=0 file="overclock_0.png"',
  `chars count=${glyphs.length}`,
  ...glyphs.map((g) => `char id=${g.id} x=${g.x} y=${g.y} width=${g.w} height=${g.h} xoffset=${g.xoffset} yoffset=${g.yoffset} xadvance=${g.xadvance} page=0 chnl=15`),
  `kernings count=${Object.keys(KERN).length}`,
  ...Object.entries(KERN).map(([p, a]) => `kerning first=${p.codePointAt(0)} second=${p.codePointAt(1)} amount=${a}`),
];
mkdirSync(join(out, 'fonts'), { recursive: true });
writeFileSync(join(out, 'fonts/overclock.fnt'), lines.join('\n') + '\n');
writeFileSync(join(out, 'fonts/overclock_0.png'), png(PAGE_W, PAGE_H, page));

// ------------------------------------------------------------------ 9-slices
mkdirSync(join(out, 'ui'), { recursive: true });
{
  // Dialog: 12×12, 4-px frame — chamfered slate plate with a teal trim line and amber corner rivets.
  const P = 12;
  const img = new Img(P, P);
  const ring = [hex('#0b1016'), hex('#3fc1b0'), hex('#3b4654'), hex('#1e252e')];
  for (let y = 0; y < P; y++)
    for (let x = 0; x < P; x++) {
      const d = Math.min(x, y, P - 1 - x, P - 1 - y);
      const cx = Math.min(x, P - 1 - x);
      const cy = Math.min(y, P - 1 - y);
      if (cx + cy < 2) continue; // chamfer
      const edge = cx + cy === 2; // the chamfer's own edge stays dark
      img.set(x, y, edge ? ring[0] : d < 4 ? ring[d] : hex('#151b22', 240));
    }
  for (const [x, y] of [[2, 2], [P - 3, 2], [2, P - 3], [P - 3, P - 3]]) img.set(x, y, hex('#ffb000'));
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
button('button.png', hex('#2a8f86'), hex('#222b35'), hex('#334050'), hex('#161c24'));
button('button_hover.png', hex('#ffb000'), hex('#2f3b48'), hex('#45566a'), hex('#222b35'));
button('button_down.png', hex('#c47a00'), hex('#141a21'), hex('#0b1016'), hex('#222b35'));

// ------------------------------------------------------------------ achievement badges (32×32 hex nuts)
mkdirSync(join(out, 'icons'), { recursive: true });
const AMBER = hex('#ffb000');
const AMBER_D = hex('#c47a00');
const TEAL = hex('#3fc1b0');
const STEEL = hex('#c9d3dc');
const STEEL_D = hex('#7d8a96');
const hexagon = (r) => Array.from({ length: 6 }, (_, k) => [16 + Math.cos((k * Math.PI) / 3) * r, 16 + Math.sin((k * Math.PI) / 3) * r]);
function badge(file, draw) {
  const img = new Img(32, 32);
  img.poly(hexagon(16), hex('#0b1016'));
  img.poly(hexagon(15), TEAL);
  img.poly(hexagon(13.5), hex('#2a323d'));
  img.poly(hexagon(12.5), hex('#1b2129'));
  draw(img);
  writeFileSync(join(out, `icons/${file}`), img.png());
}
// swing_shift: a door swinging on its hinge with a motion arc
badge('ach_swing_shift.png', (img) => {
  img.rect(8, 9, 2, 15, STEEL_D); // frame
  img.disc(9, 10, 1.6, AMBER); // hinge
  img.line(9, 10, 23, 18, STEEL);
  img.line(9, 11, 23, 19, STEEL);
  for (let a = 0; a < 14; a++) {
    const t = -0.2 + (a / 14) * 0.9;
    img.set(Math.round(9 + Math.cos(t) * 16), Math.round(10 + Math.sin(t) * 16), AMBER_D);
  }
  for (const [x, y] of [[22, 22], [24, 20], [20, 24]]) img.set(x, y, AMBER);
});
// spanner: a thrown wrench with speed lines
badge('ach_spanner.png', (img) => {
  img.line(10, 22, 20, 12, STEEL);
  img.line(11, 22, 21, 12, STEEL);
  img.disc(21.5, 10.5, 3.5, STEEL);
  img.disc(22.5, 9.5, 1.6, hex('#1b2129'));
  img.disc(9.5, 22.5, 2.5, STEEL);
  for (const [x, y, l] of [[6, 14, 4], [5, 17, 5], [8, 11, 3]]) img.rect(x, y, l, 1, AMBER);
});
// overclocked: a gauge needle pinned in the red
badge('ach_overclocked.png', (img) => {
  for (let a = 0; a <= 20; a++) {
    const t = Math.PI + (a / 20) * Math.PI;
    img.set(Math.round(16 + Math.cos(t) * 10), Math.round(19 + Math.sin(t) * 10), a > 14 ? hex('#ff5a3c') : STEEL_D);
    img.set(Math.round(16 + Math.cos(t) * 9), Math.round(19 + Math.sin(t) * 9), a > 14 ? hex('#ff5a3c') : STEEL_D);
  }
  img.line(16, 19, 24, 12, AMBER);
  img.disc(16, 19, 2, STEEL);
  img.rect(12, 23, 9, 2, TEAL);
});
// hands_on: a gripper claw
badge('ach_hands_on.png', (img) => {
  img.rect(14, 8, 4, 8, STEEL_D);
  img.rect(10, 15, 12, 3, STEEL);
  img.rect(10, 18, 3, 6, STEEL);
  img.rect(19, 18, 3, 6, STEEL);
  img.rect(12, 23, 2, 2, AMBER);
  img.rect(18, 23, 2, 2, AMBER);
});
// zero_downtime: a big S on a status light
badge('ach_zero_downtime.png', (img) => {
  img.disc(16, 16, 9, hex('#123b37'));
  const S = ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'];
  S.forEach((row, y) => [...row].forEach((ch, x) => ch === '#' && img.rect(11 + x * 2, 9 + y * 2, 2, 2, AMBER)));
});
// facility_offline: a power symbol
badge('ach_facility_offline.png', (img) => {
  for (let a = 0; a < 48; a++) {
    const t = (a / 48) * Math.PI * 2;
    if (Math.abs(Math.atan2(Math.sin(t + Math.PI / 2), Math.cos(t + Math.PI / 2))) < 0.6) continue;
    for (const r of [8, 9]) img.set(Math.round(16 + Math.cos(t) * r), Math.round(17 + Math.sin(t) * r), TEAL);
  }
  img.rect(15, 6, 2, 10, AMBER);
});

console.log(`overclock.fnt: ${glyphs.length} chars, ${Object.keys(KERN).length} kernings, page ${PAGE_W}×${PAGE_H}; ui 9-slices: panel, button ×3; 6 badges`);

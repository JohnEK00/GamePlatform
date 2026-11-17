#!/usr/bin/env node
// Generates the Kiln Clash assets (examples/kiln-clash/assets/):
//   fonts/kiln.fnt + fonts/kiln_0.png   BMFont text descriptor (with kerning) and its page: a 2x "fired clay" face
//                                       built from the engine's `pixel` glyph table, with a cream glaze on the
//                                       upper half, a dark outline and a 1-px kiln shadow down and to the right
//   ui/panel.png                        12x12 9-slice dialog frame, 4-px borders: terracotta rim, glaze line, ash fill
//   ui/button.png, ui/button_hover.png, ui/button_down.png   8x8 9-slice button states, 3-px borders
//   icons/ach_*.png                     32x32 round "kiln seal" achievement badges (referenced from game.json)
// The fighters' frame data (assets/fighters.json) is hand-authored, not generated.
// Dependency-free (Node zlib for PNG). Usage (repo root): node packages/engine/scripts/gen-kiln-assets.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const out = join(root, 'examples/kiln-clash/assets');

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
/** RGBA (Uint8Array, w*h*4) -> PNG bytes. */
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
  ring(cx, cy, r0, r1, c) {
    for (let y = Math.floor(cy - r1); y <= cy + r1; y++)
      for (let x = Math.floor(cx - r1); x <= cx + r1; x++) {
        const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
        if (d <= r1 * r1 && d >= r0 * r0) this.set(x, y, c);
      }
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

// ------------------------------------------------------------------ kiln font
// Each pixel-font texel becomes 2x2. The fill is white on the upper half and a warm grey below (drawText's color
// tints both, giving a glazed two-tone look), with a 1-px dark outline and a dark shadow 1 px right and 1 px down.
const TOP = hex('#ffffff');
const BOTTOM = hex('#e2c9ae');
const OUTLINE = hex('#120b10');
const SHADOW = hex('#3a1a12');
const PAGE_W = 256;
const LINE_HEIGHT = 22;
const BASE = 16;

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
  const w = gw + 3; // outline both sides + shadow column
  const h = gh + 3; // outline top/bottom + shadow row
  const fill = (x, y) => filled.has(`${minX + x},${minY + y}`);
  const outlineAt = (fx, fy) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (fill(fx + dx, fy + dy)) return true;
    return false;
  };
  const img = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = x - 1;
      const fy = y - 1;
      let px = null;
      if (fill(fx, fy)) px = minY + fy <= 7 ? TOP : BOTTOM;
      else if (outlineAt(fx, fy)) px = OUTLINE;
      else if (outlineAt(fx - 1, fy - 1)) px = SHADOW;
      img.push(px);
    }
  glyphs.push({ id: 32 + i, w, h, xoffset: 0, yoffset: minY, xadvance: gw + 2, img });
}

// Shelf-pack with a 1-px gap.
let px0 = 1;
let py0 = 1;
let rowH = 0;
for (const g of glyphs) {
  if (!g.img) {
    g.x = 0;
    g.y = 0;
    continue;
  }
  if (px0 + g.w + 1 > PAGE_W) {
    px0 = 1;
    py0 += rowH + 1;
    rowH = 0;
  }
  g.x = px0;
  g.y = py0;
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

const KERN = { AV: -2, VA: -2, AT: -2, TA: -2, LT: -2, LV: -2, LY: -2, YA: -2, PA: -1, FA: -1, 'T.': -2, 'Y.': -2, AW: -1, WA: -1 };

const lines = [
  'info face="Pixelforge Kiln Clay" size=20 bold=1 italic=0 charset="" unicode=1 stretchH=100 smooth=0 aa=1 padding=0,0,0,0 spacing=1,1 outline=1',
  `common lineHeight=${LINE_HEIGHT} base=${BASE} scaleW=${PAGE_W} scaleH=${PAGE_H} pages=1 packed=0 alphaChnl=0 redChnl=0 greenChnl=0 blueChnl=0`,
  'page id=0 file="kiln_0.png"',
  `chars count=${glyphs.length}`,
  ...glyphs.map((g) => `char id=${g.id} x=${g.x} y=${g.y} width=${g.w} height=${g.h} xoffset=${g.xoffset} yoffset=${g.yoffset} xadvance=${g.xadvance} page=0 chnl=15`),
  `kernings count=${Object.keys(KERN).length}`,
  ...Object.entries(KERN).map(([p, a]) => `kerning first=${p.codePointAt(0)} second=${p.codePointAt(1)} amount=${a}`),
];
mkdirSync(join(out, 'fonts'), { recursive: true });
writeFileSync(join(out, 'fonts/kiln.fnt'), lines.join('\n') + '\n');
writeFileSync(join(out, 'fonts/kiln_0.png'), png(PAGE_W, PAGE_H, page));

// ------------------------------------------------------------------ 9-slices
mkdirSync(join(out, 'ui'), { recursive: true });
{
  // Dialog: 12x12, 4-px frame. Rounded terracotta rim, a thin glaze line inside it, translucent ash fill.
  const P = 12;
  const img = new Img(P, P);
  const ring = [hex('#120b10'), hex('#c8663b'), hex('#f2d27a'), hex('#4a2a22')];
  for (let y = 0; y < P; y++)
    for (let x = 0; x < P; x++) {
      const cx = Math.min(x, P - 1 - x);
      const cy = Math.min(y, P - 1 - y);
      if (cx + cy < 1) continue; // rounded corner
      const d = Math.min(cx, cy);
      img.set(x, y, cx + cy === 1 ? ring[0] : d < 4 ? ring[d] : hex('#1c1219', 236));
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
button('button.png', hex('#a4502c'), hex('#2b1d1f'), hex('#3d2a2a'), hex('#1a1013'));
button('button_hover.png', hex('#f2d27a'), hex('#4a2a22'), hex('#6b3d2c'), hex('#2b1d1f'));
button('button_down.png', hex('#ff8a3c'), hex('#1a1013'), hex('#120b10'), hex('#2b1d1f'));

// ------------------------------------------------------------------ achievement badges (32x32 kiln seals)
mkdirSync(join(out, 'icons'), { recursive: true });
const INK = hex('#120b10');
const CLAY = hex('#c8663b');
const CLAY_D = hex('#7d3a20');
const GLAZE = hex('#f2d27a');
const EMBER = hex('#ff8a3c');
const CREAM = hex('#f3e6d0');
const CELADON = hex('#8fbfa0');
function badge(file, draw) {
  const img = new Img(32, 32);
  img.disc(16, 16, 16, INK);
  img.disc(16, 16, 15, CLAY);
  img.ring(16, 16, 13, 14, GLAZE);
  img.disc(16, 16, 12.5, hex('#2b1d1f'));
  draw(img);
  writeFileSync(join(out, `icons/${file}`), img.png());
}
const vase = (img, cx, color) => {
  img.poly([[cx - 3, 7], [cx + 3, 7], [cx + 2, 10], [cx + 7, 15], [cx + 6, 23], [cx + 3, 25], [cx - 3, 25], [cx - 6, 23], [cx - 7, 15], [cx - 2, 10]], color);
};
// perfect_firing: a flawless glazed vase with a sparkle
badge('ach_perfect_firing.png', (img) => {
  vase(img, 15, CELADON);
  img.rect(10, 16, 10, 1, hex('#c9ead2'));
  for (const [x, y] of [[23, 7], [23, 9], [22, 8], [24, 8], [23, 8]]) img.set(x, y, CREAM);
});
// kiln_burst: an eight-point flame burst
badge('ach_kiln_burst.png', (img) => {
  const pts = [];
  for (let k = 0; k < 16; k++) {
    const r = k % 2 ? 4.5 : 11;
    const a = (k / 16) * Math.PI * 2 - Math.PI / 2;
    pts.push([16 + Math.cos(a) * r, 16 + Math.sin(a) * r]);
  }
  img.poly(pts, EMBER);
  img.disc(16, 16, 4, GLAZE);
  img.disc(16, 16, 2, CREAM);
});
// ten_hit: "10" over a spray of shards
badge('ach_ten_hit.png', (img) => {
  for (const [x, y] of [[8, 22], [11, 25], [21, 24], [24, 21], [9, 9], [23, 9]]) img.rect(x, y, 2, 2, CLAY);
  img.rect(9, 9, 3, 13, GLAZE);
  img.rect(8, 10, 1, 2, GLAZE);
  img.rect(14, 9, 9, 13, GLAZE);
  img.rect(16, 11, 5, 9, hex('#2b1d1f'));
});
// clean_break: a ring split into two halves pushed apart
badge('ach_clean_break.png', (img) => {
  const half = new Img(32, 32);
  half.ring(16, 16, 5, 8, CREAM);
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      const i = (y * 32 + x) * 4;
      if (!half.px[i + 3]) continue;
      const c = [half.px[i], half.px[i + 1], half.px[i + 2], 255];
      if (x < 16) img.set(x - 3, y, c);
      else img.set(x + 3, y, c);
    }
  img.line(16, 8, 16, 24, EMBER);
});
// ladder_fired: a ladder of four rungs climbing into the glow
badge('ach_ladder_fired.png', (img) => {
  img.disc(16, 8, 5, EMBER);
  img.rect(10, 8, 2, 18, CLAY_D);
  img.rect(20, 8, 2, 18, CLAY_D);
  for (let k = 0; k < 4; k++) img.rect(10, 11 + k * 4, 12, 2, GLAZE);
});
// hard_fired: a bottle kiln with a roaring door
badge('ach_hard_fired.png', (img) => {
  img.poly([[9, 25], [23, 25], [19, 11], [13, 11]], hex('#5f7486'));
  img.rect(14, 7, 4, 5, hex('#5f7486'));
  img.rect(14, 18, 4, 7, EMBER);
  img.rect(15, 20, 2, 5, GLAZE);
  for (const [x, y] of [[15, 5], [17, 4], [16, 3]]) img.set(x, y, hex('#9a8478'));
});

console.log(`kiln.fnt: ${glyphs.length} chars, ${Object.keys(KERN).length} kernings, page ${PAGE_W}x${PAGE_H}; ui 9-slices: panel, button x3; 6 badges`);

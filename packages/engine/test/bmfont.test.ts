import { describe, expect, it, vi } from 'vitest';
import { resolveFontPages } from '../src/assets';
import { BitmapFont, layoutText, parseBMFont, type BitmapFontData } from '../src/bmfont';
import { mimeType } from '../src/files';
import { PIXEL_GLYPHS, pixelFontData, pixelFontImage, pixelGlyphRows } from '../src/pixelfont';
import { Texture, type TexturePage } from '../src/texture';

const page = (w = 256, h = 256): Texture => new Texture({ glTexture: {} as WebGLTexture, width: w, height: h, white: null } as TexturePage, w, h, 0, 0, 1, 1);

const TEXT = `info face="Press Start 2P" size=-32 bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=1 aa=1 padding=0,0,0,0 spacing=1,1
common lineHeight=36 base=28 scaleW=256 scaleH=256 pages=2 packed=0
page id=0 file="my font_0.png"
page id=1 file="my font_1.png"
chars count=3
char id=65   x=0  y=0  width=20 height=24 xoffset=1 yoffset=4 xadvance=22 page=0 chnl=15
char id=86   x=24 y=0  width=20 height=24 xoffset=0 yoffset=4 xadvance=21 page=1 chnl=15
char id=32   x=0  y=0  width=0  height=0  xoffset=0 yoffset=0 xadvance=10 page=0 chnl=15
kernings count=2
kerning first=65 second=86 amount=-3
kerning first=86 second=65 amount=-2
`;

const JSON_FONT = {
  info: { face: 'Press Start 2P', size: -32 },
  common: { lineHeight: 36, base: 28, scaleW: 256, scaleH: 256, pages: 2, packed: 0 },
  pages: ['my font_0.png', 'my font_1.png'],
  chars: [
    { id: 65, x: 0, y: 0, width: 20, height: 24, xoffset: 1, yoffset: 4, xadvance: 22, page: 0, chnl: 15 },
    { id: 86, x: 24, y: 0, width: 20, height: 24, xoffset: 0, yoffset: 4, xadvance: 21, page: 1, chnl: 15 },
    { id: 32, x: 0, y: 0, width: 0, height: 0, xoffset: 0, yoffset: 0, xadvance: 10, page: 0, chnl: 15 },
  ],
  kernings: [
    { first: 65, second: 86, amount: -3 },
    { first: 86, second: 65, amount: -2 },
  ],
};

/** A minimal valid JSON descriptor with overrides. */
function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    common: { lineHeight: 10, base: 8 },
    pages: ['a.png'],
    chars: [{ id: 65, x: 0, y: 0, width: 5, height: 7, xadvance: 6 }],
    ...over,
  };
}

describe('parseBMFont', () => {
  it('parses the text format (quoted values, negative size, two pages, kernings)', () => {
    const d = parseBMFont(TEXT, 'assets/f.fnt');
    expect(d.face).toBe('Press Start 2P');
    expect(d.size).toBe(32);
    expect(d.lineHeight).toBe(36);
    expect(d.base).toBe(28);
    expect(d.scaleW).toBe(256);
    expect(d.pages).toEqual(['my font_0.png', 'my font_1.png']);
    expect(d.chars).toHaveLength(3);
    expect(d.chars[1]).toEqual({ id: 86, x: 24, y: 0, width: 20, height: 24, xoffset: 0, yoffset: 4, xadvance: 21, page: 1 });
    expect(d.kernings).toEqual([{ first: 65, second: 86, amount: -3 }, { first: 86, second: 65, amount: -2 }]);
    expect(d.warnings).toEqual([]);
  });

  it('gives identical data for the JSON format (string or object)', () => {
    const t = parseBMFont(TEXT, 'x');
    expect(parseBMFont(JSON_FONT, 'x')).toEqual(t);
    expect(parseBMFont('﻿  ' + JSON.stringify(JSON_FONT), 'x')).toEqual(t);
  });

  it('rejects XML', () => {
    expect(() => parseBMFont('﻿\n  <?xml version="1.0"?><font></font>', 'assets/a.fnt')).toThrow(
      'BMFont "assets/a.fnt": BMFont XML is not supported; export the text or JSON format',
    );
  });

  it('size 0 or absent falls back to lineHeight; face defaults to ""', () => {
    const d = parseBMFont(base());
    expect(d.size).toBe(10);
    expect(d.face).toBe('');
    expect(d.scaleW).toBeNull();
  });

  const bad: [string, Record<string, unknown> | string, RegExp][] = [
    ['0 pages', base({ pages: [] }), /pages must have 1 to 16 entries/],
    ['17 pages', base({ pages: Array.from({ length: 17 }, (_, i) => `p${i}.png`) }), /pages must have 1 to 16 entries/],
    ['8193 chars', base({ chars: Array.from({ length: 8193 }, (_, i) => ({ id: i, x: 0, y: 0, width: 1, height: 1, xadvance: 1 })) }), /chars must have 1 to 8192 entries/],
    ['0 chars', base({ chars: [] }), /chars must have 1 to 8192 entries/],
    ['65537 kernings', base({ kernings: Array.from({ length: 65537 }, () => ({ first: 1, second: 2, amount: 1 })) }), /kernings must have at most 65536/],
    ['missing common', base({ common: undefined }), /common is missing/],
    ['missing lineHeight', base({ common: { base: 3 } }), /common.lineHeight is required/],
    ['negative width', base({ chars: [{ id: 65, x: 0, y: 0, width: -1, height: 7, xadvance: 6 }] }), /char\[0\]\.width must be a number from 0 to 4096/],
    ['page out of range', base({ chars: [{ id: 65, x: 0, y: 0, width: 1, height: 7, xadvance: 6, page: 1 }] }), /char\[0\]\.page must be a number from 0 to 0/],
    ['code point too big', base({ chars: [{ id: 0x110000, x: 0, y: 0, width: 1, height: 7, xadvance: 6 }] }), /char\[0\]\.id must be a number from 0 to 1114111/],
    ['non-numeric', base({ chars: [{ id: 65, x: 'abc', y: 0, width: 1, height: 7, xadvance: 6 }] }), /char\[0\]\.x must be a number/],
    ['missing xadvance', base({ chars: [{ id: 65, x: 0, y: 0, width: 1, height: 7 }] }), /char\[0\]\.xadvance is required/],
    ['out of range number', base({ chars: [{ id: 65, x: 0, y: 0, width: 1, height: 7, xadvance: 40000 }] }), /xadvance must be a number from -32768 to 32767/],
    ['packed', base({ common: { lineHeight: 10, base: 8, packed: 1 } }), /channel-packed fonts are not supported/],
    ['scaleW 0', base({ common: { lineHeight: 10, base: 8, scaleW: 0 } }), /common.scaleW must be a number from 1 to 8192/],
    ['absolute page', base({ pages: ['https://evil.test/a.png'] }), /pages\[0\] must be a relative png/],
    ['non-image page', base({ pages: ['a.txt'] }), /pages\[0\] must be a relative png/],
    ['kerning cp', base({ kernings: [{ first: -1, second: 2, amount: 1 }] }), /kerning\[0\]\.first must be a number from 0 to 1114111/],
    ['text page gap', 'common lineHeight=10 base=8\npage id=0 file="a.png"\npage id=2 file="b.png"\nchar id=65 x=0 y=0 width=1 height=1 xadvance=1', /page\[1\]\.id must be a number from 0 to 1/],
    ['text non-numeric', 'common lineHeight=10 base=8\npage id=0 file="a.png"\nchar id=65 x=zz y=0 width=1 height=1 xadvance=1', /char\[0\]\.x must be a number/],
    ['text packed', 'common lineHeight=10 base=8 packed=1\npage id=0 file="a.png"\nchar id=65 x=0 y=0 width=1 height=1 xadvance=1', /channel-packed/],
    ['text missing common', 'page id=0 file="a.png"\nchar id=65 x=0 y=0 width=1 height=1 xadvance=1', /common is missing/],
  ];
  it.each(bad)('rejects %s', (_n, src, re) => {
    let msg = '';
    try {
      parseBMFont(src, 'assets/a.fnt');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg.startsWith('BMFont "assets/a.fnt": ')).toBe(true);
    expect(msg).toMatch(re);
  });

  it('rounds fractional fields instead of rejecting them', () => {
    const d = parseBMFont('common lineHeight=10 base=8\npage id=0 file="a.png"\nchar id=65 x=0 y=0 width=5 height=7 xoffset=1.6 yoffset=-0.4 xadvance=6');
    expect(d.chars[0]!.xoffset).toBe(2);
    expect(d.chars[0]!.yoffset).toBe(0);
  });

  it('keeps the first of duplicate char ids, with a warning', () => {
    const d = parseBMFont(base({ chars: [{ id: 65, x: 0, y: 0, width: 5, height: 7, xadvance: 6 }, { id: 65, x: 9, y: 0, width: 5, height: 7, xadvance: 9 }] }));
    expect(d.chars).toHaveLength(1);
    expect(d.chars[0]!.xadvance).toBe(6);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatch(/duplicate char id 65/);
  });

  it('accepts distanceField with a warning', () => {
    const d = parseBMFont(base({ distanceField: { fieldType: 'msdf', distanceRange: 4 } }));
    expect(d.warnings.some((w) => /distance-field/.test(w))).toBe(true);
  });

  it('duplicate kerning pairs: the last wins', () => {
    const d = parseBMFont(base({ kernings: [{ first: 65, second: 65, amount: -1 }, { first: 65, second: 65, amount: -4 }] }));
    const f = new BitmapFont('k', d, [page()]);
    expect(f.kerning(65, 65)).toBe(-4);
    expect(f.kerning(65, 66)).toBe(0);
  });
});

describe('resolveFontPages', () => {
  it('resolves relative to the descriptor and rejects escapes', () => {
    expect(resolveFontPages('assets/fonts/a.fnt', ['a_0.png', '../img/b.png'])).toEqual(['assets/fonts/a_0.png', 'assets/img/b.png']);
    expect(resolveFontPages('a.fnt', ['a_0.png'])).toEqual(['a_0.png']);
    expect(() => resolveFontPages('assets/a.fnt', ['../../x.png'])).toThrow(/BMFont "assets\/a.fnt": .*escapes the bundle/);
    expect(() => resolveFontPages('assets/a.fnt', ['data:image/png;base64,AA'])).toThrow(/relative path/);
    expect(() => resolveFontPages('assets/a.fnt', ['/x.png'])).toThrow(/relative path/);
  });
});

describe('BitmapFont', () => {
  it('drops glyphs outside the real page size with one warning', () => {
    const d = parseBMFont(base({ chars: [{ id: 65, x: 0, y: 0, width: 5, height: 7, xadvance: 6 }, { id: 66, x: 300, y: 0, width: 5, height: 7, xadvance: 6 }, { id: 67, x: 0, y: 250, width: 5, height: 7, xadvance: 6 }] }));
    const f = new BitmapFont('t', d, [page(256, 256)]);
    expect(f.has('A')).toBe(true);
    expect(f.has('B')).toBe(false);
    expect(f.glyph(67)).toBeUndefined();
    expect(f.warnings).toEqual(['2 glyph(s) lie outside their page image and were dropped']);
  });
});

// A tiny font: size 8, lineHeight 10. 'A' advance 6, 'V' advance 6, '?' advance 5; kerning A→V = -1.
function tiny(over: Partial<BitmapFontData> = {}, smooth = false): BitmapFont {
  const data: BitmapFontData = {
    face: 't', size: 8, lineHeight: 10, base: 7, scaleW: 64, scaleH: 64, pages: ['p.png'],
    chars: [
      { id: 65, x: 0, y: 0, width: 5, height: 7, xoffset: 0, yoffset: 1, xadvance: 6, page: 0 },
      { id: 86, x: 8, y: 0, width: 5, height: 7, xoffset: 1, yoffset: 1, xadvance: 6, page: 0 },
      { id: 63, x: 16, y: 0, width: 4, height: 7, xoffset: 0, yoffset: 1, xadvance: 5, page: 0 },
      { id: 32, x: 0, y: 0, width: 0, height: 0, xoffset: 0, yoffset: 0, xadvance: 3, page: 0 },
    ],
    kernings: [{ first: 65, second: 86, amount: -1 }],
    warnings: [],
    ...over,
  };
  return new BitmapFont('tiny', data, [page(64, 64)], smooth);
}

describe('layoutText', () => {
  it('uses the native size by default and scales with size', () => {
    const f = tiny();
    const a = layoutText(f, 'A');
    expect(a.width).toBe(6);
    expect(a.height).toBe(10);
    expect(a.lines[0]!.glyphs[0]).toMatchObject({ x: 0, y: 1, w: 5, h: 7 });
    expect(a.lines[0]!.glyphs[0]!.u0).toBe(0);
    expect(a.lines[0]!.glyphs[0]!.u1).toBeCloseTo(5 / 64);
    const b = layoutText(f, 'A', { size: 16 });
    expect(b.width).toBe(12);
    expect(b.height).toBe(20);
    expect(b.lines[0]!.glyphs[0]).toMatchObject({ x: 0, y: 2, w: 10, h: 14 });
  });

  it('applies kerning between pairs only, plus letter spacing', () => {
    const f = tiny();
    expect(layoutText(f, 'AV').width).toBe(11); // 6 - 1 + 6
    expect(layoutText(f, 'VA').width).toBe(12);
    const g = layoutText(f, 'AV').lines[0]!.glyphs;
    expect(g[1]!.x).toBe(6 - 1 + 1); // pen 5 + xoffset 1
    expect(layoutText(f, 'AV', { letterSpacing: 2 }).width).toBe(13); // one gap
    expect(layoutText(f, 'AV', { size: 16 }).width).toBe(22);
    expect(layoutText(f, 'A A').width).toBe(15); // space advance 3 (no kerning A→space)
  });

  it('breaks at \\n and \\r\\n and skips other control characters', () => {
    const f = tiny();
    const l = layoutText(f, 'A\nAV\r\nV\tA');
    expect(l.lines).toHaveLength(3);
    expect(l.lines.map((x) => x.width)).toEqual([6, 11, 12]);
    expect(l.height).toBe(30);
    expect(l.lines[2]!.glyphs[0]!.y).toBe(21);
    expect(layoutText(f, 'A\nA', { lineHeight: 1.5 }).height).toBe(25);
  });

  it('wraps at spaces with maxWidth; a long word stays on its own line', () => {
    const f = tiny();
    const l = layoutText(f, 'AA AA AAAAAA A', { maxWidth: 30 });
    expect(l.lines.map((x) => x.glyphs.length)).toEqual([4, 6, 1]);
    expect(l.lines[0]!.width).toBe(27); // 12 + 3 + 12
    expect(l.lines[1]!.width).toBe(36); // wider than maxWidth, alone
    expect(l.width).toBe(36);
  });

  it('aligns and places the baseline', () => {
    const f = tiny();
    expect(layoutText(f, 'AV', { x: 100, align: 'center' }).lines[0]!.glyphs[0]!.x).toBe(Math.round(100 - 5.5));
    expect(layoutText(f, 'AV', { x: 100, align: 'right' }).lines[0]!.glyphs[0]!.x).toBe(89);
    expect(layoutText(f, 'A', { x: 100, align: 'left' }).lines[0]!.glyphs[0]!.x).toBe(100);
    expect(layoutText(f, 'A', { y: 50, baseline: 'top' }).lines[0]!.glyphs[0]!.y).toBe(51);
    expect(layoutText(f, 'A', { y: 50, baseline: 'middle' }).lines[0]!.glyphs[0]!.y).toBe(46);
    expect(layoutText(f, 'A', { y: 50, baseline: 'bottom' }).lines[0]!.glyphs[0]!.y).toBe(41);
    expect(layoutText(f, 'A\nA', { y: 50, baseline: 'bottom' }).lines[0]!.glyphs[0]!.y).toBe(31);
  });

  it('snaps line starts and tops unless smooth', () => {
    const crisp = layoutText(tiny(), 'AV', { x: 10.3, y: 5.6, align: 'center' });
    expect(crisp.lines[0]!.glyphs[0]!.x).toBe(Math.round(10.3 - 5.5));
    expect(crisp.lines[0]!.glyphs[0]!.y).toBe(6 + 1);
    const smooth = layoutText(tiny({}, true), 'AV', { x: 10.3, y: 5.6, align: 'center' });
    expect(smooth.lines[0]!.glyphs[0]!.x).toBeCloseTo(10.3 - 5.5);
    expect(smooth.lines[0]!.glyphs[0]!.y).toBeCloseTo(6.6);
  });

  it('falls back to "?" for missing glyphs, else advances size / 2', () => {
    const f = tiny();
    const l = layoutText(f, 'AéA');
    expect(l.missing).toEqual([0xe9]);
    expect(l.lines[0]!.glyphs).toHaveLength(3);
    expect(l.lines[0]!.glyphs[1]!.x).toBe(6);
    expect(l.width).toBe(17);
    const noQ = tiny({ chars: [{ id: 65, x: 0, y: 0, width: 5, height: 7, xoffset: 0, yoffset: 0, xadvance: 6, page: 0 }] });
    const m = layoutText(noQ, 'A€A', { size: 16 });
    expect(m.lines[0]!.glyphs).toHaveLength(2);
    expect(m.width).toBe(12 + 8 + 12);
    // a missing space never counts as missing and advances size / 2
    const s = layoutText(noQ, 'A A');
    expect(s.missing).toEqual([]);
    expect(s.width).toBe(6 + 4 + 6);
  });

  it('measure width equals laid-out width', () => {
    const f = tiny();
    // 'AVA' at size 24 (s = 3), spacing 1: 18 - 3 + 1 + 18 + 1 + 18 = 53
    const l = layoutText(f, 'AVA', { letterSpacing: 1, size: 24 });
    const last = l.lines[0]!.glyphs.at(-1)!;
    expect(l.width).toBe(53);
    expect(last.x + 6 * 3).toBe(l.width); // the last pen advance ends exactly at the measured width
    const r = layoutText(f, 'AVA', { letterSpacing: 1, size: 24, x: 200, align: 'right' });
    expect(r.lines[0]!.glyphs.at(-1)!.x + 18).toBe(200);
    expect(layoutText(f, 'AV\nAVAV').width).toBe(6 - 1 + 6 + 6 - 1 + 6); // AVAV: A→V kerning twice
    expect(layoutText(f, '').width).toBe(0);
    expect(layoutText(f, '').height).toBe(10);
  });
});

describe('gridFont', () => {
  it('maps chars to cells in order with spacing and margin', () => {
    const tex = page(40, 22); // margin 1, spacing 2, 8×8 cells → cols floor((40-2+2)/10)=4, rows floor((22-2+2)/10)=2
    const f = BitmapFont.grid('g', tex, { cellW: 8, cellH: 8, chars: 'ABCDE😀', spacing: 2, margin: 1 });
    expect(f.size).toBe(8);
    expect(f.base).toBe(8);
    expect(f.lineHeight).toBe(8);
    expect(f.glyph(65)).toEqual({ id: 65, x: 1, y: 1, width: 8, height: 8, xoffset: 0, yoffset: 0, xadvance: 8, page: 0 });
    expect(f.glyph(68)).toMatchObject({ x: 31, y: 1 });
    expect(f.glyph(69)).toMatchObject({ x: 1, y: 11 });
    expect(f.glyph(0x1f600)).toMatchObject({ x: 11, y: 11 });
    // a missing space advances by the grid advance
    expect(layoutText(f, 'A A').width).toBe(24);
    const g2 = BitmapFont.grid('g', tex, { cellW: 8, cellH: 8, chars: 'AB', advance: 7, lineHeight: 10 });
    expect(layoutText(g2, 'A A').width).toBe(21);
    expect(g2.lineHeight).toBe(10);
  });
  it('rejects too many chars or a duplicate', () => {
    const tex = page(16, 8);
    expect(() => BitmapFont.grid('g', tex, { cellW: 8, cellH: 8, chars: 'ABC' })).toThrow(/only 2 cells/);
    expect(() => BitmapFont.grid('g', tex, { cellW: 8, cellH: 8, chars: 'AA' })).toThrow(/repeats/);
    expect(() => BitmapFont.grid('g', tex, { cellW: 0, cellH: 8, chars: 'A' })).toThrow(/cellW/);
  });
});

describe('pixel font', () => {
  it('has 95 glyphs with the contract metrics', () => {
    expect(PIXEL_GLYPHS).toHaveLength(95);
    const d = pixelFontData();
    expect(d.chars).toHaveLength(95);
    expect(d.size).toBe(8);
    expect(d.lineHeight).toBe(10);
    expect(d.base).toBe(7);
    expect(d.chars.map((c) => c.id)).toEqual(Array.from({ length: 95 }, (_, i) => 32 + i));
    for (const c of d.chars) {
      expect(c.xadvance).toBe(6);
      expect(c.width).toBeLessThanOrEqual(5);
      expect(c.height).toBeLessThanOrEqual(9);
      expect(c.xoffset + c.width).toBeLessThanOrEqual(5);
      expect(c.yoffset + c.height).toBeLessThanOrEqual(9);
    }
    for (let i = 0; i < 95; i++) expect(PIXEL_GLYPHS[i]!.length).toBeLessThanOrEqual(9);
  });
  it('capitals occupy rows 0–6 and only descenders use rows 7–8', () => {
    for (let c = 65; c <= 90; c++) {
      const rows = pixelGlyphRows(c - 32);
      expect(rows[0]).not.toBe(0);
      expect(rows[6]).not.toBe(0);
      expect(rows[7]! | rows[8]!).toBe(0);
    }
    const desc = new Set('gjpqy,_|');
    for (let i = 0; i < 95; i++) {
      const rows = pixelGlyphRows(i);
      if (!desc.has(String.fromCharCode(32 + i))) expect(rows[7]! | rows[8]!).toBe(0);
    }
    expect(pixelFontData().chars[0]).toMatchObject({ id: 32, width: 0, height: 0 }); // space draws nothing
  });
  it('builds an RGBA page matching the glyph rects', () => {
    const img = pixelFontImage();
    const d = pixelFontData();
    expect(img.data.length).toBe(img.width * img.height * 4);
    expect(d.scaleW).toBe(img.width);
    const a = d.chars[65 - 32]!;
    expect(img.data[(a.y * img.width + a.x + 1) * 4 + 3]).toBe(255); // top row of 'A': .###.
    expect(img.data[(a.y * img.width + a.x) * 4 + 3]).toBe(0);
    for (const c of d.chars) {
      expect(c.x + c.width).toBeLessThanOrEqual(img.width);
      expect(c.y + c.height).toBeLessThanOrEqual(img.height);
    }
  });
  it('renders unknown characters as "?"', () => {
    const f = new BitmapFont('pixel', pixelFontData(), [page(96, 60)]);
    const l = layoutText(f, 'é');
    expect(l.missing).toEqual([0xe9]);
    expect(l.lines[0]!.glyphs).toHaveLength(1);
    expect(layoutText(f, 'SCORE 10', { size: 16 }).width).toBe(8 * 12);
  });
});

describe('Pixel Peaks peaks.fnt (generated by scripts/gen-bitmap-font.mjs)', () => {
  it('parses, fits its page and kerns AV / LT', async () => {
    const { readFileSync } = await import('node:fs');
    const url = new URL('../../../examples/pixel-peaks/assets/fonts/peaks.fnt', import.meta.url);
    const d = parseBMFont(readFileSync(url, 'utf8'), 'assets/fonts/peaks.fnt');
    expect(d.warnings).toEqual([]);
    expect(d.pages).toEqual(['peaks_0.png']);
    expect(d.chars).toHaveLength(95);
    const f = new BitmapFont('peaks', d, [page(d.scaleW!, d.scaleH!)]);
    expect(f.warnings).toEqual([]);
    expect(f.kerning(65, 86)).toBe(-1);
    expect(f.kerning(76, 84)).toBe(-2);
    expect(layoutText(f, 'AV').width).toBe(layoutText(f, 'A').width + layoutText(f, 'V').width - 1);
  });
});

describe('files MIME', () => {
  it('serves .fnt as text/plain', () => {
    expect(mimeType('assets/fonts/peaks.fnt')).toBe('text/plain');
    expect(mimeType('A.FNT')).toBe('text/plain');
  });
});

describe('assets font API', () => {
  it('reserved names throw', async () => {
    const { Assets } = await import('../src/assets');
    const added: string[] = [];
    const renderer = { addBitmapFont: (n: string) => added.push(n) };
    const a = new Assets('https://x.test/', renderer as never, {} as never);
    expect(() => a.gridFont('pixel', page(16, 8), { cellW: 8, cellH: 8, chars: 'A' })).toThrow('font name "pixel" is reserved');
    expect(() => a.loadBitmapFont('default', 'a.fnt')).toThrow('font name "default" is reserved');
    expect(a.gridFont('retro', page(16, 8), { cellW: 8, cellH: 8, chars: 'AB' }).name).toBe('retro');
    expect(added).toEqual(['retro']);
  });
  it('loadBitmapFont rejects XML with the BMFont prefix', async () => {
    const { Assets } = await import('../src/assets');
    const { BundleFiles } = await import('../src/files');
    const files = new BundleFiles({ 'assets/x.fnt': '<?xml version="1.0"?><font/>' }, 'https://x.test/');
    const a = new Assets('https://x.test/', {} as never, {} as never, files);
    await expect(a.loadBitmapFont('x', 'assets/x.fnt')).rejects.toThrow('BMFont "assets/x.fnt": BMFont XML is not supported; export the text or JSON format');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const files2 = new BundleFiles({ 'assets/y.fnt': 'common lineHeight=10 base=8\npage id=0 file="../../y.png"\nchar id=65 x=0 y=0 width=1 height=1 xadvance=1' }, 'https://x.test/');
    const b = new Assets('https://x.test/', {} as never, {} as never, files2);
    await expect(b.loadBitmapFont('y', 'assets/y.fnt')).rejects.toThrow(/escapes the bundle/);
    warn.mockRestore();
  });
});

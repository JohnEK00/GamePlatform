/** Review 5 engine fixes: L1 (linear parser), L2 (page paths, byte cap), L6 (binary BMFont), L8 (wrap + cache), L3 (initial focus). */
import { describe, expect, it } from 'vitest';
import { resolveFontPages } from '../src/assets';
import {
  LayoutCache, MAX_LINE_LENGTH, isBinaryBMFont, layoutText, parseBMFont, parseLine, utf8Length,
  type BitmapGlyph, type FontMetricsSource,
} from '../src/bmfont';
import { normalizePath } from '../src/files';
import { InputState } from '../src/input';
import { Ui, type UiInput, type UiRenderer } from '../src/ui';

const HDR = 'common lineHeight=10 base=8\npage id=0 file="a.png"\nchar id=65 x=0 y=0 width=1 height=1 xadvance=1\n';

describe('L1: the text parser is linear and caps line length', () => {
  it('the 80k-character line from the review is rejected fast with a clear error', () => {
    const t = performance.now();
    expect(() => parseBMFont(HDR + 'char ' + 'a'.repeat(80000), 'assets/a.fnt')).toThrow(
      `BMFont "assets/a.fnt": line 4 is longer than ${MAX_LINE_LENGTH} characters`,
    );
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('a 1 MiB single line is rejected in well under 100 ms', () => {
    const t = performance.now();
    expect(() => parseBMFont('char ' + 'a'.repeat(1024 * 1024 - 10))).toThrow(/line 1 is longer/);
    expect(performance.now() - t).toBeLessThan(100);
  });

  it('the tokenizer itself is linear (no backtracking on long runs)', () => {
    const t = performance.now();
    for (let k = 0; k < 20; k++) parseLine('char ' + 'a-'.repeat(50000) + ' x=' + '"'.repeat(3) + ' y="' + 'b'.repeat(50000));
    expect(performance.now() - t).toBeLessThan(500);
    // and many lines at the cap stay fast
    const line = 'char ' + 'a'.repeat(MAX_LINE_LENGTH - 5) + '\n';
    const t2 = performance.now();
    expect(() => parseBMFont(HDR + line.repeat(200))).toThrow(); // valid size, but no char attrs → field error
    expect(performance.now() - t2).toBeLessThan(200);
  });

  it('tokenizes like the old regex for real lines', () => {
    expect(parseLine('info face="Press Start 2P" size=-32 padding=0,0,0,0 charset=""')).toEqual({
      tag: 'info', attrs: { face: 'Press Start 2P', size: '-32', padding: '0,0,0,0', charset: '' },
    });
    expect(parseLine('  char\tid=65   x=0 chnl=15 junk 9bad=1 a-b=2')).toEqual({ tag: 'char', attrs: { id: '65', x: '0', chnl: '15', 'a-b': '2' } });
    expect(parseLine('page id=0 file="unterminated')).toEqual({ tag: 'page', attrs: { id: '0', file: '"unterminated' } });
    expect(parseLine('char_x id=1')).toBeNull();
    expect(parseLine('   ')).toBeNull();
    expect(parseLine('kernings')).toEqual({ tag: 'kernings', attrs: {} });
  });
});

describe('L2a: page paths are decoded exactly once and cannot leave the bundle', () => {
  it('rejects double-encoded dot segments and encoded backslashes', () => {
    for (const p of ['%252e%252e/%252e%252e/%252e%252e/x.png', '%2e%2e/%2e%2e/%2e%2e/x.png', '..%5c..%5c..%5cx.png', '%2E%252e/../../x.png'])
      expect(() => resolveFontPages('assets/fonts/a.fnt', [p]), p).toThrow(/BMFont "assets\/fonts\/a.fnt": pages\[0\]/);
    expect(() => resolveFontPages('assets/fonts/a.fnt', ['a%2525.png'])).toThrow(/must not contain "%"/);
    expect(() => resolveFontPages('assets/fonts/a.fnt', ['a%23b.png'])).toThrow(/must not contain/);
  });

  it('single encoding still works', () => {
    expect(resolveFontPages('assets/fonts/a.fnt', ['my%20font_0.png', 'my font_1.png', '%2e%2e/b.png'])).toEqual([
      'assets/fonts/my font_0.png', 'assets/fonts/my font_1.png', 'assets/b.png',
    ]);
  });

  it('normalizePath rejects segments that are still dot segments after one decode', () => {
    expect(normalizePath('assets/fonts/%252e%252e/x.png')).toBeNull();
    expect(normalizePath('assets/%252E/x.png')).toBeNull();
    expect(normalizePath('a/b%5c..%5cc.png')).toBe('a/c.png');
    expect(normalizePath('assets/%2e%2e/x.png')).toBe('x.png');
    expect(normalizePath('assets/..png')).toBe('assets/..png');
  });
});

describe('L2b: the 1 MiB cap is measured in UTF-8 bytes', () => {
  it('rejects the review descriptor (900k "é" = 1.8 MB UTF-8)', () => {
    const big = HDR + 'char id=66 x=0 y=0 width=1 height=1 xadvance=1 ' + 'é'.repeat(900000) + '\n';
    expect(big.length).toBeLessThan(1024 * 1024);
    expect(() => parseBMFont(big)).toThrow(/larger than 1 MiB/);
  });

  it('utf8Length matches TextEncoder', () => {
    for (const s of ['abc', 'é', '€', '😀', 'a\uD800b', 'x'.repeat(10) + '日本'])
      expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
  });

  it('accepts a descriptor just under the cap', () => {
    const pad = '\n'.repeat(1024 * 1024 - HDR.length - 4);
    expect(parseBMFont(HDR + pad).chars).toHaveLength(1);
  });
});

describe('L6: binary BMFont', () => {
  it('fails with a clear message', () => {
    const bin = 'BMF\u0003\u0001\u0014\u0000\u0000\u0000\u0010\u0000��Arial\u0000';
    expect(isBinaryBMFont(bin)).toBe(true);
    expect(() => parseBMFont(bin, 'assets/a.fnt')).toThrow('BMFont "assets/a.fnt": binary BMFont is not supported; export the text or JSON format');
    expect(isBinaryBMFont('BMFont is cool')).toBe(false);
  });
});

/** Monospace test font: every glyph advances 1 (space 1), with optional kerning. */
function monoFont(kern = 0): FontMetricsSource {
  const g = (c: number): BitmapGlyph => ({ id: c, x: 0, y: 0, width: 1, height: 1, xoffset: 0, yoffset: 0, xadvance: 1, page: 0 });
  return {
    size: 8, lineHeight: 10, smooth: false, spaceAdvance: 1,
    pages: [{ width: 1, height: 1, u0: 0, v0: 0, u1: 1, v1: 1 }],
    glyph: g,
    kerning: (a, b) => (a !== 32 && b !== 32 ? kern : 0),
  };
}

/** The pre-fix wrap (quadratic) as the reference for equivalence. */
function refWrap(font: FontMetricsSource, text: string, maxW: number, sp = 0): string[] {
  const s = 1;
  const adv = (cp: number): number => font.glyph(cp)!.xadvance * s;
  const widthOf = (cps: number[]): number => {
    let w = 0;
    for (let i = 0; i < cps.length; i++) {
      if (i > 0) w += font.kerning(cps[i - 1]!, cps[i]!) * s;
      w += adv(cps[i]!) + sp;
    }
    return cps.length ? w - sp : 0;
  };
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ').map((w) => Array.from(w, (c) => c.codePointAt(0)!));
    let cur: number[] = [];
    let started = false;
    for (const w of words) {
      const cand = started ? [...cur, 32, ...w] : w;
      if (started && cur.length && widthOf(cand) > maxW) {
        out.push(String.fromCodePoint(...cur));
        cur = w;
      } else cur = cand;
      started = true;
    }
    out.push(String.fromCodePoint(...cur));
  }
  return out;
}

describe('L8: linear wrapping and the layout cache', () => {
  it('wraps 8000 words with a huge maxWidth quickly', () => {
    const font = monoFont();
    const t = performance.now();
    const lay = layoutText(font, 'a '.repeat(8000), { maxWidth: 1e9 });
    expect(performance.now() - t).toBeLessThan(100);
    expect(lay.lines).toHaveLength(1);
    const t2 = performance.now();
    layoutText(font, 'abc '.repeat(50000), { maxWidth: 1e9 });
    expect(performance.now() - t2).toBeLessThan(300);
  });

  it('gives the same lines as the previous algorithm', () => {
    const texts = ['the quick brown fox jumps over the lazy dog', '  lead  and  double  spaces ', 'averyveryverylongword x y', 'a\nb c d e f\n\n g'];
    for (const kern of [0, -1, 2])
      for (const sp of [0, 1.5])
        for (const maxW of [1, 3, 5, 8, 13, 40])
          for (const text of texts) {
            const font = monoFont(kern);
            const got = layoutText(font, text, { maxWidth: maxW, letterSpacing: sp }).lines.map((l) => l.glyphs.length);
            const want = refWrap(font, text, maxW, sp).map((l) => l.length);
            expect(got, `${JSON.stringify(text)} kern ${kern} sp ${sp} max ${maxW}`).toEqual(want);
          }
  });

  it('caches layouts per (font, text, options), bounded LRU', () => {
    const f1 = monoFont();
    const f2 = monoFont();
    const c = new LayoutCache(3);
    const a = c.get(f1, 'SCORE 10', { x: 4, y: 4 });
    expect(c.get(f1, 'SCORE 10', { x: 4, y: 4 })).toBe(a);
    expect(c.get(f2, 'SCORE 10', { x: 4, y: 4 })).not.toBe(a);
    expect(c.get(f1, 'SCORE 10', { x: 5, y: 4 })).not.toBe(a);
    expect(c.get(f1, 'SCORE 10', { x: 4, y: 4, maxWidth: 3 })).not.toBe(a);
    expect(c.size).toBe(3);
    expect(c.get(f1, 'SCORE 10', { x: 4, y: 4 })).not.toBe(a); // evicted
    expect(c.get(f1, 'SCORE 10', { x: 4, y: 4 })).toEqual(a);
    const long = 'x'.repeat(c.maxText + 1);
    expect(c.get(f1, long)).not.toBe(c.get(f1, long));
    expect(c.size).toBe(3);
  });
});

describe('L3: initial focus (Pixel Peaks title pattern)', () => {
  it('focus set in the first update makes Enter activate on the next step', () => {
    const keys = new InputState();
    const input: UiInput = {
      mouse: { x: 0, y: 0, pressed: false, released: false, inside: false },
      actions: [],
      actionPressed: () => false,
      wasPressed: (c) => keys.wasPressed(c),
      gamepad: () => ({ wasPressed: () => false }),
    };
    const renderer: UiRenderer = { drawNineSlice() {}, drawRect() {}, strokeRect() {}, drawText() {}, ui: (fn) => fn() };
    const ui = new Ui({ input, renderer, warn: () => {} });
    let focused = false;
    const step = (): boolean => {
      ui.beginStep();
      if (!focused) {
        focused = true;
        ui.focus = 'play';
      }
      const play = ui.button('play', 'PLAY', 0, 0, 10, 10);
      ui.button('sound', 'SOUND', 0, 20, 10, 10);
      ui.endStep();
      keys.endStep();
      return play;
    };
    expect(step()).toBe(false);
    expect(ui.focus).toBe('play');
    keys.press('Enter');
    expect(step()).toBe(true);
  });
});

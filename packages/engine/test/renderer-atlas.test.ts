import { afterEach, describe, expect, it, vi } from 'vitest';
import { FontAtlas } from '../src/renderer';

// Review 8 L4: the font atlas fix (4081ab4). A fake WebGL2 context records the texture calls and a
// fake 2D canvas records what is painted, so the three behaviours are checked without a browser.

type Call = { fn: string; args: unknown[] };

function fakeGl() {
  const calls: Call[] = [];
  const consts = { TEXTURE_2D: 0x0de1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803, LINEAR: 0x2601, LINEAR_MIPMAP_LINEAR: 0x2703, CLAMP_TO_EDGE: 0x812f };
  const rec = (fn: string) => (...args: unknown[]) => void calls.push({ fn, args });
  const gl = {
    ...consts,
    createTexture: () => ({ tex: 1 }),
    bindTexture: rec('bindTexture'),
    texImage2D: rec('texImage2D'),
    texSubImage2D: rec('texSubImage2D'),
    texParameteri: rec('texParameteri'),
    generateMipmap: rec('generateMipmap'),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

/** A 2D canvas that can be "lost" (isContextLost) and restored blank, like Chrome's offscreen canvases. */
function fakeCanvas2d() {
  const painted: { op: string; ch?: string; x: number; y: number; w?: number; h?: number; font?: string }[] = [];
  const state = { lost: false };
  const ctx = {
    font: '10px sans-serif',
    fillStyle: '#000',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    measureText: (t: string) => ({ width: Array.from(t).length * 30, actualBoundingBoxAscent: 50, actualBoundingBoxDescent: 14 }),
    fillRect: (x: number, y: number, w: number, h: number) => void painted.push({ op: 'fillRect', x, y, w, h }),
    clearRect: (x: number, y: number, w: number, h: number) => void painted.push({ op: 'clearRect', x, y, w, h }),
    fillText(ch: string, x: number, y: number) {
      painted.push({ op: 'fillText', ch, x, y, font: this.font });
    },
    isContextLost: () => state.lost,
  };
  const canvas = Object.assign(new EventTarget(), { width: 0, height: 0, getContext: () => ctx });
  return { canvas, ctx, painted, state };
}

let c2d: ReturnType<typeof fakeCanvas2d>;
function setup() {
  c2d = fakeCanvas2d();
  vi.stubGlobal('document', { createElement: () => c2d.canvas });
  const g = fakeGl();
  const atlas = new FontAtlas(g.gl, 'sans-serif', 'normal', 1024);
  return { atlas, ...g };
}
afterEach(() => vi.unstubAllGlobals());

const isWhiteBlock = (c: Call): boolean => {
  if (c.fn !== 'texSubImage2D') return false;
  const [target, level, x, y, w, h, fmt, type, data] = c.args as [number, number, number, number, number, number, number, number, Uint8Array];
  return target === 0x0de1 && level === 0 && x === 0 && y === 0 && w === 8 && h === 8 && fmt === 0x1908 && type === 0x1401 &&
    data instanceof Uint8Array && data.length === 8 * 8 * 4 && data.every((b) => b === 255);
};

describe('FontAtlas upload (review 8 L4)', () => {
  it('every upload writes the 8×8 white block from bytes after the canvas and before generateMipmap', () => {
    const { atlas, calls } = setup();
    expect(atlas.page.white).toEqual({ u: 4 / 1024, v: 4 / 1024 });
    atlas.page.prepare!();
    const fns = calls.map((c) => c.fn);
    const img = fns.indexOf('texImage2D');
    const sub = calls.findIndex(isWhiteBlock);
    const mip = fns.indexOf('generateMipmap');
    expect(img).toBeGreaterThanOrEqual(0);
    expect(calls[img]!.args[5]).toBe(c2d.canvas);
    expect(sub).toBeGreaterThan(img);
    expect(mip).toBeGreaterThan(sub);
    // Not dirty: no upload.
    calls.length = 0;
    atlas.page.prepare!();
    expect(calls).toEqual([]);
    // A new glyph makes it dirty: the next upload writes the white block again.
    atlas.glyph('é');
    atlas.page.prepare!();
    expect(calls.filter((c) => c.fn === 'texImage2D')).toHaveLength(1);
    expect(calls.filter(isWhiteBlock)).toHaveLength(1);
    expect(calls.findIndex(isWhiteBlock)).toBeLessThan(calls.map((c) => c.fn).indexOf('generateMipmap'));
  });

  it('skips the upload while the 2D context is lost and keeps it pending', () => {
    const { atlas, calls } = setup();
    c2d.state.lost = true;
    atlas.page.prepare!();
    atlas.glyph('ß');
    atlas.page.prepare!();
    expect(calls).toEqual([]);
    c2d.state.lost = false;
    atlas.page.prepare!();
    expect(calls.filter((c) => c.fn === 'texImage2D')).toHaveLength(1);
    expect(calls.filter(isWhiteBlock)).toHaveLength(1);
  });

  it('contextrestored repaints the white block and every cached glyph at its cell, then uploads', () => {
    const { atlas, calls } = setup();
    atlas.glyph('Ж');
    atlas.page.prepare!();
    const cells = (from: number) =>
      new Map(c2d.painted.slice(from).filter((p) => p.op === 'fillText').map((p) => [p.ch!, `${p.x},${p.y}`] as const));
    const original = cells(0);
    expect(original.size).toBe(96); // printable ASCII + 'Ж'
    expect(c2d.painted[0]).toEqual({ op: 'fillRect', x: 0, y: 0, w: 8, h: 8 });

    // The browser discards the canvas, then restores it blank (default font).
    c2d.state.lost = true;
    c2d.ctx.font = '10px sans-serif';
    calls.length = 0;
    atlas.page.prepare!(); // not dirty anyway
    c2d.state.lost = false;
    const mark = c2d.painted.length;
    c2d.canvas.dispatchEvent(new Event('contextrestored'));
    const after = c2d.painted.slice(mark);
    expect(after[0]).toEqual({ op: 'clearRect', x: 0, y: 0, w: 1024, h: 1024 });
    expect(after[1]).toEqual({ op: 'fillRect', x: 0, y: 0, w: 8, h: 8 });
    expect(cells(mark)).toEqual(original);
    expect(after.filter((p) => p.op === 'fillText').every((p) => p.font === atlas.fontCss)).toBe(true);
    // Marked dirty: the next prepare uploads, with the white block.
    atlas.page.prepare!();
    expect(calls.filter((c) => c.fn === 'texImage2D')).toHaveLength(1);
    expect(calls.filter(isWhiteBlock)).toHaveLength(1);
  });
});

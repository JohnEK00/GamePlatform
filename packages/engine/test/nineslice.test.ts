import { describe, expect, it } from 'vitest';
import { NineSlice, nineSliceQuads } from '../src/nineslice';
import { Texture, type TexturePage } from '../src/texture';

const PAGE = { glTexture: {} as WebGLTexture, width: 256, height: 256, white: null } as TexturePage;
/** A 24×24 image at (32, 64) on a 256² page. */
const tex = new Texture(PAGE, 24, 24, 32 / 256, 64 / 256, 56 / 256, 88 / 256);
const I8 = { left: 8, top: 8, right: 8, bottom: 8 };

describe('nineSliceQuads', () => {
  it('emits 9 quads with UVs at the inset boundaries', () => {
    const q = nineSliceQuads(tex, I8, 10, 20, 200, 120);
    expect(q).toHaveLength(9);
    expect(q.map((p) => [p.x, p.y, p.w, p.h])).toEqual([
      [10, 20, 8, 8], [18, 20, 184, 8], [202, 20, 8, 8],
      [10, 28, 8, 104], [18, 28, 184, 104], [202, 28, 8, 104],
      [10, 132, 8, 8], [18, 132, 184, 8], [202, 132, 8, 8],
    ]);
    const px = (u: number): number => Math.round(u * 256);
    expect([px(q[0]!.u0), px(q[0]!.u1), px(q[1]!.u1), px(q[2]!.u1)]).toEqual([32, 40, 48, 56]);
    expect([px(q[0]!.v0), px(q[3]!.v0), px(q[6]!.v0), px(q[6]!.v1)]).toEqual([64, 72, 80, 88]);
  });

  it('scales the borders with scale', () => {
    const q = nineSliceQuads(tex, I8, 0, 0, 90, 40, 2);
    expect(q).toHaveLength(9);
    expect(q[0]).toMatchObject({ w: 16, h: 16 });
    expect(q[1]).toMatchObject({ x: 16, w: 58 });
    expect(q[8]).toMatchObject({ x: 74, y: 24, w: 16, h: 16 });
  });

  it('shrinks borders proportionally and omits the centre column', () => {
    const q = nineSliceQuads(tex, { left: 6, top: 8, right: 2, bottom: 8 }, 0, 0, 4, 40, 1);
    expect(q).toHaveLength(6); // 3 rows × (left, right)
    expect(q[0]).toMatchObject({ x: 0, w: 3 });
    expect(q[1]).toMatchObject({ x: 3, w: 1 });
    const v = nineSliceQuads(tex, I8, 0, 0, 40, 8, 2); // h 8 < 32 → f = 0.25
    expect(v).toHaveLength(6);
    expect(v[0]).toMatchObject({ y: 0, h: 4 });
    expect(v[3]).toMatchObject({ y: 4, h: 4 });
  });

  it('center: false gives 8 quads; w or h <= 0 gives none', () => {
    expect(nineSliceQuads(tex, I8, 0, 0, 100, 100, 1, false)).toHaveLength(8);
    expect(nineSliceQuads(tex, I8, 0, 0, 0, 100)).toEqual([]);
    expect(nineSliceQuads(tex, I8, 0, 0, 100, -5)).toEqual([]);
  });

  it('skips zero-area pieces (zero insets, exact fit)', () => {
    expect(nineSliceQuads(tex, { left: 0, top: 0, right: 0, bottom: 0 }, 0, 0, 50, 50)).toHaveLength(1);
    expect(nineSliceQuads(tex, { left: 8, top: 0, right: 8, bottom: 0 }, 0, 0, 16, 50)).toHaveLength(2);
  });
});

describe('NineSlice', () => {
  it('stores insets (a number means all sides)', () => {
    const n = new NineSlice(tex, 8);
    expect([n.left, n.top, n.right, n.bottom]).toEqual([8, 8, 8, 8]);
    expect(n.texture).toBe(tex);
    const m = new NineSlice(tex, { left: 1, top: 2, right: 3, bottom: 4 });
    expect([m.left, m.top, m.right, m.bottom]).toEqual([1, 2, 3, 4]);
  });
  it('throws RangeError for invalid insets', () => {
    expect(() => new NineSlice(tex, -1)).toThrow(RangeError);
    expect(() => new NineSlice(tex, 1.5)).toThrow(RangeError);
    expect(() => new NineSlice(tex, 13)).toThrow(RangeError); // 26 > 24
    expect(() => new NineSlice(tex, { left: 20, top: 0, right: 5, bottom: 0 })).toThrow(/exceeds the texture width/);
    expect(() => new NineSlice(tex, { left: 0, top: 20, right: 0, bottom: 5 })).toThrow(/exceeds the texture height/);
    expect(() => new NineSlice(tex, { left: 1, top: 1, right: 1 } as never)).toThrow(/insets.bottom/);
    expect(() => new NineSlice(null as never, 1)).toThrow(RangeError);
    expect(() => new NineSlice(tex, 12)).not.toThrow();
  });
});

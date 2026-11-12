import { describe, expect, it } from 'vitest';
import { approach, circleRectOverlap, circlesOverlap, clamp, Color, Random, Rect, Vec2, wrap } from '../src/math';
import { FixedTimestep } from '../src/loop';
import { ShelfPacker } from '../src/texture';

describe('Vec2', () => {
  it('does arithmetic without mutating', () => {
    const a = new Vec2(1, 2);
    const b = new Vec2(3, 4);
    expect(a.add(b)).toEqual(new Vec2(4, 6));
    expect(b.sub(a)).toEqual(new Vec2(2, 2));
    expect(a.scale(3)).toEqual(new Vec2(3, 6));
    expect(a).toEqual(new Vec2(1, 2));
  });
  it('computes length, dot, cross, normalize', () => {
    const v = new Vec2(3, 4);
    expect(v.length()).toBe(5);
    expect(v.lengthSq()).toBe(25);
    expect(v.dot(new Vec2(1, 0))).toBe(3);
    expect(new Vec2(1, 0).cross(new Vec2(0, 1))).toBe(1);
    expect(v.normalize().length()).toBeCloseTo(1);
    expect(new Vec2().normalize()).toEqual(new Vec2(0, 0));
    expect(v.limit(1).length()).toBeCloseTo(1);
  });
  it('rotates and builds from angles', () => {
    const r = new Vec2(1, 0).rotate(Math.PI / 2);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo(1);
    const f = Vec2.fromAngle(Math.PI, 2);
    expect(f.equals(new Vec2(-2, 0), 1e-9)).toBe(true);
    expect(Vec2.distance({ x: 0, y: 0 }, { x: 6, y: 8 })).toBe(10);
  });
  it('mutating helpers mutate', () => {
    const v = new Vec2(1, 1);
    v.addSelf({ x: 1, y: 2 }).scaleSelf(2);
    expect(v).toEqual(new Vec2(4, 6));
  });
});

describe('Rect', () => {
  it('detects strict intersection', () => {
    const a = new Rect(0, 0, 10, 10);
    expect(a.intersects(new Rect(5, 5, 10, 10))).toBe(true);
    expect(a.intersects(new Rect(10, 0, 5, 5))).toBe(false); // touching edge
    expect(a.intersects(new Rect(20, 20, 5, 5))).toBe(false);
    expect(Rect.intersects({ x: 0, y: 0, w: 1, h: 1 }, { x: 0.5, y: 0.5, w: 1, h: 1 })).toBe(true);
  });
  it('computes intersection region and separation', () => {
    const a = new Rect(0, 0, 10, 10);
    expect(a.intersection(new Rect(5, 6, 10, 10))).toEqual(new Rect(5, 6, 5, 4));
    expect(a.intersection(new Rect(10, 10, 1, 1))).toBeNull();
    // b overlaps a's right side by 2 → push a left by 2
    expect(Rect.separation(a, new Rect(8, -5, 10, 30))).toEqual(new Vec2(-2, 0));
    expect(Rect.separation(a, new Rect(-5, 9, 30, 10))).toEqual(new Vec2(0, -1));
    expect(Rect.separation(a, new Rect(50, 50, 1, 1))).toBeNull();
  });
  it('contains points and rects', () => {
    const r = new Rect(0, 0, 10, 10);
    expect(r.contains(0, 0)).toBe(true);
    expect(r.contains(10, 5)).toBe(false);
    expect(r.containsRect(new Rect(1, 1, 2, 2))).toBe(true);
    expect(Rect.fromCenter(5, 5, 4, 2)).toEqual(new Rect(3, 4, 4, 2));
  });
  it('circle overlaps', () => {
    expect(circlesOverlap(0, 0, 5, 9, 0, 5)).toBe(true);
    expect(circlesOverlap(0, 0, 5, 10, 0, 5)).toBe(false);
    expect(circleRectOverlap(12, 5, 3, { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
    expect(circleRectOverlap(14, 5, 3, { x: 0, y: 0, w: 10, h: 10 })).toBe(false);
  });
});

describe('scalars', () => {
  it('clamp/approach/wrap', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(9, 10, 3)).toBe(10);
    expect(approach(0, -10, 3)).toBe(-3);
    expect(wrap(-1, 0, 10)).toBe(9);
    expect(wrap(12, 0, 10)).toBe(2);
  });
});

describe('Color', () => {
  it('parses hex, rgb and names', () => {
    expect(Color.from('#ff0000')).toMatchObject({ r: 1, g: 0, b: 0, a: 1 });
    expect(Color.from('#0f08').a).toBeCloseTo(0x88 / 255);
    expect(Color.from(0x00ff00)).toMatchObject({ r: 0, g: 1, b: 0 });
    expect(Color.from('rgba(255, 0, 255, 0.5)')).toMatchObject({ r: 1, g: 0, b: 1, a: 0.5 });
    expect(Color.from('gold').toHex()).toBe('#ffd700');
    expect(Color.from([0.5, 0.5, 0.5])).toMatchObject({ r: 0.5, a: 1 });
    expect(() => Color.from('nope')).toThrow();
  });
  it('packs ABGR and lerps', () => {
    expect(new Color(1, 0, 0, 1).toABGR()).toBe(0xff0000ff);
    expect(new Color(0, 0, 1, 1).toABGR(0.5)).toBe(((128 << 24) | (255 << 16)) >>> 0);
    expect(Color.from('#000').lerp('#fff', 0.5).r).toBeCloseTo(0.5);
    expect(Color.hsl(120, 1, 0.5).toHex()).toBe('#00ff00');
  });
});

describe('Random', () => {
  it('is deterministic per seed and in range', () => {
    const a = new Random(42);
    const b = new Random(42);
    for (let i = 0; i < 100; i++) {
      const x = a.next();
      expect(x).toBe(b.next());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    const r = new Random(1);
    for (let i = 0; i < 200; i++) {
      const n = r.int(1, 3);
      expect([1, 2, 3]).toContain(n);
    }
  });
});

describe('FixedTimestep', () => {
  it('runs fixed steps and returns alpha', () => {
    const ts = new FixedTimestep(0.01);
    let steps = 0;
    const alpha = ts.advance(0.035, () => steps++);
    expect(steps).toBe(3);
    expect(alpha).toBeCloseTo(0.5, 3);
    ts.advance(0.005, () => steps++);
    expect(steps).toBe(4);
  });
  it('caps huge frame deltas', () => {
    const ts = new FixedTimestep(1 / 60, 0.25);
    let steps = 0;
    ts.advance(10, () => steps++);
    expect(steps).toBe(15);
  });
});

describe('ShelfPacker', () => {
  it('packs without overlap and rejects when full', () => {
    const p = new ShelfPacker(64, 64, 1);
    const rects: Rect[] = [];
    for (let i = 0; i < 8; i++) {
      const pos = p.pack(14, 14);
      expect(pos).not.toBeNull();
      rects.push(new Rect(pos!.x, pos!.y, 14, 14));
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) expect(rects[i]!.intersects(rects[j]!)).toBe(false);
    for (const r of rects) expect(new Rect(0, 0, 64, 64).containsRect(r)).toBe(true);
    expect(p.pack(100, 4)).toBeNull();
  });
});

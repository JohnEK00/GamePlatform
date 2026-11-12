/** Core math utilities: Vec2, Rect, Color, Random and scalar helpers. Pure, DOM-free. */

export interface Point {
  x: number;
  y: number;
}

export interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Inverse lerp: where `v` sits between a and b (0..1, unclamped). */
export const invLerp = (a: number, b: number, v: number): number => (a === b ? 0 : (v - a) / (b - a));
/** Re-map `v` from range [a1,b1] to [a2,b2]. */
export const remap = (v: number, a1: number, b1: number, a2: number, b2: number): number =>
  lerp(a2, b2, invLerp(a1, b1, v));
/** Move `v` toward `target` by at most `step` (step >= 0). */
export const approach = (v: number, target: number, step: number): number =>
  v < target ? Math.min(v + step, target) : Math.max(v - step, target);
/** Wrap `v` into [min, max). */
export const wrap = (v: number, min: number, max: number): number => {
  const r = max - min;
  if (r <= 0) return min;
  return ((((v - min) % r) + r) % r) + min;
};
export const degToRad = (d: number): number => (d * Math.PI) / 180;
export const radToDeg = (r: number): number => (r * 180) / Math.PI;
/** Frame-rate independent exponential smoothing factor: use as `lerp(a, b, damp(10, dt))`. */
export const damp = (lambda: number, dt: number): number => 1 - Math.exp(-lambda * dt);

export const MathUtil = { clamp, lerp, invLerp, remap, approach, wrap, degToRad, radToDeg, damp };

// ---------------------------------------------------------------------------
// Vec2
// ---------------------------------------------------------------------------

/** 2D vector. Arithmetic methods return NEW vectors; `set`/`copy`/`*Self` mutate. */
export class Vec2 implements Point {
  constructor(
    public x = 0,
    public y = 0,
  ) {}

  static from(p: Point): Vec2 {
    return new Vec2(p.x, p.y);
  }
  static fromAngle(radians: number, length = 1): Vec2 {
    return new Vec2(Math.cos(radians) * length, Math.sin(radians) * length);
  }
  static zero(): Vec2 {
    return new Vec2(0, 0);
  }
  static distance(a: Point, b: Point): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }
  copy(p: Point): this {
    this.x = p.x;
    this.y = p.y;
    return this;
  }
  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }
  add(p: Point): Vec2 {
    return new Vec2(this.x + p.x, this.y + p.y);
  }
  sub(p: Point): Vec2 {
    return new Vec2(this.x - p.x, this.y - p.y);
  }
  mul(p: Point): Vec2 {
    return new Vec2(this.x * p.x, this.y * p.y);
  }
  scale(s: number): Vec2 {
    return new Vec2(this.x * s, this.y * s);
  }
  addSelf(p: Point): this {
    this.x += p.x;
    this.y += p.y;
    return this;
  }
  subSelf(p: Point): this {
    this.x -= p.x;
    this.y -= p.y;
    return this;
  }
  scaleSelf(s: number): this {
    this.x *= s;
    this.y *= s;
    return this;
  }
  dot(p: Point): number {
    return this.x * p.x + this.y * p.y;
  }
  /** 2D cross product (z component). */
  cross(p: Point): number {
    return this.x * p.y - this.y * p.x;
  }
  length(): number {
    return Math.hypot(this.x, this.y);
  }
  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }
  distance(p: Point): number {
    return Math.hypot(p.x - this.x, p.y - this.y);
  }
  normalize(): Vec2 {
    const l = this.length();
    return l > 0 ? new Vec2(this.x / l, this.y / l) : new Vec2(0, 0);
  }
  /** Returns a copy whose length is at most `max`. */
  limit(max: number): Vec2 {
    const l = this.length();
    return l > max && l > 0 ? this.scale(max / l) : this.clone();
  }
  angle(): number {
    return Math.atan2(this.y, this.x);
  }
  rotate(radians: number): Vec2 {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return new Vec2(this.x * c - this.y * s, this.x * s + this.y * c);
  }
  perp(): Vec2 {
    return new Vec2(-this.y, this.x);
  }
  lerp(p: Point, t: number): Vec2 {
    return new Vec2(lerp(this.x, p.x, t), lerp(this.y, p.y, t));
  }
  equals(p: Point, epsilon = 1e-9): boolean {
    return Math.abs(this.x - p.x) <= epsilon && Math.abs(this.y - p.y) <= epsilon;
  }
  toString(): string {
    return `Vec2(${this.x}, ${this.y})`;
  }
}

// ---------------------------------------------------------------------------
// Rect (AABB)
// ---------------------------------------------------------------------------

/** Axis-aligned rectangle; (x, y) is the top-left corner (y grows downward). */
export class Rect implements RectLike {
  constructor(
    public x = 0,
    public y = 0,
    public w = 0,
    public h = 0,
  ) {}

  static fromCenter(cx: number, cy: number, w: number, h: number): Rect {
    return new Rect(cx - w / 2, cy - h / 2, w, h);
  }
  static from(r: RectLike): Rect {
    return new Rect(r.x, r.y, r.w, r.h);
  }
  /** Strict AABB overlap (edges that merely touch do NOT intersect). */
  static intersects(a: RectLike, b: RectLike): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  /** Overlapping region of two rects, or null. */
  static intersection(a: RectLike, b: RectLike): Rect | null {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    return x2 > x1 && y2 > y1 ? new Rect(x1, y1, x2 - x1, y2 - y1) : null;
  }
  /**
   * Minimum translation vector to push `a` out of `b` (along the axis of least penetration),
   * or null when they don't overlap.
   */
  static separation(a: RectLike, b: RectLike): Vec2 | null {
    if (!Rect.intersects(a, b)) return null;
    const left = b.x - (a.x + a.w); // negative: move a left
    const right = b.x + b.w - a.x; // positive: move a right
    const up = b.y - (a.y + a.h);
    const down = b.y + b.h - a.y;
    const dx = Math.abs(left) < Math.abs(right) ? left : right;
    const dy = Math.abs(up) < Math.abs(down) ? up : down;
    return Math.abs(dx) < Math.abs(dy) ? new Vec2(dx, 0) : new Vec2(0, dy);
  }

  get left(): number {
    return this.x;
  }
  get right(): number {
    return this.x + this.w;
  }
  get top(): number {
    return this.y;
  }
  get bottom(): number {
    return this.y + this.h;
  }
  get centerX(): number {
    return this.x + this.w / 2;
  }
  get centerY(): number {
    return this.y + this.h / 2;
  }
  set(x: number, y: number, w: number, h: number): this {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    return this;
  }
  clone(): Rect {
    return new Rect(this.x, this.y, this.w, this.h);
  }
  intersects(other: RectLike): boolean {
    return Rect.intersects(this, other);
  }
  intersection(other: RectLike): Rect | null {
    return Rect.intersection(this, other);
  }
  contains(px: number, py: number): boolean {
    return px >= this.x && px < this.x + this.w && py >= this.y && py < this.y + this.h;
  }
  containsRect(r: RectLike): boolean {
    return r.x >= this.x && r.y >= this.y && r.x + r.w <= this.x + this.w && r.y + r.h <= this.y + this.h;
  }
  /** Grow (or shrink with negative values) on every side. */
  inflate(dx: number, dy = dx): Rect {
    return new Rect(this.x - dx, this.y - dy, this.w + dx * 2, this.h + dy * 2);
  }
  toString(): string {
    return `Rect(${this.x}, ${this.y}, ${this.w}, ${this.h})`;
  }
}

/** Circle–circle overlap test. */
export function circlesOverlap(ax: number, ay: number, ar: number, bx: number, by: number, br: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const r = ar + br;
  return dx * dx + dy * dy < r * r;
}

/** Circle–AABB overlap test. */
export function circleRectOverlap(cx: number, cy: number, r: number, rect: RectLike): boolean {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

/** Anything accepted where a color is expected. Numbers are 0xRRGGBB; arrays are 0..1 floats. */
export type ColorLike = Color | string | number | readonly [number, number, number] | readonly [number, number, number, number];

const NAMED: Record<string, number> = {
  white: 0xffffff, black: 0x000000, red: 0xff0000, green: 0x00ff00, blue: 0x0000ff, yellow: 0xffff00,
  cyan: 0x00ffff, magenta: 0xff00ff, orange: 0xffa500, purple: 0x800080, gray: 0x808080, grey: 0x808080,
  pink: 0xffc0cb, brown: 0xa52a2a, lime: 0x00ff00, navy: 0x000080, teal: 0x008080, gold: 0xffd700,
  silver: 0xc0c0c0, maroon: 0x800000, olive: 0x808000, skyblue: 0x87ceeb, crimson: 0xdc143c,
};

/** RGBA color with float channels in 0..1. */
export class Color {
  constructor(
    public r = 1,
    public g = 1,
    public b = 1,
    public a = 1,
  ) {}

  static readonly WHITE: Readonly<Color> = Object.freeze(new Color(1, 1, 1, 1));
  static readonly BLACK: Readonly<Color> = Object.freeze(new Color(0, 0, 0, 1));
  static readonly TRANSPARENT: Readonly<Color> = Object.freeze(new Color(0, 0, 0, 0));
  static readonly RED: Readonly<Color> = Object.freeze(new Color(1, 0, 0, 1));
  static readonly GREEN: Readonly<Color> = Object.freeze(new Color(0, 1, 0, 1));
  static readonly BLUE: Readonly<Color> = Object.freeze(new Color(0, 0, 1, 1));
  static readonly YELLOW: Readonly<Color> = Object.freeze(new Color(1, 1, 0, 1));

  /** From 0..255 channels (alpha 0..1). */
  static rgb(r: number, g: number, b: number, a = 1): Color {
    return new Color(r / 255, g / 255, b / 255, a);
  }
  /** h in degrees, s/l in 0..1. */
  static hsl(h: number, s: number, l: number, a = 1): Color {
    h = wrap(h, 0, 360) / 360;
    const f = (n: number): number => {
      const k = (n + h * 12) % 12;
      return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return new Color(f(0), f(8), f(4), a);
  }
  /** "#rgb", "#rgba", "#rrggbb", "#rrggbbaa", "rgb(...)", "rgba(...)", named colors, or 0xRRGGBB. */
  static hex(v: string | number): Color {
    if (typeof v === 'number') return new Color(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1);
    return Color.parse(v);
  }
  static parse(input: string): Color {
    const s = input.trim().toLowerCase();
    if (s in NAMED) return Color.hex(NAMED[s]!);
    if (s === 'transparent') return new Color(0, 0, 0, 0);
    if (s.startsWith('#')) {
      let h = s.slice(1);
      if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
      if (/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) {
        const n = parseInt(h.slice(0, 6), 16);
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        return new Color(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a);
      }
    }
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
      const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map((x) => parseFloat(x));
      if (p.length >= 3 && p.every((x) => Number.isFinite(x))) {
        return new Color(p[0]! / 255, p[1]! / 255, p[2]! / 255, p.length > 3 ? p[3]! : 1);
      }
    }
    throw new Error(`Invalid color: ${input}`);
  }
  /** Convert any ColorLike into a Color (strings are cached; do not mutate the result). */
  static from(c: ColorLike): Color {
    if (c instanceof Color) return c;
    if (typeof c === 'number') return Color.hex(c);
    if (typeof c === 'string') {
      let cached = COLOR_CACHE.get(c);
      if (!cached) {
        cached = Color.parse(c);
        if (COLOR_CACHE.size > 512) COLOR_CACHE.clear();
        COLOR_CACHE.set(c, cached);
      }
      return cached;
    }
    return new Color(c[0], c[1], c[2], c.length > 3 ? (c as readonly number[])[3]! : 1);
  }

  clone(): Color {
    return new Color(this.r, this.g, this.b, this.a);
  }
  withAlpha(a: number): Color {
    return new Color(this.r, this.g, this.b, a);
  }
  lerp(other: ColorLike, t: number): Color {
    const o = Color.from(other);
    return new Color(lerp(this.r, o.r, t), lerp(this.g, o.g, t), lerp(this.b, o.b, t), lerp(this.a, o.a, t));
  }
  /** Multiply RGB by `f` (f < 1 darkens, > 1 brightens). */
  scale(f: number): Color {
    return new Color(clamp(this.r * f, 0, 1), clamp(this.g * f, 0, 1), clamp(this.b * f, 0, 1), this.a);
  }
  toHex(): string {
    const h = (v: number): string => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
    return `#${h(this.r)}${h(this.g)}${h(this.b)}${this.a < 1 ? h(this.a) : ''}`;
  }
  toCSS(): string {
    return `rgba(${Math.round(this.r * 255)},${Math.round(this.g * 255)},${Math.round(this.b * 255)},${this.a})`;
  }
  /** Packed little-endian ABGR uint32 (for vertex buffers), optionally multiplying alpha. */
  toABGR(alphaMul = 1): number {
    const r = Math.round(clamp(this.r, 0, 1) * 255);
    const g = Math.round(clamp(this.g, 0, 1) * 255);
    const b = Math.round(clamp(this.b, 0, 1) * 255);
    const a = Math.round(clamp(this.a * alphaMul, 0, 1) * 255);
    return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
}

const COLOR_CACHE = new Map<string, Color>();

// ---------------------------------------------------------------------------
// Random (seedable, mulberry32)
// ---------------------------------------------------------------------------

export class Random {
  private s: number;
  constructor(seed: number = (Math.random() * 2 ** 32) >>> 0) {
    this.s = seed >>> 0;
  }
  seed(seed: number): void {
    this.s = seed >>> 0;
  }
  /** Float in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  sign(): 1 | -1 {
    return this.next() < 0.5 ? -1 : 1;
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Random.pick: empty array');
    return items[Math.floor(this.next() * items.length)]!;
  }
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
    return items;
  }
  /** Random angle in radians [0, 2π). */
  angle(): number {
    return this.next() * Math.PI * 2;
  }
}

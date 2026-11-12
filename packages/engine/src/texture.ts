/** Texture / sprite sheet / animation types and the atlas shelf packer. */

/** A GL texture "page" (an atlas page or a standalone texture). */
export interface TexturePage {
  readonly glTexture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  /** UV of an opaque white texel in this page (lets shapes batch with sprites), or null. */
  readonly white: { u: number; v: number } | null;
}

/** An image region on a GPU page. `width`/`height` are in pixels. */
export class Texture {
  constructor(
    readonly page: TexturePage,
    readonly width: number,
    readonly height: number,
    readonly u0: number,
    readonly v0: number,
    readonly u1: number,
    readonly v1: number,
  ) {}

  /** A sub-region of this texture, in pixels relative to its top-left. */
  sub(x: number, y: number, w: number, h: number): Texture {
    const du = (this.u1 - this.u0) / this.width;
    const dv = (this.v1 - this.v0) / this.height;
    return new Texture(this.page, w, h, this.u0 + x * du, this.v0 + y * dv, this.u0 + (x + w) * du, this.v0 + (y + h) * dv);
  }
}

/** A texture cut into a grid of equally sized frames, indexed left→right, top→bottom from 0. */
export class SpriteSheet {
  readonly cols: number;
  readonly rows: number;
  private readonly frames: Texture[] = [];

  constructor(
    readonly texture: Texture,
    readonly frameW: number,
    readonly frameH: number,
    /** Pixel gap between frames (and around the edge). */
    readonly spacing = 0,
    readonly margin = 0,
  ) {
    this.cols = Math.max(1, Math.floor((texture.width - margin * 2 + spacing) / (frameW + spacing)));
    this.rows = Math.max(1, Math.floor((texture.height - margin * 2 + spacing) / (frameH + spacing)));
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        this.frames.push(texture.sub(margin + c * (frameW + spacing), margin + r * (frameH + spacing), frameW, frameH));
  }

  get count(): number {
    return this.frames.length;
  }
  get width(): number {
    return this.frameW;
  }
  get height(): number {
    return this.frameH;
  }
  /** Frame texture (index wraps around). */
  frame(i: number): Texture {
    const n = this.frames.length;
    return this.frames[((Math.floor(i) % n) + n) % n]!;
  }
}

/** Frame-based animation helper: `anim.update(dt)` then draw with `{ frame: anim.frame }`. */
export class Animation {
  time = 0;
  playing = true;
  constructor(
    public frames: number[],
    public fps = 10,
    public loop = true,
  ) {}
  /** Current frame index (into the sheet). */
  get frame(): number {
    const n = this.frames.length;
    if (n === 0) return 0;
    let i = Math.floor(this.time * this.fps);
    i = this.loop ? i % n : Math.min(i, n - 1);
    return this.frames[i]!;
  }
  get finished(): boolean {
    return !this.loop && this.time * this.fps >= this.frames.length;
  }
  update(dt: number): void {
    if (this.playing) this.time += dt;
  }
  reset(): void {
    this.time = 0;
    this.playing = true;
  }
}

/** Shelf bin-packer used to pack small images into shared atlas pages. Pure logic. */
export class ShelfPacker {
  private shelves: { y: number; h: number; x: number }[] = [];
  private nextY = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly padding = 2,
  ) {}

  /** Reserve a w×h area; returns its top-left or null if it doesn't fit. */
  pack(w: number, h: number): { x: number; y: number } | null {
    const p = this.padding;
    const pw = w + p * 2;
    const ph = h + p * 2;
    if (pw > this.width || ph > this.height) return null;
    let best: { y: number; h: number; x: number } | null = null;
    for (const s of this.shelves) {
      if (ph <= s.h && s.x + pw <= this.width && (!best || s.h < best.h)) best = s;
    }
    if (best) {
      const pos = { x: best.x + p, y: best.y + p };
      best.x += pw;
      return pos;
    }
    if (this.nextY + ph > this.height) return null;
    const shelf = { y: this.nextY, h: ph, x: pw };
    this.shelves.push(shelf);
    this.nextY += ph;
    return { x: p, y: shelf.y + p };
  }
}

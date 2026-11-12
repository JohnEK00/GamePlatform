/** Grid tilemap. Pure data + helpers; drawing goes through the renderer interface. */
import { Rect, type RectLike } from './math';
import type { Renderer, SpriteOptions } from './renderer';
import type { SpriteSheet } from './texture';

/** Tiled-style JSON (subset) or Pixelforge's own simple JSON shape. */
export interface TilemapJSON {
  // Pixelforge format
  cols?: number;
  rows?: number;
  tileW?: number;
  tileH?: number;
  data?: number[] | number[][];
  solid?: number[];
  oneWay?: number[];
  // Tiled format (orthogonal, CSV/array tile layer)
  width?: number;
  height?: number;
  tilewidth?: number;
  tileheight?: number;
  layers?: { type?: string; name?: string; data?: number[]; width?: number; height?: number }[];
}

export interface TileRef {
  col: number;
  row: number;
  id: number;
}

export type TileDrawFn = (id: number, x: number, y: number, col: number, row: number) => void;

/**
 * A rows×cols grid of integer tile ids. 0 means empty. By default every non-zero tile is solid
 * (for Physics); use `setSolid` / `setOneWay` to customize.
 */
export class Tilemap {
  readonly cols: number;
  readonly rows: number;
  readonly tileW: number;
  readonly tileH: number;
  readonly data: Int32Array;
  /** Tile ids that block movement. null = every non-zero id. */
  solid: Set<number> | null = null;
  /** Tile ids that only block from above (jump-through platforms). */
  oneWay: Set<number> = new Set();
  /** Treat the area outside the map as solid on the left/right/top/bottom edges. */
  solidBounds = { left: false, right: false, top: false, bottom: false };
  /** World offset of the map's top-left corner. */
  x = 0;
  y = 0;

  constructor(cols: number, rows: number, tileW: number, tileH: number = tileW, data?: ArrayLike<number>) {
    if (!(cols > 0 && rows > 0)) throw new Error('Tilemap: cols/rows must be > 0');
    this.cols = Math.floor(cols);
    this.rows = Math.floor(rows);
    this.tileW = tileW;
    this.tileH = tileH;
    this.data = new Int32Array(this.cols * this.rows);
    if (data) {
      if (data.length !== this.data.length) throw new Error(`Tilemap: expected ${this.data.length} tiles, got ${data.length}`);
      this.data.set(Array.from(data));
    }
  }

  /**
   * Build from a 2D array of numbers, or an array of strings plus a legend mapping characters to ids
   * (unknown characters and "." / " " become 0).
   */
  static fromArray(
    grid: readonly (readonly number[] | string)[],
    tileW: number,
    tileH: number = tileW,
    legend: Record<string, number> = {},
  ): Tilemap {
    const rows = grid.length;
    const cols = Math.max(0, ...grid.map((r) => r.length));
    const map = new Tilemap(cols, rows, tileW, tileH);
    grid.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        let id: number;
        if (typeof row === 'string') {
          const ch = row[c]!;
          id = legend[ch] ?? (/[0-9]/.test(ch) ? Number(ch) : 0);
        } else {
          id = (row as readonly number[])[c] ?? 0;
        }
        map.data[r * cols + c] = id;
      }
    });
    return map;
  }

  /** Build from Pixelforge JSON ({cols, rows, tileW, tileH, data}) or a Tiled map (first tile layer). */
  static fromJSON(json: TilemapJSON): Tilemap {
    let map: Tilemap;
    if (json.layers && (json.tilewidth || json.width)) {
      const layer = json.layers.find((l) => (l.type ?? 'tilelayer') === 'tilelayer' && Array.isArray(l.data));
      if (!layer || !layer.data) throw new Error('Tilemap.fromJSON: no tile layer with data');
      const w = layer.width ?? json.width!;
      const h = layer.height ?? json.height!;
      map = new Tilemap(w, h, json.tilewidth ?? 16, json.tileheight ?? json.tilewidth ?? 16, layer.data);
    } else if (Array.isArray(json.data) && Array.isArray(json.data[0])) {
      map = Tilemap.fromArray(json.data as number[][], json.tileW ?? 16, json.tileH ?? json.tileW ?? 16);
    } else if (Array.isArray(json.data) && json.cols && json.rows) {
      map = new Tilemap(json.cols, json.rows, json.tileW ?? 16, json.tileH ?? json.tileW ?? 16, json.data as number[]);
    } else {
      throw new Error('Tilemap.fromJSON: unrecognized format');
    }
    if (json.solid) map.setSolid(json.solid);
    if (json.oneWay) map.setOneWay(json.oneWay);
    return map;
  }

  get pixelWidth(): number {
    return this.cols * this.tileW;
  }
  get pixelHeight(): number {
    return this.rows * this.tileH;
  }
  get bounds(): Rect {
    return new Rect(this.x, this.y, this.pixelWidth, this.pixelHeight);
  }

  inBounds(col: number, row: number): boolean {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }
  /** Tile id at (col,row); out of bounds returns -1. */
  get(col: number, row: number): number {
    return this.inBounds(col, row) ? this.data[row * this.cols + col]! : -1;
  }
  set(col: number, row: number, id: number): void {
    if (this.inBounds(col, row)) this.data[row * this.cols + col] = id;
  }
  fill(id: number, col = 0, row = 0, w = this.cols, h = this.rows): void {
    for (let r = row; r < row + h; r++) for (let c = col; c < col + w; c++) this.set(c, r, id);
  }
  /** Tile id at a world position. */
  getAt(x: number, y: number): number {
    return this.get(this.colAt(x), this.rowAt(y));
  }
  colAt(x: number): number {
    return Math.floor((x - this.x) / this.tileW);
  }
  rowAt(y: number): number {
    return Math.floor((y - this.y) / this.tileH);
  }
  /** World rect of a tile. */
  tileRect(col: number, row: number): Rect {
    return new Rect(this.x + col * this.tileW, this.y + row * this.tileH, this.tileW, this.tileH);
  }
  /** World position of a tile's center. */
  tileCenter(col: number, row: number): { x: number; y: number } {
    return { x: this.x + (col + 0.5) * this.tileW, y: this.y + (row + 0.5) * this.tileH };
  }

  setSolid(ids: Iterable<number> | null): this {
    this.solid = ids === null ? null : new Set(ids);
    return this;
  }
  setOneWay(ids: Iterable<number>): this {
    this.oneWay = new Set(ids);
    return this;
  }

  /** Does the tile at (col,row) fully block movement? */
  isSolid(col: number, row: number): boolean {
    if (!this.inBounds(col, row)) {
      const b = this.solidBounds;
      return (col < 0 && b.left) || (col >= this.cols && b.right) || (row < 0 && b.top) || (row >= this.rows && b.bottom);
    }
    const id = this.data[row * this.cols + col]!;
    if (id <= 0 || this.oneWay.has(id)) return false;
    return this.solid === null ? true : this.solid.has(id);
  }
  isOneWay(col: number, row: number): boolean {
    const id = this.get(col, row);
    return id > 0 && this.oneWay.has(id);
  }
  isSolidAt(x: number, y: number): boolean {
    return this.isSolid(this.colAt(x), this.rowAt(y));
  }

  /** Inclusive tile index range covered by a world rect (strict: touching edges excluded). */
  tileRange(r: RectLike): { c0: number; r0: number; c1: number; r1: number } {
    const eps = 1e-6;
    return {
      c0: Math.floor((r.x - this.x) / this.tileW),
      r0: Math.floor((r.y - this.y) / this.tileH),
      c1: Math.floor((r.x + r.w - eps - this.x) / this.tileW),
      r1: Math.floor((r.y + r.h - eps - this.y) / this.tileH),
    };
  }

  /** Solid tiles overlapping a world rect. */
  solidTilesIn(r: RectLike): TileRef[] {
    const out: TileRef[] = [];
    const { c0, r0, c1, r1 } = this.tileRange(r);
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) if (this.isSolid(col, row)) out.push({ col, row, id: this.get(col, row) });
    return out;
  }
  overlapsSolid(r: RectLike): boolean {
    const { c0, r0, c1, r1 } = this.tileRange(r);
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) if (this.isSolid(col, row)) return true;
    return false;
  }

  /** Call `fn` for every non-empty tile. */
  forEach(fn: (id: number, col: number, row: number) => void): void {
    for (let row = 0; row < this.rows; row++)
      for (let col = 0; col < this.cols; col++) {
        const id = this.data[row * this.cols + col]!;
        if (id > 0) fn(id, col, row);
      }
  }
  /** All positions holding `id`. */
  find(id: number): TileRef[] {
    const out: TileRef[] = [];
    for (let i = 0; i < this.data.length; i++)
      if (this.data[i] === id) out.push({ col: i % this.cols, row: Math.floor(i / this.cols), id });
    return out;
  }
  /** Replace every `from` id with `to`; returns how many changed. */
  replace(from: number, to: number): number {
    let n = 0;
    for (let i = 0; i < this.data.length; i++)
      if (this.data[i] === from) {
        this.data[i] = to;
        n++;
      }
    return n;
  }

  /**
   * Draw visible tiles. With a SpriteSheet, tile id N draws frame N-1 (Tiled convention).
   * With a function, it's called per visible non-empty tile with its world position.
   * Culls to the renderer's current camera view.
   */
  draw(renderer: Renderer, tiles: SpriteSheet | TileDrawFn, opts: Pick<SpriteOptions, 'tint' | 'alpha'> = {}): void {
    const view = renderer.camera.view();
    const c0 = Math.max(0, this.colAt(view.x));
    const r0 = Math.max(0, this.rowAt(view.y));
    const c1 = Math.min(this.cols - 1, this.colAt(view.x + view.w));
    const r1 = Math.min(this.rows - 1, this.rowAt(view.y + view.h));
    const so: SpriteOptions = { w: this.tileW, h: this.tileH, frame: 0, tint: opts.tint, alpha: opts.alpha };
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const id = this.data[row * this.cols + col]!;
        if (id <= 0) continue;
        const x = this.x + col * this.tileW;
        const y = this.y + row * this.tileH;
        if (typeof tiles === 'function') tiles(id, x, y, col, row);
        else {
          so.frame = id - 1;
          renderer.drawSprite(tiles, x, y, so);
        }
      }
    }
  }
}

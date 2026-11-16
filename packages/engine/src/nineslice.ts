/** F012 9-slice: a framed image stretched to any size with unscaled corners. Pure (no GL). */
import type { ColorLike } from './math';
import type { Texture } from './texture';

/** Source px, integers >= 0. */
export type Insets = { left: number; top: number; right: number; bottom: number };

export type NineSliceOptions = {
  /** Only used when src is a Texture (a NineSlice carries its own). */
  insets?: number | Insets;
  /** Border scale on screen, default 1 (pixel art: 2, 3…); > 0. */
  scale?: number;
  tint?: ColorLike;
  alpha?: number;
  /** Draw the middle piece; default true (false = frame only). */
  center?: boolean;
};

/** One output quad of a 9-slice (game units + UVs). */
export interface NineQuad {
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** Validate insets against a `width × height` source; throws RangeError. */
export function toInsets(insets: number | Insets, width: number, height: number): Insets {
  const i: Insets =
    typeof insets === 'number'
      ? { left: insets, top: insets, right: insets, bottom: insets }
      : insets && typeof insets === 'object'
        ? { left: insets.left, top: insets.top, right: insets.right, bottom: insets.bottom }
        : (null as unknown as Insets);
  if (!i) throw new RangeError('NineSlice: insets must be a number or { left, top, right, bottom }');
  for (const k of ['left', 'top', 'right', 'bottom'] as const) {
    const v = i[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new RangeError(`NineSlice: insets.${k} must be an integer >= 0`);
  }
  if (i.left + i.right > width) throw new RangeError(`NineSlice: left + right (${i.left + i.right}) exceeds the texture width ${width}`);
  if (i.top + i.bottom > height) throw new RangeError(`NineSlice: top + bottom (${i.top + i.bottom}) exceeds the texture height ${height}`);
  return i;
}

/** A texture with fixed borders: `new engine.NineSlice(texture, insets)`. */
export class NineSlice {
  readonly texture: Texture;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;

  constructor(texture: Texture, insets: number | Insets) {
    if (!texture || typeof texture !== 'object' || !(texture.width > 0) || !(texture.height > 0))
      throw new RangeError('NineSlice: a Texture is required');
    const i = toInsets(insets, texture.width, texture.height);
    this.texture = texture;
    this.left = i.left;
    this.top = i.top;
    this.right = i.right;
    this.bottom = i.bottom;
  }
}

/** Split [0, size) into [a, size - a - b, b], shrinking a and b proportionally when they don't fit. */
function spans(size: number, a: number, b: number): [number, number, number] {
  if (a + b > 0 && size < a + b) {
    const f = size / (a + b);
    return [a * f, 0, b * f];
  }
  return [a, size - a - b, b];
}

/**
 * The quads of a 9-slice drawn at (x, y, w, h): corners at `scale`, edges stretched along one axis,
 * the centre along both. Applies the shrink rule; zero-area pieces are omitted; `w`/`h` <= 0 → [].
 */
export function nineSliceQuads(
  src: { width: number; height: number; u0: number; v0: number; u1: number; v1: number },
  insets: Insets,
  x: number, y: number, w: number, h: number,
  scale = 1,
  center = true,
): NineQuad[] {
  if (!(w > 0 && h > 0)) return [];
  const { left: L, top: T, right: R, bottom: B } = insets;
  const cols = spans(w, L * scale, R * scale);
  const rows = spans(h, T * scale, B * scale);
  const sx = [0, L, src.width - R, src.width];
  const sy = [0, T, src.height - B, src.height];
  const du = (src.u1 - src.u0) / src.width;
  const dv = (src.v1 - src.v0) / src.height;
  const out: NineQuad[] = [];
  let qy = y;
  for (let r = 0; r < 3; r++) {
    const qh = rows[r]!;
    let qx = x;
    for (let c = 0; c < 3; c++) {
      const qw = cols[c]!;
      const srcW = sx[c + 1]! - sx[c]!;
      const srcH = sy[r + 1]! - sy[r]!;
      if (qw > 0 && qh > 0 && srcW > 0 && srcH > 0 && (center || r !== 1 || c !== 1)) {
        out.push({
          x: qx, y: qy, w: qw, h: qh,
          u0: src.u0 + sx[c]! * du, v0: src.v0 + sy[r]! * dv,
          u1: src.u0 + sx[c + 1]! * du, v1: src.v0 + sy[r + 1]! * dv,
        });
      }
      qx += qw;
    }
    qy += qh;
  }
  return out;
}

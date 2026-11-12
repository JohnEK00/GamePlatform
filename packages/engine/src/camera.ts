/** 2D camera with zoom (around the view center), bounds clamping, follow and screen shake. Pure. */
import { clamp, Rect, type RectLike, type Point } from './math';

export class Camera {
  /** World position of the view's top-left corner at zoom 1. */
  x = 0;
  y = 0;
  /** Zoom factor (2 = everything twice as big), applied around the view center. */
  zoom = 1;
  /** Optional world rect the view is kept inside (applied by follow/update). */
  bounds: RectLike | null = null;
  /** Snap the view translation to whole pixels to avoid shimmering/seams. */
  roundPixels = true;
  /** Current shake offset (game units); recomputed each update. */
  shakeX = 0;
  shakeY = 0;
  private shakeTime = 0;
  private shakeDuration = 0;
  private shakeIntensity = 0;

  constructor(
    public viewWidth: number,
    public viewHeight: number,
    private rand: () => number = Math.random,
  ) {}

  /** Start a screen shake (intensity in game units, decays linearly over `duration` seconds). */
  shake(intensity = 6, duration = 0.3): void {
    // Stronger shakes override weaker ones.
    if (this.shakeTime > 0 && intensity * duration < this.shakeIntensity * this.shakeTime) return;
    this.shakeIntensity = intensity;
    this.shakeDuration = Math.max(1e-4, duration);
    this.shakeTime = duration;
  }

  /** Center the view on a world point. */
  centerOn(x: number, y: number): void {
    this.x = x - this.viewWidth / 2;
    this.y = y - this.viewHeight / 2;
    this.clampToBounds();
  }

  /**
   * Move the view toward centering (x, y). `smoothing` 1 = snap, smaller = lazier (fraction per call).
   * Call from update().
   */
  follow(x: number, y: number, smoothing = 1): void {
    const tx = x - this.viewWidth / 2;
    const ty = y - this.viewHeight / 2;
    const s = clamp(smoothing, 0, 1);
    this.x += (tx - this.x) * s;
    this.y += (ty - this.y) * s;
    this.clampToBounds();
  }

  clampToBounds(): void {
    const b = this.bounds;
    if (!b) return;
    const vw = this.viewWidth / this.zoom;
    const vh = this.viewHeight / this.zoom;
    const offX = (this.viewWidth - vw) / 2; // view-left = x + offX
    const offY = (this.viewHeight - vh) / 2;
    let left = this.x + offX;
    let top = this.y + offY;
    left = vw >= b.w ? b.x + (b.w - vw) / 2 : clamp(left, b.x, b.x + b.w - vw);
    top = vh >= b.h ? b.y + (b.h - vh) / 2 : clamp(top, b.y, b.y + b.h - vh);
    this.x = left - offX;
    this.y = top - offY;
  }

  /** Advance shake; called by the engine every fixed step. */
  update(dt: number): void {
    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - dt);
      const m = this.shakeIntensity * (this.shakeTime / this.shakeDuration);
      this.shakeX = (this.rand() * 2 - 1) * m;
      this.shakeY = (this.rand() * 2 - 1) * m;
    } else {
      this.shakeX = this.shakeY = 0;
    }
  }

  /** Visible world rect (ignoring shake). */
  view(): Rect {
    const vw = this.viewWidth / this.zoom;
    const vh = this.viewHeight / this.zoom;
    return new Rect(this.x + (this.viewWidth - vw) / 2, this.y + (this.viewHeight - vh) / 2, vw, vh);
  }

  /** Screen (game) coordinates → world coordinates (e.g. for mouse picking). */
  screenToWorld(sx: number, sy: number): Point {
    const hw = this.viewWidth / 2;
    const hh = this.viewHeight / 2;
    return { x: (sx - hw - this.shakeX) / this.zoom + this.x + hw, y: (sy - hh - this.shakeY) / this.zoom + this.y + hh };
  }

  worldToScreen(wx: number, wy: number): Point {
    const hw = this.viewWidth / 2;
    const hh = this.viewHeight / 2;
    return { x: (wx - this.x - hw) * this.zoom + hw + this.shakeX, y: (wy - this.y - hh) * this.zoom + hh + this.shakeY };
  }

  /**
   * Affine transform world → screen as [scale, offsetX, offsetY] where screen = world*scale + offset.
   * `pixelRatio` (device px per game unit) is used for pixel snapping.
   */
  transform(pixelRatio = 1): [number, number, number] {
    const hw = this.viewWidth / 2;
    const hh = this.viewHeight / 2;
    let ox = (-this.x - hw) * this.zoom + hw + this.shakeX;
    let oy = (-this.y - hh) * this.zoom + hh + this.shakeY;
    if (this.roundPixels && pixelRatio > 0) {
      ox = Math.round(ox * pixelRatio) / pixelRatio;
      oy = Math.round(oy * pixelRatio) / pixelRatio;
    }
    return [this.zoom, ox, oy];
  }
}

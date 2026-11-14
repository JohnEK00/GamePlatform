/**
 * Frame capture for screenshots (docs/GAME_FORMAT.md § F005).
 *
 * The WebGL context keeps `preserveDrawingBuffer: false`, so the drawing buffer is only readable
 * inside the task that rendered it. Captures are therefore queued with `request()` / `capture()`
 * and fulfilled by the engine calling `grab()` at the capture point inside the frame (after the
 * game's draw calls are flushed, before the debug / pause / error overlays). Encoding is async.
 */

/** Options for `engine.captureFrame`. */
export interface ScreenshotOptions {
  /** Longest output side in pixels; rounded and clamped to 64–4096 (invalid → 1920). */
  maxSize?: number;
}

/** Options for `engine.platform.shareScreenshot`. */
export interface ShareScreenshotOptions {
  /** Caption suggested to the player (sanitised, at most 140 code points). */
  caption?: string;
}

/** Error codes of a capture (the same codes `webgame:screenshot` carries). */
export type ScreenshotError = 'unavailable' | 'busy' | 'failed';

/** Outcome of one capture. */
export type CaptureResult = { blob: Blob; width: number; height: number } | { error: ScreenshotError };

/** Who asked for the capture (used for warnings only). */
export type CaptureKind = 'game' | 'player' | 'share';

export const DEFAULT_SCREENSHOT_SIZE = 1920;
export const MIN_SCREENSHOT_SIZE = 64;
export const MAX_SCREENSHOT_SIZE = 4096;
/** Integer upscale target for the longest side. */
export const SCREENSHOT_UPSCALE_TARGET = 1280;
/** A queued capture fails as `unavailable` when no frame reaches the capture point in this time. */
export const CAPTURE_TIMEOUT_MS = 2000;
/** Encoded PNGs larger than this count as `failed`. */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/** `maxSize` rule: rounded and clamped to 64–4096; anything non-numeric → 1920. */
export function normalizeMaxSize(v: unknown): number {
  if (v === undefined || v === null || v === '') return DEFAULT_SCREENSHOT_SIZE;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_SCREENSHOT_SIZE;
  return Math.min(MAX_SCREENSHOT_SIZE, Math.max(MIN_SCREENSHOT_SIZE, n));
}

/**
 * Output size of a screenshot for a logical resolution `w×h`: integer upscale so the longest side
 * approaches 1280 (`k = max(1, floor(1280 / max(w, h)))`), then scale down to fit `maxSize`
 * (normalised, see `normalizeMaxSize`) keeping the aspect ratio. Sides are rounded, at least 1.
 */
export function screenshotSize(w: number, h: number, maxSize: number = DEFAULT_SCREENSHOT_SIZE): { width: number; height: number } {
  const lw = Math.max(1, Math.round(Number(w)) || 1);
  const lh = Math.max(1, Math.round(Number(h)) || 1);
  const max = normalizeMaxSize(maxSize);
  const k = Math.max(1, Math.floor(SCREENSHOT_UPSCALE_TARGET / Math.max(lw, lh)));
  let ow = lw * k;
  let oh = lh * k;
  const longest = Math.max(ow, oh);
  if (longest > max) {
    const s = max / longest;
    ow *= s;
    oh *= s;
  }
  return { width: Math.max(1, Math.round(ow)), height: Math.max(1, Math.round(oh)) };
}

/** True when `a / b` or `b / a` is a whole number (sampling stays crisp with nearest-neighbour). */
function wholeRatio(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  const r = a >= b ? a / b : b / a;
  return Math.abs(r - Math.round(r)) < 1e-9;
}

/** True when backing → output scaling is an integer factor on both axes. */
export function isIntegerRatio(srcW: number, srcH: number, outW: number, outH: number): boolean {
  return wholeRatio(srcW, outW) && wholeRatio(srcH, outH);
}

/** The source canvas as the grabber sees it. */
export interface GrabSource {
  readonly width: number;
  readonly height: number;
}

/**
 * Draws `source` scaled to `width×height` **synchronously** and returns a promise of the encoded
 * PNG. Injectable so tests run without WebGL / canvas.
 */
export type FrameGrabber = (
  source: GrabSource,
  width: number,
  height: number,
  smooth: boolean,
  gl: WebGL2RenderingContext | null,
) => Promise<Blob>;

interface Job {
  kind: CaptureKind;
  maxSize: number;
  resolve(r: CaptureResult): void;
  timer: ReturnType<typeof setTimeout> | null;
}

type Scratch = OffscreenCanvas | HTMLCanvasElement;
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(w: number, h: number): Scratch {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function encodePng(c: Scratch): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) =>
    (c as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png'),
  );
}

function isSecurityError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'SecurityError';
}

/** One capture slot: at most one capture is queued or encoding at a time. */
export class FrameCapture {
  private job: Job | null = null;
  private active: Job | null = null;
  private closed = false;
  private scratch: Scratch | null = null;
  private readonly grabber: FrameGrabber;

  constructor(
    /** Logical resolution (game.json width/height). */
    private readonly width: number,
    private readonly height: number,
    grabber?: FrameGrabber,
    private readonly timeoutMs = CAPTURE_TIMEOUT_MS,
  ) {
    this.grabber = grabber ?? this.defaultGrab;
  }

  /** True while a capture waits for the capture point (the engine checks this every frame). */
  get queued(): boolean {
    return this.job !== null;
  }

  /** True while a capture is queued or encoding. */
  get busy(): boolean {
    return this.job !== null || this.active !== null;
  }

  /** Queue one capture; resolves with the PNG or null (busy / timeout / failure / destroyed). */
  async request(kind: CaptureKind, opts: ScreenshotOptions = {}): Promise<Blob | null> {
    const r = await this.capture(kind, opts);
    return 'blob' in r ? r.blob : null;
  }

  /** Queue one capture and resolve with the detailed result (error code on failure). */
  capture(kind: CaptureKind, opts: ScreenshotOptions = {}): Promise<CaptureResult> {
    if (this.closed) return Promise.resolve({ error: 'unavailable' });
    if (this.busy) {
      console.warn(`[pixelforge] screenshot (${kind}): another capture is in progress`);
      return Promise.resolve({ error: 'busy' });
    }
    return new Promise((resolve) => {
      const job: Job = { kind, maxSize: normalizeMaxSize(opts?.maxSize), resolve, timer: null };
      job.timer = setTimeout(() => {
        if (this.job !== job) return;
        this.job = null;
        resolve({ error: 'unavailable' });
      }, this.timeoutMs);
      this.job = job;
    });
  }

  /**
   * Engine-internal: called at the capture point of a rendered frame. Draws the queued capture
   * from `glCanvas` synchronously; encoding finishes after the frame.
   */
  grab(glCanvas: GrabSource, defaultSmooth: boolean, gl: WebGL2RenderingContext | null = null): void {
    const job = this.job;
    if (!job) return;
    this.job = null;
    if (job.timer !== null) clearTimeout(job.timer);
    this.active = job;
    const finish = (r: CaptureResult): void => {
      if (this.active !== job) return; // cancelled meanwhile
      this.active = null;
      this.shrink();
      job.resolve(r);
    };
    let encoded: Promise<Blob>;
    try {
      if (gl && typeof gl.isContextLost === 'function' && gl.isContextLost()) throw new Error('context lost');
      const { width, height } = screenshotSize(this.width, this.height, job.maxSize);
      const smooth = defaultSmooth || !isIntegerRatio(glCanvas.width, glCanvas.height, width, height);
      encoded = this.grabber(glCanvas, width, height, smooth, gl).then((blob) => {
        if (!blob || blob.size > MAX_SCREENSHOT_BYTES) throw new Error('screenshot too large');
        return blob;
      });
      encoded.then(
        (blob) => finish({ blob, width, height }),
        (e) => {
          console.warn('[pixelforge] screenshot failed:', e);
          finish({ error: 'failed' });
        },
      );
    } catch (e) {
      console.warn('[pixelforge] screenshot failed:', e);
      finish({ error: 'failed' });
    }
  }

  /** Resolve the queued and the encoding capture with `error` (destroy / crash). */
  cancel(error: ScreenshotError = 'unavailable'): void {
    for (const job of [this.job, this.active]) {
      if (!job) continue;
      if (job.timer !== null) clearTimeout(job.timer);
      job.resolve({ error });
    }
    this.job = null;
    this.active = null;
    this.shrink();
  }

  /** Cancel everything and refuse later captures (`unavailable`). */
  close(): void {
    this.closed = true;
    this.cancel('unavailable');
  }

  private shrink(): void {
    if (this.scratch) {
      this.scratch.width = 1;
      this.scratch.height = 1;
    }
  }

  private readonly defaultGrab: FrameGrabber = (src, w, h, smooth, gl) => {
    if (!this.scratch) this.scratch = makeCanvas(w, h);
    const c = this.scratch;
    c.width = w; // resizing also resets the 2D state
    c.height = h;
    const ctx = c.getContext('2d') as Ctx2D | null;
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.imageSmoothingEnabled = smooth;
    ctx.imageSmoothingQuality = 'high';
    try {
      ctx.drawImage(src as CanvasImageSource, 0, 0, src.width, src.height, 0, 0, w, h);
    } catch (e) {
      if (isSecurityError(e) || !gl) throw e;
      readPixelsInto(ctx, src, gl, w, h);
    }
    return encodePng(c);
  };
}

/** Fallback when drawImage of a WebGL canvas throws: readPixels at backing size, flip, scale. */
function readPixelsInto(ctx: Ctx2D, src: GrabSource, gl: WebGL2RenderingContext, w: number, h: number): void {
  const bw = Math.max(1, gl.drawingBufferWidth || src.width);
  const bh = Math.max(1, gl.drawingBufferHeight || src.height);
  const buf = new Uint8Array(bw * bh * 4);
  gl.readPixels(0, 0, bw, bh, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const out = new Uint8ClampedArray(buf.length);
  const row = bw * 4;
  for (let y = 0; y < bh; y++) out.set(buf.subarray((bh - 1 - y) * row, (bh - y) * row), y * row);
  for (let i = 3; i < out.length; i += 4) out[i] = 255; // opaque context (alpha: false)
  const tmp = makeCanvas(bw, bh);
  const tctx = tmp.getContext('2d') as Ctx2D | null;
  if (!tctx) throw new Error('2D canvas unavailable');
  tctx.putImageData(new ImageData(out, bw, bh), 0, 0);
  ctx.drawImage(tmp as CanvasImageSource, 0, 0, bw, bh, 0, 0, w, h);
  tmp.width = 1;
  tmp.height = 1;
}

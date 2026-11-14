// F005: screenshot helpers (pure, no React). See docs/GAME_FORMAT.md § F005 and docs/ARCHITECTURE.md § F005.
//
// SECURITY: a Blob that came from a game iframe is untrusted (its bytes AND its `type`). A blob: URL created by
// the parent has the parent's origin, so an HTML/SVG payload would run as the app. Such a Blob must go through
// `launderImage` (decode + re-encode to PNG) before it is displayed, downloaded, copied or uploaded.

import { slugify } from "./studio/project";

/**
 * `window` CustomEvent a host (e.g. the desktop "View → Take Screenshot" menu item) dispatches to trigger a capture
 * in the mounted GamePlayer or StudioPreview: `window.dispatchEvent(new CustomEvent(PLAYER_SCREENSHOT_EVENT))`.
 */
export const PLAYER_SCREENSHOT_EVENT = "webgame:player-screenshot";

/** Largest Blob accepted from a game (GAME_FORMAT § F005). */
export const SCREENSHOT_MAX_BLOB_BYTES = 8 * 1024 * 1024;
/** Largest side accepted when laundering. */
export const SCREENSHOT_MAX_SIDE = 4096;
/** Max caption length in code points. */
export const SCREENSHOT_CAPTION_MAX = 140;
/** Upload cap of `PUT /api/games/{id}/thumbnail` and `POST …/screenshots`. */
export const SCREENSHOT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

/** A decoded image. `close` releases it (ImageBitmap.close). */
export type DecodedImage = { width: number; height: number; source: CanvasImageSource; close: () => void };

/** Decoder/encoder pair; injectable so tests can run without a real canvas. */
export type ImageCodec = {
  /** Decodes an image Blob; rejects for anything that isn't a decodable image. */
  decode: (blob: Blob) => Promise<DecodedImage>;
  /** Draws `img` scaled to `width`×`height` (on black) and encodes it. Resolves null when the encoder fails. */
  encode: (img: DecodedImage, width: number, height: number, type: string, quality?: number) => Promise<Blob | null>;
};

function makeCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  throw new Error("No canvas available to process the image.");
}

/** The browser codec: `createImageBitmap` + a 2D canvas. */
export const browserImageCodec: ImageCodec = {
  async decode(blob) {
    if (typeof createImageBitmap !== "function") throw new Error("This browser can't decode images.");
    const bmp = await createImageBitmap(blob);
    return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close?.() };
  },
  async encode(img, width, height, type, quality) {
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img.source, 0, 0, width, height);
    try {
      if ("convertToBlob" in canvas) return await canvas.convertToBlob({ type, quality });
      return await new Promise<Blob | null>((resolve) => (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), type, quality));
    } finally {
      // Release the backing store early.
      canvas.width = 1;
      canvas.height = 1;
    }
  },
};

export type LaunderedImage = { blob: Blob; width: number; height: number };

/**
 * Re-encodes an untrusted image Blob to a fresh PNG ("laundering"): rejects anything over 8 MiB, decodes it with
 * `createImageBitmap` (which throws on non-images), checks each side is 1–4096, draws it to a canvas and encodes
 * `image/png`. Only the returned Blob may be given an object URL, downloaded, copied or uploaded.
 */
export async function launderImage(blob: Blob, codec: ImageCodec = browserImageCodec): Promise<LaunderedImage> {
  if (!(blob instanceof Blob)) throw new Error("Not an image.");
  if (blob.size > SCREENSHOT_MAX_BLOB_BYTES) throw new Error("The image is too large.");
  const img = await codec.decode(blob);
  try {
    const { width, height } = img;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > SCREENSHOT_MAX_SIDE || height > SCREENSHOT_MAX_SIDE)
      throw new Error("The image has unsupported dimensions.");
    const out = await codec.encode(img, width, height, "image/png");
    if (!out || out.type !== "image/png" || out.size === 0) throw new Error("The image could not be encoded.");
    return { blob: out, width, height };
  } finally {
    img.close();
  }
}

/** Shrink factor per step of {@link fitImageForUpload}, and the maximum number of steps. */
export const FIT_SCALE_STEP = 0.75;
export const FIT_MAX_STEPS = 4;

/**
 * Fits an image (normally a laundered PNG) under `maxBytes` for upload: the PNG as-is if it's small enough; else
 * WebP 0.92, then JPEG 0.9 at full size; then the same at 0.75× per step (at most 4 steps). Throws when nothing fits.
 * An encoder that silently returns another type (e.g. no WebP encoding) is skipped.
 */
export async function fitImageForUpload(blob: Blob, maxBytes = SCREENSHOT_UPLOAD_MAX_BYTES, codec: ImageCodec = browserImageCodec): Promise<Blob> {
  if (blob.type === "image/png" && blob.size <= maxBytes) return blob;
  const img = await codec.decode(blob);
  try {
    const attempts: [string, number][] = [
      ["image/webp", 0.92],
      ["image/jpeg", 0.9],
    ];
    for (let step = 0; step <= FIT_MAX_STEPS; step++) {
      const scale = FIT_SCALE_STEP ** step;
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      for (const [type, quality] of attempts) {
        const out = await codec.encode(img, w, h, type, quality);
        if (out && out.type === type && out.size > 0 && out.size <= maxBytes) return out;
      }
    }
  } finally {
    img.close();
  }
  throw new Error("The image is too large to upload.");
}

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

/** `{slug}-{YYYYMMDD-HHmmss}.png` in local time; `slug` uses the F013 bundle-download rule (`slugify`). */
export function screenshotFileName(title: string, date: Date = new Date()): string {
  const d = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const t = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${slugify(title)}-${d}-${t}.png`;
}

// C0/C1 controls, DEL, bidi embeddings/overrides/isolates, LRM/RLM/ALM.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/** Coerces to a string, removes control and bidi characters, trims, and cuts to 140 code points. */
export function sanitizeScreenshotCaption(v: unknown, max = SCREENSHOT_CAPTION_MAX): string {
  if (v === undefined || v === null) return "";
  const s = String(v).replace(UNSAFE_CHARS, "").trim();
  return Array.from(s).slice(0, max).join("").trim();
}

/** Length in code points (what the server counts). */
export function codePointLength(s: string): number {
  return Array.from(s).length;
}

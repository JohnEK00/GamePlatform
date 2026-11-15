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

/** Largest pixel count accepted when laundering (4096², ~16.8 M). */
export const SCREENSHOT_MAX_PIXELS = SCREENSHOT_MAX_SIDE * SCREENSHOT_MAX_SIDE;
/** Smallest side the server accepts for a posted screenshot (`POST …/screenshots`). */
export const SCREENSHOT_MIN_UPLOAD_SIDE = 64;
/** How many leading bytes {@link sniffImage} reads to find the dimensions (JPEG APPn segments come first). */
export const IMAGE_HEADER_SCAN_BYTES = 512 * 1024;

export type ImageHeader = { format: "png" | "jpeg" | "webp"; width: number; height: number };

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b: Uint8Array, i: number, s: string) => {
  if (i + s.length > b.length) return false;
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
  return true;
};

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngHeader(b: Uint8Array): ImageHeader | null {
  // After the signature, the first chunk must be IHDR with length 13.
  if (b.length < 24 || be32(b, 8) !== 13 || !ascii(b, 12, "IHDR")) return null;
  return { format: "png", width: be32(b, 16), height: be32(b, 20) };
}

function jpegHeader(b: Uint8Array): ImageHeader | null {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return null;
    const m = b[i++];
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // standalone markers (TEM, RSTn)
    if (m === 0x00 || m === 0xd8 || m === 0xd9 || m === 0xda) return null; // SOI again, EOI or SOS before a frame
    if (i + 2 > b.length) return null;
    const len = be16(b, i);
    if (len < 2) return null;
    if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      // SOF0/1/2: length(2) precision(1) height(2) width(2)
      if (len < 8 || i + 7 > b.length) return null;
      return { format: "jpeg", width: be16(b, i + 5), height: be16(b, i + 3) };
    }
    // Other SOFn (lossless, hierarchical, arithmetic) are not supported. C4 = DHT, C8 = JPG, CC = DAC.
    if (m >= 0xc3 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return null;
    i += len;
  }
  return null;
}

function webpHeader(b: Uint8Array): ImageHeader | null {
  if (b.length < 30 || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) {
    // Lossy: 3-byte frame tag (bit 0 = 0 for a key frame), start code 9D 01 2A, then 14-bit width / height.
    if ((b[20] & 1) !== 0 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { format: "webp", width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, "VP8L")) {
    // Lossless: signature 0x2F, then (width-1):14 and (height-1):14, little-endian bits.
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, "VP8X")) {
    // Extended: flags(1) reserved(3), (canvas width-1):24, (canvas height-1):24.
    return { format: "webp", width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  }
  return null;
}

/**
 * Reads the format and dimensions from an image's leading bytes WITHOUT decoding it: PNG (IHDR), JPEG (the first
 * SOF0/1/2 segment) or WebP (VP8 / VP8L / VP8X). Returns null for any other format or a malformed header.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length >= 8 && PNG_SIG.every((v, k) => bytes[k] === v)) return pngHeader(bytes);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return jpegHeader(bytes);
  if (ascii(bytes, 0, "RIFF")) return webpHeader(bytes);
  return null;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error("Couldn't read the image."));
    r.readAsArrayBuffer(blob);
  });
}

/** True when both sides are integers in 1–4096 and the pixel count is at most 4096². */
export function imageDimensionsOk(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= SCREENSHOT_MAX_SIDE &&
    height <= SCREENSHOT_MAX_SIDE &&
    width * height <= SCREENSHOT_MAX_PIXELS
  );
}

/**
 * Pre-decode gate for an untrusted Blob (review 3, M1). It reads at most the first 512 KiB, requires a PNG, JPEG
 * or WebP signature and a well-formed header, and checks the header's dimensions; it throws otherwise. This keeps
 * a decompression bomb (a tiny file that claims a huge size) away from `createImageBitmap`.
 */
export async function sniffImage(blob: Blob): Promise<ImageHeader> {
  const head = await blobBytes(blob.slice(0, IMAGE_HEADER_SCAN_BYTES));
  const h = readImageHeader(head);
  if (!h) throw new Error("Not a PNG, JPEG or WebP image.");
  if (!imageDimensionsOk(h.width, h.height)) throw new Error("The image has unsupported dimensions.");
  return h;
}

/**
 * Re-encodes an untrusted image Blob to a fresh PNG ("laundering"): rejects anything over 8 MiB, then checks the
 * magic bytes and header dimensions with {@link sniffImage} (PNG/JPEG/WebP only, each side 1–4096) BEFORE any
 * decode. It then decodes with `createImageBitmap`, checks the decoded size again, draws it to a canvas and
 * encodes `image/png`. Only the returned Blob may be given an object URL, downloaded, copied or uploaded.
 */
export async function launderImage(blob: Blob, codec: ImageCodec = browserImageCodec): Promise<LaunderedImage> {
  if (!(blob instanceof Blob)) throw new Error("Not an image.");
  if (blob.size > SCREENSHOT_MAX_BLOB_BYTES) throw new Error("The image is too large.");
  await sniffImage(blob);
  const img = await codec.decode(blob);
  try {
    const { width, height } = img;
    if (!imageDimensionsOk(width, height)) throw new Error("The image has unsupported dimensions.");
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

/** True when the server would refuse to store a screenshot of this size (a side under 64 px). */
export function isBelowUploadMinimum(width: number, height: number): boolean {
  return Math.min(width, height) < SCREENSHOT_MIN_UPLOAD_SIDE;
}

/**
 * Fits an already laundered image under `maxBytes` for upload: the PNG as-is if it's small enough; else WebP 0.92,
 * then JPEG 0.9 at full size; then the same at 0.75× per step (at most 4 steps). The scale never takes the short
 * side under 64 px, the server minimum (review 3, L6): a step that would is clamped to exactly 64 px, and nothing
 * smaller is tried. An image whose short side is already 64 px or less is never shrunk. Throws when nothing fits.
 * An encoder that silently returns another type (e.g. no WebP encoding) is skipped.
 * Never pass a Blob that came from a game: this decodes without {@link sniffImage}.
 */
export async function fitImageForUpload(blob: Blob, maxBytes = SCREENSHOT_UPLOAD_MAX_BYTES, codec: ImageCodec = browserImageCodec): Promise<Blob> {
  if (blob.type === "image/png" && blob.size <= maxBytes) return blob;
  const img = await codec.decode(blob);
  try {
    const attempts: [string, number][] = [
      ["image/webp", 0.92],
      ["image/jpeg", 0.9],
    ];
    const short = Math.min(img.width, img.height);
    const minScale = short > SCREENSHOT_MIN_UPLOAD_SIDE ? SCREENSHOT_MIN_UPLOAD_SIDE / short : 1;
    let lastScale = -1;
    for (let step = 0; step <= FIT_MAX_STEPS; step++) {
      const scale = Math.max(minScale, FIT_SCALE_STEP ** step);
      if (scale === lastScale) break; // already at the 64 px floor
      lastScale = scale;
      let w = Math.max(1, Math.round(img.width * scale));
      let h = Math.max(1, Math.round(img.height * scale));
      // Rounding must not dip under the floor either.
      if (short >= SCREENSHOT_MIN_UPLOAD_SIDE) {
        if (img.width <= img.height) w = Math.max(w, SCREENSHOT_MIN_UPLOAD_SIDE);
        else h = Math.max(h, SCREENSHOT_MIN_UPLOAD_SIDE);
      }
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

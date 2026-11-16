import { describe, expect, it, vi } from "vitest";
import {
  fitImageForUpload,
  imageDimensionsOk,
  isBelowUploadMinimum,
  launderImage,
  readImageHeader,
  sniffImage,
  PLAYER_SCREENSHOT_EVENT,
  sanitizeScreenshotCaption,
  screenshotFileName,
  type DecodedImage,
  type ImageCodec,
} from "../screenshot";
import * as api from "../index";
import { blobOf, jpegBytes, pngBytes, webpVp8Bytes, webpVp8lBytes, webpVp8xBytes } from "./imageBytes";

const MB = 1024 * 1024;

/** A codec whose output size depends on (type, width) through `sizeOf`. Records every encode call. */
function fakeCodec(sizeOf: (type: string, w: number, h: number) => number, dims = { width: 1920, height: 1080 }) {
  const calls: [string, number, number, number | undefined][] = [];
  const close = vi.fn();
  const codec: ImageCodec = {
    decode: vi.fn(async (): Promise<DecodedImage> => ({ ...dims, source: {} as CanvasImageSource, close })),
    encode: vi.fn(async (_img, w, h, type, q) => {
      calls.push([type, w, h, q]);
      return new Blob([new Uint8Array(sizeOf(type, w, h))], { type });
    }),
  };
  return { codec, calls, close };
}

describe("fitImageForUpload", () => {
  it("returns a small PNG as-is without decoding", async () => {
    const { codec } = fakeCodec(() => 1);
    const png = new Blob([new Uint8Array(1000)], { type: "image/png" });
    expect(await fitImageForUpload(png, 2 * MB, codec)).toBe(png);
    expect(codec.decode).not.toHaveBeenCalled();
  });

  it("tries WebP 0.92 first", async () => {
    const { codec, calls, close } = fakeCodec((t) => (t === "image/webp" ? MB : 3 * MB));
    const out = await fitImageForUpload(new Blob([new Uint8Array(3 * MB)], { type: "image/png" }), 2 * MB, codec);
    expect(out.type).toBe("image/webp");
    expect(calls).toEqual([["image/webp", 1920, 1080, 0.92]]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("falls back to JPEG 0.9, and skips an encoder that returns another type", async () => {
    const { codec, calls } = fakeCodec(() => MB);
    // No WebP encoder: the browser hands back a PNG instead.
    (codec.encode as ReturnType<typeof vi.fn>).mockImplementation(async (_i: unknown, w: number, h: number, type: string, q: number) => {
      calls.push([type, w, h, q]);
      return new Blob([new Uint8Array(MB)], { type: type === "image/webp" ? "image/png" : type });
    });
    const out = await fitImageForUpload(new Blob([new Uint8Array(3 * MB)], { type: "image/png" }), 2 * MB, codec);
    expect(out.type).toBe("image/jpeg");
    expect(calls.map((c) => [c[0], c[3]])).toEqual([
      ["image/webp", 0.92],
      ["image/jpeg", 0.9],
    ]);
  });

  it("shrinks by 0.75 per step until it fits", async () => {
    const { codec, calls } = fakeCodec((_t, w) => (w <= 1080 ? MB : 3 * MB));
    const out = await fitImageForUpload(new Blob([new Uint8Array(3 * MB)], { type: "image/png" }), 2 * MB, codec);
    expect(out.size).toBe(MB);
    expect(calls.map((c) => c[1])).toEqual([1920, 1920, 1440, 1440, 1080]);
    expect(calls.at(-1)).toEqual(["image/webp", 1080, 608, 0.92]);
  });

  it("throws after 4 shrink steps", async () => {
    const { codec, calls, close } = fakeCodec(() => 3 * MB);
    await expect(fitImageForUpload(new Blob([new Uint8Array(3 * MB)], { type: "image/png" }), 2 * MB, codec)).rejects.toThrow(/too large/);
    expect(calls).toHaveLength(10); // full size + 4 steps, two formats each
    expect(calls.at(-1)?.[1]).toBe(Math.round(1920 * 0.75 ** 4));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("never shrinks the short side under 64 px (review 3, L6)", async () => {
    // 1920×180: 0.75 steps would reach 135, 101, 76, 57 → the last one is clamped to 64 and then it stops.
    const { codec, calls } = fakeCodec(() => 3 * MB, { width: 1920, height: 180 });
    await expect(fitImageForUpload(new Blob([new Uint8Array(3 * MB)], { type: "image/png" }), 2 * MB, codec)).rejects.toThrow(/too large/);
    const heights = calls.map((c) => c[2]);
    expect(Math.min(...heights)).toBe(64);
    expect(heights).toEqual([180, 180, 135, 135, 101, 101, 76, 76, 64, 64]);
    expect(calls.at(-1)?.[1]).toBe(Math.round((1920 * 64) / 180));
  });

  it("doesn't shrink an image whose short side is already 64 px or less", async () => {
    const { codec, calls } = fakeCodec(() => 3 * MB, { width: 4096, height: 40 });
    await expect(fitImageForUpload(new Blob([new Uint8Array(3 * MB)], { type: "image/png" }), 2 * MB, codec)).rejects.toThrow(/too large/);
    expect(calls.map((c) => [c[1], c[2]])).toEqual([
      [4096, 40],
      [4096, 40],
    ]);
    expect(isBelowUploadMinimum(4096, 40)).toBe(true);
    expect(isBelowUploadMinimum(64, 64)).toBe(false);
  });

  it("re-encodes a small non-PNG", async () => {
    const { codec } = fakeCodec(() => 10);
    const out = await fitImageForUpload(new Blob([new Uint8Array(10)], { type: "image/gif" }), 2 * MB, codec);
    expect(out.type).toBe("image/webp");
  });
});

describe("launderImage", () => {
  it("decodes and re-encodes to a new PNG", async () => {
    const { codec, calls, close } = fakeCodec(() => 50, { width: 320, height: 180 });
    const src = blobOf(pngBytes(320, 180));
    const out = await launderImage(src, codec);
    expect(out.blob).not.toBe(src);
    expect(out.blob.type).toBe("image/png");
    expect([out.width, out.height]).toEqual([320, 180]);
    expect(calls).toEqual([["image/png", 320, 180, undefined]]);
    expect(close).toHaveBeenCalled();
  });

  it("rejects blobs over 8 MiB without decoding", async () => {
    const { codec } = fakeCodec(() => 1);
    await expect(launderImage(new Blob([new Uint8Array(8 * MB + 1)], { type: "image/png" }), codec)).rejects.toThrow();
    expect(codec.decode).not.toHaveBeenCalled();
  });

  it("rejects undecodable blobs and bad dimensions", async () => {
    const bad: ImageCodec = { decode: async () => Promise.reject(new DOMException("bad", "InvalidStateError")), encode: async () => null };
    await expect(launderImage(new Blob(["<html>"], { type: "text/html" }), bad)).rejects.toThrow();
    for (const dims of [
      { width: 0, height: 10 },
      { width: 4097, height: 10 },
      { width: 10, height: 5000 },
    ]) {
      const { codec, close } = fakeCodec(() => 1, dims);
      await expect(launderImage(blobOf(pngBytes(10, 10)), codec)).rejects.toThrow(/dimensions/);
      expect(close).toHaveBeenCalled();
    }
  });

  it("fails when the encoder returns nothing", async () => {
    const codec: ImageCodec = {
      decode: async () => ({ width: 10, height: 10, source: {} as CanvasImageSource, close: () => {} }),
      encode: async () => null,
    };
    await expect(launderImage(blobOf(pngBytes(10, 10)), codec)).rejects.toThrow();
  });

  it("rejects a decompression bomb from its header, without decoding (review 3, M1)", async () => {
    // A ~40-byte PNG claiming 30000×30000 (3.35 GiB decoded).
    const { codec } = fakeCodec(() => 1);
    await expect(launderImage(blobOf(pngBytes(30000, 30000)), codec)).rejects.toThrow(/dimensions/);
    await expect(launderImage(blobOf(pngBytes(4097, 1)), codec)).rejects.toThrow(/dimensions/);
    await expect(launderImage(blobOf(jpegBytes(16384, 16384), "image/jpeg"), codec)).rejects.toThrow(/dimensions/);
    await expect(launderImage(blobOf(webpVp8xBytes(16384, 16384), "image/webp"), codec)).rejects.toThrow(/dimensions/);
    expect(codec.decode).not.toHaveBeenCalled();
  });

  it("never calls createImageBitmap for an oversized header (browser codec)", async () => {
    const cib = vi.fn(async () => ({ width: 30000, height: 30000, close: vi.fn() }));
    vi.stubGlobal("createImageBitmap", cib);
    try {
      await expect(launderImage(blobOf(pngBytes(30000, 30000)))).rejects.toThrow(/dimensions/);
      await expect(launderImage(new Blob(["<svg onload=alert(1)>"], { type: "image/png" }))).rejects.toThrow(/PNG, JPEG or WebP/);
      expect(cib).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects unknown formats and malformed headers without decoding", async () => {
    const { codec } = fakeCodec(() => 1);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0]);
    const truncatedPng = pngBytes(10, 10).slice(0, 20);
    const notIhdr = pngBytes(10, 10);
    notIhdr[12] = 0x58; // "XHDR"
    for (const bytes of [gif, truncatedPng, notIhdr, new TextEncoder().encode("<svg onload=alert(1)>"), new Uint8Array(0)]) {
      await expect(launderImage(blobOf(bytes), codec)).rejects.toThrow(/PNG, JPEG or WebP/);
    }
    expect(codec.decode).not.toHaveBeenCalled();
  });

  it("decodes a well-formed in-range JPEG and WebP", async () => {
    const { codec } = fakeCodec(() => 5, { width: 100, height: 80 });
    await expect(launderImage(blobOf(jpegBytes(100, 80), "image/jpeg"), codec)).resolves.toMatchObject({ width: 100, height: 80 });
    await expect(launderImage(blobOf(webpVp8Bytes(100, 80), "image/webp"), codec)).resolves.toMatchObject({ width: 100, height: 80 });
    expect(codec.decode).toHaveBeenCalledTimes(2);
  });
});

describe("readImageHeader", () => {
  it("reads PNG, JPEG (SOF0/1/2) and WebP (VP8, VP8L, VP8X) dimensions", () => {
    expect(readImageHeader(pngBytes(320, 180))).toEqual({ format: "png", width: 320, height: 180 });
    expect(readImageHeader(jpegBytes(1920, 1080))).toEqual({ format: "jpeg", width: 1920, height: 1080 });
    expect(readImageHeader(jpegBytes(640, 480, 0xc1))).toEqual({ format: "jpeg", width: 640, height: 480 });
    expect(readImageHeader(jpegBytes(640, 480, 0xc2))).toEqual({ format: "jpeg", width: 640, height: 480 });
    expect(readImageHeader(webpVp8Bytes(800, 600))).toEqual({ format: "webp", width: 800, height: 600 });
    expect(readImageHeader(webpVp8lBytes(4096, 1))).toEqual({ format: "webp", width: 4096, height: 1 });
    expect(readImageHeader(webpVp8xBytes(30000, 20000))).toEqual({ format: "webp", width: 30000, height: 20000 });
  });

  it("refuses other JPEG frame types, SOS before a frame, and truncated data", () => {
    expect(readImageHeader(jpegBytes(10, 10, 0xc3))).toBeNull(); // lossless
    expect(readImageHeader(jpegBytes(10, 10, 0xc9))).toBeNull(); // arithmetic
    expect(readImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toBeNull();
    expect(readImageHeader(jpegBytes(10, 10).slice(0, 30))).toBeNull();
    const badLen = jpegBytes(10, 10);
    badLen[4] = 0;
    badLen[5] = 1; // APP0 length < 2
    expect(readImageHeader(badLen)).toBeNull();
    const vp8 = webpVp8Bytes(10, 10);
    vp8[23] = 0; // bad start code
    expect(readImageHeader(vp8)).toBeNull();
    expect(readImageHeader(webpVp8Bytes(10, 10).slice(0, 29))).toBeNull();
  });

  it("dimension rules: 1–4096 per side and at most 4096² pixels", async () => {
    expect(imageDimensionsOk(4096, 4096)).toBe(true);
    expect(imageDimensionsOk(1, 1)).toBe(true);
    expect(imageDimensionsOk(0, 10)).toBe(false);
    expect(imageDimensionsOk(4097, 1)).toBe(false);
    expect(imageDimensionsOk(1.5, 10)).toBe(false);
    await expect(sniffImage(blobOf(pngBytes(0, 10)))).rejects.toThrow(/dimensions/);
    await expect(sniffImage(blobOf(pngBytes(4096, 4096)))).resolves.toEqual({ format: "png", width: 4096, height: 4096 });
  });
});

describe("screenshotFileName", () => {
  it("uses the slug and local time", () => {
    expect(screenshotFileName("Space Dodge", new Date(2026, 10, 14, 15, 30, 12))).toBe("space-dodge-20261114-153012.png");
    expect(screenshotFileName("  ¡Pixel Peaks! 2 ", new Date(2026, 0, 2, 3, 4, 5))).toBe("pixel-peaks-2-20260102-030405.png");
    expect(screenshotFileName("???", new Date(2026, 0, 2, 3, 4, 5))).toBe("game-20260102-030405.png");
  });
});

describe("sanitizeScreenshotCaption", () => {
  it("strips control and bidi characters and cuts to 140 code points", () => {
    expect(sanitizeScreenshotCaption("New\nbest:‮ 12,340\u0007")).toBe("Newbest: 12,340");
    expect(sanitizeScreenshotCaption(42)).toBe("42");
    expect(sanitizeScreenshotCaption(undefined)).toBe("");
    const long = "😀".repeat(200);
    expect(Array.from(sanitizeScreenshotCaption(long))).toHaveLength(140);
  });
});

describe("exports", () => {
  it("exports PLAYER_SCREENSHOT_EVENT from the package entry", () => {
    expect(PLAYER_SCREENSHOT_EVENT).toBe("webgame:player-screenshot");
    expect(api.PLAYER_SCREENSHOT_EVENT).toBe("webgame:player-screenshot");
  });
});

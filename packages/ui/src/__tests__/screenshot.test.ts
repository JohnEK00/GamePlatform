import { describe, expect, it, vi } from "vitest";
import {
  fitImageForUpload,
  launderImage,
  PLAYER_SCREENSHOT_EVENT,
  sanitizeScreenshotCaption,
  screenshotFileName,
  type DecodedImage,
  type ImageCodec,
} from "../screenshot";
import * as api from "../index";

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

  it("re-encodes a small non-PNG", async () => {
    const { codec } = fakeCodec(() => 10);
    const out = await fitImageForUpload(new Blob([new Uint8Array(10)], { type: "image/gif" }), 2 * MB, codec);
    expect(out.type).toBe("image/webp");
  });
});

describe("launderImage", () => {
  it("decodes and re-encodes to a new PNG", async () => {
    const { codec, calls, close } = fakeCodec(() => 50, { width: 320, height: 180 });
    const src = new Blob(["<svg onload=alert(1)>"], { type: "image/png" });
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
      await expect(launderImage(new Blob(["x"]), codec)).rejects.toThrow(/dimensions/);
      expect(close).toHaveBeenCalled();
    }
  });

  it("fails when the encoder returns nothing", async () => {
    const codec: ImageCodec = {
      decode: async () => ({ width: 10, height: 10, source: {} as CanvasImageSource, close: () => {} }),
      encode: async () => null,
    };
    await expect(launderImage(new Blob(["x"]), codec)).rejects.toThrow();
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

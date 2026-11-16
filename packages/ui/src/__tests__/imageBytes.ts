// Test helpers: minimal image headers (enough for `readImageHeader`; not decodable images).

const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16be = (n: number) => [(n >>> 8) & 255, n & 255];
const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** PNG signature + IHDR claiming `w`×`h` (+ a few trailing bytes). */
export function pngBytes(w: number, h: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii("IHDR"), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
}

/** SOI, an APP0 segment, optionally a DQT, then SOF`sof` claiming `w`×`h`. */
export function jpegBytes(w: number, h: number, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, ...u16be(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const dqt = [0xff, 0xdb, ...u16be(4), 0, 0];
  const sofSeg = [0xff, sof, ...u16be(17), 8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, 0xff, ...dqt, ...sofSeg, 0xff, 0xd9]);
}

const riff = (chunk: number[]) => new Uint8Array([...ascii("RIFF"), ...u32le(4 + chunk.length), ...ascii("WEBP"), ...chunk]);

export function webpVp8Bytes(w: number, h: number): Uint8Array {
  return riff([...ascii("VP8 "), ...u32le(10), 0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h), 0, 0]);
}

export function webpVp8lBytes(w: number, h: number): Uint8Array {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riff([...ascii("VP8L"), ...u32le(5), 0x2f, ...u32le(bits >>> 0), 0, 0, 0, 0, 0]);
}

export function webpVp8xBytes(w: number, h: number): Uint8Array {
  return riff([...ascii("VP8X"), ...u32le(10), 0, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]);
}

export const blobOf = (bytes: Uint8Array, type = "image/png") => new Blob([bytes as BlobPart], { type });

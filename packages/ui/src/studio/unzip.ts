// Minimal ZIP reader (F013): central directory walk, stored + DEFLATE entries, CRC-32 and size checks,
// limits enforced on the actual inflated bytes. No dependencies: inflates with DecompressionStream("deflate-raw").
// Format: PKWARE APPNOTE 6.3. ZIP64, encryption, multi-disk archives and other methods are refused.

import { crc32 } from "./zip";
import { MAX_BUNDLE_UNCOMPRESSED_BYTES, MAX_PROJECT_FILES, normalizeProjectPath } from "./project";

export type ReadZipLimits = {
  /** Maximum number of file entries (directories don't count). Default MAX_PROJECT_FILES (2000). */
  maxEntries?: number;
  /** Maximum total of the inflated bytes. Default MAX_BUNDLE_UNCOMPRESSED_BYTES (200 MB). */
  maxTotalBytes?: number;
};

export type ZipEntryData = { path: string; data: Uint8Array };

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
/** EOCD is 22 bytes plus a comment of at most 65 535 bytes. */
const EOCD_SEARCH = 22 + 0xffff;

type CentralEntry = {
  path: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

function fail(message: string): never {
  throw new Error(message);
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder("utf-8").decode(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function findEocd(view: DataView): number {
  const len = view.byteLength;
  const stop = Math.max(0, len - EOCD_SEARCH);
  for (let i = len - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

/** True when the runtime can inflate raw DEFLATE with `DecompressionStream("deflate-raw")`. */
export function canInflateRaw(): boolean {
  if (typeof DecompressionStream !== "function") return false;
  try {
    new DecompressionStream("deflate-raw" as CompressionFormat);
    return true;
  } catch {
    return false;
  }
}

class LimitError extends Error {}

/**
 * Inflates `src`, calling `onChunk(n)` for each produced chunk; `onChunk` throws to abort (the stream is
 * cancelled, so a bomb is never inflated in full).
 */
async function inflateRaw(src: Uint8Array, onChunk: (n: number) => void): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw" as CompressionFormat);
  const writer = ds.writable.getWriter();
  void writer.write(src as Uint8Array<ArrayBuffer>).catch(() => {});
  void writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(value.length);
      chunks.push(value);
      total += value.length;
    }
  } catch (e) {
    void reader.cancel().catch(() => {});
    void writer.abort().catch(() => {});
    throw e;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Reads a .zip archive into `{ path, data }` entries (in central-directory order, directories skipped).
 * Rejects with an `Error` on anything it can't read safely: ZIP64, encryption, multi-disk archives, methods
 * other than stored/deflate, invalid paths (absolute, `..`), CRC or size mismatches, and archives over the limits.
 */
export async function readZip(data: ArrayBuffer | Uint8Array, limits: ReadZipLimits = {}): Promise<ZipEntryData[]> {
  const maxEntries = limits.maxEntries ?? MAX_PROJECT_FILES;
  const maxTotalBytes = limits.maxTotalBytes ?? MAX_BUNDLE_UNCOMPRESSED_BYTES;
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) fail("This isn't a .zip file.");

  const eocd = findEocd(view);
  if (eocd < 0) fail("This isn't a .zip file (no end of central directory).");
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (totalEntries === 0xffff || entriesOnDisk === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    fail("ZIP64 archives aren't supported.");
  if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) fail("Multi-part (split) .zip archives aren't supported.");
  if (cdOffset + cdSize > eocd) fail("The .zip is damaged (central directory out of range).");

  // ---- central directory ----
  const entries: CentralEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cdOffset + cdSize || view.getUint32(p, true) !== SIG_CENTRAL) fail("The .zip is damaged (bad central directory).");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const diskStart = view.getUint16(p + 34, true);
    const localOffset = view.getUint32(p + 42, true);
    const nameEnd = p + 46 + nameLen;
    if (nameEnd > cdOffset + cdSize) fail("The .zip is damaged (bad central directory).");
    const rawName = decodeName(bytes.subarray(p + 46, nameEnd), (flags & 0x0800) !== 0);
    p = nameEnd + extraLen + commentLen;

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff || diskStart === 0xffff)
      fail("ZIP64 archives aren't supported.");
    if (diskStart !== 0) fail("Multi-part (split) .zip archives aren't supported.");
    if (flags & 0x0001) fail(`"${rawName}" is encrypted; encrypted .zip files aren't supported.`);
    if (rawName.endsWith("/") || rawName.endsWith("\\")) continue; // directory entry

    const unixAbs = rawName.startsWith("/") || rawName.startsWith("\\");
    const driveAbs = /^[a-zA-Z]:/.test(rawName);
    const path = unixAbs || driveAbs ? null : normalizeProjectPath(rawName);
    if (!path) fail(`The .zip contains an invalid path: "${rawName}".`);
    if (method !== 0 && method !== 8) fail(`"${path}" uses an unsupported compression method (${method}).`);
    if (seen.has(path)) fail(`The .zip contains "${path}" twice.`);
    seen.add(path);
    if (entries.length >= maxEntries) fail(`The .zip has too many files (max ${maxEntries}).`);
    entries.push({ path, method, crc, compressedSize, size, localOffset });
  }

  if (entries.some((e) => e.method === 8) && !canInflateRaw()) fail("This browser can't open compressed .zip files.");

  // ---- data ----
  const out: ZipEntryData[] = [];
  let total = 0;
  const tooLarge = () => new LimitError(`The .zip is too large when unpacked (max ${Math.round(maxTotalBytes / (1024 * 1024))} MB).`);
  for (const e of entries) {
    const lo = e.localOffset;
    if (lo + 30 > cdOffset || view.getUint32(lo, true) !== SIG_LOCAL) fail(`The .zip is damaged (bad local header for "${e.path}").`);
    const start = lo + 30 + view.getUint16(lo + 26, true) + view.getUint16(lo + 28, true);
    const end = start + e.compressedSize;
    if (end > cdOffset) fail(`The .zip is damaged ("${e.path}" is truncated).`);
    const raw = bytes.subarray(start, end);

    let content: Uint8Array;
    if (e.method === 0) {
      if (e.compressedSize !== e.size) fail(`"${e.path}": size doesn't match the .zip directory.`);
      if (total + raw.length > maxTotalBytes) throw tooLarge();
      content = raw.slice();
    } else {
      let produced = 0;
      try {
        content = await inflateRaw(raw, (n) => {
          produced += n;
          if (total + produced > maxTotalBytes) throw tooLarge();
          if (produced > e.size) throw new LimitError(`"${e.path}": size doesn't match the .zip directory.`);
        });
      } catch (err) {
        if (err instanceof LimitError) throw new Error(err.message);
        throw new Error(`"${e.path}" couldn't be decompressed (the .zip may be damaged).`);
      }
    }
    if (content.length !== e.size) fail(`"${e.path}": size doesn't match the .zip directory.`);
    if (crc32(content) !== e.crc) fail(`"${e.path}" is damaged (CRC mismatch).`);
    total += content.length;
    out.push({ path: e.path, data: content });
  }
  return out;
}

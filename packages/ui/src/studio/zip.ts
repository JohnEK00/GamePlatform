// Minimal ZIP writer with CRC-32 (stored, or DEFLATE via CompressionStream / a supplied deflater). No dependencies.
// Format: PKWARE APPNOTE 6.3 — local file headers + data, central directory, end of central directory record.

let CRC_TABLE: Uint32Array | null = null;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (CRC_TABLE = t);
}

/** CRC-32 (IEEE 802.3, as used by zip/png/gzip) of bytes or a string (UTF-8). Returns an unsigned 32-bit int. */
export function crc32(data: Uint8Array | ArrayBuffer | string, seed = 0): number {
  const bytes = toBytes(data);
  const t = crcTable();
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type ZipInput = string | ArrayBuffer | Uint8Array;
/** Either a path → content map, or an ordered list of entries. */
export type ZipFiles = Record<string, ZipInput> | { path: string; data: ZipInput; date?: Date }[];

function toBytes(d: ZipInput): Uint8Array {
  if (typeof d === "string") return new TextEncoder().encode(d);
  if (d instanceof Uint8Array) return d;
  return new Uint8Array(d);
}

/** MS-DOS date/time (local time, 2s resolution, years 1980–2107). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

function normalizePath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) throw new Error(`createZip: invalid path "${p}"`);
  if (!parts.length) throw new Error("createZip: empty path");
  return parts.join("/");
}

/** Raw DEFLATE (RFC 1951, no zlib/gzip header) compressor, e.g. `pako.deflateRaw`. */
export type DeflateRawSync = (data: Uint8Array) => Uint8Array;

export type CreateZipOptions = {
  date?: Date;
  /**
   * Optional synchronous raw-DEFLATE function. When given, entries are stored DEFLATE-compressed (method 8)
   * whenever that makes them smaller and `shouldCompress(path)` allows it; otherwise they are stored as-is.
   */
  deflateRaw?: DeflateRawSync;
  /** Which paths to try compressing. Default: everything except already-compressed formats (png, jpg, mp3, …). */
  shouldCompress?: (path: string) => boolean;
};

export type CreateZipAsyncOptions = {
  date?: Date;
  /** "deflate" (default) uses `CompressionStream("deflate-raw")` when the runtime has it, else falls back to "store". */
  compression?: "deflate" | "store";
  shouldCompress?: (path: string) => boolean;
};

/** Extensions whose content is already compressed; DEFLATE rarely helps them. */
const PRECOMPRESSED = new Set(["png", "jpg", "jpeg", "webp", "gif", "mp3", "ogg", "woff2", "zip"]);

export function defaultShouldCompress(path: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return !(m && PRECOMPRESSED.has(m[1].toLowerCase()));
}

type PreparedEntry = { path: string; name: Uint8Array; data: Uint8Array; crc: number; dt: { time: number; date: number } };
type ZipEntry = PreparedEntry & { method: 0 | 8; stored: Uint8Array };

function prepare(files: ZipFiles, date: Date | undefined): PreparedEntry[] {
  const list = Array.isArray(files) ? files : Object.entries(files).map(([path, data]) => ({ path, data, date: undefined as Date | undefined }));
  if (list.length > 0xffff) throw new Error("createZip: too many files (max 65535)");
  const enc = new TextEncoder();
  const seen = new Set<string>();
  return list.map((f) => {
    const path = normalizePath(f.path);
    if (seen.has(path)) throw new Error(`createZip: duplicate path "${path}"`);
    seen.add(path);
    const data = toBytes(f.data);
    return { path, name: enc.encode(path), data, crc: crc32(data), dt: dosDateTime(f.date ?? date ?? new Date()) };
  });
}

function pick(e: PreparedEntry, deflated: Uint8Array | null): ZipEntry {
  return deflated && deflated.length < e.data.length ? { ...e, method: 8, stored: deflated } : { ...e, method: 0, stored: e.data };
}

/**
 * Builds a .zip in memory. Paths use "/" separators and must be relative (no "..").
 * Names are written as UTF-8 (general purpose flag bit 11). Entries are stored uncompressed unless
 * `opts.deflateRaw` is supplied (see {@link createZipAsync} for built-in compression). Returns the archive
 * bytes; wrap it in `new Blob([bytes], { type: "application/zip" })` to upload or download it.
 */
export function createZip(files: ZipFiles, opts: CreateZipOptions = {}): Uint8Array<ArrayBuffer> {
  const should = opts.shouldCompress ?? defaultShouldCompress;
  const entries = prepare(files, opts.date).map((e) => pick(e, opts.deflateRaw && e.data.length > 0 && should(e.path) ? opts.deflateRaw(e.data) : null));
  return writeZip(entries);
}

/** True when the runtime can raw-DEFLATE with `CompressionStream("deflate-raw")`. */
export function canDeflateRaw(): boolean {
  if (typeof CompressionStream !== "function") return false;
  try {
    new CompressionStream("deflate-raw" as CompressionFormat);
    return true;
  } catch {
    return false;
  }
}

async function deflateRawStream(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw" as CompressionFormat);
  const writer = cs.writable.getWriter();
  void writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  void writer.close().catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
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
 * Like {@link createZip}, but DEFLATE-compresses entries with the platform `CompressionStream("deflate-raw")`
 * (falls back to stored entries where it is unavailable or fails). Each entry is only compressed if that
 * makes it smaller.
 */
export async function createZipAsync(files: ZipFiles, opts: CreateZipAsyncOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const prepared = prepare(files, opts.date);
  const should = opts.shouldCompress ?? defaultShouldCompress;
  let useDeflate = (opts.compression ?? "deflate") === "deflate" && canDeflateRaw();
  const entries: ZipEntry[] = [];
  for (const e of prepared) {
    let deflated: Uint8Array | null = null;
    if (useDeflate && e.data.length > 0 && should(e.path)) {
      try {
        deflated = await deflateRawStream(e.data);
      } catch {
        useDeflate = false;
      }
    }
    entries.push(pick(e, deflated));
  }
  return writeZip(entries);
}

function writeZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  let localSize = 0;
  let centralSize = 0;
  for (const e of entries) {
    localSize += 30 + e.name.length + e.stored.length;
    centralSize += 46 + e.name.length;
  }
  if (localSize + centralSize > 0xffffffff) throw new Error("createZip: archive too large (zip64 not supported)");

  const out = new Uint8Array(new ArrayBuffer(localSize + centralSize + 22));
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let p = 0;
  const u16 = (v: number) => {
    view.setUint16(p, v, true);
    p += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(p, v >>> 0, true);
    p += 4;
  };
  const FLAGS = 0x0800; // UTF-8 names

  for (const e of entries) {
    offsets.push(p);
    u32(0x04034b50); // local file header signature
    u16(20); // version needed to extract (2.0: deflate)
    u16(FLAGS);
    u16(e.method); // 0 = stored, 8 = deflate
    u16(e.dt.time);
    u16(e.dt.date);
    u32(e.crc);
    u32(e.stored.length); // compressed size
    u32(e.data.length); // uncompressed size
    u16(e.name.length);
    u16(0); // extra field length
    out.set(e.name, p);
    p += e.name.length;
    out.set(e.stored, p);
    p += e.stored.length;
  }

  const cdStart = p;
  entries.forEach((e, i) => {
    u32(0x02014b50); // central directory header signature
    u16(20); // version made by (2.0, MS-DOS attrs)
    u16(20); // version needed
    u16(FLAGS);
    u16(e.method);
    u16(e.dt.time);
    u16(e.dt.date);
    u32(e.crc);
    u32(e.stored.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk number start
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]);
    out.set(e.name, p);
    p += e.name.length;
  });
  const cdSize = p - cdStart;

  u32(0x06054b50); // end of central directory signature
  u16(0); // this disk
  u16(0); // disk with the central directory
  u16(entries.length);
  u16(entries.length);
  u32(cdSize);
  u32(cdStart);
  u16(0); // comment length
  return out;
}

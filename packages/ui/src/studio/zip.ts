// Minimal store-only (no compression) ZIP writer with CRC-32. No dependencies.
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

/**
 * Builds a store-only .zip in memory. Paths use "/" separators and must be relative (no "..").
 * Names are written as UTF-8 (general purpose flag bit 11). Returns the archive bytes; wrap it in
 * `new Blob([bytes], { type: "application/zip" })` to upload or download it.
 */
export function createZip(files: ZipFiles, opts: { date?: Date } = {}): Uint8Array<ArrayBuffer> {
  const list = Array.isArray(files) ? files : Object.entries(files).map(([path, data]) => ({ path, data, date: undefined as Date | undefined }));
  if (list.length > 0xffff) throw new Error("createZip: too many files (max 65535)");
  const enc = new TextEncoder();
  const seen = new Set<string>();
  const entries = list.map((f) => {
    const name = normalizePath(f.path);
    if (seen.has(name)) throw new Error(`createZip: duplicate path "${name}"`);
    seen.add(name);
    const data = toBytes(f.data);
    return { name: enc.encode(name), data, crc: crc32(data), dt: dosDateTime(f.date ?? opts.date ?? new Date()) };
  });

  let localSize = 0;
  let centralSize = 0;
  for (const e of entries) {
    localSize += 30 + e.name.length + e.data.length;
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
    u16(20); // version needed to extract (2.0)
    u16(FLAGS);
    u16(0); // method: stored
    u16(e.dt.time);
    u16(e.dt.date);
    u32(e.crc);
    u32(e.data.length); // compressed size
    u32(e.data.length); // uncompressed size
    u16(e.name.length);
    u16(0); // extra field length
    out.set(e.name, p);
    p += e.name.length;
    out.set(e.data, p);
    p += e.data.length;
  }

  const cdStart = p;
  entries.forEach((e, i) => {
    u32(0x02014b50); // central directory header signature
    u16(20); // version made by (2.0, MS-DOS attrs)
    u16(20); // version needed
    u16(FLAGS);
    u16(0);
    u16(e.dt.time);
    u16(e.dt.date);
    u32(e.crc);
    u32(e.data.length);
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

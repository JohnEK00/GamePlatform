import { describe, expect, it } from "vitest";
import { readZip } from "../studio/unzip";
import { crc32, createZip, createZipAsync } from "../studio/zip";

const enc = new TextEncoder();

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw" as CompressionFormat);
  const w = cs.writable.getWriter();
  void w.write(data as Uint8Array<ArrayBuffer>);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

type RawEntry = {
  name: string | Uint8Array;
  /** Bytes as stored in the archive (already compressed for method 8). */
  stored: Uint8Array;
  method?: number;
  crc?: number;
  /** Declared uncompressed size (default: stored.length). */
  size?: number;
  flags?: number;
};

/** Hand-written zip so tests can craft bad flags, methods, sizes and paths. */
function rawZip(entries: RawEntry[]): Uint8Array {
  const parts: number[] = [];
  const u16 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff);
  const u32 = (v: number) => parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const bytes = (b: Uint8Array) => b.forEach((x) => parts.push(x));
  const meta = entries.map((e) => {
    const name = typeof e.name === "string" ? enc.encode(e.name) : e.name;
    return {
      name,
      flags: e.flags ?? (typeof e.name === "string" ? 0x0800 : 0),
      method: e.method ?? 0,
      crc: e.crc ?? crc32(e.stored),
      size: e.size ?? e.stored.length,
      stored: e.stored,
      offset: 0,
    };
  });
  for (const m of meta) {
    m.offset = parts.length;
    u32(0x04034b50);
    u16(20);
    u16(m.flags);
    u16(m.method);
    u16(0);
    u16(0);
    u32(m.crc);
    u32(m.stored.length);
    u32(m.size);
    u16(m.name.length);
    u16(0);
    bytes(m.name);
    bytes(m.stored);
  }
  const cd = parts.length;
  for (const m of meta) {
    u32(0x02014b50);
    u16(20);
    u16(20);
    u16(m.flags);
    u16(m.method);
    u16(0);
    u16(0);
    u32(m.crc);
    u32(m.stored.length);
    u32(m.size);
    u16(m.name.length);
    u16(0);
    u16(0);
    u16(0);
    u16(0);
    u32(0);
    u32(m.offset);
    bytes(m.name);
  }
  const cdSize = parts.length - cd;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(meta.length);
  u16(meta.length);
  u32(cdSize);
  u32(cd);
  u16(0);
  return new Uint8Array(parts);
}

const text = (d: Uint8Array) => new TextDecoder().decode(d);

describe("readZip (F013)", () => {
  const files = {
    "game.json": '{"name":"T","entry":"main.js","width":320,"height":240}\n',
    "main.js": "export default {};\n".repeat(200),
    "assets/a.png": new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3, 255]),
  };

  it("round-trips createZipAsync archives, both deflate and stored", async () => {
    for (const compression of ["deflate", "store"] as const) {
      const zip = await createZipAsync(files, { compression });
      if (compression === "deflate") expect(zip.length).toBeLessThan(files["main.js"].length);
      const out = await readZip(zip);
      expect(out.map((e) => e.path)).toEqual(["game.json", "main.js", "assets/a.png"]);
      expect(text(out[1].data)).toBe(files["main.js"]);
      expect(Array.from(out[2].data)).toEqual(Array.from(files["assets/a.png"]));
    }
    // An ArrayBuffer works too.
    const zip = createZip(files);
    expect((await readZip(zip.buffer)).length).toBe(3);
  });

  it("decodes UTF-8 names (flag 11) and latin1 otherwise, and skips directory entries", async () => {
    const out = await readZip(
      rawZip([
        { name: "assets/", stored: new Uint8Array() },
        { name: "niveaux/ébauche.txt", stored: enc.encode("a") },
        { name: new Uint8Array([0xe9, 0x2e, 0x74, 0x78, 0x74]), stored: enc.encode("b") },
      ]),
    );
    expect(out.map((e) => e.path)).toEqual(["niveaux/ébauche.txt", "é.txt"]);
    const utf = await readZip(createZip({ "ä/ü.js": "x" }));
    expect(utf[0].path).toBe("ä/ü.js");
  });

  it("rejects a CRC mismatch, the encrypted flag, method 12 and ZIP64 markers", async () => {
    const data = enc.encode("hello");
    await expect(readZip(rawZip([{ name: "a.txt", stored: data, crc: crc32(data) ^ 1 }]))).rejects.toThrow(/CRC/);
    await expect(readZip(rawZip([{ name: "a.txt", stored: data, flags: 0x0801 }]))).rejects.toThrow(/encrypted/);
    await expect(readZip(rawZip([{ name: "a.txt", stored: data, method: 12 }]))).rejects.toThrow(/compression method \(12\)/);
    await expect(readZip(rawZip([{ name: "a.txt", stored: data, size: 0xffffffff }]))).rejects.toThrow(/ZIP64/);
  });

  it("rejects a deflate bomb without trusting the declared size", async () => {
    const big = new Uint8Array(8 * 1024 * 1024); // 8 MB of zeros → a few KB compressed
    const bomb = await deflateRaw(big);
    expect(bomb.length).toBeLessThan(64 * 1024);
    // Declared small: aborts as soon as the inflated bytes pass the declared size.
    await expect(readZip(rawZip([{ name: "bomb.txt", stored: bomb, method: 8, crc: 0, size: 100 }]), { maxTotalBytes: 1024 * 1024 })).rejects.toThrow(
      /too large|size/,
    );
    // Declared honestly: the total limit (counted on actual bytes) still stops it.
    await expect(
      readZip(rawZip([{ name: "bomb.txt", stored: bomb, method: 8, crc: crc32(big), size: big.length }]), { maxTotalBytes: 1024 * 1024 }),
    ).rejects.toThrow(/too large/);
    // The limit is the total over all entries.
    const half = new Uint8Array(600 * 1024);
    const z = createZip({ "a.bin": half, "b.bin": half });
    await expect(readZip(z, { maxTotalBytes: 1024 * 1024 })).rejects.toThrow(/too large/);
    expect((await readZip(z, { maxTotalBytes: 2 * 1024 * 1024 })).length).toBe(2);
  });

  it("rejects more than maxEntries files", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 5; i++) many[`f${i}.txt`] = String(i);
    await expect(readZip(createZip(many), { maxEntries: 4 })).rejects.toThrow(/too many files/);
    expect((await readZip(createZip(many), { maxEntries: 5 })).length).toBe(5);
  });

  it("rejects ../ and absolute paths", async () => {
    const d = enc.encode("x");
    await expect(readZip(rawZip([{ name: "../x.js", stored: d }]))).rejects.toThrow(/invalid path/);
    await expect(readZip(rawZip([{ name: "/x.js", stored: d }]))).rejects.toThrow(/invalid path/);
    await expect(readZip(rawZip([{ name: "a/../../x.js", stored: d }]))).rejects.toThrow(/invalid path/);
    await expect(readZip(rawZip([{ name: "C:/x.js", stored: d }]))).rejects.toThrow(/invalid path/);
  });

  it("rejects non-zip data and declared-size mismatches", async () => {
    await expect(readZip(enc.encode("definitely not a zip file at all"))).rejects.toThrow(/isn't a \.zip/);
    const deflated = await deflateRaw(enc.encode("hello hello hello"));
    await expect(readZip(rawZip([{ name: "a.txt", stored: deflated, method: 8, crc: crc32("hello hello hello"), size: 99 }]))).rejects.toThrow(/size/);
  });
});

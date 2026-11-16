import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canDeflateRaw, crc32, createZip, createZipAsync } from "../studio/zip";
import {
  buildBundleZipAsync,
  checkBundleSize,
  MAX_BUNDLE_COMPRESSED_BYTES,
  MAX_BUNDLE_UNCOMPRESSED_BYTES,
  projectSize,
  resolveProjectFile,
  validateBundlePaths,
  validateProject,
} from "../studio/project";
import { STUDIO_TEMPLATES } from "../studio/templates";

afterEach(() => vi.unstubAllGlobals());

/** Compression method of each central-directory entry, keyed by name. */
function methods(bytes: Uint8Array): Record<string, number> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const method = v.getUint16(p + 10, true);
    const nameLen = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out[name] = method;
    p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}

const text = "function update(dt) { player.x += dt * speed; }\n".repeat(200);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const files = { "main.js": text, "lib/player.js": "export const p = 1;\n".repeat(50), "assets/a.png": png, "tiny.txt": "x", "empty.txt": "" };

async function readAll(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  return {
    main: await zip.file("main.js")!.async("string"),
    player: await zip.file("lib/player.js")!.async("string"),
    png: [...(await zip.file("assets/a.png")!.async("uint8array"))],
    tiny: await zip.file("tiny.txt")!.async("string"),
    empty: await zip.file("empty.txt")!.async("string"),
  };
}

describe("R11: DEFLATE zips", () => {
  it("createZipAsync deflates compressible entries and jszip reads them back", async () => {
    expect(canDeflateRaw()).toBe(true);
    const bytes = await createZipAsync(files);
    const m = methods(bytes);
    expect(m["main.js"]).toBe(8);
    expect(m["lib/player.js"]).toBe(8);
    expect(m["assets/a.png"]).toBe(0); // already-compressed formats are stored
    expect(m["tiny.txt"]).toBe(0); // deflate would be larger
    expect(m["empty.txt"]).toBe(0);
    expect(bytes.length).toBeLessThan(text.length / 4);
    expect(await readAll(bytes)).toEqual({ main: text, player: files["lib/player.js"], png: [...png], tiny: "x", empty: "" });
  });

  it("compression: 'store' writes a store-only zip that jszip reads", async () => {
    const bytes = await createZipAsync(files, { compression: "store" });
    expect(Object.values(methods(bytes)).every((x) => x === 0)).toBe(true);
    expect(await readAll(bytes)).toEqual({ main: text, player: files["lib/player.js"], png: [...png], tiny: "x", empty: "" });
  });

  it("falls back to store when CompressionStream is unavailable", async () => {
    vi.stubGlobal("CompressionStream", undefined);
    expect(canDeflateRaw()).toBe(false);
    const bytes = await createZipAsync(files);
    expect(Object.values(methods(bytes)).every((x) => x === 0)).toBe(true);
    expect((await readAll(bytes)).main).toBe(text);
  });

  it("createZip keeps its sync signature and accepts a deflateRaw option", async () => {
    // A real raw-deflate stream of `text`, standing in for e.g. pako.deflateRaw.
    // Taken from the first local entry of an async-built zip.
    const ref = await createZipAsync({ "a.js": text });
    const rv = new DataView(ref.buffer);
    const start = 30 + rv.getUint16(26, true) + rv.getUint16(28, true);
    const deflated = ref.slice(start, start + rv.getUint32(18, true));
    const deflateRaw = vi.fn(() => deflated);
    const bytes = createZip({ "a.js": text, "b.png": png }, { deflateRaw });
    expect(deflateRaw).toHaveBeenCalledTimes(1); // the png is not offered for compression
    expect(methods(bytes)).toEqual({ "a.js": 8, "b.png": 0 });
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    expect(await zip.file("a.js")!.async("string")).toBe(text);
    // Without the option it is still store-only.
    expect(methods(createZip({ "a.js": text }))).toEqual({ "a.js": 0 });
    expect(new DataView(bytes.buffer).getUint32(14, true)).toBe(crc32(text)); // CRC is of the uncompressed data
  });

  it("buildBundleZipAsync bundles every template, compressed, readable by jszip", async () => {
    for (const t of STUDIO_TEMPLATES) {
      const blob = await buildBundleZipAsync({ manifest: t.manifest, files: t.files });
      const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()), { checkCRC32: true });
      expect(JSON.parse(await zip.file("game.json")!.async("string")).entry).toBe("main.js");
      expect(await zip.file("main.js")!.async("string")).toBe(t.files["main.js"]);
    }
  });
});

describe("R11: pre-upload validation", () => {
  const base = { name: "T", entry: "main.js", width: 320, height: 240 };

  it("reports case-insensitive duplicates (including game.json)", () => {
    expect(validateBundlePaths(["main.js", "Main.JS"])).toEqual([expect.stringMatching(/"Main.JS" clashes with "main.js"/)]);
    expect(validateBundlePaths(["GAME.json"]).join()).toMatch(/clashes with "game.json"/);
    expect(validateBundlePaths(["a/b.png", "A/B.png", "c.js"])).toHaveLength(1);
  });

  it("reports file-vs-folder clashes", () => {
    expect(validateBundlePaths(["assets.txt", "assets.txt/b.txt"]).join()).toMatch(/"assets.txt" is a file but "assets.txt\/b.txt" uses it as a folder/);
    expect(validateBundlePaths(["Lib", "lib/x.js"]).join()).toMatch(/is a file but/);
    expect(validateBundlePaths(["game.json/x.txt"]).join()).toMatch(/"game.json" is a file/);
    expect(validateBundlePaths(["lib/a.js", "lib/b.js", "libx.js"])).toEqual([]);
  });

  it("validateProject includes path, extension, count and size problems", () => {
    const errs = validateProject({ manifest: base, files: { "main.js": "", "MAIN.js": "", "x.exe": "", "x.exe/y.txt": "" } }).join("\n");
    expect(errs).toMatch(/clashes with "main.js"/);
    expect(errs).toMatch(/"x.exe": file type not allowed/);
    expect(errs).toMatch(/"x.exe" is a file but/);

    const many: Record<string, string> = { "main.js": "" };
    for (let i = 0; i < 2000; i++) many[`f${i}.txt`] = "";
    expect(validateProject({ manifest: base, files: many }).join()).toMatch(/Too many files \(max 2000\)/);

    const huge = { byteLength: MAX_BUNDLE_UNCOMPRESSED_BYTES } as ArrayBuffer;
    const big = { manifest: base, files: { "main.js": "", "assets/big.png": huge } };
    expect(projectSize(big)).toBeGreaterThan(MAX_BUNDLE_UNCOMPRESSED_BYTES);
    expect(validateProject(big).join()).toMatch(/uncompressed; bundles may be at most 200 MB/);
    expect(validateProject({ manifest: base, files: { "main.js": "" } })).toEqual([]);
  });

  it("checkBundleSize enforces the 50 MB compressed limit", () => {
    expect(checkBundleSize(new Uint8Array(10))).toBeNull();
    expect(checkBundleSize({ size: MAX_BUNDLE_COMPRESSED_BYTES } as Blob)).toBeNull();
    expect(checkBundleSize({ size: MAX_BUNDLE_COMPRESSED_BYTES + 1 } as Blob)).toMatch(/at most 50 MB/);
  });
});

describe("R3: resolveProjectFile", () => {
  const f = { "main.js": "", "lib/player.js": "", "player.js": "" };
  it("maps bundle paths and URLs to project files", () => {
    expect(resolveProjectFile(f, "lib/player.js")).toBe("lib/player.js");
    expect(resolveProjectFile(f, "./lib/player.js")).toBe("lib/player.js");
    expect(resolveProjectFile(f, "http://api.test/games/x/files/lib/player.js")).toBe("lib/player.js");
    expect(resolveProjectFile(f, "http://api.test/games/x/files/player.js")).toBe("player.js");
    expect(resolveProjectFile(f, "blob:http://api.test/1234-5678")).toBeNull();
    expect(resolveProjectFile(f, "nope.js")).toBeNull();
    expect(resolveProjectFile(f, undefined)).toBeNull();
  });
});

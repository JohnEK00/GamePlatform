import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { crc32, createZip } from "../studio/zip";
import { buildBundleZip, validateProject } from "../studio/project";
import { STUDIO_TEMPLATES } from "../studio/templates";

describe("crc32", () => {
  it("matches known vectors", () => {
    expect(crc32("")).toBe(0);
    expect(crc32("a")).toBe(0xe8b7be43);
    expect(crc32("123456789")).toBe(0xcbf43926);
    expect(crc32("The quick brown fox jumps over the lazy dog")).toBe(0x414fa339);
    expect(crc32(new Uint8Array([0, 0, 0, 0]))).toBe(0x2144df1c);
    expect(crc32(new Uint8Array([0xff, 0xff, 0xff, 0xff]).buffer)).toBe(0xffffffff);
  });

  it("supports incremental computation via seed", () => {
    expect(crc32("56789", crc32("1234"))).toBe(0xcbf43926);
  });
});

describe("createZip", () => {
  it("produces a valid store-only zip that jszip can read", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]);
    const bytes = createZip({
      "game.json": '{"name":"Test"}',
      "main.js": "export default {};\n",
      "assets/sprite.png": png.buffer,
      "assets/ünïcödé.txt": "héllo ✓",
      "empty.txt": "",
    });
    // Local header + EOCD signatures
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect([...bytes.slice(bytes.length - 22, bytes.length - 18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);

    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual(["assets/sprite.png", "assets/ünïcödé.txt", "empty.txt", "game.json", "main.js"]);
    expect(await zip.file("game.json")!.async("string")).toBe('{"name":"Test"}');
    expect(await zip.file("main.js")!.async("string")).toBe("export default {};\n");
    expect(await zip.file("assets/ünïcödé.txt")!.async("string")).toBe("héllo ✓");
    expect(await zip.file("empty.txt")!.async("string")).toBe("");
    expect([...(await zip.file("assets/sprite.png")!.async("uint8array"))]).toEqual([...png]);
  });

  it("writes correct sizes, offsets and stored method in the central directory", () => {
    const bytes = createZip([{ path: "a.txt", data: "abc" }]);
    const v = new DataView(bytes.buffer);
    const eocd = bytes.length - 22;
    expect(v.getUint16(eocd + 10, true)).toBe(1); // entries
    const cd = v.getUint32(eocd + 16, true);
    expect(v.getUint32(cd, true)).toBe(0x02014b50);
    expect(v.getUint16(cd + 10, true)).toBe(0); // stored
    expect(v.getUint32(cd + 16, true)).toBe(crc32("abc"));
    expect(v.getUint32(cd + 20, true)).toBe(3);
    expect(v.getUint32(cd + 24, true)).toBe(3);
    expect(v.getUint32(cd + 42, true)).toBe(0); // local header offset
  });

  it("rejects unsafe and duplicate paths", () => {
    expect(() => createZip({ "../evil.js": "x" })).toThrow();
    expect(() => createZip([{ path: "a.js", data: "1" }, { path: "./a.js", data: "2" }])).toThrow(/duplicate/);
  });

  it("buildBundleZip puts game.json at the root and every template validates", async () => {
    for (const t of STUDIO_TEMPLATES) {
      const project = { manifest: t.manifest, files: t.files };
      expect(validateProject(project)).toEqual([]);
      const blob = buildBundleZip(project);
      expect(blob.type).toBe("application/zip");
      const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
      const manifest = JSON.parse(await zip.file("game.json")!.async("string"));
      expect(manifest.entry).toBe("main.js");
      expect(zip.file("main.js")).not.toBeNull();
    }
  });

  it("validateProject reports problems", () => {
    const errs = validateProject({
      manifest: { name: "", entry: "nope.js", width: 10, height: 600, achievements: [{ id: "Bad Id", name: "" }, { id: "x", name: "X", icon: "missing.png" }] },
      files: { "main.js": "", "evil.exe": new ArrayBuffer(1) },
    });
    const text = errs.join("\n");
    expect(text).toMatch(/name is required/);
    expect(text).toMatch(/entry "nope.js"/);
    expect(text).toMatch(/width/);
    expect(text).toMatch(/id must match/);
    expect(text).toMatch(/icon "missing.png"/);
    expect(text).toMatch(/evil.exe/);
  });
});

import { describe, expect, it } from "vitest";
import {
  deserializeProject,
  deserializeSession,
  projectFromFileList,
  projectFromZip,
  serializeProject,
  type StudioLink,
  type StudioProject,
} from "../studio/project";
import { createZip } from "../studio/zip";

const manifest = { name: "Pixel Peaks", entry: "main.js", width: 320, height: 240 };
const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

describe("projectFromZip (F013)", () => {
  it("strips a single top-level folder that holds game.json, skips dotfiles and .exe, decodes text", async () => {
    const zip = createZip({
      "pixel-peaks/game.json": JSON.stringify(manifest),
      "pixel-peaks/main.js": "export default {}; // ü",
      "pixel-peaks/lib/bom.js": "﻿export const k = 1;",
      "pixel-peaks/assets/a.png": png,
      "pixel-peaks/.secret.js": "nope",
      "pixel-peaks/.git/config": "nope",
      "pixel-peaks/tool.exe": new Uint8Array([1]),
    });
    const { project, skipped } = await projectFromZip(zip);
    expect(project.manifest).toEqual(manifest);
    expect(Object.keys(project.files).sort()).toEqual(["assets/a.png", "lib/bom.js", "main.js"]);
    expect(project.files["main.js"]).toBe("export default {}; // ü");
    // A UTF-8 BOM is kept so it survives a round trip.
    expect(project.files["lib/bom.js"]).toBe("﻿export const k = 1;");
    expect(project.files["assets/a.png"]).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(project.files["assets/a.png"] as ArrayBuffer))).toEqual(Array.from(png));
    expect(skipped).toEqual(["tool.exe"]);
  });

  it("keeps files at the root as they are", async () => {
    const { project } = await projectFromZip(createZip({ "game.json": JSON.stringify(manifest), "main.js": "x", "src/a.js": "y" }));
    expect(Object.keys(project.files).sort()).toEqual(["main.js", "src/a.js"]);
  });

  it("does not strip a top-level folder without game.json, and errors when game.json is missing", async () => {
    await expect(projectFromZip(createZip({ "pp/main.js": "x", "pp/sub/game.json": JSON.stringify(manifest) }))).rejects.toThrow(/No game.json/);
    await expect(projectFromZip(createZip({ "main.js": "x" }))).rejects.toThrow(/No game.json found at the top of the .zip/);
    await expect(projectFromZip(createZip({ "game.json": "[1]" }))).rejects.toThrow(/not a valid JSON object/);
  });
});

function fileWithPath(path: string, data: string | Uint8Array): File {
  const f = new File([data as BlobPart], path.split("/").pop()!);
  Object.defineProperty(f, "webkitRelativePath", { value: path });
  return f;
}

describe("projectFromFileList (unchanged behaviour)", () => {
  it("strips the picked folder, skips dotfiles and disallowed types, keeps binaries as ArrayBuffers", async () => {
    const { project, skipped } = await projectFromFileList([
      fileWithPath("peaks/game.json", JSON.stringify(manifest)),
      fileWithPath("peaks/main.js", "// main"),
      fileWithPath("peaks/assets/a.png", png),
      fileWithPath("peaks/.DS_Store", "x"),
      fileWithPath("peaks/notes.exe", "x"),
    ]);
    expect(project.manifest).toEqual(manifest);
    expect(project.files["main.js"]).toBe("// main");
    expect(project.files["assets/a.png"]).toBeInstanceOf(ArrayBuffer);
    expect(Object.keys(project.files).sort()).toEqual(["assets/a.png", "main.js"]);
    expect(skipped).toEqual(["notes.exe"]);
  });

  it("errors on an empty selection or a missing game.json", async () => {
    await expect(projectFromFileList([])).rejects.toThrow(/empty/);
    await expect(projectFromFileList([fileWithPath("peaks/main.js", "x")])).rejects.toThrow(/No game.json found at the top of the folder/);
  });
});

describe("autosave session (F013)", () => {
  const project: StudioProject = { manifest, files: { "main.js": "x", "a.png": png.slice().buffer } };
  const link: StudioLink = { gameId: "g1", title: "Pixel Peaks", version: 4, apiBase: "http://api.test" };

  it("round-trips link and dirty", () => {
    const s = deserializeSession(serializeProject(project, { link, dirty: true }))!;
    expect(s.link).toEqual(link);
    expect(s.dirty).toBe(true);
    expect(s.project.files["main.js"]).toBe("x");
    expect(new Uint8Array(s.project.files["a.png"] as ArrayBuffer)).toEqual(png);
    // deserializeProject keeps its old shape (no session fields inside the project).
    expect(Object.keys(deserializeProject(serializeProject(project, { link, dirty: true }))!).sort()).toEqual(["files", "manifest"]);
  });

  it("loads an old autosave without link/dirty as clean and unlinked", () => {
    const old = JSON.stringify({ v: 1, manifest, files: { "main.js": { t: "x" } } });
    const s = deserializeSession(old)!;
    expect(s.dirty).toBe(false);
    expect(s.link).toBeUndefined();
    expect(serializeProject(project)).not.toMatch(/"link"/);
  });

  it("drops a malformed link", () => {
    for (const bad of [{ ...link, version: 0 }, { ...link, gameId: "" }, { ...link, version: "4" }, { gameId: "g1" }, "g1", null]) {
      const raw = JSON.stringify({ v: 1, manifest, files: {}, link: bad, dirty: "yes" });
      const s = deserializeSession(raw)!;
      expect(s.link).toBeUndefined();
      expect(s.dirty).toBe(false);
    }
  });
});

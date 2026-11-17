import { describe, expect, it } from "vitest";
import { ALLOWED_EXTENSIONS, TEXT_EXTENSIONS, buildBundleZipAsync, isTextPath, projectFromZip, validateProject, type StudioProject } from "../studio/project";
import { STUDIO_TEMPLATES } from "../studio/templates";

const FNT = `info face="Peaks" size=16
common lineHeight=18 base=14 scaleW=128 scaleH=64 pages=1 packed=0
page id=0 file="peaks.png"
char id=65 x=0 y=0 width=8 height=12 xoffset=0 yoffset=2 xadvance=9 page=0
`;

describe(".fnt bundle files (F012)", () => {
  it("is an allowed text extension", () => {
    expect(ALLOWED_EXTENSIONS).toContain("fnt");
    expect(TEXT_EXTENSIONS).toContain("fnt");
    expect(isTextPath("assets/a.fnt")).toBe(true);
    expect(isTextPath("assets/A.FNT")).toBe(true);
  });

  it("survives zip export and open as a string", async () => {
    const project: StudioProject = {
      manifest: { name: "Fonts", entry: "main.js", width: 320, height: 180 },
      files: { "main.js": "export default {};", "assets/peaks.fnt": FNT, "assets/peaks.png": new Uint8Array([137, 80, 78, 71, 1]).buffer },
    };
    expect(validateProject(project)).toEqual([]);
    const blob = await buildBundleZipAsync(project);
    const { project: back, skipped } = await projectFromZip(new Uint8Array(await blob.arrayBuffer()));
    expect(skipped).toEqual([]);
    expect(typeof back.files["assets/peaks.fnt"]).toBe("string");
    expect(back.files["assets/peaks.fnt"]).toBe(FNT);
    expect(back.files["assets/peaks.png"]).toBeInstanceOf(ArrayBuffer);
  });
});

describe("Menu & HUD template (F012)", () => {
  const t = STUDIO_TEMPLATES.find((x) => x.id === "menu-hud")!;

  it("is listed last, 480x270, and validates", () => {
    expect(t).toBeTruthy();
    expect(t.name).toBe("Menu & HUD");
    expect(STUDIO_TEMPLATES[STUDIO_TEMPLATES.length - 1]).toBe(t);
    expect(t.manifest).toMatchObject({ width: 480, height: 270, entry: "main.js", achievements: [] });
    expect(t.manifest.controls).toBe("Arrows or WASD to move, Enter to choose, P to pause. Remap keys with ⌨.");
    expect(validateProject({ manifest: t.manifest, files: t.files })).toEqual([]);
  });

  it("declares the menu actions, including confirm and pause", () => {
    const actions = t.manifest.actions as { id: string; keys: string[]; gamepad: string[] }[];
    expect(actions.map((a) => a.id)).toEqual(["left", "right", "up", "down", "confirm", "pause"]);
    expect(actions.find((a) => a.id === "confirm")).toMatchObject({ keys: ["Enter", "Space"], gamepad: ["A"] });
    expect(actions.find((a) => a.id === "pause")).toMatchObject({ keys: ["KeyP"], gamepad: ["Start"] });
  });

  it("uses the documented F012 API only", () => {
    const js = t.files["main.js"];
    expect(js).toContain("engine.ui.button(");
    expect(js).toMatch(/ui\.button\("play", "PLAY"/);
    // F019: the old "SOUND: ON/OFF" button became a SETTINGS screen with a SOUND toggle.
    expect(js).toMatch(/ui\.button\("settings", "SETTINGS"/);
    expect(js).toMatch(/ui\.button\("help", "HOW TO PLAY"/);
    expect(js).toMatch(/ui\.button\("resume", "RESUME"/);
    expect(js).toMatch(/ui\.button\("quit", "QUIT"/);
    expect(js).toMatch(/\{ nav: false \}/);
    expect(js).toMatch(/ui\.panel\(/);
    expect(js).toMatch(/new NineSlice\(/);
    expect(js).toMatch(/assets\.createTexture\(/);
    expect(js).toMatch(/font: "pixel", size: 8/);
    expect(js).toMatch(/actionPressed\("pause"\)/);
    expect(js).toMatch(/platform\.submitScore\(/);
    expect(js).toMatch(/section 16/);
    // Parses as a module body (no imports needed).
    expect(() => new Function(js.replace("export default", "return"))).not.toThrow();
  });
});

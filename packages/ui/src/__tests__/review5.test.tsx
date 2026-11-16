import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { DOCS_SECTIONS } from "../pages/DocsPage";
import { BINARY_BMFONT_MESSAGE, decodeProjectFile, isBinaryBmfont, projectFromFileList, projectFromZip } from "../studio/project";
import { readZip } from "../studio/unzip";
import { createZip } from "../studio/zip";
import { WebGameApp } from "../WebGameApp";

describe("DocsPage 'On this page' (review 5, L4)", () => {
  it("links every numbered section, with labels equal to the headings, and scrolls in-page without touching the route", async () => {
    window.location.hash = "#/docs";
    render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash" }} client={new ApiClient({ baseUrl: "" })} />);
    const nav = await screen.findByRole("navigation", { name: "On this page" });
    const links = within(nav).getAllByRole("link");
    const headings = Array.from(document.querySelectorAll<HTMLHeadingElement>(".pf-docs section h2")).filter((h) => /^\d+\. /.test(h.textContent!));
    expect(headings).toHaveLength(16);
    expect(links).toHaveLength(headings.length);
    expect(DOCS_SECTIONS).toHaveLength(16);
    headings.forEach((h, i) => {
      expect(h.textContent).toBe(`${i + 1}. ${links[i].textContent}`);
      expect(h.id).toBeTruthy();
      expect(links[i].getAttribute("href")).toBe(`#${h.id}`);
      expect(document.querySelectorAll(`#${h.id}`)).toHaveLength(1);
    });
    expect(links.map((l) => l.textContent)).toContain("Scores & leaderboards");
    expect(links.map((l) => l.textContent)).toContain("Your players can follow you");
    expect(links[15].textContent).toBe("Text, fonts and menus");

    const target = headings[11];
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    fireEvent.click(links[11]);
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
    expect(document.activeElement).toBe(target);
    // The HashRouter route is unchanged (no #section navigation).
    expect(window.location.hash).toBe("#/docs");
    expect(screen.getByRole("heading", { level: 1, name: "Make a game for Pixelforge Arcade" })).toBeTruthy();
    window.location.hash = "";
  });
});

describe("Studio keeps binary BMFont bytes intact (review 5, L6)", () => {
  // "BMF" 3, then bytes that are not valid UTF-8.
  const binaryFnt = new Uint8Array([0x42, 0x4d, 0x46, 0x03, 0x01, 0x10, 0x00, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x00]);
  const manifest = { name: "Fonts", entry: "main.js" };

  it("detects binary BMFont and decodes everything else as before", () => {
    expect(isBinaryBmfont(binaryFnt)).toBe(true);
    expect(isBinaryBmfont(binaryFnt.buffer)).toBe(true);
    expect(isBinaryBmfont(new TextEncoder().encode("info face=x"))).toBe(false);
    expect(isBinaryBmfont(new Uint8Array([0x42, 0x4d, 0x46]))).toBe(false);

    const bin = decodeProjectFile("assets/f.fnt", binaryFnt);
    expect(bin.binary).toBe(true);
    expect(bin.data).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(new Uint8Array(bin.data as ArrayBuffer))).toEqual(Array.from(binaryFnt));

    expect(decodeProjectFile("assets/f.fnt", new TextEncoder().encode("info face=\"Pixel\""))).toEqual({ data: 'info face="Pixel"', binary: false });
    // A .fnt that isn't a BMF header but isn't valid UTF-8 either is kept as bytes too.
    expect(decodeProjectFile("assets/g.fnt", new Uint8Array([0x69, 0xff, 0xfe])).binary).toBe(true);
    // Other text types keep the lenient decoder.
    expect(decodeProjectFile("main.js", new Uint8Array([0x61, 0xff]))).toEqual({ data: "a�", binary: false });
    expect(BINARY_BMFONT_MESSAGE).toMatch(/text or JSON/);
  });

  it("zip open → export is byte-identical and reports the file", async () => {
    const zip = createZip({ "game.json": JSON.stringify(manifest), "main.js": "// main", "assets/f.fnt": binaryFnt, "assets/t.fnt": "info face=x" });
    const { project, binary } = await projectFromZip(zip);
    expect(binary).toEqual(["assets/f.fnt"]);
    expect(project.files["assets/t.fnt"]).toBe("info face=x");
    expect(project.files["assets/f.fnt"]).toBeInstanceOf(ArrayBuffer);

    const again = await readZip(createZip({ "game.json": JSON.stringify(manifest), ...project.files }));
    const f = again.find((e) => e.path === "assets/f.fnt")!;
    expect(Array.from(f.data as Uint8Array)).toEqual(Array.from(binaryFnt));
  });

  it("open folder keeps the bytes too", async () => {
    const file = (path: string, data: string | Uint8Array) => {
      const f = new File([data as BlobPart], path.split("/").pop()!);
      Object.defineProperty(f, "webkitRelativePath", { value: path });
      return f;
    };
    const { project, binary } = await projectFromFileList([
      file("fonts/game.json", JSON.stringify(manifest)),
      file("fonts/main.js", "// main"),
      file("fonts/assets/f.fnt", binaryFnt),
    ]);
    expect(binary).toEqual(["assets/f.fnt"]);
    expect(Array.from(new Uint8Array(project.files["assets/f.fnt"] as ArrayBuffer))).toEqual(Array.from(binaryFnt));
  });
});

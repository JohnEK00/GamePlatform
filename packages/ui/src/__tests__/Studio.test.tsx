import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { StudioPreview, type StudioConsoleEntry } from "../studio/StudioPreview";
import type { StudioProject } from "../studio/project";
import { WebGameApp, WebGameProviders } from "../WebGameApp";
import { STUDIO_OPEN_FOLDER_EVENT } from "../index";

const project: StudioProject = {
  manifest: { name: "T", entry: "main.js", width: 320, height: 240, achievements: [{ id: "win", name: "Winner", description: "" }] },
  files: { "main.js": "export default {}", "assets/a.png": new Uint8Array([1, 2, 3]).buffer },
};

function post(source: MessageEventSource | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

function setup(runId = 1) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const submitScore = vi.spyOn(client, "submitScore");
  const unlock = vi.spyOn(client, "unlockAchievement");
  const recordPlay = vi.spyOn(client, "recordPlay");
  const logs: StudioConsoleEntry[] = [];
  const ui = (id: number) => (
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <StudioPreview project={project} runId={id} onLog={(e) => logs.push(e)} />
      </MemoryRouter>
    </WebGameProviders>
  );
  const utils = render(ui(runId));
  const iframe = () => utils.container.querySelector("iframe")!;
  return { ...utils, iframe, logs, submitScore, unlock, recordPlay, rerunWith: (id: number) => utils.rerender(ui(id)) };
}

afterEach(() => vi.restoreAllMocks());

describe("StudioPreview", () => {
  it("renders the studio player in a sandboxed iframe", () => {
    const { iframe } = setup();
    expect(iframe().getAttribute("src")).toBe("http://api.test/play/studio");
    expect(iframe().getAttribute("sandbox")).toBe("allow-scripts allow-pointer-lock");
  });

  it("only answers studio-ready from its own iframe, then posts studio-load", () => {
    const { iframe } = setup();
    const spy = vi.spyOn(iframe().contentWindow!, "postMessage");
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    const otherSpy = vi.spyOn(other.contentWindow!, "postMessage");
    post(other.contentWindow, { type: "webgame:studio-ready" });
    post(window, { type: "webgame:studio-ready" });
    post(null, { type: "webgame:studio-ready" });
    expect(spy).not.toHaveBeenCalled();
    expect(otherSpy).not.toHaveBeenCalled();

    post(iframe().contentWindow, { type: "webgame:studio-ready" });
    expect(spy).toHaveBeenCalledTimes(1);
    const [msg, target] = spy.mock.calls[0] as [{ type: string; manifest: { entry: string }; files: Record<string, unknown> }, string];
    expect(target).toBe("*");
    expect(msg.type).toBe("webgame:studio-load");
    expect(msg.manifest.entry).toBe("main.js");
    expect(msg.files["main.js"]).toBe("export default {}");
    expect(msg.files["assets/a.png"]).toBeInstanceOf(ArrayBuffer);
    other.remove();
  });

  it("shows errors with line/col and simulates scores/achievements without API calls", async () => {
    const { iframe, logs, submitScore, unlock, recordPlay } = setup();
    const w = iframe().contentWindow;
    post(w, { type: "webgame:error", message: "boom", line: 12, column: 5 });
    post(w, { type: "webgame:score", score: 99 });
    post(w, { type: "webgame:achievement", id: "win" });
    post(w, { type: "webgame:achievement", id: "nope" });
    post(w, { type: "webgame:ready" });
    expect(logs[0]).toMatchObject({ level: "error", message: "boom", line: 12, column: 5 });
    expect(logs[1].message).toMatch(/Would submit score 99/);
    expect(logs[2].message).toMatch(/Would unlock achievement "Winner"/);
    expect(logs[3].level).toBe("warn");
    expect(await screen.findByText("Would unlock: Winner")).toBeTruthy();
    expect(submitScore).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
    expect(recordPlay).not.toHaveBeenCalled();
  });

  it("re-creates the iframe on a new run and ignores the old one", () => {
    const { iframe, rerunWith, logs } = setup(1);
    const first = iframe();
    const oldWin = first.contentWindow;
    rerunWith(2);
    const second = iframe();
    expect(second).not.toBe(first);
    post(oldWin, { type: "webgame:error", message: "stale" });
    expect(logs).toHaveLength(0);
  });
});

describe("StudioPage", () => {
  it("is reachable logged out and offers templates, export and a login-to-publish link", async () => {
    window.location.hash = "#/studio";
    const client = new ApiClient({ baseUrl: "" });
    render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash" }} client={client} />);
    expect(await screen.findByRole("heading", { name: "Studio" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Export .zip/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Log in to publish" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Edit main.js" })).toBeTruthy();
    expect(document.querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-scripts allow-pointer-lock");
    window.location.hash = "";
  });

  it("uses platform.openLocalProject when provided", async () => {
    window.location.hash = "#/studio";
    const client = new ApiClient({ baseUrl: "" });
    const openLocalProject = vi.fn(async () => ({ manifest: { name: "Local", entry: "game.js", width: 100, height: 100 }, files: { "game.js": "// local" } }));
    render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash", platform: { openLocalProject } }} client={client} />);
    await act(async () => screen.getByRole("button", { name: /Open/ }).click());
    await act(async () => screen.getByRole("menuitem", { name: "Local folder…" }).click());
    expect(openLocalProject).toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: "Edit game.js" }) as HTMLTextAreaElement).value).toBe("// local");
    window.location.hash = "";
  });

  it("runs the open-folder flow on the STUDIO_OPEN_FOLDER_EVENT window event, and stops after unmount", async () => {
    window.location.hash = "#/studio";
    const client = new ApiClient({ baseUrl: "" });
    const openLocalProject = vi.fn(async () => ({ manifest: { name: "Local", entry: "game.js", width: 100, height: 100 }, files: { "game.js": "// evt" } }));
    const { unmount } = render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash", platform: { openLocalProject } }} client={client} />);
    await screen.findByRole("heading", { name: "Studio" });
    expect(openLocalProject).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(STUDIO_OPEN_FOLDER_EVENT));
    });
    expect(openLocalProject).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox", { name: "Edit game.js" }) as HTMLTextAreaElement).value).toBe("// evt");
    unmount();
    window.dispatchEvent(new CustomEvent(STUDIO_OPEN_FOLDER_EVENT));
    expect(openLocalProject).toHaveBeenCalledTimes(1);
    window.location.hash = "";
  });

  it("consumes window.__webgameStudioOpenPending once on mount and clears it", async () => {
    window.location.hash = "#/studio";
    window.__webgameStudioOpenPending = true;
    const client = new ApiClient({ baseUrl: "" });
    const openLocalProject = vi.fn(async () => null);
    const { unmount } = render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash", platform: { openLocalProject } }} client={client} />);
    await screen.findByRole("heading", { name: "Studio" });
    await act(async () => {});
    expect(openLocalProject).toHaveBeenCalledTimes(1);
    expect(window.__webgameStudioOpenPending).toBe(false);
    unmount();
    render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash", platform: { openLocalProject } }} client={client} />);
    await screen.findByRole("heading", { name: "Studio" });
    await act(async () => {});
    expect(openLocalProject).toHaveBeenCalledTimes(1);
    delete window.__webgameStudioOpenPending;
    window.location.hash = "";
  });

  async function exportWith(saveFile?: (name: string, data: Blob) => Promise<boolean>) {
    window.location.hash = "#/studio";
    const client = new ApiClient({ baseUrl: "" });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<WebGameApp config={{ apiBaseUrl: "", routerMode: "hash", platform: saveFile ? { saveFile } : undefined }} client={client} />);
    await act(async () => (await screen.findByRole("button", { name: /Export .zip/ })).click());
    // The zip is built asynchronously (DEFLATE via CompressionStream).
    await waitFor(() => expect(saveFile ?? clickSpy).toHaveBeenCalled());
    window.location.hash = "";
    return clickSpy;
  }

  it("exports through platform.saveFile and toasts Saved when it resolves true", async () => {
    const saveFile = vi.fn(async (_name: string, _data: Blob) => true);
    const clickSpy = await exportWith(saveFile);
    expect(saveFile).toHaveBeenCalledTimes(1);
    const [name, data] = saveFile.mock.calls[0];
    expect(name).toMatch(/\.zip$/);
    expect(data).toBeInstanceOf(Blob);
    expect(clickSpy).not.toHaveBeenCalled();
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("stays silent when platform.saveFile is cancelled", async () => {
    const saveFile = vi.fn(async () => false);
    await exportWith(saveFile);
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.queryByText("Couldn't save the zip")).toBeNull();
  });

  it("shows an error toast when platform.saveFile throws", async () => {
    const saveFile = vi.fn(async () => {
      throw new Error("disk full");
    });
    await exportWith(saveFile);
    expect(await screen.findByText("Couldn't save the zip")).toBeTruthy();
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("falls back to an <a download> link without platform.saveFile", async () => {
    const createUrl = URL.createObjectURL;
    const revokeUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    try {
      const clickSpy = await exportWith();
      expect(clickSpy).toHaveBeenCalled();
      expect((clickSpy.mock.contexts[0] as HTMLAnchorElement).download).toMatch(/\.zip$/);
    } finally {
      URL.createObjectURL = createUrl;
      URL.revokeObjectURL = revokeUrl;
    }
  });
});

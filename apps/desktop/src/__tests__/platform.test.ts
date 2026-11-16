import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
  isTauri: vi.fn<() => boolean>(() => true),
}));
vi.mock("@tauri-apps/api/core", () => core);

import {
  OS_NOTIFICATIONS_KEY,
  acceptToExtensions,
  openLocalProject,
  osNotifications,
  osNotificationsStatus,
  readOsNotificationsEnabled,
  reloadLocalProject,
  requestOsNotifications,
  writeOsNotificationsEnabled,
} from "../platform";

beforeEach(() => {
  core.invoke.mockReset();
  core.isTauri.mockReset().mockReturnValue(true);
  localStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

describe("OS notification bridge", () => {
  it("isEnabled reads the per-device localStorage key", () => {
    expect(osNotifications.isEnabled()).toBe(false);
    localStorage.setItem(OS_NOTIFICATIONS_KEY, "1");
    expect(osNotifications.isEnabled()).toBe(true);
    localStorage.setItem(OS_NOTIFICATIONS_KEY, "true");
    expect(osNotifications.isEnabled()).toBe(false);
    writeOsNotificationsEnabled(true);
    expect(localStorage.getItem(OS_NOTIFICATIONS_KEY)).toBe("1");
    writeOsNotificationsEnabled(false);
    expect(localStorage.getItem(OS_NOTIFICATIONS_KEY)).toBeNull();
  });

  it("is off outside Tauri and when storage throws", () => {
    localStorage.setItem(OS_NOTIFICATIONS_KEY, "1");
    core.isTauri.mockReturnValue(false);
    expect(readOsNotificationsEnabled()).toBe(false);
    core.isTauri.mockImplementation(() => {
      throw new Error("no __TAURI_INTERNALS__");
    });
    expect(readOsNotificationsEnabled()).toBe(false);
    core.isTauri.mockReset().mockReturnValue(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readOsNotificationsEnabled()).toBe(false);
  });

  it("show() forwards only title and body to show_os_notification", async () => {
    core.invoke.mockResolvedValue(true);
    const input = { title: "New comment", body: "Ann replied", url: "javascript:alert(1)", icon: "file:///x" };
    await osNotifications.show(input);
    expect(core.invoke).toHaveBeenCalledTimes(1);
    expect(core.invoke).toHaveBeenCalledWith("show_os_notification", { title: "New comment", body: "Ann replied" });
  });

  it("show() swallows invoke errors and does nothing outside Tauri", async () => {
    core.invoke.mockRejectedValue("title must be 1-64 characters");
    await expect(osNotifications.show({ title: "", body: "x" })).resolves.toBeUndefined();
    core.invoke.mockImplementation(() => {
      throw new Error("sync failure");
    });
    await expect(osNotifications.show({ title: "t", body: "b" })).resolves.toBeUndefined();
    core.invoke.mockClear();
    core.isTauri.mockReturnValue(false);
    await osNotifications.show({ title: "t", body: "b" });
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("maps permission states", async () => {
    core.invoke.mockResolvedValueOnce("granted");
    expect(await osNotificationsStatus()).toBe("granted");
    core.invoke.mockResolvedValueOnce("weird");
    expect(await osNotificationsStatus()).toBe("unsupported");
    core.invoke.mockRejectedValueOnce("no feature");
    expect(await osNotificationsStatus()).toBe("unsupported");
    core.invoke.mockResolvedValueOnce("prompt");
    expect(await requestOsNotifications()).toBe("prompt");
    core.invoke.mockRejectedValueOnce("boom");
    expect(await requestOsNotifications()).toBe("denied");
    core.isTauri.mockReturnValue(false);
    expect(await requestOsNotifications()).toBe("unsupported");
    expect(await osNotificationsStatus()).toBe("unsupported");
  });
});

describe("acceptToExtensions", () => {
  it("expands MIME types and extensions, deduplicated", () => {
    expect(acceptToExtensions(".zip,application/zip, image/* ,.PNG,")).toEqual(["zip", "png", "jpg", "jpeg", "gif", "webp"]);
    expect(acceptToExtensions("application/unknown")).toEqual([]);
  });
});

describe("openLocalProject / reloadLocalProject", () => {
  const index = (over: object = {}) => ({
    ticket: "T1",
    folderId: "fid",
    folder: "my-game",
    manifest: { entry: "main.js" },
    files: [
      { path: "game.json", size: 20, text: '{"entry":"main.js"}' },
      { path: "main.js", size: 0, text: "" },
      { path: "empty.wav", size: 0 },
      { path: "a.png", size: 3 },
      // A binary BMFont arrives without `text` (project.rs L6) and is fetched as bytes.
      { path: "font.fnt", size: 4 },
    ],
    skipped: [],
    skippedCount: 0,
    ...over,
  });

  it("returns null when the dialog is cancelled", async () => {
    core.invoke.mockResolvedValueOnce(null);
    expect(await openLocalProject()).toBeNull();
    expect(core.invoke).toHaveBeenCalledWith("pick_project_folder");
  });

  it("inlines text, fetches each binary once and keeps the opaque folder id", async () => {
    const bufs: Record<string, ArrayBuffer> = {
      "a.png": new Uint8Array([1, 2, 3]).buffer,
      "font.fnt": new Uint8Array([66, 77, 70, 3]).buffer,
    };
    core.invoke.mockImplementation(async (cmd, args) => {
      if (cmd === "pick_project_folder") return index();
      if (cmd === "read_project_file") return bufs[(args as { path: string }).path];
      throw new Error(`unexpected ${cmd}`);
    });
    const p = (await openLocalProject())!;
    expect(p.manifest).toEqual({ entry: "main.js" });
    expect(p.localFolder).toEqual({ id: "fid", name: "my-game" });
    expect(p.files["game.json"]).toBe('{"entry":"main.js"}');
    expect(p.files["main.js"]).toBe("");
    expect(p.files["empty.wav"]).toBeInstanceOf(ArrayBuffer);
    expect((p.files["empty.wav"] as ArrayBuffer).byteLength).toBe(0);
    expect(p.files["a.png"]).toBe(bufs["a.png"]);
    expect(p.files["font.fnt"]).toBe(bufs["font.fnt"]);
    const reads = core.invoke.mock.calls.filter(([c]) => c === "read_project_file");
    expect(reads.map(([, a]) => a)).toEqual([
      { ticket: "T1", path: "a.png" },
      { ticket: "T1", path: "font.fnt" },
    ]);
    expect(core.invoke.mock.calls.some(([c]) => c === "release_project")).toBe(false);
  });

  it("fetches binaries with bounded concurrency", async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.png`, size: 1 }));
    let inFlight = 0;
    let peak = 0;
    core.invoke.mockImplementation(async (cmd) => {
      if (cmd === "reload_project_folder") return index({ files });
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return new ArrayBuffer(1);
    });
    const p = (await reloadLocalProject("fid"))!;
    expect(core.invoke).toHaveBeenCalledWith("reload_project_folder", { folderId: "fid" });
    expect(Object.keys(p.files)).toHaveLength(10);
    expect(peak).toBe(4);
  });

  it("releases the ticket and rejects with an Error when a binary read fails", async () => {
    core.invoke.mockImplementation(async (cmd) => {
      if (cmd === "pick_project_folder") return index();
      if (cmd === "read_project_file") throw "Unknown or expired ticket.";
      return undefined;
    });
    await expect(openLocalProject()).rejects.toThrow(new Error("Unknown or expired ticket."));
    expect(core.invoke).toHaveBeenCalledWith("release_project", { ticket: "T1" });
  });

  it("turns string rejections from Rust into Errors", async () => {
    core.invoke.mockRejectedValueOnce("No game.json found in the selected folder.");
    await expect(openLocalProject()).rejects.toThrow("No game.json found in the selected folder.");
    core.invoke.mockRejectedValueOnce("The folder is no longer available. Open it again.");
    await expect(reloadLocalProject("gone")).rejects.toBeInstanceOf(Error);
    core.invoke.mockRejectedValueOnce(undefined);
    await expect(openLocalProject()).rejects.toThrow("Something went wrong.");
  });

  it("does not fetch when there is no ticket", async () => {
    core.invoke.mockResolvedValueOnce(index({ ticket: null, files: [{ path: "game.json", size: 2, text: "{}" }] }));
    const p = (await openLocalProject())!;
    expect(p.files).toEqual({ "game.json": "{}" });
    expect(core.invoke).toHaveBeenCalledTimes(1);
  });
});

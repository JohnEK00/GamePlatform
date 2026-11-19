import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const m = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string) => undefined),
  isTauri: vi.fn(() => true),
  listen: vi.fn<(event: string, fn: Handler) => Promise<() => void>>(),
  unlisten: vi.fn(),
  handler: null as Handler | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke, isTauri: m.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: m.listen }));
vi.mock("@webgame/ui", () => ({
  PLAYER_CONTROLS_EVENT: "webgame:player-controls",
  PLAYER_SCREENSHOT_EVENT: "webgame:player-screenshot",
  STUDIO_OPEN_FOLDER_EVENT: "webgame:studio-open-folder",
}));

import { MENU_EVENT, installNativeIntegrations } from "../nativeMenu";

type PendingWindow = { __webgameStudioOpenPending?: boolean };
const pendingFlag = () => (window as unknown as PendingWindow).__webgameStudioOpenPending;

let cleanup: () => void = () => {};
const listeners: Array<[string, () => void]> = [];
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  m.handler = null;
  m.isTauri.mockReturnValue(true);
  m.unlisten.mockReset();
  m.invoke.mockClear();
  m.listen.mockReset().mockImplementation(async (event, fn) => {
    expect(event).toBe(MENU_EVENT);
    m.handler = fn;
    return m.unlisten;
  });
  window.location.hash = "#/";
  delete (window as unknown as PendingWindow).__webgameStudioOpenPending;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  for (const [e, fn] of listeners.splice(0)) window.removeEventListener(e, fn);
  vi.restoreAllMocks();
});

function capture(...events: string[]) {
  const seen: string[] = [];
  for (const e of events) {
    const fn = () => seen.push(e);
    listeners.push([e, fn]);
    window.addEventListener(e, fn);
  }
  return seen;
}

describe("native menu events", () => {
  it("does nothing outside Tauri", () => {
    m.isTauri.mockReturnValue(false);
    cleanup = installNativeIntegrations();
    expect(m.listen).not.toHaveBeenCalled();
  });

  it("navigates for route items", async () => {
    cleanup = installNativeIntegrations();
    await flush();
    for (const [id, route] of [
      ["upload", "/upload"],
      ["settings", "/settings"],
      ["profile", "/me"],
      ["feed", "/feed"],
      ["notifications", "/notifications"],
      ["collections", "/collections"],
      ["creators", "/creators"],
      ["docs", "/docs"],
    ]) {
      m.handler!({ payload: id });
      expect(window.location.hash).toBe(`#${route}`);
    }
  });

  it("collections navigates to #/collections from any route", async () => {
    cleanup = installNativeIntegrations();
    await flush();
    window.location.hash = "#/play/abc";
    m.handler!({ payload: "collections" });
    expect(window.location.hash).toBe("#/collections");
  });

  it("creators (View → Creators, F035) navigates to #/creators from any route", async () => {
    const seen = capture("webgame:player-screenshot", "webgame:player-controls", "webgame:studio-open-folder");
    cleanup = installNativeIntegrations();
    await flush();
    window.location.hash = "#/play/abc";
    m.handler!({ payload: "creators" });
    expect(window.location.hash).toBe("#/creators");
    expect(seen).toEqual([]);
    expect(pendingFlag()).toBeUndefined();
  });

  it("profile (View → My Profile, F028) navigates to #/me from any route", async () => {
    const seen = capture("webgame:player-screenshot", "webgame:player-controls", "webgame:studio-open-folder");
    cleanup = installNativeIntegrations();
    await flush();
    window.location.hash = "#/u/sam/games";
    m.handler!({ payload: "profile" });
    expect(window.location.hash).toBe("#/me");
    expect(seen).toEqual([]);
    expect(pendingFlag()).toBeUndefined();
  });

  it("dispatches screenshot and controls events without navigating", async () => {
    const seen = capture("webgame:player-screenshot", "webgame:player-controls");
    cleanup = installNativeIntegrations();
    await flush();
    window.location.hash = "#/play/abc";
    m.handler!({ payload: "screenshot" });
    m.handler!({ payload: "controls" });
    expect(seen).toEqual(["webgame:player-screenshot", "webgame:player-controls"]);
    expect(window.location.hash).toBe("#/play/abc");
  });

  it("open-folder: dispatches on the Studio, else sets the pending flag and navigates", async () => {
    const seen = capture("webgame:studio-open-folder");
    cleanup = installNativeIntegrations();
    await flush();
    window.location.hash = "#/studio?x=1";
    m.handler!({ payload: "open-folder" });
    expect(seen).toEqual(["webgame:studio-open-folder"]);
    expect(pendingFlag()).toBeUndefined();

    window.location.hash = "#/feed";
    m.handler!({ payload: "open-folder" });
    expect(seen).toHaveLength(1);
    expect(pendingFlag()).toBe(true);
    expect(window.location.hash).toBe("#/studio");
  });

  it("ignores unknown and prototype-named payloads", async () => {
    cleanup = installNativeIntegrations();
    await flush();
    window.location.hash = "#/feed";
    for (const payload of ["nope", "constructor", "__proto__", "toString", "hasOwnProperty", 42, null]) {
      m.handler!({ payload });
      expect(window.location.hash).toBe("#/feed");
    }
  });

  it("unlistens on cleanup, even if cleanup runs before listen resolves", async () => {
    const first = installNativeIntegrations();
    await flush();
    first();
    expect(m.unlisten).toHaveBeenCalledTimes(1);

    m.unlisten.mockClear();
    const second = installNativeIntegrations();
    second();
    expect(m.unlisten).not.toHaveBeenCalled();
    await flush();
    expect(m.unlisten).toHaveBeenCalledTimes(1);
  });

  it("warns when menu events are unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    m.listen.mockRejectedValueOnce(new Error("no ipc"));
    cleanup = installNativeIntegrations();
    await flush();
    expect(warn).toHaveBeenCalledWith("menu events unavailable", expect.any(Error));
  });

  it("F11 toggles fullscreen once per press and stops after cleanup", () => {
    const dispose = installNativeIntegrations();
    const press = new KeyboardEvent("keydown", { key: "F11", cancelable: true });
    window.dispatchEvent(press);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11", repeat: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F10" }));
    expect(press.defaultPrevented).toBe(true);
    expect(m.invoke).toHaveBeenCalledTimes(1);
    expect(m.invoke).toHaveBeenCalledWith("toggle_fullscreen");
    dispose();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11" }));
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });

  // F019: a game's ui.textField reads typing, AltGr characters and Ctrl+V paste. The desktop's only key listener
  // must leave all of them alone (it sees parent-page keys; iframe keys never reach it, which is fine too).
  it("leaves text-field typing, AltGr, editing keys and paste untouched (F019)", () => {
    cleanup = installNativeIntegrations();
    const keys: KeyboardEventInit[] = [
      { key: "a", code: "KeyA" },
      { key: "A", code: "KeyA", shiftKey: true },
      { key: " ", code: "Space" },
      { key: "é", code: "Digit2" },
      { key: "€", code: "KeyE", ctrlKey: true, altKey: true }, // AltGr on Windows
      { key: "@", code: "KeyQ", ctrlKey: true, altKey: true },
      { key: "v", code: "KeyV", ctrlKey: true }, // paste
      { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true },
      { key: "Backspace", code: "Backspace" },
      { key: "Delete", code: "Delete" },
      { key: "ArrowLeft", code: "ArrowLeft" },
      { key: "Home", code: "Home" },
      { key: "Enter", code: "Enter" },
      { key: "Escape", code: "Escape" },
      { key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }, // View → Controls is native, not a JS listener
    ];
    for (const init of keys) {
      const e = new KeyboardEvent("keydown", { ...init, cancelable: true, bubbles: true });
      window.dispatchEvent(e);
      expect(e.defaultPrevented, `${init.key} must not be prevented`).toBe(false);
    }
    const paste = new Event("paste", { cancelable: true, bubbles: true });
    window.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    expect(m.invoke).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/");
  });
});

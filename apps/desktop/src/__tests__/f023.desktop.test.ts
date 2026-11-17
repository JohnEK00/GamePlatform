/**
 * F023 (the engine's on-screen keyboard for `ui.textField`) in the desktop shell. The keyboard lives entirely in the
 * sandboxed game iframe; the shell must stay out of its way:
 * - gamepad buttons (X, Y, Start, LB drive DEL, SPACE, OK, SHIFT) and touch/pointer presses are never listened to,
 *   prevented or swallowed by the shell (its only DOM listener is the F11 keydown handler);
 * - F11 toggles fullscreen and View → Controls opens the controls panel (the UI pauses the game) independently, and
 *   neither navigates away from the Studio preview or player that hosts the open keyboard;
 * - tauri.conf.json passes no WebView2 arguments that disable touch or pointer events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import confRaw from "../../src-tauri/tauri.conf.json?raw";

type Handler = (e: { payload: unknown }) => void;
const m = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string) => undefined),
  isTauri: vi.fn(() => true),
  listen: vi.fn<(event: string, fn: Handler) => Promise<() => void>>(),
  handler: null as Handler | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke, isTauri: m.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: m.listen }));
vi.mock("@webgame/ui", () => ({
  PLAYER_CONTROLS_EVENT: "webgame:player-controls",
  PLAYER_SCREENSHOT_EVENT: "webgame:player-screenshot",
  STUDIO_OPEN_FOLDER_EVENT: "webgame:studio-open-folder",
}));

import { installNativeIntegrations } from "../nativeMenu";

let cleanup: () => void = () => {};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  m.handler = null;
  m.isTauri.mockReturnValue(true);
  m.invoke.mockClear();
  m.listen.mockReset().mockImplementation(async (_event, fn) => {
    m.handler = fn;
    return () => {};
  });
  window.location.hash = "#/studio";
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** An event with extra fields (jsdom has no PointerEvent, TouchEvent or GamepadEvent constructors). */
function event(type: string, extra: Record<string, unknown> = {}): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(e, k, { value: v });
  return e;
}

describe("F023 desktop: the shell leaves gamepad and touch input to the game", () => {
  it("registers only the F11 keydown listener: no gamepad, pointer, touch, focus or visibility listeners", () => {
    const onWindow = vi.spyOn(window, "addEventListener");
    const onDocument = vi.spyOn(document, "addEventListener");
    cleanup = installNativeIntegrations();
    expect(onWindow.mock.calls.map((c) => c[0])).toEqual(["keydown"]);
    expect(onDocument).not.toHaveBeenCalled();
  });

  it("never prevents gamepad, pointer or touch events (WebView2 reports taps as pointerType touch)", () => {
    cleanup = installNativeIntegrations();
    const events = [
      event("gamepadconnected"),
      event("gamepaddisconnected"),
      event("pointerdown", { pointerType: "touch", isPrimary: true }),
      event("pointerup", { pointerType: "touch", isPrimary: true }),
      event("pointercancel", { pointerType: "touch" }),
      event("touchstart"),
      event("touchend"),
      event("contextmenu"), // a long press on a touch screen
    ];
    for (const e of events) {
      window.dispatchEvent(e);
      expect(e.defaultPrevented, `${e.type} must not be prevented`).toBe(false);
    }
    expect(m.invoke).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/studio");
  });
});

describe("F023 desktop: F11 and View → Controls while the keyboard is open", () => {
  it("F11 toggles fullscreen without opening Controls; Controls opens without toggling fullscreen or navigating", async () => {
    const controls: Event[] = [];
    const onControls = (e: Event) => controls.push(e);
    window.addEventListener("webgame:player-controls", onControls);
    try {
      cleanup = installNativeIntegrations();
      await flush();

      const f11 = new KeyboardEvent("keydown", { key: "F11", code: "F11", cancelable: true });
      window.dispatchEvent(f11);
      expect(f11.defaultPrevented).toBe(true);
      expect(m.invoke.mock.calls).toEqual([["toggle_fullscreen"]]);
      expect(controls).toHaveLength(0);

      m.handler!({ payload: "controls" });
      expect(controls).toHaveLength(1);
      expect(m.invoke).toHaveBeenCalledTimes(1);
      expect(window.location.hash).toBe("#/studio");

      // Back out of fullscreen with the panel still up: still one toggle per press.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F11", code: "F11", cancelable: true }));
      expect(m.invoke.mock.calls).toEqual([["toggle_fullscreen"], ["toggle_fullscreen"]]);
      expect(controls).toHaveLength(1);
    } finally {
      window.removeEventListener("webgame:player-controls", onControls);
    }
  });

  it("the Ctrl+Shift+K key itself is left to the native accelerator (no JS toggle, no prevented default)", () => {
    cleanup = installNativeIntegrations();
    const k = new KeyboardEvent("keydown", { key: "K", code: "KeyK", ctrlKey: true, shiftKey: true, cancelable: true });
    window.dispatchEvent(k);
    expect(k.defaultPrevented).toBe(false);
    expect(m.invoke).not.toHaveBeenCalled();
  });
});

describe("F023 desktop: tauri.conf.json keeps touch input working in WebView2", () => {
  const conf = JSON.parse(confRaw) as { app: { windows: Array<Record<string, unknown>> } };

  it("passes no WebView2 browser arguments that disable touch or pointer events", () => {
    for (const w of conf.app.windows) {
      const args = typeof w.additionalBrowserArgs === "string" ? w.additionalBrowserArgs.toLowerCase() : "";
      expect(args).not.toContain("touch");
      expect(args).not.toContain("pointer");
    }
  });
});

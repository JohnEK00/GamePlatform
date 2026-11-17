import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { ControlAction, User } from "../api/types";
import { CLOUD_LOAD_TIMEOUT_MS, CONTROLS_HINT_MS, GamePlayer, type GamePlayerGame } from "../components/GamePlayer";
import { controlsStorageKey, PLAYER_CONTROLS_EVENT, resetControlsStoreForTests, writeOverrides } from "../controls";
import { WebGameProviders } from "../WebGameApp";

const ACTIONS: ControlAction[] = [
  { id: "jump", name: "Jump", keys: ["Space", "ArrowUp"], gamepad: ["A"] },
  { id: "fire", name: "Fire", keys: ["KeyZ"], gamepad: [] },
];
const base = { id: "g1", title: "Pixel Peaks", width: 320, height: 180, playUrl: "/play/g1", version: 3, published: true, isOwner: false };
const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

function post(source: MessageEventSource | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

async function flush(ms = 0) {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((r) => setTimeout(r, ms));
  });
}

let hidden = false;
function setHidden(h: boolean) {
  hidden = h;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetControlsStoreForTests();
  hidden = false;
});

async function setup(game: GamePlayerGame = { ...base, actions: ACTIONS, controlsHint: "" }, { loggedIn = false, saveNever = false } = {}) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  if (loggedIn) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "recordPlay").mockResolvedValue({ plays: 1 });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "getSave").mockImplementation(() => (saveNever ? new Promise(() => {}) : Promise.resolve({ data: null, updatedAt: null })));
  // F016: signed-in players sync bindings; these tests use an account without any.
  vi.spyOn(client, "getControls").mockResolvedValue({ bindings: null, updatedAt: null });
  vi.spyOn(client, "putControls").mockImplementation(async (_id, bindings) => ({ bindings, updatedAt: "2026-11-17T00:00:00Z" }));
  const ui = (g: GamePlayerGame) => (
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <GamePlayer game={g} />
      </MemoryRouter>
    </WebGameProviders>
  );
  const utils = render(ui(game));
  await flush();
  const iframe = utils.container.querySelector("iframe")!;
  const win = iframe.contentWindow!;
  const frameSpy = vi.spyOn(win, "postMessage");
  return { ...utils, client, iframe, win, frameSpy, rerenderWith: (g: GamePlayerGame) => utils.rerender(ui(g)) };
}

const msgs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0] as Record<string, unknown>);
const sent = (spy: { mock: { calls: unknown[][] } }, type: string) => msgs(spy).filter((m) => m?.type === type);
const controlsButton = () => screen.queryByRole("button", { name: "Controls" });

describe("GamePlayer controls (F009)", () => {
  it("hides ⌨ without actions and hint; shows it with only a hint, before ready, between Restart and Mute", async () => {
    const { rerenderWith } = await setup({ ...base });
    expect(controlsButton()).toBeNull();
    rerenderWith({ ...base, actions: [], controlsHint: "   " });
    expect(controlsButton()).toBeNull();
    rerenderWith({ ...base, actions: [], controlsHint: "Arrows move, Space shoots" });
    const btn = controlsButton()!;
    expect(btn).toBeTruthy();
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    const labels = Array.from(document.querySelectorAll(".pf-player__controls button")).map((b) => b.getAttribute("aria-label"));
    expect(labels.slice(0, 3)).toEqual(["Restart game", "Controls", "Mute"]);
    fireEvent.click(btn);
    expect(screen.getByRole("dialog", { name: "Controls" })).toBeTruthy();
    expect(screen.getByText("Arrows move, Space shoots")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("posts webgame:controls right after the load reply, with only ids and codes", async () => {
    writeOverrides("g1", { jump: ["KeyK"], stale: ["KeyQ"] });
    const { win, frameSpy } = await setup();
    post(win, { type: "webgame:hello" });
    await flush();
    const types = msgs(frameSpy).map((m) => m.type);
    expect(types).toEqual(["webgame:load", "webgame:controls"]);
    expect(sent(frameSpy, "webgame:controls")[0]).toEqual({ type: "webgame:controls", overrides: { jump: ["KeyK"] }, gamepad: {} });
    // A restart's hello gets it again.
    post(win, { type: "webgame:hello" });
    await flush();
    expect(sent(frameSpy, "webgame:controls")).toHaveLength(2);
  });

  it("does not post webgame:controls for games without actions", async () => {
    const { win, frameSpy } = await setup({ ...base, actions: [], controlsHint: "Mouse to aim" });
    post(win, { type: "webgame:hello" });
    await flush();
    expect(sent(frameSpy, "webgame:controls")).toHaveLength(0);
  });

  it("the delayed (cloud timeout) load reply sends the overrides current when it fires", async () => {
    vi.useFakeTimers();
    const { win, frameSpy } = await setup(undefined, { loggedIn: true, saveNever: true });
    post(win, { type: "webgame:hello" });
    expect(sent(frameSpy, "webgame:load")).toHaveLength(0);
    act(() => {
      writeOverrides("g1", { fire: ["KeyX"] }, ACTIONS);
    });
    await flush(CLOUD_LOAD_TIMEOUT_MS);
    const types = msgs(frameSpy).map((m) => m.type);
    expect(types.slice(-2)).toEqual(["webgame:load", "webgame:controls"]);
    expect(sent(frameSpy, "webgame:controls").at(-1)).toEqual({ type: "webgame:controls", overrides: { fire: ["KeyX"] }, gamepad: {} });
  });

  it("posts the new overrides after a change in the panel and stores them on the device", async () => {
    const { win, frameSpy } = await setup();
    post(win, { type: "webgame:ready" });
    await flush();
    fireEvent.click(controlsButton()!);
    const s = screen.getByRole("button", { name: /^Jump, key 3: / });
    fireEvent.click(s);
    fireEvent.keyDown(s, { code: "KeyK", key: "k" });
    expect(sent(frameSpy, "webgame:controls").at(-1)).toEqual({ type: "webgame:controls", overrides: { jump: ["Space", "ArrowUp", "KeyK"] }, gamepad: {} });
    expect(JSON.parse(localStorage.getItem(controlsStorageKey("g1"))!)).toEqual({ v: 1, overrides: { jump: ["Space", "ArrowUp", "KeyK"] } });
    // Nothing but ids and codes: no labels, no layout.
    const json = JSON.stringify(sent(frameSpy, "webgame:controls"));
    expect(json).not.toMatch(/Jump|Space,|↑|label|layout/);
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(sent(frameSpy, "webgame:controls").at(-1)).toEqual({ type: "webgame:controls", overrides: {}, gamepad: {} });
    expect(localStorage.getItem(controlsStorageKey("g1"))).toBeNull();
  });

  it("pauses on open and resumes on close, then focuses the game", async () => {
    const { win, frameSpy, iframe } = await setup();
    post(win, { type: "webgame:ready" });
    await flush();
    fireEvent.click(controlsButton()!);
    expect(sent(frameSpy, "webgame:pause")).toHaveLength(1);
    expect(sent(frameSpy, "webgame:resume")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent(frameSpy, "webgame:resume")).toHaveLength(1);
    expect(document.activeElement).toBe(iframe);
  });

  it("does not resume while the tab is still hidden (and vice versa)", async () => {
    const { win, frameSpy } = await setup();
    post(win, { type: "webgame:ready" });
    await flush();
    fireEvent.click(controlsButton()!);
    expect(sent(frameSpy, "webgame:pause")).toHaveLength(1);
    setHidden(true);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(sent(frameSpy, "webgame:resume")).toHaveLength(0);
    setHidden(false);
    expect(sent(frameSpy, "webgame:resume")).toHaveLength(1);
    // Hidden tab, then the panel opens and the tab comes back: still paused until the panel closes.
    setHidden(true);
    expect(sent(frameSpy, "webgame:pause")).toHaveLength(2);
    fireEvent.click(controlsButton()!);
    setHidden(false);
    expect(sent(frameSpy, "webgame:resume")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(sent(frameSpy, "webgame:resume")).toHaveLength(2);
  });

  it("visibility alone still pauses and resumes", async () => {
    const { frameSpy } = await setup({ ...base });
    setHidden(true);
    setHidden(false);
    expect(msgs(frameSpy).map((m) => m.type)).toEqual(["webgame:pause", "webgame:resume"]);
  });

  it("PLAYER_CONTROLS_EVENT opens the panel, and is ignored when ⌨ is hidden", async () => {
    const { rerenderWith } = await setup();
    act(() => {
      window.dispatchEvent(new CustomEvent(PLAYER_CONTROLS_EVENT));
    });
    expect(screen.getByRole("dialog", { name: "Controls" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    rerenderWith({ ...base });
    act(() => {
      window.dispatchEvent(new CustomEvent(PLAYER_CONTROLS_EVENT));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the first-play hint once per game, and closes it after 8 s", async () => {
    vi.useFakeTimers();
    const first = await setup();
    post(first.win, { type: "webgame:ready" });
    await flush();
    expect(screen.getByRole("status").textContent).toContain("See and change the controls");
    expect(localStorage.getItem("webgame.controls.hinted.g1")).toBe("1");
    await flush(CONTROLS_HINT_MS);
    expect(screen.queryByText("See and change the controls")).toBeNull();
    // A restart (another ready) doesn't show it again.
    post(first.win, { type: "webgame:ready" });
    await flush();
    expect(screen.queryByText("See and change the controls")).toBeNull();
    first.unmount();
    const again = await setup();
    post(again.win, { type: "webgame:ready" });
    await flush();
    expect(screen.queryByText("See and change the controls")).toBeNull();
  });

  it("the hint closes on × and when the panel opens; never for hint-only games", async () => {
    const { win } = await setup();
    post(win, { type: "webgame:ready" });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("See and change the controls")).toBeNull();

    localStorage.clear();
    const other = await setup({ ...base, id: "g2", actions: ACTIONS });
    post(other.win, { type: "webgame:ready" });
    await flush();
    expect(screen.getByText("See and change the controls")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Controls" }).at(-1)!);
    expect(screen.queryByText("See and change the controls")).toBeNull();

    const hintOnly = await setup({ ...base, id: "g3", actions: [], controlsHint: "Mouse to aim" });
    post(hintOnly.win, { type: "webgame:ready" });
    await flush();
    expect(screen.queryByText("See and change the controls")).toBeNull();
    expect(localStorage.getItem("webgame.controls.hinted.g3")).toBeNull();
  });

  it("tolerates games from older servers without actions/controlsHint", async () => {
    const { win, frameSpy } = await setup({ ...base });
    post(win, { type: "webgame:hello" });
    post(win, { type: "webgame:ready" });
    await flush();
    expect(sent(frameSpy, "webgame:controls")).toHaveLength(0);
    expect(controlsButton()).toBeNull();
  });
});

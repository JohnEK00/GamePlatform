import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { ControlAction, ControlBindingsResponse, User } from "../api/types";
import { GamePlayer, type GamePlayerGame } from "../components/GamePlayer";
import { controlsStorageKey, resetControlsStoreForTests, writeBindings } from "../controls";
import { CONTROLS_SYNC_DEBOUNCE_MS } from "../controlsSync";
import { WebGameProviders } from "../WebGameApp";
import { installFakeGamepads, type FakeGamepads } from "./fakeGamepads";

const ACTIONS: ControlAction[] = [
  { id: "jump", name: "Jump", keys: ["Space", "ArrowUp"], gamepad: ["A"] },
  { id: "fire", name: "Fire", keys: ["KeyZ"], gamepad: [] },
];
const game: GamePlayerGame = { id: "g1", title: "Pixel Peaks", width: 320, height: 180, playUrl: "/play/g1", version: 3, published: true, isOwner: false, actions: ACTIONS };
const PAD_ID = "Secret Pad (Vendor: 045e Product: 02fd)";
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

let pads: FakeGamepads;
beforeEach(() => {
  pads = installFakeGamepads();
});
afterEach(() => {
  pads.uninstall();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetControlsStoreForTests();
});

async function setup({ loggedIn = false, account = { bindings: null, updatedAt: null } as ControlBindingsResponse | Promise<ControlBindingsResponse> } = {}) {
  if (loggedIn) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "recordPlay").mockResolvedValue({ plays: 1 });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "getSave").mockResolvedValue({ data: null, updatedAt: null });
  const getControls = vi.spyOn(client, "getControls").mockImplementation(() => Promise.resolve(account));
  const putControls = vi.spyOn(client, "putControls").mockImplementation(async (_id, bindings) => ({ bindings, updatedAt: "2026-11-17T00:00:00Z" }));
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <GamePlayer game={game} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  const win = utils.container.querySelector("iframe")!.contentWindow!;
  const frameSpy = vi.spyOn(win, "postMessage");
  await flush();
  return { ...utils, win, frameSpy, getControls, putControls };
}

const sent = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m?.type === "webgame:controls");

describe("GamePlayer bindings (F016)", () => {
  it("the message after load includes gamepad, with only ids, codes and button names", async () => {
    writeBindings("g1", { keys: { jump: ["KeyK"] }, gamepad: { jump: ["B"], gone: ["X"] } }, undefined, { unsynced: "u1" });
    const { win, frameSpy } = await setup();
    post(win, { type: "webgame:hello" });
    await flush();
    expect(sent(frameSpy)).toEqual([{ type: "webgame:controls", overrides: { jump: ["KeyK"] }, gamepad: { jump: ["B"] } }]);
    expect(JSON.stringify(sent(frameSpy))).not.toMatch(/u1|unsynced|Jump|label|account/);
  });

  it("a gamepad capture in the panel posts both sets at once, never the controller name", async () => {
    pads.connect(0, { id: PAD_ID });
    const { win, frameSpy } = await setup();
    post(win, { type: "webgame:ready" });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Controls" }));
    fireEvent.click(screen.getByRole("button", { name: /^Fire, gamepad button 1: / }));
    pads.press(0, 2);
    pads.frame();
    expect(sent(frameSpy).at(-1)).toEqual({ type: "webgame:controls", overrides: {}, gamepad: { fire: ["X"] } });
    expect(JSON.parse(localStorage.getItem(controlsStorageKey("g1"))!)).toEqual({ v: 1, overrides: {}, gamepad: { fire: ["X"] } });
    const everything = JSON.stringify([frameSpy.mock.calls, { ...localStorage }]);
    expect(everything).not.toMatch(/Secret|045e|Vendor/);
    expect(screen.getByText("Saved on this device")).toBeTruthy();
  });

  it("adopting the account copy posts a fresh message", async () => {
    writeBindings("g1", { keys: { jump: ["KeyK"] }, gamepad: {} }, ACTIONS);
    let resolve!: (r: ControlBindingsResponse) => void;
    const account = new Promise<ControlBindingsResponse>((r) => (resolve = r));
    const { win, frameSpy, getControls } = await setup({ loggedIn: true, account });
    post(win, { type: "webgame:hello" });
    await flush();
    expect(getControls).toHaveBeenCalledWith("g1");
    expect(sent(frameSpy).at(-1)).toEqual({ type: "webgame:controls", overrides: { jump: ["KeyK"] }, gamepad: {} });
    await act(async () => {
      resolve({ bindings: { keys: {}, gamepad: { jump: ["B"] } }, updatedAt: "2026-11-17T00:00:00Z" });
      await account;
    });
    expect(sent(frameSpy).at(-1)).toEqual({ type: "webgame:controls", overrides: {}, gamepad: { jump: ["B"] } });
  });

  it("signed in: a panel change is uploaded once after the debounce and the footer says so", async () => {
    vi.useFakeTimers();
    const { putControls } = await setup({ loggedIn: true });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Controls" }));
    expect(screen.getByText("Saved to your account")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear gamepad A from Jump" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Space from Jump" }));
    expect(JSON.parse(localStorage.getItem(controlsStorageKey("g1"))!).unsynced).toBe("u1");
    await flush(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(putControls).toHaveBeenCalledTimes(1);
    expect(putControls.mock.calls[0][1]).toEqual({ keys: { jump: ["ArrowUp"] }, gamepad: { jump: [] } });
    expect(JSON.parse(localStorage.getItem(controlsStorageKey("g1"))!).unsynced).toBeUndefined();
  });

  it("a failed upload shows the failed-sync note", async () => {
    vi.useFakeTimers();
    const { putControls } = await setup({ loggedIn: true });
    putControls.mockRejectedValue(new ApiError("network", "offline", 0));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Controls" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear gamepad A from Jump" }));
    await flush(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(screen.getByText("Saved on this device. Couldn't save to your account; it will be retried.").getAttribute("role")).toBe("status");
  });
});

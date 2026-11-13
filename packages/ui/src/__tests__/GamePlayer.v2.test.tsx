import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { CloudSave, UnlockAchievementResponse, User } from "../api/types";
import { discardPendingCloudSave, GamePlayer } from "../components/GamePlayer";
import { WebGameProviders } from "../WebGameApp";

const game = { id: "g1", title: "Space Dodge", width: 800, height: 600, playUrl: "/play/g1", version: 3, published: true, isOwner: false };
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

type Opts = { loggedIn?: boolean; getSave?: () => Promise<CloudSave> };

async function setup({ loggedIn = true, getSave }: Opts = {}) {
  if (loggedIn) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "recordPlay").mockResolvedValue({ plays: 1 });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  const getSaveSpy = vi.spyOn(client, "getSave").mockImplementation(getSave ?? (async () => ({ data: null, updatedAt: null })));
  const putSave = vi.spyOn(client, "putSave").mockResolvedValue({ updatedAt: "2026-01-01T00:00:00Z" });
  const unlock = vi.spyOn(client, "unlockAchievement");
  const onAch = vi.fn();
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <GamePlayer game={game} onAchievementUnlocked={onAch} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await flush();
  const iframe = utils.container.querySelector("iframe")!;
  const frameSpy = vi.spyOn(iframe.contentWindow!, "postMessage");
  return { ...utils, client, iframe, frameSpy, getSave: getSaveSpy, putSave, unlock, onAch };
}

const loads = (spy: ReturnType<typeof vi.fn> | { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) => (c[0] as { type?: string })?.type === "webgame:load").map((c) => (c[0] as { data: unknown }).data);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GamePlayer achievements", () => {
  const unlocked = (isNew: boolean): UnlockAchievementResponse => ({
    achievement: { id: "first_blood", name: "First Blood", description: "Destroy a rock", iconUrl: null, gameId: "g1", gameTitle: "Space Dodge", unlockedAt: "2026-01-01T00:00:00Z" },
    new: isNew,
  });

  it("POSTs the unlock when logged in and toasts when it's new (once per id)", async () => {
    const { iframe, unlock, onAch } = await setup();
    unlock.mockResolvedValue(unlocked(true));
    post(iframe.contentWindow, { type: "webgame:achievement", id: "first_blood" });
    post(iframe.contentWindow, { type: "webgame:achievement", id: "first_blood" });
    expect(await screen.findByText("Achievement unlocked: First Blood")).toBeTruthy();
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalledWith("g1", "first_blood");
    expect(onAch).toHaveBeenCalledWith(unlocked(true));
  });

  it("does not toast for an already-unlocked achievement", async () => {
    const { iframe, unlock, onAch } = await setup();
    unlock.mockResolvedValue(unlocked(false));
    post(iframe.contentWindow, { type: "webgame:achievement", id: "first_blood" });
    await flush(10);
    expect(onAch).toHaveBeenCalled();
    expect(screen.queryByText(/Achievement unlocked/)).toBeNull();
  });

  it("ignores invalid ids and foreign sources", async () => {
    const { iframe, unlock } = await setup();
    unlock.mockResolvedValue(unlocked(true));
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    post(other.contentWindow, { type: "webgame:achievement", id: "first_blood" });
    post(window, { type: "webgame:achievement", id: "first_blood" });
    post(iframe.contentWindow, { type: "webgame:achievement", id: "Bad Id!" });
    post(iframe.contentWindow, { type: "webgame:achievement", id: 42 });
    await flush(10);
    expect(unlock).not.toHaveBeenCalled();
    other.remove();
  });

  it("anonymous players get a single 'Log in to earn achievements' hint per session", async () => {
    const first = await setup({ loggedIn: false });
    post(first.iframe.contentWindow, { type: "webgame:achievement", id: "a" });
    post(first.iframe.contentWindow, { type: "webgame:achievement", id: "b" });
    await flush(10);
    expect(screen.getAllByText("Log in to earn achievements")).toHaveLength(1);
    expect(first.unlock).not.toHaveBeenCalled();
    first.unmount();
    const second = await setup({ loggedIn: false });
    post(second.iframe.contentWindow, { type: "webgame:achievement", id: "c" });
    await flush(10);
    expect(screen.queryByText("Log in to earn achievements")).toBeNull();
  });
});

describe("GamePlayer cloud saves", () => {
  it("prefetches the cloud save on mount and answers hello with it", async () => {
    localStorage.setItem("webgame.save.g1", JSON.stringify({ level: 1 }));
    const { iframe, frameSpy, getSave } = await setup({ getSave: async () => ({ data: { level: 9 }, updatedAt: "x" }) });
    expect(getSave).toHaveBeenCalledWith("g1");
    post(iframe.contentWindow, { type: "webgame:hello" });
    expect(loads(frameSpy)).toEqual([{ level: 9 }]);
    expect(JSON.parse(localStorage.getItem("webgame.save.g1")!)).toEqual({ level: 9 });
  });

  it("falls back to local data when the server has no save or the request fails", async () => {
    localStorage.setItem("webgame.save.g1", JSON.stringify({ level: 1 }));
    const a = await setup({ getSave: async () => ({ data: null, updatedAt: null }) });
    post(a.iframe.contentWindow, { type: "webgame:hello" });
    expect(loads(a.frameSpy)).toEqual([{ level: 1 }]);
    a.unmount();
    const b = await setup({ getSave: async () => Promise.reject(new ApiError("network", "down", 0)) });
    post(b.iframe.contentWindow, { type: "webgame:hello" });
    expect(loads(b.frameSpy)).toEqual([{ level: 1 }]);
  });

  it("answers with local data after 400ms and sends a late server copy as an extra load", async () => {
    vi.useFakeTimers();
    localStorage.setItem("webgame.save.g1", JSON.stringify({ level: 1 }));
    let resolve!: (v: CloudSave) => void;
    const { iframe, frameSpy } = await setup({ getSave: () => new Promise<CloudSave>((r) => (resolve = r)) });
    post(iframe.contentWindow, { type: "webgame:hello" });
    await flush(399);
    expect(loads(frameSpy)).toEqual([]);
    await flush(1);
    expect(loads(frameSpy)).toEqual([{ level: 1 }]);
    await act(async () => resolve({ data: { level: 7 }, updatedAt: "x" }));
    await flush(0);
    expect(loads(frameSpy)).toEqual([{ level: 1 }, { level: 7 }]);
  });

  it("answers as soon as a slow-but-under-400ms prefetch arrives", async () => {
    vi.useFakeTimers();
    let resolve!: (v: CloudSave) => void;
    const { iframe, frameSpy } = await setup({ getSave: () => new Promise<CloudSave>((r) => (resolve = r)) });
    post(iframe.contentWindow, { type: "webgame:hello" });
    await flush(200);
    await act(async () => resolve({ data: { level: 5 }, updatedAt: "x" }));
    await flush(0);
    expect(loads(frameSpy)).toEqual([{ level: 5 }]);
    await flush(1000);
    expect(loads(frameSpy)).toEqual([{ level: 5 }]);
  });

  it("writes localStorage immediately and debounces the PUT (>= 2s, latest data)", async () => {
    vi.useFakeTimers();
    const { iframe, putSave } = await setup();
    post(iframe.contentWindow, { type: "webgame:save", data: { coins: 1 } });
    expect(JSON.parse(localStorage.getItem("webgame.save.g1")!)).toEqual({ coins: 1 });
    await flush(500);
    post(iframe.contentWindow, { type: "webgame:save", data: { coins: 2 } });
    post(iframe.contentWindow, { type: "webgame:save", data: { coins: 3 } });
    expect(JSON.parse(localStorage.getItem("webgame.save.g1")!)).toEqual({ coins: 3 });
    await flush(1499);
    expect(putSave).not.toHaveBeenCalled();
    await flush(1);
    expect(putSave).toHaveBeenCalledTimes(1);
    expect(putSave).toHaveBeenCalledWith("g1", { coins: 3 });
    // invalid saves are neither stored nor uploaded
    post(iframe.contentWindow, { type: "webgame:save", data: [1, 2] });
    await flush(3000);
    expect(putSave).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending PUT on unmount", async () => {
    vi.useFakeTimers();
    const { iframe, putSave, unmount } = await setup();
    post(iframe.contentWindow, { type: "webgame:save", data: { hp: 3 } });
    expect(putSave).not.toHaveBeenCalled();
    unmount();
    expect(putSave).toHaveBeenCalledWith("g1", { hp: 3 });
  });

  it("discardPendingCloudSave drops the pending write (used by Clear save data)", async () => {
    vi.useFakeTimers();
    const { iframe, putSave, unmount } = await setup();
    post(iframe.contentWindow, { type: "webgame:save", data: { hp: 3 } });
    await act(async () => discardPendingCloudSave("g1"));
    await flush(5000);
    unmount();
    expect(putSave).not.toHaveBeenCalled();
  });

  it("anonymous players use localStorage only", async () => {
    vi.useFakeTimers();
    localStorage.setItem("webgame.save.g1", JSON.stringify({ level: 2 }));
    const { iframe, frameSpy, getSave, putSave, unmount } = await setup({ loggedIn: false });
    post(iframe.contentWindow, { type: "webgame:hello" });
    expect(loads(frameSpy)).toEqual([{ level: 2 }]);
    post(iframe.contentWindow, { type: "webgame:save", data: { level: 3 } });
    await flush(5000);
    unmount();
    expect(getSave).not.toHaveBeenCalled();
    expect(putSave).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("webgame.save.g1")!)).toEqual({ level: 3 });
  });
});

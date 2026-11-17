import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { ControlAction, ControlBindings, ControlBindingsResponse, PutControlsResponse } from "../api/types";
import { controlsParkedKey, readBindings, readUnsynced, resetControlsStoreForTests, subscribeBindings, writeBindings } from "../controls";
import { CONTROLS_SYNC_DEBOUNCE_MS, resetControlsSyncForTests, useControlsSync, type ControlsSyncApi } from "../controlsSync";

const ACTIONS: ControlAction[] = [
  { id: "jump", name: "Jump", keys: ["Space"], gamepad: ["A"] },
  { id: "fire", name: "Fire", keys: ["KeyZ"], gamepad: [] },
];
const U1 = { id: "u1" };
const U2 = { id: "u2" };
const AT = "2026-11-17T10:00:00Z";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockApi(get: ControlBindingsResponse | Error = { bindings: null, updatedAt: null }) {
  const getControls = vi.fn(async () => {
    if (get instanceof Error) throw get;
    return get;
  });
  const api = { token: "tokA" as string | null, getControls, putControls: null as unknown, putTokens: [] as (string | null)[] };
  // Echoes the sent bindings as the server's normalised copy, and records the token each PUT would carry.
  const putControls = vi.fn(async (_id: string, bindings: ControlBindings, _opts?: { keepalive?: boolean }): Promise<PutControlsResponse> => {
    api.putTokens.push(api.token);
    return { bindings, updatedAt: AT };
  });
  api.putControls = putControls;
  return api as unknown as ControlsSyncApi & {
    token: string | null;
    putTokens: (string | null)[];
    getControls: typeof getControls;
    putControls: typeof putControls;
  };
}

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(api: ControlsSyncApi, user: { id: string } | null = U1, gameId = "g1") {
  return renderHook(({ u }: { u: { id: string } | null }) => useControlsSync(gameId, ACTIONS, u, api), { initialProps: { u: user } });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  resetControlsStoreForTests();
  resetControlsSyncForTests();
});

describe("useControlsSync (F016)", () => {
  it("adopts the account copy: the device store is overwritten and subscribers are told", async () => {
    writeBindings("g1", { keys: { jump: ["KeyK"] }, gamepad: {} }, ACTIONS);
    const seen = vi.fn();
    const off = subscribeBindings("g1", seen);
    const api = mockApi({ bindings: { keys: {}, gamepad: { jump: ["B"] } }, updatedAt: AT });
    const { result } = mount(api);
    await tick();
    expect(api.getControls).toHaveBeenCalledWith("g1");
    expect(api.putControls).not.toHaveBeenCalled();
    expect(readBindings("g1")).toEqual({ keys: {}, gamepad: { jump: ["B"] } });
    expect(readUnsynced("g1")).toBeNull();
    expect(seen).toHaveBeenLastCalledWith({ keys: {}, gamepad: { jump: ["B"] } });
    expect(result.current.syncState).toBe("account");
    off();
  });

  it("an empty account row ({keys:{}, gamepad:{}}) is adopted too", async () => {
    writeBindings("g1", { keys: { jump: ["KeyK"] }, gamepad: {} }, ACTIONS);
    const api = mockApi({ bindings: { keys: {}, gamepad: {} }, updatedAt: AT });
    mount(api);
    await tick();
    expect(readBindings("g1")).toEqual({ keys: {}, gamepad: {} });
    expect(api.putControls).not.toHaveBeenCalled();
  });

  it("no account row and device bindings → PUT them", async () => {
    writeBindings("g1", { keys: { fire: ["KeyX"] }, gamepad: { jump: ["B"] } }, ACTIONS);
    const api = mockApi();
    mount(api);
    await tick();
    expect(api.putControls).toHaveBeenCalledTimes(1);
    expect(api.putControls.mock.calls[0][0]).toBe("g1");
    expect(api.putControls.mock.calls[0][1]).toEqual({ keys: { fire: ["KeyX"] }, gamepad: { jump: ["B"] } });
    expect(readBindings("g1")).toEqual({ keys: { fire: ["KeyX"] }, gamepad: { jump: ["B"] } });
  });

  it("no account row and nothing on the device → no PUT", async () => {
    const api = mockApi();
    mount(api);
    await tick(5000);
    expect(api.getControls).toHaveBeenCalledTimes(1);
    expect(api.putControls).not.toHaveBeenCalled();
  });

  it("an unsynced change of this user is uploaded without reading the account copy", async () => {
    writeBindings("g1", { keys: {}, gamepad: { jump: ["X"] } }, ACTIONS, { unsynced: "u1" });
    const api = mockApi({ bindings: { keys: {}, gamepad: { jump: ["B"] } }, updatedAt: AT });
    mount(api);
    await tick();
    expect(api.getControls).not.toHaveBeenCalled();
    expect(api.putControls).toHaveBeenCalledWith("g1", { keys: {}, gamepad: { jump: ["X"] } }, {});
    expect(readBindings("g1")).toEqual({ keys: {}, gamepad: { jump: ["X"] } });
    expect(readUnsynced("g1")).toBeNull();
  });

  it("L2b: another user's unsynced change is parked for them; this user reads and edits their own copy", async () => {
    writeBindings("g1", { keys: {}, gamepad: { jump: ["X"] } }, ACTIONS, { unsynced: "u9" });
    const api = mockApi({ bindings: { keys: { fire: ["KeyQ"] }, gamepad: {} }, updatedAt: AT });
    const { result, rerender } = mount(api);
    await tick();
    expect(api.getControls).toHaveBeenCalledTimes(1);
    expect(api.putControls).not.toHaveBeenCalled();
    // The device now shows this user's account copy, not u9's change.
    expect(readBindings("g1")).toEqual({ keys: { fire: ["KeyQ"] }, gamepad: {} });
    expect(readUnsynced("g1")).toBeNull();
    expect(JSON.parse(localStorage.getItem(controlsParkedKey("g1", "u9"))!)).toEqual({ v: 1, overrides: {}, gamepad: { jump: ["X"] } });
    // The first change builds on this user's copy.
    act(() => result.current.change({ keys: { fire: ["KeyQ"] }, gamepad: { fire: ["Y"] } }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(api.putControls.mock.calls[0][1]).toEqual({ keys: { fire: ["KeyQ"] }, gamepad: { fire: ["Y"] } });
    expect(JSON.stringify(api.putControls.mock.calls)).not.toContain('"X"');

    // u9 signs in later: their parked change is restored and uploaded without reading their account copy.
    api.token = "tok9";
    rerender({ u: { id: "u9" } });
    await tick();
    expect(api.getControls).toHaveBeenCalledTimes(1);
    expect(api.putControls).toHaveBeenCalledTimes(2);
    expect(api.putControls.mock.calls[1][1]).toEqual({ keys: {}, gamepad: { jump: ["X"] } });
    expect(api.putTokens.at(-1)).toBe("tok9");
    expect(localStorage.getItem(controlsParkedKey("g1", "u9"))).toBeNull();
    expect(readUnsynced("g1")).toBeNull();
  });

  it("L2b: with no account copy, the parked change is not uploaded to this account", async () => {
    writeBindings("g1", { keys: {}, gamepad: { jump: ["X"] } }, ACTIONS, { unsynced: "u9" });
    const api = mockApi();
    const { result } = mount(api);
    await tick();
    expect(api.putControls).not.toHaveBeenCalled();
    expect(readBindings("g1")).toEqual({ keys: {}, gamepad: {} });
    expect(result.current.syncState).toBe("account");
  });

  it("L2a: a change made while signed out clears another user's marker, so it is never uploaded as theirs", async () => {
    writeBindings("g1", { keys: {}, gamepad: { jump: ["X"] } }, ACTIONS, { unsynced: "u9" });
    const api = mockApi({ bindings: { keys: {}, gamepad: { jump: ["B"] } }, updatedAt: AT });
    const { result, rerender } = mount(api, null);
    await tick();
    act(() => result.current.change({ keys: { fire: ["KeyM"] }, gamepad: { jump: ["X"] } }));
    expect(readUnsynced("g1")).toBeNull();
    // u9 signs in: their account copy is read (and wins); nothing is uploaded.
    rerender({ u: { id: "u9" } });
    await tick();
    expect(api.getControls).toHaveBeenCalledTimes(1);
    expect(api.putControls).not.toHaveBeenCalled();
    expect(readBindings("g1")).toEqual({ keys: {}, gamepad: { jump: ["B"] } });
  });

  it("a change writes the device at once with unsynced, and 3 changes within 1 s make one PUT", async () => {
    const api = mockApi();
    const { result } = mount(api);
    await tick();
    act(() => result.current.change({ keys: { jump: ["KeyK"] }, gamepad: {} }));
    expect(readBindings("g1").keys).toEqual({ jump: ["KeyK"] });
    expect(readUnsynced("g1")).toBe("u1");
    await tick(500);
    act(() => result.current.change({ keys: { jump: ["KeyL"] }, gamepad: {} }));
    await tick(500);
    act(() => result.current.change({ keys: { jump: ["KeyL"] }, gamepad: { fire: ["Y"] } }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS - 1);
    expect(api.putControls).not.toHaveBeenCalled();
    await tick(1);
    expect(api.putControls).toHaveBeenCalledTimes(1);
    expect(api.putControls.mock.calls[0][1]).toEqual({ keys: { jump: ["KeyL"] }, gamepad: { fire: ["Y"] } });
    expect(readUnsynced("g1")).toBeNull();
    expect(result.current.syncState).toBe("account");
  });

  it("a successful PUT adopts the server's normalised copy", async () => {
    const api = mockApi();
    api.putControls.mockResolvedValueOnce({ bindings: { keys: {}, gamepad: { jump: ["B"] } }, updatedAt: AT });
    const { result } = mount(api);
    await tick();
    act(() => result.current.change({ keys: { jump: ["KeyK"] }, gamepad: { jump: ["B"] } }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(readBindings("g1")).toEqual({ keys: {}, gamepad: { jump: ["B"] } });
  });

  it("success clears unsynced only when the device still holds what was sent", async () => {
    const api = mockApi();
    const put = deferred<PutControlsResponse>();
    api.putControls.mockReturnValueOnce(put.promise);
    const { result } = mount(api);
    await tick();
    act(() => result.current.change({ keys: { jump: ["KeyK"] }, gamepad: {} }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(api.putControls).toHaveBeenCalledTimes(1);
    // A newer change while the PUT is in flight.
    act(() => result.current.change({ keys: { jump: ["KeyM"] }, gamepad: {} }));
    await act(async () => {
      put.resolve({ bindings: { keys: { jump: ["KeyK"] }, gamepad: {} }, updatedAt: AT });
      await put.promise;
    });
    expect(readUnsynced("g1")).toBe("u1");
    expect(readBindings("g1").keys).toEqual({ jump: ["KeyM"] });
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(api.putControls).toHaveBeenCalledTimes(2);
    expect(readUnsynced("g1")).toBeNull();
  });

  it("a failed PUT → failed, unsynced kept, no automatic retry; the next change retries", async () => {
    const api = mockApi();
    api.putControls.mockRejectedValueOnce(new ApiError("network", "offline", 0));
    const { result } = mount(api);
    await tick();
    act(() => result.current.change({ keys: {}, gamepad: { jump: ["B"] } }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(result.current.syncState).toBe("failed");
    expect(readUnsynced("g1")).toBe("u1");
    expect(readBindings("g1").gamepad).toEqual({ jump: ["B"] });
    await tick(60_000);
    expect(api.putControls).toHaveBeenCalledTimes(1);
    act(() => result.current.change({ keys: {}, gamepad: { jump: ["X"] } }));
    expect(result.current.syncState).toBe("failed");
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(api.putControls).toHaveBeenCalledTimes(2);
    expect(result.current.syncState).toBe("account");
    expect(readUnsynced("g1")).toBeNull();
  });

  it("a 401 does not retry in a loop", async () => {
    writeBindings("g1", { keys: {}, gamepad: { jump: ["B"] } }, ACTIONS, { unsynced: "u1" });
    const api = mockApi();
    api.putControls.mockRejectedValue(new ApiError("unauthorized", "Log in", 401));
    const { result } = mount(api);
    await tick(120_000);
    expect(api.putControls).toHaveBeenCalledTimes(1);
    expect(result.current.syncState).toBe("failed");
    expect(readUnsynced("g1")).toBe("u1");
  });

  it("a failed GET leaves the device copy in charge, without retrying", async () => {
    writeBindings("g1", { keys: {}, gamepad: { jump: ["B"] } }, ACTIONS);
    const api = mockApi(new ApiError("network", "offline", 0));
    const { result } = mount(api);
    await tick(60_000);
    expect(api.getControls).toHaveBeenCalledTimes(1);
    expect(api.putControls).not.toHaveBeenCalled();
    expect(readBindings("g1").gamepad).toEqual({ jump: ["B"] });
    expect(result.current.syncState).toBe("failed");
  });

  it("a change made while the GET is in flight is not overwritten by the account copy", async () => {
    const get = deferred<ControlBindingsResponse>();
    const api = mockApi();
    api.getControls.mockReturnValueOnce(get.promise);
    const { result } = mount(api);
    act(() => result.current.change({ keys: {}, gamepad: { jump: ["Y"] } }));
    await act(async () => {
      get.resolve({ bindings: { keys: {}, gamepad: { jump: ["B"] } }, updatedAt: AT });
      await get.promise;
    });
    expect(readBindings("g1").gamepad).toEqual({ jump: ["Y"] });
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(api.putControls.mock.calls[0][1]).toEqual({ keys: {}, gamepad: { jump: ["Y"] } });
  });

  it("unmount with a pending change flushes the PUT at once with keepalive", async () => {
    const api = mockApi();
    const { result, unmount } = mount(api);
    await tick();
    act(() => result.current.change({ keys: { fire: ["KeyX"] }, gamepad: {} }));
    unmount();
    expect(api.putControls).toHaveBeenCalledTimes(1);
    expect(api.putControls.mock.calls[0]).toEqual(["g1", { keys: { fire: ["KeyX"] }, gamepad: {} }, { keepalive: true }]);
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(api.putControls).toHaveBeenCalledTimes(1);
    // Confirmed after unmount: the marker is cleared.
    expect(readUnsynced("g1")).toBeNull();
  });

  it("pagehide with a pending change flushes with keepalive", async () => {
    const api = mockApi();
    const { result } = mount(api);
    await tick();
    act(() => result.current.change({ keys: { fire: ["KeyX"] }, gamepad: {} }));
    window.dispatchEvent(new Event("pagehide"));
    expect(api.putControls.mock.calls[0][2]).toEqual({ keepalive: true });
  });

  it("unmount without a pending change sends nothing", async () => {
    const api = mockApi();
    const { unmount } = mount(api);
    await tick();
    unmount();
    expect(api.putControls).not.toHaveBeenCalled();
  });

  it("anonymous players make no requests; changes stay on the device", async () => {
    const api = mockApi();
    const { result } = mount(api, null);
    await tick();
    expect(result.current.syncState).toBe("device");
    act(() => result.current.change({ keys: {}, gamepad: { jump: ["B"] } }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS * 3);
    expect(readBindings("g1").gamepad).toEqual({ jump: ["B"] });
    expect(readUnsynced("g1")).toBeNull();
    expect(api.getControls).not.toHaveBeenCalled();
    expect(api.putControls).not.toHaveBeenCalled();
  });

  it("games without actions never sync", async () => {
    const api = mockApi();
    const { result } = renderHook(() => useControlsSync("g1", [], U1, api));
    await tick();
    expect(result.current.syncState).toBe("device");
    expect(api.getControls).not.toHaveBeenCalled();
  });

  it("direct switch A → B before the debounce: no PUT with B's token; A's change uploads at A's next sign-in", async () => {
    const api = mockApi({ bindings: { keys: {}, gamepad: { jump: ["Y"] } }, updatedAt: AT });
    const { result, rerender } = mount(api, U1);
    await tick();
    expect(readBindings("g1").gamepad).toEqual({ jump: ["Y"] }); // A's account copy adopted
    act(() => result.current.change({ keys: {}, gamepad: { jump: ["B"] } }));
    // The app switches straight to B: the client gets B's token, then the user changes.
    api.token = "tokB";
    api.getControls.mockResolvedValueOnce({ bindings: null, updatedAt: null });
    rerender({ u: U2 });
    await tick(CONTROLS_SYNC_DEBOUNCE_MS * 5);
    expect(api.putControls).not.toHaveBeenCalled();
    expect(api.putTokens).toEqual([]);
    // A's change is parked for A; B reads their own (empty) copy and gets the defaults.
    expect(api.getControls).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(controlsParkedKey("g1", "u1"))!).gamepad).toEqual({ jump: ["B"] });
    expect(readBindings("g1")).toEqual({ keys: {}, gamepad: {} });
    window.dispatchEvent(new Event("pagehide"));
    expect(api.putControls).not.toHaveBeenCalled();

    // A signs back in: the parked change is restored and uploaded with A's token, without reading the account copy.
    api.token = "tokA";
    rerender({ u: U1 });
    await tick();
    expect(api.getControls).toHaveBeenCalledTimes(2);
    expect(api.putControls).toHaveBeenCalledTimes(1);
    expect(api.putControls.mock.calls[0][1]).toEqual({ keys: {}, gamepad: { jump: ["B"] } });
    expect(api.putTokens).toEqual(["tokA"]);
    expect(readUnsynced("g1")).toBeNull();
  });

  it("L1: a token change before the debounce cancels the PUT and the footer stops claiming the account", async () => {
    const api = mockApi();
    const { result } = mount(api, U1);
    await tick();
    act(() => result.current.change({ keys: { fire: ["KeyX"] }, gamepad: {} }));
    api.token = "tokA2"; // same user, new token (re-login in another tab)
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(api.putControls).not.toHaveBeenCalled();
    expect(readUnsynced("g1")).toBe("u1");
    expect(result.current.syncState).toBe("failed");
  });

  it("M1: a change made after the token switched (user not yet updated) is never sent with the new token", async () => {
    const api = mockApi();
    const { result } = mount(api, U1);
    await tick();
    api.token = "tokB"; // another tab signed in as B; /users/me hasn't answered
    act(() => result.current.change({ keys: { fire: ["KeyX"] }, gamepad: {} }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    window.dispatchEvent(new Event("pagehide"));
    await tick();
    expect(api.putTokens).toEqual([]);
    expect(readUnsynced("g1")).toBe("u1");
    expect(result.current.syncState).toBe("failed");
  });

  it("M1/L1: a token change passed in restarts the session; the same user's pending change uploads with the new token", async () => {
    const api = mockApi();
    const { result, rerender } = renderHook(({ t }: { t: string }) => useControlsSync("g1", ACTIONS, U1, api, t), { initialProps: { t: "tokA" } });
    await tick();
    act(() => result.current.change({ keys: { fire: ["KeyX"] }, gamepad: {} }));
    api.token = "tokA2";
    rerender({ t: "tokA2" });
    await tick();
    expect(api.putTokens).toEqual(["tokA2"]);
    expect(readUnsynced("g1")).toBeNull();
    expect(result.current.syncState).toBe("account");
  });

  it("L3: one PUT in flight; changes meanwhile are sent afterwards with the latest bindings", async () => {
    const api = mockApi();
    const first = deferred<PutControlsResponse>();
    api.putControls.mockImplementationOnce(async (_id, bindings) => {
      api.putTokens.push(api.token);
      await first.promise;
      return { bindings, updatedAt: AT };
    });
    const { result } = mount(api, U1);
    await tick();
    act(() => result.current.change({ keys: { fire: ["KeyX"] }, gamepad: {} }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(api.putControls).toHaveBeenCalledTimes(1);
    act(() => result.current.change({ keys: { fire: ["KeyY"] }, gamepad: {} }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    act(() => result.current.change({ keys: { fire: ["KeyW"] }, gamepad: {} }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    // Still only the first request: the later ones wait for it.
    expect(api.putControls).toHaveBeenCalledTimes(1);
    expect(readUnsynced("g1")).toBe("u1");
    await act(async () => {
      first.resolve({ bindings: { keys: {}, gamepad: {} }, updatedAt: AT });
      await vi.advanceTimersByTimeAsync(0);
    });
    // Exactly one follow-up, with the latest bindings.
    expect(api.putControls).toHaveBeenCalledTimes(2);
    expect(api.putControls.mock.calls[1][1]).toEqual({ keys: { fire: ["KeyW"] }, gamepad: {} });
    expect(readUnsynced("g1")).toBeNull();
  });

  it("L3: the keepalive flush on close waits for the PUT in flight, then sends the latest bindings", async () => {
    const api = mockApi();
    const first = deferred<PutControlsResponse>();
    api.putControls.mockImplementationOnce(async (_id, bindings) => {
      await first.promise;
      return { bindings, updatedAt: AT };
    });
    const { result, unmount } = mount(api, U1);
    await tick();
    act(() => result.current.change({ keys: { fire: ["KeyX"] }, gamepad: {} }));
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    act(() => result.current.change({ keys: { fire: ["KeyY"] }, gamepad: {} }));
    unmount();
    expect(api.putControls).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve({ bindings: { keys: {}, gamepad: {} }, updatedAt: AT });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.putControls).toHaveBeenCalledTimes(2);
    expect(api.putControls.mock.calls[1]).toEqual(["g1", { keys: { fire: ["KeyY"] }, gamepad: {} }, { keepalive: true }]);
    expect(readUnsynced("g1")).toBeNull();
  });

  it("sign-out before the debounce sends nothing and keeps the change unsynced", async () => {
    const api = mockApi();
    const { result, rerender, unmount } = mount(api, U1);
    await tick();
    act(() => result.current.change({ keys: { fire: ["KeyX"] }, gamepad: {} }));
    api.token = null;
    rerender({ u: null });
    unmount();
    await tick(CONTROLS_SYNC_DEBOUNCE_MS * 2);
    expect(api.putControls).not.toHaveBeenCalled();
    expect(readUnsynced("g1")).toBe("u1");
    expect(readBindings("g1").keys).toEqual({ fire: ["KeyX"] });
  });

  it("an unmount flush after a token switch sends nothing", async () => {
    const api = mockApi();
    const { result, unmount } = mount(api, U1);
    await tick();
    act(() => result.current.change({ keys: { fire: ["KeyX"] }, gamepad: {} }));
    api.token = "tokB";
    unmount();
    await tick(CONTROLS_SYNC_DEBOUNCE_MS);
    expect(api.putControls).not.toHaveBeenCalled();
    expect(readUnsynced("g1")).toBe("u1");
  });

  it("a GET answered after a token switch neither adopts nor uploads", async () => {
    writeBindings("g1", { keys: { fire: ["KeyX"] }, gamepad: {} }, ACTIONS);
    const get = deferred<ControlBindingsResponse>();
    const api = mockApi();
    api.getControls.mockReturnValueOnce(get.promise);
    mount(api, U1);
    api.token = "tokB";
    await act(async () => {
      get.resolve({ bindings: null, updatedAt: null });
      await get.promise;
    });
    await tick();
    expect(api.putControls).not.toHaveBeenCalled();
    expect(readBindings("g1").keys).toEqual({ fire: ["KeyX"] });
  });

  it("re-runs when the signed-in user changes (sign in, switch)", async () => {
    writeBindings("g1", { keys: {}, gamepad: { jump: ["B"] } }, ACTIONS);
    const api = mockApi();
    const { rerender, result } = mount(api, null);
    await tick();
    expect(api.getControls).not.toHaveBeenCalled();
    rerender({ u: U1 });
    await tick();
    expect(api.getControls).toHaveBeenCalledTimes(1);
    expect(api.putControls).toHaveBeenCalledTimes(1); // story 3: device bindings uploaded on first sign-in
    expect(result.current.syncState).toBe("account");
    api.getControls.mockResolvedValueOnce({ bindings: { keys: {}, gamepad: { jump: ["X"] } }, updatedAt: AT });
    rerender({ u: U2 });
    await tick();
    expect(api.getControls).toHaveBeenCalledTimes(2);
    expect(readBindings("g1").gamepad).toEqual({ jump: ["X"] });
    // Signing out keeps the device copy.
    rerender({ u: null });
    await tick();
    expect(result.current.syncState).toBe("device");
    expect(readBindings("g1").gamepad).toEqual({ jump: ["X"] });
  });
});

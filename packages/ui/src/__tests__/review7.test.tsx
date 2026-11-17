// Review 7 (2026-11-17) frontend fixes: M1 (a cross-tab sign-in must never send one user's control change with
// another user's token; AuthProvider forgets the old user until /users/me confirms the new token). The hook-level
// cases for M1, L1, L2 and L3 are in controlsSync.test.ts.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { ControlAction, User } from "../api/types";
import { GamePlayer } from "../components/GamePlayer";
import { useAuth } from "../context/auth";
import { controlsParkedKey, readUnsynced, resetControlsStoreForTests } from "../controls";
import { CONTROLS_SYNC_DEBOUNCE_MS, resetControlsSyncForTests } from "../controlsSync";
import { WebGameProviders } from "../WebGameApp";

const ana: User = { id: "u1", username: "ana", displayName: "Ana", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const ben: User = { ...ana, id: "u2", username: "ben", displayName: "Ben" };
const ACTIONS: ControlAction[] = [{ id: "jump", name: "Jump", keys: ["Space"], gamepad: ["A"] }];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetControlsStoreForTests();
  resetControlsSyncForTests();
});

async function flush(ms = 0) {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((r) => setTimeout(r, ms));
  });
}

function otherTabSignsIn(token: string | null) {
  act(() => {
    localStorage.setItem("webgame.token", token ?? "");
    window.dispatchEvent(new StorageEvent("storage", { key: "webgame.token", newValue: token }));
  });
}

function Who() {
  const { user, loading } = useAuth();
  return <span data-testid="who">{loading ? "loading" : (user?.username ?? "nobody")}</span>;
}

type Pending = { token: string | null; resolve: (u: User) => void; reject: (e: unknown) => void };

function setup(withPlayer = false) {
  localStorage.setItem("webgame.token", "tokA");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const pending: Pending[] = [];
  vi.spyOn(client, "me").mockImplementation(() => {
    if (client.token === "tokA") return Promise.resolve(ana);
    return new Promise<User>((resolve, reject) => pending.push({ token: client.token, resolve, reject }));
  });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "getSave").mockResolvedValue({ data: null, updatedAt: null });
  vi.spyOn(client, "recordPlay").mockResolvedValue({ plays: 1 });
  vi.spyOn(client, "getControls").mockResolvedValue({ bindings: null, updatedAt: null });
  const putTokens: (string | null)[] = [];
  const put = vi.spyOn(client, "putControls").mockImplementation(async (_id, bindings) => {
    putTokens.push(client.token);
    return { bindings, updatedAt: "2026-11-17T00:00:00Z" };
  });
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <Who />
        {withPlayer && <GamePlayer game={{ id: "g1", title: "Pixel Peaks", width: 320, height: 180, playUrl: "/play/g1", published: true, actions: ACTIONS }} />}
      </MemoryRouter>
    </WebGameProviders>,
  );
  return { client, pending, put, putTokens };
}

const who = () => screen.getByTestId("who").textContent;

describe("M1: AuthProvider and a sign-in in another tab", () => {
  it("forgets the old user at once and shows the new one only after /users/me confirms the token", async () => {
    const { pending } = setup();
    await flush();
    expect(who()).toBe("ana");
    otherTabSignsIn("tokB");
    expect(who()).toBe("loading");
    expect(pending.map((p) => p.token)).toEqual(["tokB"]);
    await act(async () => pending[0].resolve(ben));
    expect(who()).toBe("ben");
  });

  it("a non-401 /users/me failure leaves nobody signed in (never the old user)", async () => {
    const { pending } = setup();
    await flush();
    otherTabSignsIn("tokB");
    await act(async () => pending[0].reject(new Error("offline")));
    expect(who()).toBe("nobody");
  });

  it("drops the answer for a token that was replaced meanwhile", async () => {
    const { pending } = setup();
    await flush();
    otherTabSignsIn("tokB");
    otherTabSignsIn("tokC");
    await act(async () => pending[0].resolve(ben)); // tokB's answer arrives late
    expect(who()).toBe("loading");
    await act(async () => pending[1].resolve({ ...ben, id: "u3", username: "cy" }));
    expect(who()).toBe("cy");
  });

  it("signing out in another tab clears the user", async () => {
    setup();
    await flush();
    otherTabSignsIn(null);
    expect(who()).toBe("nobody");
  });
});

describe("M1: GamePlayer during a cross-tab account switch", () => {
  it("a pending remap is never uploaded with the other account's token; it stays with its owner", async () => {
    vi.useFakeTimers();
    const { pending, put, putTokens } = setup(true);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Controls" }));
    expect(screen.getByText("Saved to your account")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear Space from Jump" }));
    expect(readUnsynced("g1")).toBe("u1");
    // Another tab signs in as Ben before the debounce fires; /users/me is slow.
    otherTabSignsIn("tokB");
    await flush(CONTROLS_SYNC_DEBOUNCE_MS * 3);
    expect(put).not.toHaveBeenCalled();
    expect(screen.getByText("Saved on this device")).toBeTruthy();
    // A change in this window is a signed-out change: it stays on the device and is never uploaded as Ana's.
    fireEvent.click(screen.getByRole("button", { name: "Clear gamepad A from Jump" }));
    await flush(CONTROLS_SYNC_DEBOUNCE_MS * 3);
    expect(put).not.toHaveBeenCalled();
    expect(readUnsynced("g1")).toBeNull();
    // Ben is confirmed: the device copy is not marked as anyone's change, so nothing is sent as Ana with Ben's token.
    await act(async () => pending[0].resolve(ben));
    await flush();
    expect(putTokens.every((t) => t === "tokB")).toBe(true);
    expect(localStorage.getItem(controlsParkedKey("g1", "u2"))).toBeNull();
  });

  it("Ana's pending remap is parked when Ben is confirmed, and goes to Ana's account when she is back", async () => {
    vi.useFakeTimers();
    const { pending, put, putTokens, client } = setup(true);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Controls" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear Space from Jump" }));
    otherTabSignsIn("tokB");
    await act(async () => pending[0].resolve(ben));
    await flush(CONTROLS_SYNC_DEBOUNCE_MS * 3);
    expect(put).not.toHaveBeenCalled();
    expect(localStorage.getItem(controlsParkedKey("g1", "u1"))).not.toBeNull();
    expect(client.getControls).toHaveBeenCalledTimes(2); // Ana's session, then Ben's own copy
    otherTabSignsIn("tokA");
    await flush();
    expect(put).toHaveBeenCalledTimes(1);
    expect(putTokens).toEqual(["tokA"]);
    expect(put.mock.calls[0][1]).toEqual({ keys: { jump: [] }, gamepad: {} });
    expect(readUnsynced("g1")).toBeNull();
  });
});

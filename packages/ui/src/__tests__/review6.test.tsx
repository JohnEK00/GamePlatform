// Review 6 (2026-11-16) frontend fixes: M2 (timing-adjustable Undo, inline collection Undo row, confirm for
// unavailable games), L1 (label in name, no pressed + changing label), L3 (unavailable-game mutes in Settings).
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Collection, NotificationMute, NotificationMuteList, User } from "../api/types";
import { CollectionItemRow } from "../components/CollectionItemRow";
import { MuteGameButton } from "../components/MuteGameButton";
import { NotificationItem } from "../components/NotificationItem";
import { TOAST_ACTION_MIN_MS, ToastProvider, toastDuration, useToast, type ToastInput } from "../context/toast";
import { muteActionFor } from "../notifications";
import { CollectionPage } from "../pages/CollectionPage";
import { SettingsPage } from "../pages/SettingsPage";
import { WebGameProviders } from "../WebGameApp";
import { anaUser, collection, item } from "./collectionFixtures";
import { me, notif } from "./notifFixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** WCAG 2.5.3: the accessible name contains (here: starts with) the visible text. */
function expectLabelInName(el: HTMLElement) {
  // Decorative glyphs ("▶ Play") are not words a speech-input user would say.
  const visible = (el.textContent ?? "").replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  const name = el.getAttribute("aria-label") ?? visible;
  expect(name.toLowerCase().startsWith(visible.toLowerCase())).toBe(true);
}

// ---------------------------------------------------------------- M2: toasts
describe("review 6 M2: toasts are timing-adjustable", () => {
  function Trigger({ t }: { t: ToastInput }) {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast.show(t)}>
        show
      </button>
    );
  }
  const renderToasts = (t: ToastInput) =>
    render(
      <ToastProvider>
        <Trigger t={t} />
      </ToastProvider>,
    );
  const region = () => screen.getByRole("region", { name: "Status messages" });

  it("toasts with an action last at least 10 s; others keep their defaults", () => {
    expect(TOAST_ACTION_MIN_MS).toBeGreaterThanOrEqual(10_000);
    expect(toastDuration({ title: "x" })).toBe(4500);
    expect(toastDuration({ title: "x", kind: "error" })).toBe(7000);
    expect(toastDuration({ title: "x", action: { label: "Undo", onClick: () => {} } })).toBe(TOAST_ACTION_MIN_MS);
    expect(toastDuration({ title: "x", duration: 4000, action: { label: "Undo", onClick: () => {} } })).toBe(TOAST_ACTION_MIN_MS);
    expect(toastDuration({ title: "x", duration: 20_000, action: { label: "Undo", onClick: () => {} } })).toBe(20_000);
  });

  it("an Undo toast is announced, survives 5 s, and closes after its time without interaction", () => {
    vi.useFakeTimers();
    renderToasts({ kind: "success", title: "Muted", action: { label: "Undo", onClick: () => {} } });
    fireEvent.click(screen.getByText("show"));
    const status = within(region()).getByRole("status");
    expect(status.textContent).toContain("Muted");
    expect(region().getAttribute("aria-live")).toBe("polite");
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(TOAST_ACTION_MIN_MS - 5000));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("never closes while focus is inside the region; resumes after focus leaves", () => {
    vi.useFakeTimers();
    renderToasts({ kind: "success", title: "Muted", action: { label: "Undo", onClick: () => {} } });
    const opener = screen.getByText("show");
    opener.focus();
    fireEvent.click(opener);
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => undo.focus());
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByRole("button", { name: "Undo" })).toBe(undo);
    expect(region().hasAttribute("data-paused")).toBe(true);
    act(() => opener.focus());
    expect(region().hasAttribute("data-paused")).toBe(false);
    act(() => vi.advanceTimersByTime(TOAST_ACTION_MIN_MS + 1000));
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("never closes while hovered; resumes after the pointer leaves", () => {
    vi.useFakeTimers();
    renderToasts({ title: "Saved" });
    fireEvent.click(screen.getByText("show"));
    fireEvent.mouseEnter(region());
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Saved")).toBeTruthy();
    fireEvent.mouseLeave(region());
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("Undo from the keyboard closes the toast and returns focus to where it came from", () => {
    const onUndo = vi.fn();
    renderToasts({ kind: "success", title: "Muted", action: { label: "Undo", onClick: onUndo } });
    const opener = screen.getByText("show");
    opener.focus();
    fireEvent.click(opener);
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => undo.focus());
    act(() => fireEvent.click(undo));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(region().hasAttribute("data-paused")).toBe(false);
  });
});

// ---------------------------------------------------------------- M2: mute Undo toast
describe("review 6 M2: mute Undo toasts", () => {
  it("the game-mute Undo toast stays past 5 s and while focused", async () => {
    vi.useFakeTimers();
    localStorage.setItem("webgame.token", "tok");
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "me").mockResolvedValue(me);
    vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
    vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 1, latestAt: null, pollAfterSecs: 600 });
    vi.spyOn(client, "muteGame").mockResolvedValue({ muted: true, unread: 0 });
    const unmute = vi.spyOn(client, "unmuteGame").mockResolvedValue({ muted: false, unread: 0 });
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter>
          <MuteGameButton gameId="g1" gameTitle="Space Dodge" muted={false} />
        </MemoryRouter>
      </WebGameProviders>,
    );
    await act(async () => {});
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Mute notifications" })));
    expect(screen.getByText("Muted notifications for Space Dodge")).toBeTruthy();
    await act(async () => vi.advanceTimersByTime(6000));
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => undo.focus());
    await act(async () => vi.advanceTimersByTime(60_000));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Undo" })));
    expect(unmute).toHaveBeenCalledWith("g1");
  });
});

// ---------------------------------------------------------------- M2: collection remove
async function setupCollection(coll: Collection, user: User = anaUser) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(user);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 600 });
  vi.spyOn(client, "getCollection").mockImplementation(async () => structuredClone(coll));
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/c/c1"]}>
        <Routes>
          <Route path="/c/:id" element={<CollectionPage />} />
        </Routes>
      </MemoryRouter>
    </WebGameProviders>,
  );
  for (let i = 0; i < 4; i++) await act(async () => {});
  return client;
}

const owned = () =>
  collection({
    isOwner: true,
    canDelete: true,
    items: [item("g1", "Space Dodge", "Best soundtrack"), item("g2", "Brick Breaker"), item("g3", "Pixel Peaks"), item("g4", null, "gone")],
  });
const btn = (name: string) => screen.getByRole("button", { name });
const queryBtn = (name: string) => screen.queryByRole("button", { name });
const rows = () => within(screen.getByRole("list", { name: "Games in this collection" })).getAllByRole("listitem");

describe("review 6 M2: collection remove", () => {
  it("the inline Undo row has no time limit and no toast Undo competes with it", async () => {
    const client = await setupCollection(owned());
    vi.spyOn(client, "deleteCollectionGame").mockResolvedValue({ removed: true, gameCount: 2, updatedAt: "x" });
    await act(async () => fireEvent.click(btn("Remove Space Dodge from collection")));
    expect(document.activeElement).toBe(btn("Undo remove: Space Dodge"));
    expectLabelInName(btn("Undo remove: Space Dodge"));
    vi.useFakeTimers();
    act(() => vi.advanceTimersByTime(10 * 60_000));
    vi.useRealTimers();
    expect(btn("Undo remove: Space Dodge")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Status messages" })).queryByRole("button", { name: "Undo" })).toBeNull();
    // The removal is announced in the page's live region.
    expect(document.querySelector(".pf-collection-page > p[role=status]")!.textContent).toBe("Removed Space Dodge");
  });

  it("several removals keep their places; Undo restores the original order", async () => {
    const client = await setupCollection(owned());
    vi.spyOn(client, "deleteCollectionGame").mockResolvedValue({ removed: true, gameCount: 2, updatedAt: "x" });
    await act(async () => fireEvent.click(btn("Remove Brick Breaker from collection")));
    await act(async () => fireEvent.click(btn("Remove Space Dodge from collection")));
    expect(rows().map((r) => r.dataset.removedId ?? r.dataset.gameId)).toEqual(["g1", "g2", "g3", "g4"]);
    expect(rows()[0].className).toContain("pf-collection-removed");
    expect(rows()[1].className).toContain("pf-collection-removed");
    // The item rows keep their 1-based positions among the remaining games.
    expect(rows()[2].querySelector(".pf-collection-item__pos")!.textContent).toBe("1");

    const put = vi.spyOn(client, "putCollectionGame").mockResolvedValue({ added: true, item: item("g2", "Brick Breaker"), gameCount: 3, updatedAt: "y" });
    const order = vi.spyOn(client, "reorderCollection").mockImplementation(async (_id, ids) => ({
      ...owned(),
      items: ids.map((id) => owned().items.find((i) => i.gameId === id)!),
    }));
    await act(async () => fireEvent.click(btn("Undo remove: Brick Breaker")));
    await act(async () => {});
    expect(put).toHaveBeenCalledWith("c1", "g2", { note: "" });
    expect(order).toHaveBeenCalledWith("c1", ["g2", "g3", "g4"]);
    expect(rows().map((r) => r.dataset.removedId ?? r.dataset.gameId)).toEqual(["g1", "g2", "g3", "g4"]);
    expect(document.activeElement).toBe(btn("Remove Brick Breaker from collection"));
  });

  it("a failed Undo keeps the row (and focus) and shows the error", async () => {
    const client = await setupCollection(owned());
    vi.spyOn(client, "deleteCollectionGame").mockResolvedValue({ removed: true, gameCount: 2, updatedAt: "x" });
    await act(async () => fireEvent.click(btn("Remove Pixel Peaks from collection")));
    vi.spyOn(client, "putCollectionGame").mockRejectedValue(new ApiError("not_found", "Game not found", 404));
    const undo = btn("Undo remove: Pixel Peaks");
    await act(async () => fireEvent.click(undo));
    expect(screen.getByText("Couldn't restore Pixel Peaks")).toBeTruthy();
    expect(btn("Undo remove: Pixel Peaks")).toBe(undo);
    expect(document.activeElement).toBe(undo);
  });

  it("an unavailable game asks for confirmation (focus managed); Cancel keeps it", async () => {
    const client = await setupCollection(owned());
    const del = vi.spyOn(client, "deleteCollectionGame").mockResolvedValue({ removed: true, gameCount: 3, updatedAt: "x" });
    const remove = btn("Remove Unavailable game from collection");
    remove.focus();
    await act(async () => fireEvent.click(remove));
    const dialog = screen.getByRole("dialog", { name: "Remove this unavailable game?" });
    expect(within(dialog).getByText(/won't be able to add it back/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(del).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(del).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(btn("Remove Unavailable game from collection"));
  });

  it("an unavailable game: confirming removes it with no Undo; focus goes to the neighbour", async () => {
    const client = await setupCollection(owned());
    const del = vi.spyOn(client, "deleteCollectionGame").mockResolvedValue({ removed: true, gameCount: 3, updatedAt: "x" });
    await act(async () => fireEvent.click(btn("Remove Unavailable game from collection")));
    const dialog = screen.getByRole("dialog", { name: "Remove this unavailable game?" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Remove" })));
    expect(del).toHaveBeenCalledWith("c1", "g4");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(queryBtn("Remove Unavailable game from collection")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(rows()).toHaveLength(3);
    expect(document.activeElement).toBe(btn("Remove Pixel Peaks from collection"));
    expect(document.querySelector(".pf-collection-page > p[role=status]")!.textContent).toBe("Removed Unavailable game");
  });
});

// ---------------------------------------------------------------- L1: label in name
function renderWithProviders(ui: ReactNode) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockRejectedValue(new ApiError("unauthorized", "no", 401));
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 600 });
  return render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      {ui}
    </WebGameProviders>,
  );
}

describe("review 6 L1: accessible names contain the visible text", () => {
  it("collection row controls", () => {
    renderWithProviders(
      <MemoryRouter>
        <ol>
          <CollectionItemRow item={item("g1", "Space Dodge")} index={1} count={3} isOwner onMove={() => {}} onSaveNote={async () => {}} onRemove={() => {}} />
        </ol>
      </MemoryRouter>,
    );
    expect(btn("Move up: Space Dodge").textContent).toBe("Move up");
    expect(btn("Move down: Space Dodge").textContent).toBe("Move down");
    for (const b of screen.getAllByRole("button")) expectLabelInName(b);
    expectLabelInName(screen.getByRole("link", { name: "Play Space Dodge" }));
  });

  it("notification item mute actions", () => {
    const game = { id: "g7", title: "Space Dodge", thumbnailUrl: null };
    const items = [notif({ id: "1", kind: "comment", game }), notif({ id: "2", kind: "reply", game, threadId: "c9" })];
    renderWithProviders(
      <MemoryRouter>
        <ul>
          {items.map((n) => (
            <NotificationItem key={n.id} item={n} variant="page" showMute onMute={() => {}} />
          ))}
        </ul>
      </MemoryRouter>,
    );
    const game1 = btn("Mute game: Space Dodge");
    const thread = btn("Mute thread on Space Dodge");
    expect(game1.textContent).toBe("Mute game");
    expect(thread.textContent).toBe("Mute thread");
    expectLabelInName(game1);
    expectLabelInName(thread);
    expect(muteActionFor(items[0])!.label).toBe("Mute game: Space Dodge");
  });

  it("the game mute toggle: changing label = visible text, no aria-pressed", async () => {
    localStorage.setItem("webgame.token", "tok");
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "me").mockResolvedValue(me);
    vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
    vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 1, latestAt: null, pollAfterSecs: 600 });
    vi.spyOn(client, "muteGame").mockResolvedValue({ muted: true, unread: 0 });
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter>
          <MuteGameButton gameId="g1" gameTitle="Space Dodge" muted={false} />
        </MemoryRouter>
      </WebGameProviders>,
    );
    await act(async () => {});
    await act(async () => {});
    const b = btn("Mute notifications");
    expect(b.hasAttribute("aria-pressed")).toBe(false);
    expectLabelInName(b);
    await act(async () => fireEvent.click(b));
    const on = btn("Unmute notifications");
    expect(on.hasAttribute("aria-pressed")).toBe(false);
    expect(on.className).toContain("is-on");
    expectLabelInName(on);
  });
});

// ---------------------------------------------------------------- L3: unavailable-game mutes
describe("review 6 L3: mutes of games the user can no longer see", () => {
  async function setupSettings(mutes: NotificationMuteList) {
    localStorage.setItem("webgame.token", "tok");
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "me").mockResolvedValue(me);
    vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
    vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 600 });
    vi.spyOn(client, "getNotificationSettings").mockResolvedValue({ comments: true, replies: true, hearts: true, follows: true, newGames: true, pins: true });
    vi.spyOn(client, "listNotificationMutes").mockResolvedValue(mutes);
    const unmuteGame = vi.spyOn(client, "unmuteGame").mockResolvedValue({ muted: false, unread: 0 });
    const unmuteThread = vi.spyOn(client, "unmuteThread").mockResolvedValue({ muted: false, unread: 0 });
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter initialEntries={["/settings"]}>
          <SettingsPage />
        </MemoryRouter>
      </WebGameProviders>,
    );
    for (let i = 0; i < 4; i++) await act(async () => {});
    return { unmuteGame, unmuteThread };
  }

  const hiddenGame = { target: "game", game: null, threadId: null, excerpt: null, path: "/games/gx", createdAt: "2026-11-10T10:00:00.000Z" } as unknown as NotificationMute;
  const hiddenThread = {
    target: "thread",
    game: { id: "gy", title: "", thumbnailUrl: null, available: false },
    threadId: "c42",
    excerpt: null,
    path: "/games/gy?comment=c42",
    createdAt: "2026-11-11T10:00:00.000Z",
  } as unknown as NotificationMute;
  const visible: NotificationMute = {
    target: "game",
    game: { id: "g1", title: "Space Dodge", thumbnailUrl: null },
    threadId: null,
    excerpt: null,
    path: "/games/g1",
    createdAt: "2026-11-12T10:00:00.000Z",
  };

  it("lists them as 'Unavailable game' rows without links, each with Unmute", async () => {
    const { unmuteGame, unmuteThread } = await setupSettings({ items: [visible, hiddenThread, hiddenGame], total: 3 });
    const section = await screen.findByRole("region", { name: "Muted" });
    const list = within(section).getAllByRole("listitem");
    expect(list).toHaveLength(3);
    expect(within(list[0]).getByRole("link", { name: "Space Dodge" })).toBeTruthy();
    for (const row of [list[1], list[2]]) {
      expect(row.textContent).toContain("Unavailable game");
      expect(within(row).queryByRole("link")).toBeNull();
    }
    const unmuteThreadBtn = within(list[1]).getByRole("button", { name: "Unmute thread on Unavailable game" });
    const unmuteGameBtn = within(list[2]).getByRole("button", { name: "Unmute Unavailable game" });
    expectLabelInName(unmuteThreadBtn);
    expectLabelInName(unmuteGameBtn);

    await act(async () => fireEvent.click(unmuteGameBtn));
    expect(unmuteGame).toHaveBeenCalledWith("gx");
    expect(screen.getByText("Unmuted the unavailable game.")).toBeTruthy();
    await act(async () => fireEvent.click(within(section).getByRole("button", { name: "Unmute thread on Unavailable game" })));
    expect(unmuteThread).toHaveBeenCalledWith("c42");
    expect(within(section).getAllByRole("listitem")).toHaveLength(1);
  });
});

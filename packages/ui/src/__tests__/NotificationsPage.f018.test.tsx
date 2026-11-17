import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Notification, NotificationPage } from "../api/types";
import { NotificationBell } from "../components/NotificationBell";
import { useNotifications } from "../context/notifications";
import { NotificationsPage } from "../pages/NotificationsPage";
import { WebGameProviders } from "../WebGameApp";
import { me, noah, notif } from "./notifFixtures";

const space = { id: "g7", title: "Space Dodge", thumbnailUrl: null };

function Unread() {
  return <output data-testid="unread">{useNotifications().unread}</output>;
}

async function setup(pages: NotificationPage[], opts: { muteFails?: boolean; bell?: boolean } = {}) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 5, latestAt: "2026-11-15T11:00:00.000Z", pollAfterSecs: 60 });
  let i = 0;
  const list = vi.spyOn(client, "listNotifications").mockImplementation(async () => pages[Math.min(i++, pages.length - 1)]);
  const fail = () => Promise.reject(new ApiError("not_found", "Game not found", 404));
  const muteGame = vi.spyOn(client, "muteGame").mockImplementation(async () => (opts.muteFails ? fail() : { muted: true, unread: 1 }));
  const muteThread = vi.spyOn(client, "muteThread").mockResolvedValue({ muted: true, unread: 2 });
  const unmuteThread = vi.spyOn(client, "unmuteThread").mockResolvedValue({ muted: false, unread: 2 });
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/notifications"]}>
        {opts.bell && <NotificationBell />}
        <NotificationsPage />
        <Unread />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  return { list, muteGame, muteThread, unmuteThread };
}

const page = (items: Notification[], unread = 5): NotificationPage => ({ items, nextCursor: null, unread });
const item = (id: string) => document.querySelector(`.pf-notif-list--page li[data-notif-id="${id}"]`) as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotificationsPage: item mute (F018)", () => {
  const items = [
    notif({ id: "1", kind: "comment", game: space, threadId: null }),
    notif({ id: "2", kind: "reply", game: space, threadId: "t1", ownsThread: true }),
    notif({ id: "3", kind: "heart", game: space, threadId: "t2" }),
    notif({ id: "4", kind: "pinned", game: space, threadId: "t3" }),
    notif({ id: "5", kind: "gamePublished", game: space, threadId: null, commentId: null }),
    notif({ id: "6", kind: "follow", game: null, commentId: null, threadId: null, actors: [noah] }),
  ];

  it("labels the action per kind; follows get none; the button is outside the link", async () => {
    await setup([page(items)]);
    await waitFor(() => expect(item("1")).toBeTruthy());
    const btn = (id: string) => within(item(id)).queryByRole("button");
    expect(btn("1")!.textContent).toBe("Mute game");
    expect(btn("1")!.getAttribute("aria-label")).toBe("Mute game: Space Dodge");
    for (const id of ["2", "3", "4"]) {
      expect(btn(id)!.textContent).toBe("Mute thread");
      expect(btn(id)!.getAttribute("aria-label")).toBe("Mute thread on Space Dodge");
    }
    expect(btn("5")!.getAttribute("aria-label")).toBe("Mute game: Space Dodge");
    expect(btn("6")).toBeNull();
    expect(btn("1")!.closest("a")).toBeNull();
    // The pinned summary renders with the pin glyph.
    expect(item("4").textContent).toContain("Mia pinned your comment on Space Dodge");
    expect(item("4").querySelector(".pf-notif__kind--pinned")).not.toBeNull();
  });

  it("older servers (no threadId on items) get no mute buttons", async () => {
    const old = notif({ id: "1", kind: "comment", game: space });
    delete (old as Partial<Notification>).threadId;
    await setup([page([old])]);
    await waitFor(() => expect(item("1")).toBeTruthy());
    expect(within(item("1")).queryByRole("button")).toBeNull();
  });

  it("mutes a thread, toasts with Undo, adopts the unread count and refetches the first page", async () => {
    const after = page([{ ...items[1], read: true }], 2);
    const { list, muteThread, unmuteThread } = await setup([page(items), after]);
    await waitFor(() => expect(item("2")).toBeTruthy());
    expect(list).toHaveBeenCalledTimes(1);
    fireEvent.click(within(item("2")).getByRole("button", { name: "Mute thread on Space Dodge" }));
    expect(muteThread).toHaveBeenCalledWith("t1");
    expect(await screen.findByText("Thread muted. Replies, hearts and pins in it won't notify you.")).toBeTruthy();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenLastCalledWith({ limit: 20, unread: undefined });
    await waitFor(() => expect(item("1")).toBeNull());
    expect(item("2").className).not.toContain("pf-notif--unread");
    expect(screen.getByTestId("unread").textContent).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(unmuteThread).toHaveBeenCalledWith("t1");
    expect(await screen.findByText("Thread unmuted.")).toBeTruthy();
  });

  it("mutes a game and shows the game toast", async () => {
    const { muteGame } = await setup([page(items), page(items.map((n) => ({ ...n, read: true })), 1)]);
    await waitFor(() => expect(item("1")).toBeTruthy());
    fireEvent.click(within(item("1")).getByRole("button", { name: "Mute game: Space Dodge" }));
    expect(muteGame).toHaveBeenCalledWith("g7");
    expect(await screen.findByText("Muted notifications for Space Dodge")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("1"));
  });

  it("shows the server error and does not refetch on failure", async () => {
    const { list } = await setup([page(items)], { muteFails: true });
    await waitFor(() => expect(item("1")).toBeTruthy());
    fireEvent.click(within(item("1")).getByRole("button", { name: "Mute game: Space Dodge" }));
    expect(await screen.findByText("Game not found")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("the bell panel stays compact (no mute buttons)", async () => {
    await setup([page(items)], { bell: true });
    await waitFor(() => expect(item("1")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
    await waitFor(() => expect(document.querySelector(".pf-notif--panel")).not.toBeNull());
    expect(document.querySelector(".pf-notif--panel .pf-notif__mute")).toBeNull();
  });
});

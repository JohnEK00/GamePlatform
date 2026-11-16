import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { NotificationListQuery, NotificationPage } from "../api/types";
import { NotificationsPage } from "../pages/NotificationsPage";
import { WebGameProviders } from "../WebGameApp";
import { ava, me, mia, noah, notif } from "./notifFixtures";

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

async function setup(listImpl: (q: NotificationListQuery) => Promise<NotificationPage>, url = "/notifications") {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 2, latestAt: "2026-11-15T11:00:00.000Z", pollAfterSecs: 60 });
  const list = vi.spyOn(client, "listNotifications").mockImplementation(async (q) => listImpl(q ?? {}));
  const mark = vi.spyOn(client, "markNotificationsRead").mockResolvedValue({ unread: 0 });
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[url]}>
        <NotificationsPage />
        <Where />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  return { list, mark };
}

const rows = () => Array.from(document.querySelectorAll(".pf-notif-list .pf-notif__text")).map((e) => e.textContent?.replace("Unread: ", ""));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotificationsPage", () => {
  it("All / Unread tabs live in the query string", async () => {
    const { list } = await setup(async (q) => ({
      items: q.unread ? [notif({ id: "2", actors: [noah] })] : [notif({ id: "2", actors: [noah] }), notif({ id: "1", read: true })],
      nextCursor: null,
      unread: 1,
    }));
    await waitFor(() => expect(rows()).toEqual(["Noah commented on Pixel Peaks", "Mia commented on Pixel Peaks"]));
    expect(list).toHaveBeenLastCalledWith({ limit: 20, unread: undefined });
    expect(screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Unread" }));
    expect(screen.getByTestId("where").textContent).toBe("/notifications?filter=unread");
    await waitFor(() => expect(rows()).toEqual(["Noah commented on Pixel Peaks"]));
    expect(list).toHaveBeenLastCalledWith({ limit: 20, unread: true });
    expect(screen.getByRole("tab", { name: "Unread" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("link", { name: "Notification settings" }).getAttribute("href")).toBe("/settings#notifications");
  });

  it("opens on ?filter=unread", async () => {
    const { list } = await setup(async () => ({ items: [], nextCursor: null, unread: 0 }), "/notifications?filter=unread");
    await screen.findByText("No unread notifications.");
    expect(list).toHaveBeenCalledWith({ limit: 20, unread: true });
    const all = screen.getByRole("link", { name: "Show all notifications" });
    expect(all.getAttribute("href")).toBe("/notifications");
  });

  it("Load more passes the cursor and dedupes by id, keeping the newest copy", async () => {
    const { list } = await setup(async (q) =>
      q.cursor === "p2"
        ? {
            items: [
              notif({ id: "3", actors: [ava], kind: "heart", updatedAt: "2026-11-15T11:00:00.000Z" }), // moved up: newer copy
              notif({ id: "1", actors: [mia], kind: "follow", game: null, updatedAt: "2026-11-15T08:00:00.000Z" }),
            ],
            nextCursor: null,
            unread: 2,
          }
        : {
            items: [
              notif({ id: "3", actors: [ava], updatedAt: "2026-11-15T10:00:00.000Z" }),
              notif({ id: "2", actors: [noah], updatedAt: "2026-11-15T09:00:00.000Z" }),
            ],
            nextCursor: "p2",
            unread: 2,
          },
    );
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(list).toHaveBeenLastCalledWith({ cursor: "p2", limit: 20, unread: undefined });
    expect(rows()).toEqual(["Ava hearted your comment on Pixel Peaks", "Noah commented on Pixel Peaks", "Mia followed you"]);
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("empty All state", async () => {
    await setup(async () => ({ items: [], nextCursor: null, unread: 0 }));
    await screen.findByText("You're all caught up.");
    expect(screen.getByText(/Comments on your games, replies, hearts and new followers show up here/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mark all as read/ })).toBeNull();
  });

  it("clicking marks read and navigates; Mark all uses the newest updatedAt", async () => {
    const { mark } = await setup(async () => ({
      items: [notif({ id: "5", updatedAt: "2026-11-15T11:00:00.000Z" }), notif({ id: "4", updatedAt: "2026-11-15T10:00:00.000Z", path: "/games/g1?comment=c4" })],
      nextCursor: null,
      unread: 2,
    }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Mark all as read/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Mark all as read/ })).toBeNull());
    expect(mark).toHaveBeenCalledWith({ upTo: "2026-11-15T11:00:00.000Z" });
    expect(document.querySelectorAll(".pf-notif--unread")).toHaveLength(0);
  });

  it("clicking an unread item marks it read with its updatedAt", async () => {
    const { mark } = await setup(async () => ({
      items: [notif({ id: "4", updatedAt: "2026-11-15T10:00:00.000Z", path: "/games/g1?comment=c4" })],
      nextCursor: null,
      unread: 1,
    }));
    const link = await screen.findByRole("link", { name: /commented on Pixel Peaks/ });
    fireEvent.click(link);
    expect(mark).toHaveBeenCalledWith({ ids: ["4"], upTo: "2026-11-15T10:00:00.000Z" });
    expect(screen.getByTestId("where").textContent).toBe("/games/g1?comment=c4");
  });
});

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Notification, NotificationPage } from "../api/types";
import { Header } from "../components/Layout";
import { NotificationBell } from "../components/NotificationBell";
import { WebGameProviders } from "../WebGameApp";
import { me, noah, notif } from "./notifFixtures";

function Where() {
  const l = useLocation();
  return <output data-testid="where">{l.pathname + l.search}</output>;
}

const items: Notification[] = [
  notif({ id: "11", kind: "reply", actors: [noah], ownsThread: true, excerpt: "Press Esc twice", updatedAt: "2026-11-15T11:00:00.000Z", path: "/games/g1?comment=c7" }),
  notif({ id: "10", read: true, kind: "follow", game: null, commentId: null, updatedAt: "2026-11-15T10:00:00.000Z", path: "/u/bob/followers" }),
];

async function setup(opts: { unread?: number; list?: () => Promise<NotificationPage>; countError?: Error; header?: boolean } = {}) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  const count = vi.spyOn(client, "unreadNotificationCount").mockImplementation(async () => {
    if (opts.countError) throw opts.countError;
    return { unread: opts.unread ?? 1, latestAt: "2026-11-15T11:00:00.000Z", pollAfterSecs: 60 };
  });
  const list = vi
    .spyOn(client, "listNotifications")
    .mockImplementation(opts.list ?? (async () => ({ items: items.map((n) => ({ ...n })), nextCursor: null, unread: opts.unread ?? 1 })));
  const mark = vi.spyOn(client, "markNotificationsRead").mockResolvedValue({ unread: 0 });
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/"]}>
        {opts.header ? <Header /> : <NotificationBell />}
        <button type="button">Outside</button>
        <Where />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  return { client, count, list, mark };
}

const bell = () => screen.getByRole("button", { name: /^Notifications/ });

const panelEl = () => document.getElementById("pf-notif-panel");

async function openPanel() {
  fireEvent.click(bell());
  // (The toast region is also called "Notifications"; find the panel by its id and check its role/name.)
  const panel = await waitFor(() => {
    const el = panelEl();
    if (!el) throw new Error("panel not open");
    return el;
  });
  expect(screen.getAllByRole("region", { name: "Notifications" })).toContain(panel);
  return panel;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NotificationBell", () => {
  it("accessible name for 0 / n / 100 with an aria-hidden badge", async () => {
    await setup({ unread: 0 });
    expect(bell()).toHaveProperty("textContent", "");
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
    expect(document.querySelector(".pf-bell__badge")).toBeNull();
  });

  it("accessible name with n unread", async () => {
    await setup({ unread: 3 });
    expect(bell().getAttribute("aria-label")).toBe("Notifications, 3 unread");
    const badge = document.querySelector(".pf-bell__badge")!;
    expect(badge.textContent).toBe("3");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
  });

  it("accessible name at the 100 cap shows 99+", async () => {
    await setup({ unread: 100 });
    expect(bell().getAttribute("aria-label")).toBe("Notifications, more than 99 unread");
    expect(document.querySelector(".pf-bell__badge")!.textContent).toBe("99+");
  });

  it("is hidden when the server has no notifications API (404)", async () => {
    await setup({ countError: new ApiError("not_found", "nope", 404) });
    expect(screen.queryByRole("button", { name: /^Notifications/ })).toBeNull();
  });

  it("sits in the header outside the collapsible nav", async () => {
    await setup({ header: true });
    const b = bell();
    expect(b.closest("#pf-mainnav")).toBeNull();
    expect(b.closest(".pf-header__inner")).not.toBeNull();
  });

  it("aria-expanded / aria-controls; opening fetches 10 and focuses the heading", async () => {
    const { list } = await setup();
    expect(bell().getAttribute("aria-expanded")).toBe("false");
    expect(bell().getAttribute("aria-controls")).toBe("pf-notif-panel");
    const panel = await openPanel();
    expect(panel.id).toBe("pf-notif-panel");
    expect(bell().getAttribute("aria-expanded")).toBe("true");
    expect(list).toHaveBeenCalledWith({ limit: 10 });
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Notifications" }));
    await within(panel).findByText("Press Esc twice", { exact: false });
  });

  it("Escape closes and returns focus to the bell", async () => {
    await setup();
    const panel = await openPanel();
    await within(panel).findAllByRole("link");
    fireEvent.keyDown(within(panel).getAllByRole("link")[0], { key: "Escape" });
    expect(panelEl()).toBeNull();
    expect(document.activeElement).toBe(bell());
    expect(bell().getAttribute("aria-expanded")).toBe("false");
  });

  it("an outside click closes without moving focus", async () => {
    await setup();
    await openPanel();
    const outside = screen.getByRole("button", { name: "Outside" });
    fireEvent.mouseDown(outside);
    expect(panelEl()).toBeNull();
    expect(document.activeElement).not.toBe(bell());
  });

  it("Tab out of the panel closes it", async () => {
    await setup();
    const panel = await openPanel();
    const settings = within(panel).getByRole("link", { name: "Settings" });
    act(() => settings.focus());
    const outside = screen.getByRole("button", { name: "Outside" });
    fireEvent.blur(settings, { relatedTarget: outside });
    expect(panelEl()).toBeNull();
  });

  it("unread items carry the hidden 'Unread: ' prefix and a dot; read ones don't", async () => {
    await setup();
    const panel = await openPanel();
    const links = await within(panel).findAllByRole("link", { name: /replied|followed/ });
    expect(links[0].textContent).toContain("Unread: ");
    expect(links[0].querySelector(".pf-sr-only")!.textContent).toBe("Unread: ");
    expect(links[0].querySelector(".pf-notif__dot")).not.toBeNull();
    expect(links[0].closest("li")!.className).toContain("pf-notif--unread");
    expect(links[1].textContent).not.toContain("Unread:");
    expect(links[1].querySelector(".pf-notif__dot")).toBeNull();
    expect(links[0].getAttribute("href")).toBe("/games/g1?comment=c7");
    expect(links[0].querySelector("strong")!.textContent).toBe("Noah");
    expect(links[0].querySelector("time")!.getAttribute("datetime")).toBe("2026-11-15T11:00:00.000Z");
  });

  it("activating an item marks it read with upTo = its updatedAt, lowers the badge, closes and navigates", async () => {
    const { mark } = await setup({ unread: 2 });
    const panel = await openPanel();
    const link = await within(panel).findByRole("link", { name: /replied to your comment/ });
    fireEvent.click(link);
    expect(mark).toHaveBeenCalledWith({ ids: ["11"], upTo: "2026-11-15T11:00:00.000Z" });
    expect(screen.getByTestId("where").textContent).toBe("/games/g1?comment=c7");
    expect(panelEl()).toBeNull();
    await waitFor(() => expect(bell().getAttribute("aria-label")).toBe("Notifications"));
  });

  it("Mark all as read sends the newest listed updatedAt and keeps focus on the heading", async () => {
    const { mark } = await setup({ unread: 1 });
    const panel = await openPanel();
    const btn = await within(panel).findByRole("button", { name: "Mark all as read" });
    fireEvent.click(btn);
    await waitFor(() => expect(within(panel).queryByRole("button", { name: "Mark all as read" })).toBeNull());
    expect(mark).toHaveBeenCalledWith({ upTo: "2026-11-15T11:00:00.000Z" });
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: "Notifications" }));
    expect(within(panel).queryByText("Unread:", { exact: false })).toBeNull();
    expect(document.querySelector(".pf-notif-live")!.textContent).toBe("All notifications marked as read");
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
  });

  it("load error shows an alert with Retry", async () => {
    let fail = true;
    const { list } = await setup({
      list: async () => {
        if (fail) throw new ApiError("internal", "Server exploded", 500);
        return { items, nextCursor: null, unread: 1 };
      },
    });
    const panel = await openPanel();
    const alert = await within(panel).findByRole("alert");
    expect(alert.textContent).toContain("Server exploded");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await within(panel).findByText("Press Esc twice", { exact: false });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("empty: all caught up", async () => {
    await setup({ unread: 0, list: async () => ({ items: [], nextCursor: null, unread: 0 }) });
    const panel = await openPanel();
    await within(panel).findByText("You're all caught up.");
    expect(within(panel).getByText(/Comments on your games, replies, hearts and new followers/)).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "See all" }).getAttribute("href")).toBe("/notifications");
    expect(within(panel).getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings#notifications");
  });
});

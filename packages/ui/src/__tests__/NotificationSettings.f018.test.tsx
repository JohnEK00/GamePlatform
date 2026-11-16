import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { NotificationMute, NotificationMuteList, NotificationSettings } from "../api/types";
import { SettingsPage } from "../pages/SettingsPage";
import { WebGameProviders } from "../WebGameApp";
import { me } from "./notifFixtures";

const F007: NotificationSettings = { comments: true, replies: true, hearts: true, follows: true, newGames: true };
const F018: NotificationSettings = { ...F007, pins: true };

const gameMute = (id: string, title: string, createdAt = "2026-11-10T10:00:00.000Z"): NotificationMute => ({
  target: "game",
  game: { id, title, thumbnailUrl: `/thumbs/${id}.png` },
  threadId: null,
  excerpt: null,
  path: `/games/${id}`,
  createdAt,
});
const threadMute = (gameId: string, title: string, threadId: string, excerpt: string): NotificationMute => ({
  target: "thread",
  game: { id: gameId, title, thumbnailUrl: null },
  threadId,
  excerpt,
  path: `/games/${gameId}?comment=${threadId}`,
  createdAt: "2026-11-12T10:00:00.000Z",
});

async function setup(opts: { settings?: NotificationSettings; mutes?: () => Promise<NotificationMuteList> } = {}) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  vi.spyOn(client, "getNotificationSettings").mockResolvedValue(opts.settings ?? F018);
  const put = vi.spyOn(client, "updateNotificationSettings").mockImplementation(async (p) => ({ ...(opts.settings ?? F018), ...p }));
  const list = vi.spyOn(client, "listNotificationMutes").mockImplementation(opts.mutes ?? (async () => ({ items: [], total: 0 })));
  const unmuteGame = vi.spyOn(client, "unmuteGame").mockResolvedValue({ muted: false, unread: 0 });
  const unmuteThread = vi.spyOn(client, "unmuteThread").mockResolvedValue({ muted: false, unread: 0 });
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/settings"]}>
        <SettingsPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  return { put, list, unmuteGame, unmuteThread };
}

const mutedSection = () => screen.queryByRole("region", { name: "Muted" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Settings → Notifications (F018)", () => {
  it("shows the pins switch after hearts and saves it", async () => {
    const { put } = await setup();
    const pins = (await screen.findByRole("checkbox", { name: "Pins on your comments" })) as HTMLInputElement;
    expect(pins.checked).toBe(true);
    const labels = screen.getAllByRole("checkbox").map((b) => b.getAttribute("aria-labelledby"));
    expect(labels.indexOf("pf-notif-set-pins-label")).toBe(labels.indexOf("pf-notif-set-hearts-label") + 1);
    fireEvent.click(pins);
    expect(put).toHaveBeenCalledWith({ pins: false });
    await screen.findByText("Notification settings saved");
    expect(pins.checked).toBe(false);
  });

  it("older servers: no pins switch and no Muted section (no mutes request)", async () => {
    const { list } = await setup({ settings: F007 });
    await screen.findByRole("checkbox", { name: "Comments on my games" });
    expect(screen.queryByRole("checkbox", { name: "Pins on your comments" })).toBeNull();
    expect(mutedSection()).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("Muted: empty state", async () => {
    await setup();
    expect(await screen.findByText("You haven't muted any games or threads.")).toBeTruthy();
    expect(within(mutedSection()!).getByRole("heading", { level: 3, name: "Muted" })).toBeTruthy();
  });

  it("Muted: a 404 hides the section", async () => {
    const { list } = await setup({ mutes: async () => Promise.reject(new ApiError("not_found", "nope", 404)) });
    await screen.findByRole("checkbox", { name: "Pins on your comments" });
    await waitFor(() => expect(list).toHaveBeenCalled());
    await act(async () => {});
    expect(mutedSection()).toBeNull();
  });

  it("Muted: rows link to the game and thread; Unmute removes the row and toasts", async () => {
    const items = [threadMute("g2", "Pixel Peaks", "c9", "Is there a level skip?"), gameMute("g1", "Space Dodge")];
    const { unmuteGame, unmuteThread } = await setup({ mutes: async () => ({ items, total: 2 }) });
    const section = await waitFor(() => {
      const s = mutedSection();
      expect(s && within(s).queryAllByRole("listitem").length).toBe(2);
      return s!;
    });
    const rows = within(section).getAllByRole("listitem");
    expect(within(rows[0]).getByRole("link", { name: "Pixel Peaks" }).getAttribute("href")).toBe("/games/g2");
    expect(within(rows[0]).getByRole("link", { name: "Thread: “Is there a level skip?”" }).getAttribute("href")).toBe("/games/g2?comment=c9");
    expect(within(rows[1]).getByRole("link", { name: "Space Dodge" }).getAttribute("href")).toBe("/games/g1");
    expect(rows[1].querySelector("img")!.getAttribute("src")).toBe("http://api.test/thumbs/g1.png");
    expect(rows[1].querySelector("time")!.getAttribute("dateTime")).toBe("2026-11-10T10:00:00.000Z");
    expect(within(section).queryByText(/of 500/)).toBeNull();

    const unmute1 = within(rows[0]).getByRole("button", { name: "Unmute thread on Pixel Peaks" });
    unmute1.focus();
    fireEvent.click(unmute1);
    expect(unmuteThread).toHaveBeenCalledWith("c9");
    expect(await screen.findByText("Thread unmuted.")).toBeTruthy();
    await waitFor(() => expect(within(section).getAllByRole("listitem")).toHaveLength(1));
    // Focus moves to the next row's Unmute button.
    expect(document.activeElement).toBe(within(section).getByRole("button", { name: "Unmute Space Dodge" }));

    fireEvent.click(within(section).getByRole("button", { name: "Unmute Space Dodge" }));
    expect(unmuteGame).toHaveBeenCalledWith("g1");
    expect(await screen.findByText("You'll get notifications for Space Dodge again")).toBeTruthy();
    expect(await screen.findByText("You haven't muted any games or threads.")).toBeTruthy();
  });

  it("Muted: shows the count line from 400 mutes on", async () => {
    const items = Array.from({ length: 400 }, (_, i) => gameMute(`g${i}`, `Game ${i}`));
    await setup({ mutes: async () => ({ items, total: 400 }) });
    expect(await screen.findByText("400 of 500")).toBeTruthy();
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { NotificationSettings } from "../api/types";
import { SettingsPage } from "../pages/SettingsPage";
import { WebGameProviders } from "../WebGameApp";
import { me } from "./notifFixtures";

const F018: NotificationSettings = { comments: true, replies: true, hearts: true, follows: true, newGames: true, pins: true };
const F021: NotificationSettings = { ...F018, collections: true };

async function setup(settings: NotificationSettings) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  vi.spyOn(client, "getNotificationSettings").mockResolvedValue(settings);
  vi.spyOn(client, "listNotificationMutes").mockResolvedValue({ items: [], total: 0 });
  const put = vi.spyOn(client, "updateNotificationSettings").mockImplementation(async (p) => ({ ...settings, ...p }));
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/settings"]}>
        <SettingsPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  return { put };
}

const NAME = "My games added to collections";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("Settings → Notifications (F021)", () => {
  it("shows the collections switch after New games, with its hint, and round-trips it", async () => {
    const { put } = await setup(F021);
    const sw = (await screen.findByRole("checkbox", { name: NAME })) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    expect(screen.getByText("Someone adds a game you made to a public collection.")).toBeTruthy();
    const labels = screen.getAllByRole("checkbox").map((b) => b.getAttribute("aria-labelledby"));
    expect(labels).toHaveLength(7);
    expect(labels.indexOf("pf-notif-set-collections-label")).toBe(labels.indexOf("pf-notif-set-newGames-label") + 1);
    fireEvent.click(sw);
    expect(put).toHaveBeenCalledWith({ collections: false });
    await screen.findByText("Notification settings saved");
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    expect(put).toHaveBeenLastCalledWith({ collections: true });
    await act(async () => {});
    expect(sw.checked).toBe(true);
  });

  it("older servers (no collections field): the switch is hidden and the rest is unchanged", async () => {
    await setup(F018);
    await screen.findByRole("checkbox", { name: "Comments on my games" });
    expect(screen.queryByRole("checkbox", { name: NAME })).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(6);
  });
});

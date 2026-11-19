import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { NotificationSettings } from "../api/types";
import { NOTIFICATION_SETTING_FIELDS } from "../components/NotificationSettings";
import { SettingsPage } from "../pages/SettingsPage";
import { WebGameProviders } from "../WebGameApp";
import { me } from "./notifFixtures";

const F021: NotificationSettings = { comments: true, replies: true, hearts: true, follows: true, newGames: true, pins: true, collections: true };
const F024: NotificationSettings = { ...F021, screenshots: true };

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

const NAME = "Screenshots of my games";
const HINT = "Someone posts a screenshot of a game you made.";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("Settings → Notifications (F024)", () => {
  it("the field list ends with the screenshots switch, right after collections (F031 adds two after pins)", () => {
    expect(NOTIFICATION_SETTING_FIELDS).toHaveLength(10);
    expect(NOTIFICATION_SETTING_FIELDS[9]).toEqual({ key: "screenshots", label: NAME, hint: HINT });
    expect(NOTIFICATION_SETTING_FIELDS[8].key).toBe("collections");
  });

  it("shows the switch last, after collections, with label and hint verbatim, and round-trips it", async () => {
    const { put } = await setup(F024);
    const sw = (await screen.findByRole("checkbox", { name: NAME })) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    expect(document.getElementById("pf-notif-set-screenshots-label")!.textContent).toBe(NAME);
    expect(document.getElementById("pf-notif-set-screenshots-hint")!.textContent).toBe(HINT);
    expect(sw.getAttribute("aria-describedby")).toBe("pf-notif-set-screenshots-hint");
    const labels = screen.getAllByRole("checkbox").map((b) => b.getAttribute("aria-labelledby"));
    expect(labels).toHaveLength(8);
    expect(labels[7]).toBe("pf-notif-set-screenshots-label");
    expect(labels[6]).toBe("pf-notif-set-collections-label");

    fireEvent.click(sw);
    expect(put).toHaveBeenCalledWith({ screenshots: false });
    await screen.findByText("Notification settings saved");
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    expect(put).toHaveBeenLastCalledWith({ screenshots: true });
    await act(async () => {});
    expect(sw.checked).toBe(true);
  });

  it("older servers (no screenshots field): the switch is hidden and the other seven are unchanged", async () => {
    await setup(F021);
    await screen.findByRole("checkbox", { name: "Comments on my games" });
    expect(screen.queryByRole("checkbox", { name: NAME })).toBeNull();
    const labels = screen.getAllByRole("checkbox").map((b) => b.getAttribute("aria-labelledby"));
    expect(labels).toEqual([
      "pf-notif-set-comments-label",
      "pf-notif-set-replies-label",
      "pf-notif-set-hearts-label",
      "pf-notif-set-pins-label",
      "pf-notif-set-follows-label",
      "pf-notif-set-newGames-label",
      "pf-notif-set-collections-label",
    ]);
  });
});

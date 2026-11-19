import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { NotificationSettings } from "../api/types";
import { NOTIFICATION_SETTING_FIELDS } from "../components/NotificationSettings";
import { SettingsPage } from "../pages/SettingsPage";
import { WebGameProviders } from "../WebGameApp";
import { me } from "./notifFixtures";

const F024: NotificationSettings = { comments: true, replies: true, hearts: true, follows: true, newGames: true, pins: true, collections: true, screenshots: true };
const F031: NotificationSettings = { ...F024, postReplies: true, postHearts: false };

const REPLIES = { key: "postReplies", label: "Replies to my posts", hint: "Someone replies to a post you wrote, or answers your reply on a post." };
const HEARTS = { key: "postHearts", label: "Hearts on my posts", hint: "Someone hearts a post you wrote." };

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

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("Settings → Notifications (F031 § 0.10)", () => {
  it("the two fields come right after pins", () => {
    const keys = NOTIFICATION_SETTING_FIELDS.map((f) => f.key);
    const i = keys.indexOf("pins");
    expect(NOTIFICATION_SETTING_FIELDS[i + 1]).toEqual(REPLIES);
    expect(NOTIFICATION_SETTING_FIELDS[i + 2]).toEqual(HEARTS);
  });

  it("shows both switches after pins with the exact labels and hints", async () => {
    await setup(F031);
    const replies = (await screen.findByRole("checkbox", { name: REPLIES.label })) as HTMLInputElement;
    const hearts = screen.getByRole("checkbox", { name: HEARTS.label }) as HTMLInputElement;
    expect(replies.checked).toBe(true);
    expect(hearts.checked).toBe(false);
    expect(document.getElementById("pf-notif-set-postReplies-hint")!.textContent).toBe(REPLIES.hint);
    expect(document.getElementById("pf-notif-set-postHearts-hint")!.textContent).toBe(HEARTS.hint);
    const order = screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-labelledby"));
    const pins = order.indexOf("pf-notif-set-pins-label");
    expect(order[pins + 1]).toBe("pf-notif-set-postReplies-label");
    expect(order[pins + 2]).toBe("pf-notif-set-postHearts-label");
    expect(order).toHaveLength(10);
  });

  it("hides them when the server omits the fields", async () => {
    await setup(F024);
    await screen.findByRole("checkbox", { name: "Pins on your comments" });
    expect(screen.queryByRole("checkbox", { name: REPLIES.label })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: HEARTS.label })).toBeNull();
    expect(screen.getAllByRole("checkbox")).toHaveLength(8);
  });

  it("sends a partial PUT", async () => {
    const { put } = await setup(F031);
    const hearts = (await screen.findByRole("checkbox", { name: HEARTS.label })) as HTMLInputElement;
    await act(async () => fireEvent.click(hearts));
    expect(put).toHaveBeenCalledWith({ postHearts: true });
    expect(hearts.checked).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: REPLIES.label })));
    expect(put).toHaveBeenLastCalledWith({ postReplies: false });
  });
});

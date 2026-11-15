import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { NotificationSettings } from "../api/types";
import { SettingsPage } from "../pages/SettingsPage";
import { WebGameProviders } from "../WebGameApp";
import { me } from "./notifFixtures";

const ALL_ON: NotificationSettings = { comments: true, replies: true, hearts: true, follows: true, newGames: true };

async function setup(opts: { get?: () => Promise<NotificationSettings>; put?: (p: Partial<NotificationSettings>) => Promise<NotificationSettings>; url?: string } = {}) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  const get = vi.spyOn(client, "getNotificationSettings").mockImplementation(opts.get ?? (async () => ({ ...ALL_ON, hearts: false })));
  const put = vi.spyOn(client, "updateNotificationSettings").mockImplementation(opts.put ?? (async (p) => ({ ...ALL_ON, hearts: false, ...p })));
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[opts.url ?? "/settings"]}>
        <SettingsPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  return { get, put };
}

const box = (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsPage notifications", () => {
  it("loads the settings into five labelled checkboxes", async () => {
    const { get } = await setup();
    await screen.findByRole("checkbox", { name: "Comments on my games" });
    expect(get).toHaveBeenCalledTimes(1);
    expect(box("Comments on my games").checked).toBe(true);
    expect(box("Replies to my comments and to me").checked).toBe(true);
    expect(box("Hearts on my comments").checked).toBe(false);
    expect(box("New followers").checked).toBe(true);
    expect(box("New games from creators I follow").checked).toBe(true);
    expect(screen.getByRole("group", { name: "Notifications" })).toBeTruthy();
    expect(document.getElementById("notifications")).not.toBeNull();
    expect(screen.getByText(/Turning a type off stops new notifications of that type/)).toBeTruthy();
  });

  it("PUTs only the changed field and toasts success", async () => {
    const { put } = await setup();
    await screen.findByRole("checkbox", { name: "New followers" });
    fireEvent.click(box("New followers"));
    expect(put).toHaveBeenCalledWith({ follows: false });
    expect(box("New followers").checked).toBe(false);
    expect(box("New followers").disabled).toBe(false);
    await screen.findByText("Notification settings saved");
    expect(box("New followers").checked).toBe(false);
  });

  it("reverts on error and shows a toast", async () => {
    await setup({ put: async () => Promise.reject(new ApiError("internal", "Database on fire", 500)) });
    await screen.findByRole("checkbox", { name: "Hearts on my comments" });
    fireEvent.click(box("Hearts on my comments"));
    expect(box("Hearts on my comments").checked).toBe(true);
    await waitFor(() => expect(box("Hearts on my comments").checked).toBe(false));
    expect(await screen.findByText("Database on fire")).toBeTruthy();
  });

  it("is hidden against an older server (404)", async () => {
    await setup({ get: async () => Promise.reject(new ApiError("not_found", "nope", 404)) });
    await waitFor(() => expect(document.getElementById("notifications")).toBeNull());
    expect(screen.queryByRole("checkbox", { name: "Comments on my games" })).toBeNull();
  });

  it("/settings#notifications scrolls the section into view", async () => {
    const spy = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      await setup({ url: "/settings#notifications" });
      await screen.findByRole("checkbox", { name: "Comments on my games" });
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.contexts[0]).toBe(document.getElementById("notifications"));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

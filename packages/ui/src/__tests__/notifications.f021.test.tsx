import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client";
import type { Notification } from "../api/types";
import { NotificationItem } from "../components/NotificationItem";
import {
  isKnownNotification,
  muteActionFor,
  NOTIFICATION_KINDS,
  notificationParts,
  notificationText,
  osNotificationsFor,
  osNotificationText,
} from "../notifications";
import { WebGameProviders } from "../WebGameApp";
import { mia, noah, notif } from "./notifFixtures";

const added = (over: Partial<Notification> = {}): Notification =>
  notif({
    id: "21",
    kind: "addedToCollection",
    game: { id: "g7", title: "Space Dodge", thumbnailUrl: null },
    commentId: null,
    excerpt: null,
    path: "/c/col-1",
    collection: { id: "col-1", title: "Cozy games", path: "/c/col-1" },
    ...over,
  });

describe("F021: addedToCollection notifications", () => {
  it("is a known kind with the normative summary", () => {
    expect(NOTIFICATION_KINDS).toContain("addedToCollection");
    const n = added();
    expect(isKnownNotification(n)).toBe(true);
    expect(notificationText(n)).toBe("Mia added Space Dodge to Cozy games");
    expect(notificationParts(n)).toEqual([
      { type: "name", text: "Mia" },
      { type: "text", text: " added " },
      { type: "title", text: "Space Dodge" },
      { type: "text", text: " to " },
      { type: "title", text: "Cozy games" },
    ]);
  });

  it("without a collection (missing or null): '… to a collection'", () => {
    expect(notificationText(added({ collection: null }))).toBe("Mia added Space Dodge to a collection");
    const missing = added();
    delete (missing as Partial<Notification>).collection;
    expect(notificationText(missing)).toBe("Mia added Space Dodge to a collection");
  });

  it("muteActionFor → the game mute", () => {
    expect(muteActionFor(added())).toEqual({ target: "game", id: "g7", label: "Mute game: Space Dodge" });
    expect(muteActionFor(added({ game: null }))).toBeNull();
  });

  it("osNotificationText omits the collection title", () => {
    const n = added({ collection: { id: "col-1", title: "SECRET TITLE", path: "/c/col-1" } });
    expect(osNotificationText(n)).toBe("Mia added Space Dodge to a collection");
    expect(osNotificationText(n)).not.toContain("SECRET");
  });

  it("osNotificationText equals notificationText for every other kind", () => {
    const others: Notification[] = [
      notif({ id: "1", kind: "comment", eventCount: 3 }),
      notif({ id: "2", kind: "reply", ownsThread: true, actors: [mia, noah], actorCount: 2, eventCount: 2 }),
      notif({ id: "3", kind: "heart" }),
      notif({ id: "4", kind: "follow", game: null }),
      notif({ id: "5", kind: "gamePublished" }),
      notif({ id: "6", kind: "pinned", threadId: "c1" }),
    ];
    const kinds = new Set(others.map((n) => n.kind));
    for (const k of NOTIFICATION_KINDS) if (k !== "addedToCollection") expect(kinds.has(k)).toBe(true);
    for (const n of others) {
      expect(osNotificationText(n)).toBe(notificationText(n));
      expect(osNotificationText(n)).not.toBe("");
    }
    expect(osNotificationText(notif({ id: "9", kind: "nope" as never }))).toBe("");
  });

  it("osNotificationsFor uses osNotificationText", () => {
    const n = added({ collection: { id: "col-1", title: "SECRET TITLE", path: "/c/col-1" }, updatedAt: "2026-11-15T10:05:00.000Z" });
    const c = notif({ id: "2", updatedAt: "2026-11-15T10:01:00.000Z" });
    const shown = osNotificationsFor([n, c]);
    expect(shown).toEqual([
      { title: "Pixelforge Arcade", body: "Mia commented on Pixel Peaks" },
      { title: "Pixelforge Arcade", body: "Mia added Space Dodge to a collection" },
    ]);
    expect(JSON.stringify(shown)).not.toContain("SECRET");
  });

  it("NotificationItem renders the summary, the 📚 icon and links to /c/{id}", () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const { container } = render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter>
          <ul>
            <NotificationItem item={added()} />
          </ul>
        </MemoryRouter>
      </WebGameProviders>,
    );
    expect(container.querySelector(".pf-notif__text")!.textContent).toBe("Unread: Mia added Space Dodge to Cozy games");
    expect(container.querySelector("a.pf-notif__link")!.getAttribute("href")).toBe("/c/col-1");
    const icon = container.querySelector(".pf-notif__kind--collection")!;
    expect(icon.textContent).toBe("📚");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".pf-notif__excerpt")).toBeNull();
  });
});

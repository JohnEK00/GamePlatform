import { describe, expect, it } from "vitest";
import type { Notification } from "../api/types";
import {
  isKnownNotification,
  muteActionFor,
  NOTIFICATION_KINDS,
  notificationParts,
  notificationText,
  osNotificationsFor,
  osNotificationText,
  screenshotThumb,
} from "../notifications";
import { ava, mia, noah, notif } from "./notifFixtures";

const shot = (over: Partial<Notification> = {}): Notification =>
  notif({
    id: "24",
    kind: "screenshotPosted",
    commentId: null,
    excerpt: null,
    path: "/games/g1?section=screenshots",
    screenshot: { id: "s1", thumbUrl: "/media/screenshots/s1_t.jpg" },
    ...over,
  });

describe("F024: screenshotPosted summaries (spec § 0.8)", () => {
  it("is a known kind, listed after the F021 kind (F031 appends its two kinds after it)", () => {
    expect(NOTIFICATION_KINDS.indexOf("screenshotPosted")).toBe(NOTIFICATION_KINDS.indexOf("addedToCollection") + 1);
    expect(isKnownNotification(shot())).toBe(true);
  });

  it("1 actor, 1 screenshot", () => {
    const n = shot();
    expect(notificationText(n)).toBe("Mia posted a screenshot of Pixel Peaks");
    expect(notificationParts(n)).toEqual([
      { type: "name", text: "Mia" },
      { type: "text", text: " posted a screenshot of " },
      { type: "title", text: "Pixel Peaks" },
    ]);
  });

  it("1 actor, n screenshots", () => {
    const n = shot({ eventCount: 2 });
    expect(notificationText(n)).toBe("Mia posted 2 screenshots of Pixel Peaks");
    expect(notificationParts(n)).toEqual([
      { type: "name", text: "Mia" },
      { type: "text", text: " posted 2 screenshots of " },
      { type: "title", text: "Pixel Peaks" },
    ]);
  });

  it("2 actors, n screenshots", () => {
    const n = shot({ actors: [noah, mia], actorCount: 2, eventCount: 4 });
    expect(notificationText(n)).toBe("Noah and Mia posted 4 screenshots of Pixel Peaks");
    expect(notificationParts(n)).toEqual([
      { type: "name", text: "Noah" },
      { type: "text", text: " and " },
      { type: "name", text: "Mia" },
      { type: "text", text: " posted 4 screenshots of " },
      { type: "title", text: "Pixel Peaks" },
    ]);
  });

  it("3+ actors, n screenshots", () => {
    const n = shot({ actors: [mia, noah, ava], actorCount: 3, eventCount: 7 });
    expect(notificationText(n)).toBe("Mia and 2 others posted 7 screenshots of Pixel Peaks");
  });

  it("actorCount 2 with one actor sent: '{A} and 1 other'", () => {
    expect(notificationText(shot({ actors: [mia], actorCount: 2, eventCount: 2 }))).toBe("Mia and 1 other posted 2 screenshots of Pixel Peaks");
  });

  it("a missing game → '… of a game'", () => {
    expect(notificationText(shot({ game: null }))).toBe("Mia posted a screenshot of a game");
  });

  it("muteActionFor → the game mute", () => {
    expect(muteActionFor(shot())).toEqual({ target: "game", id: "g1", label: "Mute game: Pixel Peaks" });
    expect(muteActionFor(shot({ game: null }))).toBeNull();
  });

  it("OS text equals the in-app summary and never carries URLs", () => {
    const n = shot();
    expect(osNotificationText(n)).toBe(notificationText(n));
    const shown = osNotificationsFor([n]);
    expect(shown).toHaveLength(1);
    expect(shown[0].body).toBe("Mia posted a screenshot of Pixel Peaks");
    expect(shown[0].body).not.toContain("/media/");
  });
});

describe("F024: screenshotThumb", () => {
  it("returns the thumbUrl of a screenshotPosted item", () => {
    expect(screenshotThumb(shot())).toBe("/media/screenshots/s1_t.jpg");
  });

  it("returns null for other kinds, even with a screenshot", () => {
    expect(screenshotThumb(notif({ id: "1", screenshot: { id: "s1", thumbUrl: "/media/screenshots/s1_t.jpg" } }))).toBeNull();
    expect(screenshotThumb(notif({ id: "2", kind: "gamePublished" }))).toBeNull();
  });

  it("returns null for a null, missing or malformed screenshot, or an empty thumbUrl", () => {
    expect(screenshotThumb(shot({ screenshot: null }))).toBeNull();
    const missing = shot();
    delete (missing as Partial<Notification>).screenshot;
    expect(screenshotThumb(missing)).toBeNull();
    expect(screenshotThumb(shot({ screenshot: "s1" as never }))).toBeNull();
    expect(screenshotThumb(shot({ screenshot: { id: "s1" } as never }))).toBeNull();
    expect(screenshotThumb(shot({ screenshot: { id: "s1", thumbUrl: 42 } as never }))).toBeNull();
    expect(screenshotThumb(shot({ screenshot: { id: "s1", thumbUrl: "" } }))).toBeNull();
  });
});

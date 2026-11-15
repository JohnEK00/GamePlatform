import { afterEach, describe, expect, it } from "vitest";
import type { Notification } from "../api/types";
import {
  bellLabel,
  isKnownNotification,
  mergeNotifications,
  normalizePollSecs,
  notificationParts,
  notificationPollDelay,
  notificationText,
  OS_WATERMARK_PREFIX,
  osNotificationsFor,
  readOsWatermark,
  safeNotificationPath,
  unreadBadgeText,
  writeOsWatermark,
} from "../notifications";
import { ava, mia, noah, notif, user } from "./notifFixtures";

const kim = user("u9", "", "kim"); // no display name → username

const text = (over: Partial<Notification>) => notificationText(notif({ id: "1", ...over }));

describe("notificationText (spec § 2.5 table)", () => {
  it("comment", () => {
    expect(text({ kind: "comment", actors: [mia], actorCount: 1, eventCount: 1 })).toBe("Mia commented on Pixel Peaks");
    expect(text({ kind: "comment", actors: [mia], actorCount: 1, eventCount: 4 })).toBe("Mia left 4 comments on Pixel Peaks");
    expect(text({ kind: "comment", actors: [noah, mia], actorCount: 2, eventCount: 3 })).toBe("Noah and Mia commented on Pixel Peaks");
    expect(text({ kind: "comment", actors: [mia, noah, ava], actorCount: 3, eventCount: 3 })).toBe("Mia and 2 others commented on Pixel Peaks");
  });

  it("reply (ownsThread)", () => {
    const base = { kind: "reply" as const, ownsThread: true };
    expect(text({ ...base, actors: [noah], actorCount: 1, eventCount: 1 })).toBe("Noah replied to your comment on Pixel Peaks");
    expect(text({ ...base, actors: [noah], actorCount: 1, eventCount: 3 })).toBe("Noah replied 3 times to your comment on Pixel Peaks");
    expect(text({ ...base, actors: [mia, noah], actorCount: 2, eventCount: 2 })).toBe("Mia and Noah replied to your comment on Pixel Peaks");
    expect(text({ ...base, actors: [mia, noah, ava], actorCount: 5, eventCount: 9 })).toBe("Mia and 4 others replied to your comment on Pixel Peaks");
  });

  it("reply (not ownsThread)", () => {
    const base = { kind: "reply" as const, ownsThread: false };
    expect(text({ ...base, actors: [noah], actorCount: 1, eventCount: 1 })).toBe("Noah replied to you on Pixel Peaks");
    expect(text({ ...base, actors: [noah], actorCount: 1, eventCount: 2 })).toBe("Noah replied 2 times to you on Pixel Peaks");
    expect(text({ ...base, actors: [mia, noah], actorCount: 2, eventCount: 2 })).toBe("Mia and Noah replied to you on Pixel Peaks");
    expect(text({ ...base, actors: [mia, noah, ava], actorCount: 3, eventCount: 3 })).toBe("Mia and 2 others replied to you on Pixel Peaks");
  });

  it("heart", () => {
    const base = { kind: "heart" as const };
    expect(text({ ...base, actors: [ava], actorCount: 1, eventCount: 1 })).toBe("Ava hearted your comment on Pixel Peaks");
    expect(text({ ...base, actors: [ava, mia], actorCount: 2, eventCount: 2 })).toBe("Ava and Mia hearted your comment on Pixel Peaks");
    expect(text({ ...base, actors: [ava, mia, noah], actorCount: 12, eventCount: 12 })).toBe("Ava and 11 others hearted your comment on Pixel Peaks");
  });

  it("follow (no game)", () => {
    const base = { kind: "follow" as const, game: null, commentId: null };
    expect(text({ ...base, actors: [mia], actorCount: 1, eventCount: 1 })).toBe("Mia followed you");
    expect(text({ ...base, actors: [mia, kim], actorCount: 2, eventCount: 2 })).toBe("Mia and kim followed you");
    expect(text({ ...base, actors: [mia, noah, ava], actorCount: 3, eventCount: 3 })).toBe("Mia and 2 others followed you");
  });

  it("gamePublished", () => {
    expect(text({ kind: "gamePublished", actors: [user("u5", "Rex")], game: { id: "g2", title: "Lava Leap", thumbnailUrl: null } })).toBe(
      "Rex published Lava Leap",
    );
  });

  it('"1 other" vs "others"', () => {
    // actorCount 2 but only one actor returned → "1 other"
    expect(text({ kind: "heart", actors: [ava], actorCount: 2, eventCount: 2 })).toBe("Ava and 1 other hearted your comment on Pixel Peaks");
    expect(text({ kind: "heart", actors: [ava, mia, noah], actorCount: 4, eventCount: 4 })).toBe("Ava and 3 others hearted your comment on Pixel Peaks");
  });

  it("parts mark names and titles; names are display name else username", () => {
    const parts = notificationParts(notif({ id: "1", kind: "comment", actors: [kim, mia], actorCount: 2, eventCount: 2 }));
    expect(parts).toEqual([
      { type: "name", text: "kim" },
      { type: "text", text: " and " },
      { type: "name", text: "Mia" },
      { type: "text", text: " commented on " },
      { type: "title", text: "Pixel Peaks" },
    ]);
  });

  it("unknown kind is ignored", () => {
    const odd = { ...notif({ id: "1" }), kind: "mention" } as unknown as Notification;
    expect(isKnownNotification(odd)).toBe(false);
    expect(notificationText(odd)).toBe("");
    expect(notificationParts(odd)).toEqual([]);
    expect(isKnownNotification(notif({ id: "1" }))).toBe(true);
    expect(isKnownNotification(null)).toBe(false);
    expect(mergeNotifications([], [odd, notif({ id: "2" })]).map((n) => n.id)).toEqual(["2"]);
  });
});

describe("badge, label, path, merge", () => {
  it("badge text and accessible name", () => {
    expect(unreadBadgeText(0)).toBe("");
    expect(unreadBadgeText(7)).toBe("7");
    expect(unreadBadgeText(99)).toBe("99");
    expect(unreadBadgeText(100)).toBe("99+");
    expect(bellLabel(0)).toBe("Notifications");
    expect(bellLabel(3)).toBe("Notifications, 3 unread");
    expect(bellLabel(100)).toBe("Notifications, more than 99 unread");
  });

  it("only in-app paths are followed", () => {
    expect(safeNotificationPath("/games/g1?comment=c1")).toBe("/games/g1?comment=c1");
    expect(safeNotificationPath("/u/bob/followers")).toBe("/u/bob/followers");
    for (const bad of ["javascript:alert(1)", "https://evil.test/", "//evil.test", "/\\evil.test", "games/1", "", null]) {
      expect(safeNotificationPath(bad)).toBe("/notifications");
    }
  });

  it("merge dedupes by id keeping the newest copy", () => {
    const a = notif({ id: "1", updatedAt: "2026-11-15T10:00:00.000Z" });
    const b = notif({ id: "2" });
    const a2 = notif({ id: "1", updatedAt: "2026-11-15T11:00:00.000Z", actorCount: 2 });
    const aOld = notif({ id: "1", updatedAt: "2026-11-15T09:00:00.000Z", actorCount: 9 });
    expect(mergeNotifications([a, b], [a2, notif({ id: "3" })]).map((n) => [n.id, n.actorCount])).toEqual([
      ["1", 2],
      ["2", 1],
      ["3", 1],
    ]);
    expect(mergeNotifications([a], [aOld])[0].actorCount).toBe(1);
  });
});

describe("OS notifications", () => {
  afterEach(() => localStorage.clear());

  it("watermark read/write; malformed values → null", () => {
    expect(readOsWatermark("u1")).toBeNull();
    writeOsWatermark("u1", "2026-11-15T10:00:00.000Z");
    expect(localStorage.getItem(OS_WATERMARK_PREFIX + "u1")).toBe("2026-11-15T10:00:00.000Z");
    expect(readOsWatermark("u1")).toBe("2026-11-15T10:00:00.000Z");
    expect(readOsWatermark("u2")).toBeNull();
    for (const bad of ["yesterday", "2026-11-15", "2026-13-45T99:99:99Z", "{}", ""]) {
      localStorage.setItem(OS_WATERMARK_PREFIX + "u1", bad);
      expect(readOsWatermark("u1")).toBeNull();
    }
    writeOsWatermark("u1", "not a date");
    expect(localStorage.getItem(OS_WATERMARK_PREFIX + "u1")).toBe("");
    localStorage.setItem(OS_WATERMARK_PREFIX + "u1", "2026-11-15T10:00:00+02:00");
    expect(readOsWatermark("u1")).toBe("2026-11-15T10:00:00+02:00");
  });

  it("1–3 items oldest first with summary text only; more → one summary", () => {
    const n1 = notif({ id: "1", updatedAt: "2026-11-15T10:02:00.000Z", excerpt: "secret text" });
    const n2 = notif({ id: "2", kind: "follow", game: null, updatedAt: "2026-11-15T10:01:00.000Z" });
    const shown = osNotificationsFor([n1, n2]);
    expect(shown).toEqual([
      { title: "Pixelforge Arcade", body: "Mia followed you" },
      { title: "Pixelforge Arcade", body: "Mia commented on Pixel Peaks" },
    ]);
    expect(JSON.stringify(shown)).not.toContain("secret");
    const many = [1, 2, 3, 4].map((i) => notif({ id: String(i) }));
    expect(osNotificationsFor(many)).toEqual([{ title: "Pixelforge Arcade", body: "You have 4 new notifications" }]);
    expect(osNotificationsFor([])).toEqual([]);
  });
});

describe("notificationPollDelay (spec § 2.7)", () => {
  const base = { pollAfterSecs: 60, visible: true, osEnabled: false, outcome: "ok" as const };

  it("visible: pollAfterSecs; hidden: paused; hidden with OS notifications: 2×", () => {
    expect(notificationPollDelay(base)).toBe(60_000);
    expect(notificationPollDelay({ ...base, pollAfterSecs: 30 })).toBe(30_000);
    expect(notificationPollDelay({ ...base, visible: false })).toBeNull();
    expect(notificationPollDelay({ ...base, visible: false, osEnabled: true })).toBe(120_000);
    expect(notificationPollDelay({ ...base, osEnabled: true })).toBe(60_000);
  });

  it("429: Retry-After, at least pollAfterSecs", () => {
    expect(notificationPollDelay({ ...base, outcome: "rateLimited", retryAfter: 300 })).toBe(300_000);
    expect(notificationPollDelay({ ...base, outcome: "rateLimited", retryAfter: 5 })).toBe(60_000);
    expect(notificationPollDelay({ ...base, outcome: "rateLimited" })).toBe(60_000);
    expect(notificationPollDelay({ ...base, outcome: "rateLimited", retryAfter: 300, visible: false })).toBeNull();
  });

  it("errors back off 2×, 4×, … up to 10 min; a success resets", () => {
    const err = (n: number) => notificationPollDelay({ ...base, outcome: "error", errorStreak: n });
    expect(err(1)).toBe(120_000);
    expect(err(2)).toBe(240_000);
    expect(err(3)).toBe(480_000);
    expect(err(4)).toBe(600_000);
    expect(err(50)).toBe(600_000);
    expect(notificationPollDelay({ ...base, outcome: "ok", errorStreak: 0 })).toBe(60_000);
  });

  it("401 and 404 stop", () => {
    expect(notificationPollDelay({ ...base, outcome: "unauthorized" })).toBeNull();
    expect(notificationPollDelay({ ...base, outcome: "unsupported", osEnabled: true })).toBeNull();
  });

  it("sanitises pollAfterSecs", () => {
    expect(normalizePollSecs(undefined)).toBe(60);
    expect(normalizePollSecs(Number.NaN)).toBe(60);
    expect(normalizePollSecs(1)).toBe(15);
    expect(normalizePollSecs(99999)).toBe(600);
    expect(normalizePollSecs(45)).toBe(45);
  });
});

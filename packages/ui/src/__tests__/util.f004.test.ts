import { describe, expect, it } from "vitest";
import { gameVersionsPath, isRecentlyUpdated, UPDATED_BADGE_MS } from "../util";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("isRecentlyUpdated", () => {
  it("is 7 days", () => {
    expect(UPDATED_BADGE_MS).toBe(7 * 24 * 3600 * 1000);
  });

  it("is false for null, undefined (older servers) and invalid strings", () => {
    expect(isRecentlyUpdated({ lastUpdatedAt: null }, NOW)).toBe(false);
    expect(isRecentlyUpdated({ lastUpdatedAt: undefined }, NOW)).toBe(false);
    expect(isRecentlyUpdated({}, NOW)).toBe(false);
    expect(isRecentlyUpdated({ lastUpdatedAt: "" }, NOW)).toBe(false);
    expect(isRecentlyUpdated({ lastUpdatedAt: "not a date" }, NOW)).toBe(false);
  });

  it("is true just now and at 6 days 23 hours", () => {
    expect(isRecentlyUpdated({ lastUpdatedAt: at(0) }, NOW)).toBe(true);
    expect(isRecentlyUpdated({ lastUpdatedAt: at(6 * DAY + 23 * HOUR) }, NOW)).toBe(true);
  });

  it("is false at exactly 7 days and later", () => {
    expect(isRecentlyUpdated({ lastUpdatedAt: at(7 * DAY) }, NOW)).toBe(false);
    expect(isRecentlyUpdated({ lastUpdatedAt: at(30 * DAY) }, NOW)).toBe(false);
  });

  it("tolerates a few minutes of clock skew into the future, not a day", () => {
    expect(isRecentlyUpdated({ lastUpdatedAt: at(-3 * MIN) }, NOW)).toBe(true);
    expect(isRecentlyUpdated({ lastUpdatedAt: at(-1 * DAY) }, NOW)).toBe(false);
  });

  it("defaults now to Date.now()", () => {
    expect(isRecentlyUpdated({ lastUpdatedAt: new Date().toISOString() })).toBe(true);
  });
});

describe("gameVersionsPath", () => {
  it("uses ?section=versions (HashRouter-safe) and encodes the id", () => {
    expect(gameVersionsPath("g1")).toBe("/games/g1?section=versions");
    expect(gameVersionsPath("a b")).toBe("/games/a%20b?section=versions");
  });
});

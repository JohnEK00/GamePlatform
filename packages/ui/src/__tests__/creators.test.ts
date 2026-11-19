import { describe, expect, it } from "vitest";
import { CREATOR_SORTS, CREATOR_SORT_LABELS, CREATORS_PER_PAGE, creatorStatsText, creatorsPath, isValidCreator, parseCreatorSort } from "../creators";

describe("creators helpers (F035)", () => {
  it("sorts, labels and page size", () => {
    expect(CREATOR_SORTS).toEqual(["popular", "active", "new"]);
    expect(CREATOR_SORT_LABELS).toEqual({ popular: "Popular", active: "Recently active", new: "New creators" });
    expect(CREATORS_PER_PAGE).toBe(24);
  });

  it("parseCreatorSort falls back to popular", () => {
    expect(parseCreatorSort(null)).toBe("popular");
    expect(parseCreatorSort(undefined)).toBe("popular");
    expect(parseCreatorSort("")).toBe("popular");
    expect(parseCreatorSort("new")).toBe("new");
    expect(parseCreatorSort("active")).toBe("active");
    expect(parseCreatorSort("bogus")).toBe("popular");
    expect(parseCreatorSort("NEW")).toBe("popular");
  });

  it("creatorsPath omits the defaults", () => {
    expect(creatorsPath("popular")).toBe("/creators");
    expect(creatorsPath("new", 2)).toBe("/creators?sort=new&page=2");
    expect(creatorsPath("popular", 3)).toBe("/creators?page=3");
    expect(creatorsPath("active", 1)).toBe("/creators?sort=active");
  });

  it("creatorStatsText pluralises and formats", () => {
    expect(creatorStatsText(1, 1, 1)).toBe("1 game · 1 play · 1 follower");
    // formatCount renders thousands as a lowercase "k" across the app.
    expect(creatorStatsText(3, 1200, 45)).toBe("3 games · 1.2k plays · 45 followers");
    expect(creatorStatsText(2, 0, 0)).toBe("2 games · 0 plays · 0 followers");
  });

  it("isValidCreator", () => {
    const ok = {
      user: { id: "u1", username: "mia", displayName: "Mia", avatarUrl: null },
      bannerUrl: null,
      bioExcerpt: "",
      games: 1,
      plays: 0,
      followers: 0,
      isFollowing: false,
      firstPublishedAt: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    };
    expect(isValidCreator(ok)).toBe(true);
    expect(isValidCreator(null)).toBe(false);
    expect(isValidCreator("mia")).toBe(false);
    expect(isValidCreator({ ...ok, user: null })).toBe(false);
    expect(isValidCreator({ ...ok, user: { id: "u1" } })).toBe(false);
    expect(isValidCreator({ ...ok, games: "1" })).toBe(false);
    expect(isValidCreator({ ...ok, plays: undefined })).toBe(false);
    expect(isValidCreator({ ...ok, followers: null })).toBe(false);
    expect(isValidCreator({ ...ok, isFollowing: 0 })).toBe(false);
  });
});

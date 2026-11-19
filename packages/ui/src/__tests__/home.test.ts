import { describe, expect, it } from "vitest";
import {
  BROWSE_PATH,
  browsePath,
  FEATURED_GAMES_MAX,
  HOME_COLLECTIONS_SIZE,
  HOME_SHELF_SIZE,
  HOME_TAGS_MAX,
  isValidSpotlight,
  LEGACY_HOME_KEYS,
  legacyHomeRedirect,
  moveItem,
} from "../home";
import { creator } from "./creatorFixtures";

describe("home constants (F032)", () => {
  it("sizes", () => {
    expect([HOME_SHELF_SIZE, HOME_COLLECTIONS_SIZE, HOME_TAGS_MAX, FEATURED_GAMES_MAX]).toEqual([4, 3, 12, 4]);
    expect(BROWSE_PATH).toBe("/browse");
    expect(LEGACY_HOME_KEYS).toEqual(["q", "tag", "sort", "page"]);
  });
});

describe("browsePath", () => {
  it.each([
    [{}, "/browse"],
    [undefined, "/browse"],
    [{ q: "  dodge " }, "/browse?q=dodge"],
    [{ q: "   " }, "/browse"],
    [{ sort: "new" as const, page: 1 }, "/browse"],
    [{ sort: "updated" as const }, "/browse?sort=updated"],
    [{ tag: "puzzle", page: 2 }, "/browse?tag=puzzle&page=2"],
    [{ tag: "puzzle", sort: "updated" as const, page: 3 }, "/browse?tag=puzzle&sort=updated&page=3"],
    [{ page: 3, sort: "top" as const, tag: "a", q: "x" }, "/browse?q=x&tag=a&sort=top&page=3"],
    [{ q: "a&b c", tag: "x/y" }, "/browse?q=a%26b+c&tag=x%2Fy"],
    [{ page: 0 }, "/browse"],
    [{ page: Number.NaN }, "/browse"],
  ])("%j -> %s", (p, want) => {
    expect(browsePath(p)).toBe(want);
  });
});

describe("legacyHomeRedirect", () => {
  it.each([
    ["", null],
    ["?utm=x", null],
    ["?", null],
    ["?q=", "/browse?q="],
    ["?tag=a&page=2", "/browse?tag=a&page=2"],
    ["?utm=x&sort=top", "/browse?utm=x&sort=top"],
    ["?page=2", "/browse?page=2"],
    ["q=dodge", "/browse?q=dodge"],
  ])("%j -> %j", (search, want) => {
    expect(legacyHomeRedirect(search)).toBe(want);
  });
});

describe("isValidSpotlight", () => {
  it("accepts a creator or null, with a games array", () => {
    expect(isValidSpotlight({ day: "2026-11-19", creator: creator("mia"), games: [] })).toBe(true);
    expect(isValidSpotlight({ day: "2026-11-19", creator: null, games: [] })).toBe(true);
  });
  it.each([
    null,
    undefined,
    "x",
    [],
    {},
    { day: 1, creator: null, games: [] },
    { day: "d", games: [] },
    { day: "d", creator: { user: null }, games: [] },
    { day: "d", creator: null, games: null },
    { day: "d", creator: null },
  ])("rejects %j", (x) => {
    expect(isValidSpotlight(x)).toBe(false);
  });
});

describe("moveItem", () => {
  const list = ["a", "b", "c"] as const;
  it("moves up and down", () => {
    expect(moveItem(list, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(list, 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(list, 2, -1)).toEqual(["a", "c", "b"]);
  });
  it("boundaries return an unchanged copy", () => {
    expect(moveItem(list, 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(list, 2, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem(list, 5, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(list, -1, 1)).toEqual(["a", "b", "c"]);
    expect(moveItem([], 0, 1)).toEqual([]);
  });
  it("never mutates the input and always returns a new array", () => {
    const src = ["a", "b"];
    const out = moveItem(src, 0, 1);
    expect(src).toEqual(["a", "b"]);
    expect(out).not.toBe(src);
    const same = moveItem(src, 0, -1);
    expect(same).not.toBe(src);
  });
});

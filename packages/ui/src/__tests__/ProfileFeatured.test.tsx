// F029 (F032 section 0.14): the Featured row on profile Overviews.
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSummary, ProfileStats, User, UserProfileResponse } from "../api/types";
import { WebGameRoutes } from "../WebGameApp";
import { game } from "./collectionFixtures";
import { leoUser, miaUser, page } from "./postFixtures";
import { makeClient, renderWith } from "./postRender";

const EMPTY_STATS: ProfileStats = { plays: 0, achievements: 0, screenshots: 0, collections: 0, posts: 0 };
const fav = (id: string, title: string) => game(id, title, { owner: { id: "u3", username: "kai", displayName: "Kai", avatarUrl: null } });

function profileOf(user: User, over: Partial<UserProfileResponse> = {}): UserProfileResponse {
  return {
    user,
    games: [game("g0", "Own Game", { owner: user })],
    gamesTotal: 1,
    followers: 0,
    following: 0,
    isFollowing: false,
    stats: { ...EMPTY_STATS, plays: 3 },
    ...over,
  };
}

async function setup(me: User | null, profiles: UserProfileResponse[]) {
  const client = makeClient(me);
  vi.spyOn(client, "listUserAchievements").mockResolvedValue([]);
  vi.spyOn(client, "listUserScreenshots").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 4 });
  vi.spyOn(client, "listUserCollections").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 6 });
  vi.spyOn(client, "listUserPosts").mockResolvedValue(page([], 0, 1, 20));
  vi.spyOn(client, "listGames").mockResolvedValue({ items: [game("g1", "Own One", { owner: miaUser })], total: 1, page: 1, perPage: 100 });
  let call = 0;
  const getUser = vi.spyOn(client, "getUser").mockImplementation(async () => profiles[Math.min(call++, profiles.length - 1)]);
  const save = vi.spyOn(client, "setFeaturedGames");
  await renderWith(client, <WebGameRoutes />, "/u/mia", me);
  return { client, getUser, save };
}

const featuredSection = () => document.querySelector<HTMLElement>("section.pf-profile-featured");

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("Profile Featured row (F029)", () => {
  it("visitor with featured games: the section comes first in the Overview, with no edit button", async () => {
    const featured: GameSummary[] = [fav("f1", "Fav One"), game("f2", "Fav Two")];
    await setup(leoUser, [profileOf(miaUser, { featured })]);
    const sec = featuredSection()!;
    expect(sec.getAttribute("aria-labelledby")).toBe("profile-featured-title");
    expect(within(sec).getByRole("heading", { level: 2, name: "Featured" }).id).toBe("profile-featured-title");
    expect(within(sec).getAllByRole("article").map((a) => within(a).getByRole("heading", { level: 3 }).textContent)).toEqual(["Fav One", "Fav Two"]);
    expect(sec.parentElement!.firstElementChild).toBe(sec);
    expect(within(sec).queryByRole("button", { name: /featured/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Feature games" })).toBeNull();
  });

  it("visitor with none: no section; older server (no featured): nothing, even for the owner", async () => {
    const { unmount } = await renderNone(leoUser, []);
    expect(featuredSection()).toBeNull();
    unmount();
    localStorage.clear();
    await renderNone(miaUser, undefined);
    expect(featuredSection()).toBeNull();
    expect(screen.queryByRole("button", { name: "Feature games" })).toBeNull();
  });

  it("the empty-Overview rule counts featured games", async () => {
    const base = profileOf(miaUser, { games: [], gamesTotal: 0, stats: EMPTY_STATS });
    await setup(leoUser, [{ ...base, featured: [fav("f1", "Fav One")] }]);
    expect(screen.queryByText("Nothing here yet")).toBeNull();
    expect(featuredSection()).not.toBeNull();
  });

  it("the empty-Overview rule still applies with nothing featured", async () => {
    const base = profileOf(miaUser, { games: [], gamesTotal: 0, stats: EMPTY_STATS });
    await setup(leoUser, [{ ...base, featured: [] }]);
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
  });

  it("owner with none: the panel text and Feature games", async () => {
    await setup(miaUser, [profileOf(miaUser, { featured: [] })]);
    const sec = featuredSection()!;
    const panel = sec.querySelector(".pf-featured-empty")!;
    expect(panel.querySelector("p")!.textContent).toBe("Pick up to 4 games to show first on your profile: your own or ones you love.");
    const btn = within(sec).getByRole("button", { name: "Feature games" });
    expect(btn.className).toContain("pf-btn pf-btn--sm");
    expect(within(sec).getByRole("heading", { name: "Featured" })).toBeTruthy();
  });

  it("owner with games: Edit featured (aria-label Edit featured games) opens the picker", async () => {
    await setup(miaUser, [profileOf(miaUser, { featured: [fav("f1", "Fav One")] })]);
    const btn = screen.getByRole("button", { name: "Edit featured games" });
    expect(btn.textContent).toBe("Edit featured");
    expect(btn.className).toContain("pf-btn pf-btn--ghost pf-btn--sm");
    await act(async () => fireEvent.click(btn));
    expect(screen.getByRole("dialog", { name: "Featured games" })).toBeTruthy();
  });

  it("saving from the empty panel: focus lands on Edit featured, and the profile reloads", async () => {
    const saved = [game("g1", "Own One", { owner: miaUser })];
    const { save, getUser } = await setup(miaUser, [profileOf(miaUser, { featured: [] })]);
    getUser.mockImplementation(async () => profileOf(miaUser, { featured: save.mock.calls.length > 0 ? saved : [] }));
    save.mockResolvedValue({ featured: saved });
    const callsBefore = getUser.mock.calls.length;
    const open = screen.getByRole("button", { name: "Feature games" });
    open.focus();
    await act(async () => fireEvent.click(open));
    const dialog = screen.getByRole("dialog", { name: "Featured games" });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Add Own One" })));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    await act(async () => {});
    expect(save).toHaveBeenCalledWith(["g1"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit featured games" }));
    expect(getUser.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(within(featuredSection()!).getByText("Own One")).toBeTruthy();
  });
});

async function renderNone(me: User, featured: GameSummary[] | undefined) {
  const client = makeClient(me);
  vi.spyOn(client, "listUserAchievements").mockResolvedValue([]);
  vi.spyOn(client, "listUserScreenshots").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 4 });
  vi.spyOn(client, "listUserCollections").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 6 });
  const p = profileOf(miaUser);
  if (featured) p.featured = featured;
  vi.spyOn(client, "getUser").mockResolvedValue(p);
  return renderWith(client, <WebGameRoutes />, "/u/mia", me);
}

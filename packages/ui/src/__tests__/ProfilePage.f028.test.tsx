import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { GameSummary, ProfileStats, User, UserProfileResponse } from "../api/types";
import { markCollectionsUnsupported } from "../components/collectionsSupport";
import { WebGameProviders, WebGameRoutes } from "../WebGameApp";
import { game } from "./collectionFixtures";

const mia: User = {
  id: "u7",
  username: "mia",
  displayName: "Mia",
  avatarUrl: null,
  bio: "I make games.",
  createdAt: "2024-03-15T12:00:00Z",
  role: "user",
  bannerUrl: "/media/banners/u7.jpg?v=2",
  links: [
    { label: "YouTube", url: "https://youtube.com/@mia" },
    { label: "", url: "https://www.mia.dev" },
    { label: "Evil", url: "javascript:alert(1)" },
  ],
};
const bob: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2025-01-01T00:00:00Z", role: "user", bannerUrl: null, links: [] };

const STATS: ProfileStats = { plays: 1234, achievements: 5, screenshots: 3, collections: 2 };
const games = (n: number, owner = mia): GameSummary[] => Array.from({ length: n }, (_, i) => game(`g${i}`, `Game ${i}`, { owner }));

function profileOf(user: User, over: Partial<UserProfileResponse> = {}): UserProfileResponse {
  return { user, games: games(2, user), gamesTotal: 2, followers: 10, following: 4, isFollowing: false, stats: STATS, ...over };
}

function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="location">{loc.pathname + loc.search}</p>;
}

type Opts = { me?: User | null; profile?: UserProfileResponse; collectionsUnsupported?: boolean };

async function setup(url: string, { me = null, profile = profileOf(mia), collectionsUnsupported = false }: Opts = {}) {
  if (me) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockImplementation(async () => {
    if (!me) throw new ApiError("unauthorized", "no", 401);
    return me;
  });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  vi.spyOn(client, "listUserAchievements").mockResolvedValue([]);
  vi.spyOn(client, "listUserScreenshots").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 4 });
  vi.spyOn(client, "listUserCollections").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 6 });
  const getUser = vi.spyOn(client, "getUser").mockImplementation(async (u) => {
    if (u.toLowerCase() === profile.user.username.toLowerCase()) return profile;
    throw new ApiError("not_found", "User not found", 404);
  });
  const listGames = vi.spyOn(client, "listGames").mockResolvedValue({ items: games(3), total: 3, page: 1, perPage: 24 });
  if (collectionsUnsupported) markCollectionsUnsupported(client);
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[url]}>
        <WebGameRoutes />
        <LocationProbe />
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (me) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
  return { client, getUser, listGames };
}

const location = () => screen.getByTestId("location").textContent;
const nav = () => screen.getByRole("navigation", { name: "Profile sections" });
const header = () => document.querySelector<HTMLElement>(".pf-profile")!;

afterEach(() => vi.restoreAllMocks());

describe("Profile header (F028 § 0.5)", () => {
  it("shows the banner, @username · Joined, safe links and stats from `stats`", async () => {
    await setup("/u/mia");
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    const banner = header().querySelector(".pf-profile__banner img")!;
    expect(banner.getAttribute("src")).toBe("http://api.test/media/banners/u7.jpg?v=2");
    expect(banner.getAttribute("alt")).toBe("");
    const joined = new Date("2024-03-15T12:00:00Z").toLocaleDateString(undefined, { year: "numeric", month: "long" });
    expect(within(header()).getByText(`@mia · Joined ${joined}`)).toBeTruthy();

    const list = within(header()).getByRole("list", { name: "Links" });
    const links = within(list).getAllByRole("link");
    expect(links).toHaveLength(2);
    // Review 11 M1: the real host is always shown next to the label.
    expect(links[0].textContent).toBe("🔗 YouTube · youtube.com (opens in a new tab)");
    expect(links[1].textContent).toContain("mia.dev");
    expect(links[1].textContent).not.toContain("www.");
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")!.split(" ")).toEqual(["noopener", "noreferrer", "nofollow", "ugc"]);
      expect(a.querySelector(".pf-sr-only")!.textContent).toBe(" (opens in a new tab)");
    }
    expect(header().innerHTML).not.toContain("javascript:");

    const stats = header().querySelector(".pf-profile__stats")!.textContent;
    expect(stats).toContain("2 games");
    expect(stats).toContain("1.2k plays");
    expect(stats).toContain("10 followers");
    expect(stats).toContain("4 following");
    expect(stats).toContain("5 achievements");
  });

  it("no banner image without bannerUrl; no plays/achievements without stats", async () => {
    await setup("/u/mia", { profile: profileOf({ ...mia, bannerUrl: null }, { stats: undefined }) });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(header().querySelector(".pf-profile__banner")).not.toBeNull();
    expect(header().querySelector(".pf-profile__banner img")).toBeNull();
    const stats = header().querySelector(".pf-profile__stats")!.textContent!;
    expect(stats).toContain("2 games");
    expect(stats).not.toMatch(/plays?\b/);
    expect(stats).not.toContain("achievement");
    // Section counts that depend on stats are omitted too.
    expect(within(nav()).getByRole("link", { name: "Screenshots" })).toBeTruthy();
  });

  it("own profile: Edit profile and Copy link, no Report", async () => {
    await setup("/u/mia", { me: mia });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    const actions = header().querySelector(".pf-profile__actions") as HTMLElement;
    expect(within(actions).getByRole("link", { name: "Edit profile" }).getAttribute("href")).toBe("/settings");
    expect(within(actions).getByRole("button", { name: /Copy link/ })).toBeTruthy();
    expect(within(actions).queryByRole("button", { name: /Report/ })).toBeNull();
    expect(within(actions).queryByRole("button", { name: /Follow/ })).toBeNull();
  });

  it("another user's profile: Follow, Copy link, ⚑ Report → 'Report profile: @mia'", async () => {
    await setup("/u/mia", { me: bob });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    const actions = header().querySelector(".pf-profile__actions") as HTMLElement;
    const buttons = within(actions)
      .getAllByRole("button")
      .map((b) => b.textContent!.trim());
    expect(buttons[0]).toMatch(/Follow/);
    expect(buttons[1]).toBe("🔗 Copy link");
    expect(buttons[2]).toBe("⚑ Report");
    await act(async () => fireEvent.click(within(actions).getByRole("button", { name: "⚑ Report" })));
    const dialog = screen.getByRole("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)!.textContent).toBe("Report profile: @mia");
  });
});

describe("Profile sections strip (F028 § 0.3–0.4)", () => {
  it("is a labelled nav of links with counts; Overview is current; Games keeps the header and focus", async () => {
    const { getUser } = await setup("/u/mia");
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    const overview = within(nav()).getByRole("link", { name: "Overview" });
    expect(overview.getAttribute("aria-current")).toBe("page");
    expect(overview.getAttribute("href")).toBe("/u/mia");
    const gamesLink = within(nav()).getByRole("link", { name: "Games 2" });
    expect(gamesLink.getAttribute("href")).toBe("/u/mia/games");
    expect(gamesLink.querySelector(".pf-profile-tabs__count")!.textContent).toBe("2");
    expect(within(nav()).getByRole("link", { name: "Screenshots 3" }).getAttribute("href")).toBe("/u/mia/screenshots");
    expect(within(nav()).getByRole("link", { name: "Collections 2" }).getAttribute("href")).toBe("/u/mia/collections");
    expect(nav().querySelector('[role="tab"]')).toBeNull();

    const headerEl = header();
    gamesLink.focus();
    await act(async () => fireEvent.click(gamesLink));
    expect(location()).toBe("/u/mia/games");
    expect(gamesLink.getAttribute("aria-current")).toBe("page");
    expect(overview.getAttribute("aria-current")).toBeNull();
    expect(document.activeElement).toBe(gamesLink);
    expect(header()).toBe(headerEl);
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("hides Collections when the server has no collections", async () => {
    await setup("/u/mia", { collectionsUnsupported: true });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(within(nav()).queryByRole("link", { name: /Collections/ })).toBeNull();
    expect(within(nav()).getAllByRole("link")).toHaveLength(3);
  });

  it("a 404 renders the player not-found page", async () => {
    await setup("/u/ghost");
    await waitFor(() => expect(document.querySelector(".pf-profile")).toBeNull());
    expect(screen.queryByRole("navigation", { name: "Profile sections" })).toBeNull();
  });
});

describe("Profile routes and redirects (F028 § 0.2)", () => {
  it("canonical username: /u/MIA/games?page=2 → /u/mia/games?page=2", async () => {
    const { listGames } = await setup("/u/MIA/games?page=2");
    await waitFor(() => expect(location()).toBe("/u/mia/games?page=2"));
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(listGames).toHaveBeenLastCalledWith({ owner: "mia", sort: "new", page: 2, perPage: 24 });
  });

  it("legacy paging: /u/mia?page=3 → /u/mia/games?page=3; ?page=1 stays on the Overview", async () => {
    await setup("/u/mia?page=3");
    await waitFor(() => expect(location()).toBe("/u/mia/games?page=3"));
  });

  it("?page=1 or junk on the bare profile URL renders the Overview", async () => {
    await setup("/u/mia?page=1");
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(location()).toBe("/u/mia?page=1");
    expect(within(nav()).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  });

  it("/me → /u/{me}", async () => {
    await setup("/me", { me: mia });
    await waitFor(() => expect(location()).toBe("/u/mia"));
    await screen.findByRole("heading", { level: 1, name: "Mia" });
  });

  it("/me signed out → /login?next=%2Fme", async () => {
    await setup("/me");
    await waitFor(() => expect(location()).toBe("/login?next=%2Fme"));
  });
});

describe("Overview (F028 § 0.7)", () => {
  it("shows the first 8 games and 'See all 30 games →'", async () => {
    await setup("/u/mia", { profile: profileOf(mia, { games: games(24), gamesTotal: 30 }) });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    const shelf = document.querySelector(".pf-profile-games")!;
    const titles = new Set(within(shelf as HTMLElement).getAllByText(/^Game \d+$/).map((e) => e.textContent));
    expect(titles.size).toBe(8);
    const more = within(shelf as HTMLElement).getByRole("link", { name: "See all 30 games →" });
    expect(more.getAttribute("href")).toBe("/u/mia/games");
    expect(document.title).toBe("Mia (@mia) · Pixelforge Arcade");
  });

  it("another user with 0 games: no Games section", async () => {
    await setup("/u/mia", { profile: profileOf(mia, { games: [], gamesTotal: 0 }) });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(screen.queryByRole("heading", { level: 2, name: "Games" })).toBeNull();
  });

  it("own profile with 0 games: the upload empty state", async () => {
    await setup("/u/mia", { me: mia, profile: profileOf(mia, { games: [], gamesTotal: 0 }) });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(screen.getByRole("heading", { level: 2, name: "Games" })).toBeTruthy();
    expect(screen.getByText("No games yet")).toBeTruthy();
    expect(screen.getByText("Your uploaded games will appear here.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload a game" })).toBeTruthy();
  });

  it("all-zero stats on another profile: only 'Nothing here yet'", async () => {
    await setup("/u/mia", {
      profile: profileOf(mia, { games: [], gamesTotal: 0, stats: { plays: 0, achievements: 0, screenshots: 0, collections: 0 } }),
    });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(screen.getByText("Mia hasn't shared anything yet.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Screenshots/ })).toBeNull();
  });
});

describe("Games and Screenshots sections (F028 § 0.8–0.9, 0.11)", () => {
  it("Games for another user: owner=username, page from the URL, title", async () => {
    const { listGames } = await setup("/u/mia/games?page=2");
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    await waitFor(() => expect(listGames).toHaveBeenCalledWith({ owner: "mia", sort: "new", page: 2, perPage: 24 }));
    expect(screen.getByRole("heading", { level: 2, name: "Games" })).toBeTruthy();
    expect(document.title).toBe("Games · Mia · Pixelforge Arcade");
  });

  it("Games for yourself: owner=me", async () => {
    const { listGames } = await setup("/u/mia/games", { me: mia });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    await waitFor(() => expect(listGames).toHaveBeenCalledWith({ owner: "me", sort: "new", page: 1, perPage: 24 }));
  });

  it("Games empty states, verbatim", async () => {
    const { client } = await setup("/u/mia");
    vi.spyOn(client, "listGames").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 24 });
    await act(async () => fireEvent.click(within(nav()).getByRole("link", { name: /^Games/ })));
    expect(await screen.findByText("Nothing here yet")).toBeTruthy();
    expect(screen.getByText("This player hasn't published any games.")).toBeTruthy();
  });

  it("Games own empty state", async () => {
    const { client } = await setup("/u/mia", { me: mia });
    vi.spyOn(client, "listGames").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 24 });
    await act(async () => fireEvent.click(within(nav()).getByRole("link", { name: /^Games/ })));
    expect(await screen.findByText("Your uploaded games will appear here.")).toBeTruthy();
    expect(screen.getByText("No games yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload a game" })).toBeTruthy();
  });

  it("Screenshots for another user with stats.screenshots 0: the empty state and title", async () => {
    await setup("/u/mia/screenshots", { profile: profileOf(mia, { stats: { ...STATS, screenshots: 0 } }) });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(screen.getByText("No screenshots yet")).toBeTruthy();
    expect(screen.getByText("Mia hasn't posted any screenshots.")).toBeTruthy();
    expect(document.title).toBe("Screenshots · Mia · Pixelforge Arcade");
  });

  it("Collections section title, inside the shell with an h2", async () => {
    await setup("/u/mia/collections");
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(screen.getByRole("heading", { level: 2, name: "Collections" })).toBeTruthy();
    expect(screen.queryByText(/Curated by/)).toBeNull();
    await waitFor(() => expect(document.title).toBe("Collections · Mia · Pixelforge Arcade"));
  });
});

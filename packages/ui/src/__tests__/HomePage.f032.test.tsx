// F032 sectioned home page `/` (spec section 0.1-0.8). Kept ASCII-only: non-ASCII characters are built with
// String.fromCodePoint.
import { act, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionSummary, CreatorSpotlight, GameSummary, ListGamesQuery, Page, TagCount } from "../api/types";
import { FollowButton } from "../components/Follow";
import { HomePage } from "../pages/HomePage";
import { creator, viewer } from "./creatorFixtures";
import { currentLocation, makeClient, renderWith } from "./postRender";

const ARROW = String.fromCodePoint(0x2192);
const SEE_ALL = `See all ${ARROW}`;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.title = "";
});

const game = (id: string, title: string, over: Partial<GameSummary> = {}): GameSummary => ({
  id,
  title,
  description: "",
  tags: [],
  owner: { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null },
  thumbnailUrl: null,
  plays: 10,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek: 0,
  ...over,
});
const games = (prefix: string, n: number, over: Partial<GameSummary> = {}) => Array.from({ length: n }, (_, i) => game(`${prefix}${i}`, `${prefix} game ${i}`, over));
const page = <T,>(items: T[], total = items.length): Page<T> => ({ items, total, page: 1, perPage: 24 });
const collection = (id: string, title: string): CollectionSummary => ({
  id,
  title,
  description: "",
  visibility: "public",
  owner: { id: "u3", username: "ana", displayName: "Ana", avatarUrl: null },
  gameCount: 3,
  coverUrls: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
} as CollectionSummary);

type Handlers = {
  top?: () => Promise<Page<GameSummary>>;
  trending?: () => Promise<Page<GameSummary>>;
  newest?: () => Promise<Page<GameSummary>>;
  updated?: () => Promise<Page<GameSummary>>;
  spotlight?: () => Promise<CreatorSpotlight>;
  collections?: () => Promise<Page<CollectionSummary>>;
  tags?: () => Promise<TagCount[]>;
};

const defaults: Required<Handlers> = {
  top: async () => page(games("top", 4)),
  trending: async () => page(games("hot", 8, { playsWeek: 5 })),
  newest: async () => page(games("new", 4), 40),
  updated: async () => page(games("upd", 4)),
  spotlight: async () => ({ day: "2026-11-19", creator: creator("mia", { bioExcerpt: "Makes games" }), games: games("spot", 4) }),
  collections: async () => page([collection("c1", "Best puzzles"), collection("c2", "Retro"), collection("c3", "Cozy")]),
  tags: async () => Array.from({ length: 15 }, (_, i) => ({ tag: `tag${i}`, count: 15 - i })),
};

async function setup(h: Handlers = {}, opts: { url?: string; signedIn?: boolean; extra?: ReactNode } = {}) {
  const me = opts.signedIn ? viewer : null;
  const client = makeClient(me);
  const all = { ...defaults, ...h };
  const listGames = vi.spyOn(client, "listGames").mockImplementation(async (q: ListGamesQuery = {}) => {
    if (q.sort === "top") return all.top();
    if (q.sort === "trending") return all.trending();
    if (q.sort === "updated") return all.updated();
    if (q.sort === "new") return all.newest();
    return page([]);
  });
  const spotlight = vi.spyOn(client, "getCreatorSpotlight").mockImplementation(() => all.spotlight());
  const collections = vi.spyOn(client, "listCollections").mockImplementation(() => all.collections());
  const tags = vi.spyOn(client, "listTags").mockImplementation(() => all.tags());
  const utils = await renderWith(
    client,
    <Routes>
      <Route
        path="/"
        element={
          <>
            <HomePage />
            {opts.extra}
          </>
        }
      />
      <Route path="/browse" element={<p>browse page</p>} />
    </Routes>,
    opts.url ?? "/",
    me,
  );
  return { ...utils, client, listGames, spotlight, collections, tags };
}

const sectionOf = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section")!;
const never = <T,>() => new Promise<T>(() => {});

describe("HomePage F032: requests and order", () => {
  it("starts the seven requests in parallel with the spec arguments", async () => {
    const { listGames, spotlight, collections, tags } = await setup();
    const sorts = listGames.mock.calls.map(([q]) => q);
    expect(sorts).toEqual(
      expect.arrayContaining([
        { sort: "top", perPage: 4 },
        { sort: "trending", perPage: 8 },
        { sort: "new", perPage: 4 },
        { sort: "updated", perPage: 4 },
      ]),
    );
    expect(listGames).toHaveBeenCalledTimes(4);
    expect(collections).toHaveBeenCalledWith({ perPage: 3 });
    expect(collections).toHaveBeenCalledTimes(1);
    expect(spotlight).toHaveBeenCalledTimes(1);
    expect(spotlight.mock.calls[0]).toEqual([]);
    expect(tags).toHaveBeenCalledTimes(1);
    expect(document.title).toBe("Pixelforge Arcade");
  });

  it("section headings in order, each section labelled by its h2, with the See all links", async () => {
    await setup();
    const h2s = Array.from(document.querySelectorAll("h2")).map((h) => h.textContent);
    expect(h2s).toEqual([
      "Featured",
      "Trending this week",
      "New releases",
      "Creator spotlight",
      "Recently updated",
      "Player collections",
      "Browse by tag",
    ]);
    const ids = ["pf-featured-title", "pf-trending-title", "pf-home-new-title", "pf-home-spotlight-title", "pf-home-updated-title", "pf-home-collections-title", "pf-home-tags-title"];
    expect(Array.from(document.querySelectorAll("section h2")).map((h) => h.id)).toEqual(ids);
    for (const id of ids) expect(document.getElementById(id)!.closest("section")!.getAttribute("aria-labelledby")).toBe(id);
    const more = (name: string) => within(sectionOf(name)).queryByRole("link", { name: new RegExp(`^See all`) });
    expect(more("Trending this week")!.getAttribute("href")).toBe("/browse?sort=trending");
    expect(more("New releases")!.getAttribute("href")).toBe("/browse");
    expect(more("Recently updated")!.getAttribute("href")).toBe("/browse?sort=updated");
    expect(more("Recently updated")!.textContent).toBe(SEE_ALL);
    expect(more("Featured")).toBeNull();
    expect(more("Player collections")).toBeNull();
    const creators = within(sectionOf("Creator spotlight")).getByRole("link", { name: `See all creators ${ARROW}` });
    expect(creators.getAttribute("href")).toBe("/creators");
  });

  it("shelves show 4 cards; collections 3 with owners", async () => {
    await setup();
    expect(within(sectionOf("New releases")).getAllByRole("article")).toHaveLength(4);
    expect(within(sectionOf("Recently updated")).getAllByRole("article")).toHaveLength(4);
    const cols = sectionOf("Player collections");
    expect(within(cols).getAllByRole("article")).toHaveLength(3);
    expect(within(cols).getAllByText("by Ana")).toHaveLength(3);
  });

  it("Start playing links to /browse", async () => {
    await setup();
    const cta = screen.getByRole("link", { name: "Start playing" });
    expect(cta.getAttribute("href")).toBe("/browse");
    expect(cta.className).toBe("pf-btn pf-btn--primary pf-btn--lg");
  });
});

describe("HomePage F032: section states", () => {
  it("loading: headings with skeletons", async () => {
    const { container } = await setup({ trending: never, newest: never, updated: never, spotlight: never, collections: never, tags: never });
    expect(sectionOf("New releases").querySelectorAll(".pf-card--skeleton")).toHaveLength(4);
    expect(sectionOf("Recently updated").querySelectorAll(".pf-card--skeleton")).toHaveLength(4);
    expect(sectionOf("Trending this week").querySelectorAll(".pf-card--skeleton")).toHaveLength(8);
    const spot = sectionOf("Creator spotlight");
    expect(spot.querySelectorAll(".pf-creator-card--skeleton")).toHaveLength(1);
    expect(spot.querySelectorAll(".pf-card--skeleton")).toHaveLength(3);
    expect(sectionOf("Player collections").querySelectorAll(".pf-card--skeleton")).toHaveLength(3);
    expect(sectionOf("Browse by tag").querySelectorAll(".pf-skeleton")).toHaveLength(6);
    expect(container.querySelector(".pf-empty")).toBeNull();
  });

  it("a failing section hides while the others render", async () => {
    const boom = async () => {
      throw new Error("boom");
    };
    await setup({ updated: boom, spotlight: boom, collections: boom, trending: boom });
    expect(screen.queryByRole("heading", { name: "Recently updated" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Creator spotlight" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Player collections" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Trending this week" })).toBeNull();
    expect(screen.getByRole("heading", { name: "New releases" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Browse by tag" })).toBeTruthy();
  });

  it("an empty section hides", async () => {
    await setup({ updated: async () => page([]), collections: async () => page([]), top: async () => page([]) });
    expect(screen.queryByRole("heading", { name: "Recently updated" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Player collections" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Featured" })).toBeNull();
    expect(screen.getByRole("heading", { name: "New releases" })).toBeTruthy();
  });

  it("empty platform: only the hero and No games yet", async () => {
    await setup({ newest: async () => page([], 0), top: async () => page([]), trending: async () => page([]), updated: async () => page([]) });
    expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No games yet" })).toBeTruthy();
    expect(screen.getByText("The arcade is empty. Be the first to ship a game!")).toBeTruthy();
    const upload = screen.getByRole("link", { name: "Upload the first one" });
    expect(upload.getAttribute("href")).toBe("/upload");
    expect(upload.className).toBe("pf-btn pf-btn--primary");
    expect(document.querySelectorAll("h2")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "Browse all games" })).toBeNull();
  });
});

describe("HomePage F032: creator spotlight", () => {
  it("CreatorCard with an h3 name, up to 3 games and the lead", async () => {
    await setup();
    const spot = sectionOf("Creator spotlight");
    expect(within(spot).getByText("A different creator every day.").className).toBe("pf-muted pf-small pf-home-spotlight__lead");
    expect(within(spot).getByRole("heading", { level: 3, name: "Mia" }).className).toBe("pf-creator-card__name");
    expect(within(spot).getByRole("article", { name: "Mia" })).toBeTruthy();
    expect(spot.querySelectorAll(".pf-card")).toHaveLength(3);
    expect(spot.querySelector(".pf-spotlight")).not.toBeNull();
  });

  it("hidden for creator: null and for an invalid response", async () => {
    const { unmount } = await setup({ spotlight: async () => ({ day: "2026-11-19", creator: null, games: [] }) });
    expect(screen.queryByRole("heading", { name: "Creator spotlight" })).toBeNull();
    unmount();
    await setup({ spotlight: async () => ({ day: 3, creator: { user: null }, games: "x" }) as unknown as CreatorSpotlight });
    expect(screen.queryByRole("heading", { name: "Creator spotlight" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Recently updated" })).toBeTruthy();
  });

  it("seeds the follow store from the creator", async () => {
    await setup(
      { spotlight: async () => ({ day: "2026-11-19", creator: creator("mia", { isFollowing: true, followers: 9 }), games: [] }) },
      {
        signedIn: true,
        extra: (
          <div data-testid="elsewhere">
            <FollowButton username="MIA" isFollowing={false} displayName="Mia elsewhere" />
          </div>
        ),
      },
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Following Mia elsewhere" }).getAttribute("data-following")).toBe("true"));
    expect(screen.getByRole("button", { name: "Following Mia" })).toBeTruthy();
  });
});

describe("HomePage F032: tags", () => {
  it("up to 12 chips linking to /browse?tag=, then Browse all games", async () => {
    await setup();
    const sec = sectionOf("Browse by tag");
    const chips = Array.from(sec.querySelectorAll<HTMLAnchorElement>("a.pf-chip"));
    expect(chips).toHaveLength(12);
    expect(chips[0].textContent).toBe("#tag0");
    expect(chips[0].getAttribute("href")).toBe("/browse?tag=tag0");
    const all = within(sec).getByRole("link", { name: "Browse all games" });
    expect(all.getAttribute("href")).toBe("/browse");
    expect(all.className).toBe("pf-btn pf-btn--primary");
  });

  it("Browse all games also shows when tags fail", async () => {
    await setup({
      tags: async () => {
        throw new Error("boom");
      },
    });
    const sec = sectionOf("Browse by tag");
    expect(sec.querySelectorAll("a.pf-chip")).toHaveLength(0);
    expect(within(sec).getByRole("link", { name: "Browse all games" }).getAttribute("href")).toBe("/browse");
  });
});

describe("HomePage F032: legacy redirects", () => {
  it.each([
    ["/?q=dodge", "/browse?q=dodge"],
    ["/?tag=arcade&page=2", "/browse?tag=arcade&page=2"],
    ["/?sort=top", "/browse?sort=top"],
    ["/?page=2", "/browse?page=2"],
  ])("%s ends at %s without loading the home sections", async (url, want) => {
    const { listGames, spotlight } = await setup({}, { url });
    expect(currentLocation()).toBe(want);
    expect(screen.getByText("browse page")).toBeTruthy();
    expect(spotlight).not.toHaveBeenCalled();
    expect(listGames).not.toHaveBeenCalled();
  });

  it("/?utm=x stays on home", async () => {
    await setup({}, { url: "/?utm=x" });
    expect(currentLocation()).toBe("/?utm=x");
    expect(screen.getByRole("heading", { name: "New releases" })).toBeTruthy();
  });

  it("the redirect replaces the history entry", async () => {
    // A MemoryRouter with two entries: going back from /browse lands on the first entry, not on the redirecting URL.
    const client = makeClient(null);
    vi.spyOn(client, "listGames").mockResolvedValue(page([]));
    const { MemoryRouter, useNavigate } = await import("react-router-dom");
    const { render } = await import("@testing-library/react");
    const { WebGameProviders } = await import("../WebGameApp");
    const { LocationProbe } = await import("./postRender");
    let nav: ((d: number) => void) | null = null;
    function Grab() {
      const n = useNavigate();
      nav = (d) => n(d);
      return null;
    }
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter initialEntries={["/creators", "/?tag=arcade"]} initialIndex={1}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/browse" element={<p>browse page</p>} />
            <Route path="/creators" element={<p>creators page</p>} />
          </Routes>
          <Grab />
          <LocationProbe />
        </MemoryRouter>
      </WebGameProviders>,
    );
    await act(async () => {});
    expect(currentLocation()).toBe("/browse?tag=arcade");
    await act(async () => nav!(-1));
    expect(currentLocation()).toBe("/creators");
  });
});

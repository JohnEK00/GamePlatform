// F003 Trending shelf on the home page. Since F032 the grid and its sort toggles live on /browse (their cases moved
// to BrowsePage.test.tsx), and the old `/?page=`, `/?q=` and `/?tag=` URLs redirect there.
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { GameSummary, ListGamesQuery, Page } from "../api/types";
import { HomePage } from "../pages/HomePage";
import { WebGameProviders } from "../WebGameApp";

const SEE_ALL = `See all ${String.fromCodePoint(0x2192)}`;
const FIRE = String.fromCodePoint(0x1f525);

const game = (id: string, title: string, playsWeek: number): GameSummary => ({
  id,
  title,
  description: "",
  tags: ["arcade"],
  owner: { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null },
  thumbnailUrl: null,
  plays: 100,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek,
});

const page = (items: GameSummary[], perPage = 24): Page<GameSummary> => ({ items, total: items.length, page: 1, perPage });

function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname + loc.search}</p>;
}

function makeClient(trending: (q: ListGamesQuery) => Promise<Page<GameSummary>>) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "listTags").mockResolvedValue([]);
  vi.spyOn(client, "getCreatorSpotlight").mockResolvedValue({ day: "2026-11-19", creator: null, games: [] });
  vi.spyOn(client, "listCollections").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 3 });
  const listGames = vi.spyOn(client, "listGames").mockImplementation(async (q: ListGamesQuery = {}) => {
    if (q.sort === "trending") return trending(q);
    if (q.sort === "top") return page([]);
    if (q.sort === "updated") return page([]);
    return page([game("m1", "New Game", 0)], 4);
  });
  return { client, listGames };
}

async function setup(path: string, trendingItems: GameSummary[]) {
  const { client, listGames } = makeClient(async (q) => page(q.perPage === 8 ? trendingItems : [], q.perPage ?? 24));
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/"
            element={
              <>
                <HomePage />
                <LocationProbe />
              </>
            }
          />
          <Route path="/browse" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  return { ...utils, client, listGames };
}

const shelfCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([q]) => (q as ListGamesQuery | undefined)?.sort === "trending" && (q as ListGamesQuery).perPage === 8);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HomePage F003", () => {
  it("shows the Trending this week shelf with weekly counts; See all goes to /browse?sort=trending", async () => {
    const { container, listGames } = await setup("/", [game("t1", "Hot Game", 1200), game("t2", "Cold Game", 0)]);
    expect(shelfCalls(listGames).length).toBe(1);
    const heading = screen.getByRole("heading", { name: "Trending this week" });
    expect(heading.id).toBe("pf-trending-title");
    const shelf = heading.closest("section")!;
    expect(shelf.getAttribute("aria-labelledby")).toBe("pf-trending-title");
    expect(shelf.textContent).toContain("Hot Game");
    // Only items with playsWeek > 0 show.
    expect(shelf.textContent).not.toContain("Cold Game");
    expect(shelf.querySelector(".pf-card__trending")!.textContent).toBe(`${FIRE} 1.2k plays this week`);
    const seeAll = shelf.querySelector<HTMLAnchorElement>(".pf-shelf__more")!;
    expect(seeAll.textContent).toBe(SEE_ALL);
    expect(seeAll.getAttribute("href")).toBe("/browse?sort=trending");
    // The other shelves keep the all-time count.
    expect(container.querySelectorAll(".pf-card__trending").length).toBe(1);
  });

  it("hides the shelf when no item has weekly plays", async () => {
    await setup("/", [game("t1", "Quiet A", 0), game("t2", "Quiet B", 0)]);
    expect(screen.queryByRole("heading", { name: "Trending this week" })).toBeNull();
    expect(screen.queryByText("Quiet A")).toBeNull();
  });

  it("hides the shelf silently when the request fails", async () => {
    const { client } = makeClient(async () => {
      throw new Error("boom");
    });
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter initialEntries={["/"]}>
          <HomePage />
        </MemoryRouter>
      </WebGameProviders>,
    );
    await act(async () => {});
    expect(screen.queryByRole("heading", { name: "Trending this week" })).toBeNull();
    expect(screen.getByText("New Game")).toBeTruthy();
  });

  it.each(["/?page=2", "/?q=dodge", "/?tag=arcade"])("%s redirects to /browse with the same query (no shelf request)", async (path) => {
    const { listGames } = await setup(path, [game("t1", "Hot Game", 50)]);
    expect(screen.getByTestId("loc").textContent).toBe(path.replace("/?", "/browse?"));
    expect(shelfCalls(listGames).length).toBe(0);
    expect(screen.queryByRole("heading", { name: "Trending this week" })).toBeNull();
  });
});

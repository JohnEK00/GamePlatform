import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { GameSummary, ListGamesQuery, Page } from "../api/types";
import { HomePage } from "../pages/HomePage";
import { WebGameProviders } from "../WebGameApp";

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

async function setup(path: string, trendingItems: GameSummary[]) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "listTags").mockResolvedValue([]);
  const listGames = vi.spyOn(client, "listGames").mockImplementation(async (q: ListGamesQuery = {}) => {
    if (q.sort === "trending" && q.perPage === 8) return page(trendingItems, 8);
    if (q.sort === "top" && q.perPage === 4) return page([]);
    return page([game("m1", "Main Grid Game", 0)]);
  });
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <HomePage />
                <LocationProbe />
              </>
            }
          />
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
  it("shows the Trending this week shelf on page 1 without filters, with weekly counts", async () => {
    const { container, listGames } = await setup("/", [game("t1", "Hot Game", 1200), game("t2", "Cold Game", 0)]);
    expect(shelfCalls(listGames).length).toBe(1);
    const heading = screen.getByRole("heading", { name: "Trending this week" });
    const shelf = heading.closest("section")!;
    expect(shelf.textContent).toContain("Hot Game");
    // Only items with playsWeek > 0 show.
    expect(shelf.textContent).not.toContain("Cold Game");
    expect(shelf.querySelector(".pf-card__trending")!.textContent).toBe("🔥 1.2k this week");
    const seeAll = screen.getByRole("link", { name: "See all →" });
    expect(seeAll.getAttribute("href")).toBe("/?sort=trending");
    // The main grid (sort=new) keeps the all-time count.
    expect(container.querySelectorAll(".pf-card__trending").length).toBe(1);
  });

  it("hides the shelf when no item has weekly plays", async () => {
    await setup("/", [game("t1", "Quiet A", 0), game("t2", "Quiet B", 0)]);
    expect(screen.queryByRole("heading", { name: "Trending this week" })).toBeNull();
    expect(screen.queryByText("Quiet A")).toBeNull();
  });

  it("hides the shelf silently when the request fails", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "listTags").mockResolvedValue([]);
    vi.spyOn(client, "listGames").mockImplementation(async (q: ListGamesQuery = {}) => {
      if (q.sort === "trending") throw new Error("boom");
      if (q.sort === "top") return page([]);
      return page([game("m1", "Main Grid Game", 0)]);
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
    expect(screen.getByText("Main Grid Game")).toBeTruthy();
  });

  it.each(["/?page=2", "/?q=dodge", "/?tag=arcade"])("does not show the shelf on %s", async (path) => {
    const { listGames } = await setup(path, [game("t1", "Hot Game", 50)]);
    expect(shelfCalls(listGames).length).toBe(0);
    expect(screen.queryByRole("heading", { name: "Trending this week" })).toBeNull();
  });

  it("the Trending tab sets ?sort=trending and the main grid shows weekly counts", async () => {
    const { listGames } = await setup("/?page=2", []);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs.slice(0, 2)).toEqual(["New", "Trending"]);
    listGames.mockImplementation(async (q: ListGamesQuery = {}) =>
      q.sort === "trending" && q.perPage === 24 ? page([game("m2", "Weekly Hit", 7)]) : page([]),
    );
    await act(async () => fireEvent.click(screen.getByRole("tab", { name: "Trending" })));
    expect(screen.getByTestId("loc").textContent).toBe("/?sort=trending");
    expect(listGames).toHaveBeenCalledWith(expect.objectContaining({ sort: "trending", page: 1, perPage: 24 }));
    expect(screen.getByRole("tab", { name: "Trending" }).getAttribute("aria-selected")).toBe("true");
    const card = screen.getByText("Weekly Hit").closest("article")!;
    expect(card.querySelector(".pf-card__trending")!.textContent).toBe("🔥 7 this week");
  });
});

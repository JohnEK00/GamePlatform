// F032 /browse: the full sortable grid that used to live on `/` (including the F003 cases moved from
// HomePage.f003.test.tsx). Kept ASCII-only: non-ASCII characters are built with String.fromCodePoint.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { GameSummary, ListGamesQuery, Page } from "../api/types";
import { BrowsePage } from "../pages/BrowsePage";
import { WebGameProviders } from "../WebGameApp";

const LQ = String.fromCodePoint(0x201c);
const RQ = String.fromCodePoint(0x201d);
const FIRE = String.fromCodePoint(0x1f525);
const DOT = String.fromCodePoint(0xb7);

const game = (id: string, title: string, playsWeek = 0): GameSummary => ({
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

const page = (items: GameSummary[], total = items.length): Page<GameSummary> => ({ items, total, page: 1, perPage: 24 });

function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname + loc.search}</p>;
}
const loc = () => screen.getByTestId("loc").textContent;

async function setup(path: string, impl?: (q: ListGamesQuery) => Promise<Page<GameSummary>>) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "listTags").mockResolvedValue([{ tag: "arcade", count: 3 }]);
  const listGames = vi.spyOn(client, "listGames").mockImplementation(impl ?? (async () => page([game("m1", "Main Grid Game")])));
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/browse"
            element={
              <>
                <BrowsePage />
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

const h1 = () => document.getElementById("pf-browse-title")!;

afterEach(() => {
  vi.restoreAllMocks();
  document.title = "";
});

describe("BrowsePage (F032)", () => {
  it.each([
    ["/browse", "Browse games", `Browse games ${DOT} Pixelforge Arcade`],
    ["/browse?q=dodge", `Results for ${LQ}dodge${RQ}`, `Search: dodge ${DOT} Pixelforge Arcade`],
    ["/browse?tag=arcade", "#arcade", `#arcade ${DOT} Pixelforge Arcade`],
  ])("%s: h1 and document title", async (path, heading, title) => {
    await setup(path);
    expect(h1().tagName).toBe("H1");
    expect(h1().className).toContain("pf-section-title");
    expect(h1().textContent).toBe(`${heading}1`);
    expect(h1().querySelector(".pf-section-title__count")!.textContent).toBe("1");
    expect(document.title).toBe(title);
    const section = document.getElementById("pf-browse")!;
    expect(section.getAttribute("aria-labelledby")).toBe("pf-browse-title");
  });

  it("has no hero, Featured or Trending shelf", async () => {
    const { listGames } = await setup("/browse");
    expect(document.querySelector(".pf-hero")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Featured" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Trending this week" })).toBeNull();
    expect(listGames).toHaveBeenCalledTimes(1);
    expect(listGames).toHaveBeenCalledWith({ q: "", tag: "", sort: "new", page: 1, perPage: 24 });
  });

  it("six sort toggles with Recently updated last; selecting it writes ?sort=updated", async () => {
    const { listGames } = await setup("/browse?page=3");
    // N6: the sort strip is a toggle-button group, not a tab list.
    expect(screen.queryAllByRole("tab")).toEqual([]);
    const group = screen.getByRole("group", { name: "Sort games" });
    const labels = Array.from(group.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["New", "Trending", "Popular", "Top rated", "Most favorited", "Recently updated"]);
    expect(screen.getByRole("button", { name: "New" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Recently updated" })));
    expect(loc()).toBe("/browse?sort=updated");
    expect(listGames).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "updated", page: 1 }));
    expect(screen.getByRole("button", { name: "Recently updated" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "New" }).getAttribute("aria-pressed")).toBe("false");
    // Back to New drops sort from the URL.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New" })));
    expect(loc()).toBe("/browse");
  });

  it("an unknown sort shows New", async () => {
    const { listGames } = await setup("/browse?sort=bogus");
    expect(listGames).toHaveBeenCalledWith(expect.objectContaining({ sort: "new" }));
    expect(screen.getByRole("button", { name: "New" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the Trending toggle sets ?sort=trending and the grid shows weekly counts (moved F003 case)", async () => {
    const { listGames } = await setup("/browse?page=2", async () => page([]));
    listGames.mockImplementation(async (q: ListGamesQuery = {}) => (q.sort === "trending" && q.perPage === 24 ? page([game("m2", "Weekly Hit", 7)]) : page([])));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Trending" })));
    expect(loc()).toBe("/browse?sort=trending");
    expect(listGames).toHaveBeenCalledWith(expect.objectContaining({ sort: "trending", page: 1, perPage: 24 }));
    const card = screen.getByText("Weekly Hit").closest("article")!;
    expect(card.querySelector(".pf-card__trending")!.textContent).toBe(`${FIRE} 7 plays this week`);
  });

  it("unfiltered sort=updated with no items: No updated games yet; Show all games removes sort and page", async () => {
    await setup("/browse?sort=updated&page=2", async () => page([]));
    expect(screen.getByRole("heading", { name: "No updated games yet" })).toBeTruthy();
    expect(screen.getByText("Games show up here after their creators publish an update.")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show all games" })));
    expect(loc()).toBe("/browse");
  });

  it("filtered and unfiltered empty states keep their texts", async () => {
    const { unmount } = await setup("/browse?sort=updated&tag=arcade", async () => page([]));
    expect(screen.getByRole("heading", { name: "No games match" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Clear filters" })));
    expect(loc()).toBe("/browse");
    unmount();
    await setup("/browse", async () => page([]));
    expect(screen.getByRole("heading", { name: "No games yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Upload the first one" }).getAttribute("href")).toBe("/upload");
  });

  it("tag chips filter in place; the active-filter chip removes the filter", async () => {
    await setup("/browse?q=dodge");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "#arcade" })));
    expect(loc()).toBe("/browse?q=dodge&tag=arcade");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: `${LQ}dodge${RQ} ${String.fromCodePoint(0xd7)}` })));
    expect(loc()).toBe("/browse?tag=arcade");
  });

  it("pagination writes ?page=2 and scrolls to the grid", async () => {
    const scroll = vi.fn();
    const { listGames } = await setup("/browse", async () => page([game("m1", "Main Grid Game")], 60));
    document.getElementById("pf-browse")!.scrollIntoView = scroll;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "2" })));
    expect(loc()).toBe("/browse?page=2");
    expect(listGames).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(scroll).toHaveBeenCalled();
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeTruthy();
  });
});

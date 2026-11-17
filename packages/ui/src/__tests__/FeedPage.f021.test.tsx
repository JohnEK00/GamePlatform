import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { FeedItem, FeedPage as FeedPageData, GameSummary, User } from "../api/types";
import { FEED_TAB_KEY, FeedPage } from "../pages/FeedPage";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

const game: GameSummary = {
  id: "g1",
  title: "Space Dodge",
  description: "",
  tags: [],
  owner: { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null },
  thumbnailUrl: null,
  plays: 0,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek: 0,
};

const collItem: FeedItem = {
  id: "9",
  kind: "collectionUpdated",
  actor: { id: "u5", username: "mia", displayName: "Mia", avatarUrl: null },
  game,
  reason: "following",
  createdAt: "2026-01-01T00:00:00Z",
  version: null,
  score: null,
  achievement: null,
  collection: { id: "col-1", title: "Cozy games", path: "/c/col-1", games: [{ game, note: "" }], gameCount: 1 },
};

async function setup(getFeed: (q: Parameters<ApiClient["getFeed"]>[0]) => Promise<FeedPageData>) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  const feed = vi.spyOn(client, "getFeed").mockImplementation(async (q) => getFeed(q));
  const suggestions = vi
    .spyOn(client, "getFeedSuggestions")
    .mockResolvedValue([{ user: { id: "u3", username: "kim", displayName: "Kim", avatarUrl: null }, reason: "popular", games: 2 }]);
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <FeedPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  return { feed, suggestions };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("FeedPage: Collections tab (F021)", () => {
  it("has three tabs in order", async () => {
    await setup(async () => ({ items: [], nextCursor: null }));
    await screen.findByText("Your feed is empty");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Everything", "New games", "Collections"]);
  });

  it("requests kinds=collectionUpdated, remembers the tab and shows its empty state with suggestions", async () => {
    const { feed } = await setup(async () => ({ items: [], nextCursor: null }));
    await screen.findByText("Your feed is empty");
    fireEvent.click(screen.getByRole("tab", { name: "Collections" }));
    await waitFor(() => expect(feed).toHaveBeenLastCalledWith({ kinds: ["collectionUpdated"] }, expect.any(AbortSignal)));
    expect(localStorage.getItem(FEED_TAB_KEY)).toBe("collections");
    expect(screen.getByRole("tab", { name: "Collections" }).getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel", { name: "Collections" });
    expect(await screen.findByText("No collection updates yet.")).toBeTruthy();
    expect(panel.textContent).toContain("Follow players who curate collections to see their picks here.");
    expect(await screen.findByText("Suggested creators")).toBeTruthy();
  });

  it("the client sends kinds=collectionUpdated on the wire", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new ApiClient({ baseUrl: "http://api.test" });
      await client.getFeed({ kinds: ["collectionUpdated"] });
      const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
      expect(url).toContain("kinds=collectionUpdated");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores the remembered Collections tab and renders collection items", async () => {
    localStorage.setItem(FEED_TAB_KEY, "collections");
    const { feed } = await setup(async () => ({ items: [collItem], nextCursor: null }));
    expect(feed.mock.calls[0][0]).toEqual({ kinds: ["collectionUpdated"] });
    expect(await screen.findByText((_, el) => el?.className === "pf-feeditem__text" && el.textContent === "Mia added Space Dodge to Cozy games")).toBeTruthy();
  });

  it("an unknown stored tab falls back to Everything", async () => {
    localStorage.setItem(FEED_TAB_KEY, "bogus");
    const { feed } = await setup(async () => ({ items: [], nextCursor: null }));
    expect(feed.mock.calls[0][0]).toEqual({ kinds: undefined });
    expect(screen.getByRole("tab", { name: "Everything" }).getAttribute("aria-selected")).toBe("true");
  });
});

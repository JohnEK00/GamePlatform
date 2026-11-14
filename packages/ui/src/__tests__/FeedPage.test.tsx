import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { FeedItem, FeedPage as FeedPageData, GameSummary, User } from "../api/types";
import { FEED_TAB_KEY, FeedPage } from "../pages/FeedPage";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

const game = (id: string, title: string): GameSummary => ({
  id,
  title,
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
});

const item = (id: string, title: string): FeedItem => ({
  id,
  kind: "gamePublished",
  actor: { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null },
  game: game(`g${id}`, title),
  reason: "following",
  createdAt: "2026-01-01T00:00:00Z",
  version: 1,
  score: null,
  achievement: null,
});

async function setup(getFeed: (q: Parameters<ApiClient["getFeed"]>[0]) => Promise<FeedPageData>) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  const feed = vi.spyOn(client, "getFeed").mockImplementation(async (q) => getFeed(q));
  const suggestions = vi.spyOn(client, "getFeedSuggestions").mockResolvedValue([
    { user: { id: "u3", username: "kim", displayName: "Kim", avatarUrl: null }, reason: "favorited", games: 3 },
    { user: { id: "u4", username: "lee", displayName: "Lee", avatarUrl: null }, reason: "popular", games: 1 },
  ]);
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <FeedPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  return { client, feed, suggestions };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FeedPage", () => {
  it("load more appends the next page with the cursor and hides when nextCursor is null", async () => {
    const { feed } = await setup(async (q) =>
      q?.cursor === "2" ? { items: [item("1", "Gamma")], nextCursor: null } : { items: [item("3", "Alpha"), item("2", "Beta")], nextCursor: "2" },
    );
    expect((await screen.findAllByRole("link", { name: "Alpha" })).length).toBe(2);
    expect(screen.queryAllByRole("link", { name: "Gamma" })).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    expect((await screen.findAllByRole("link", { name: "Gamma" })).length).toBe(2);
    expect(feed).toHaveBeenLastCalledWith({ cursor: "2", kinds: undefined }, expect.any(AbortSignal));
    const titles = Array.from(document.querySelectorAll(".pf-feeditem__gametitle")).map((e) => e.textContent);
    expect(titles).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("empty feed shows the empty state, suggestions and a refresh button after following", async () => {
    const { client, suggestions, feed } = await setup(async () => ({ items: [], nextCursor: null }));
    expect(await screen.findByText("Your feed is empty")).toBeTruthy();
    expect(screen.getByText("Follow creators to see their new games and high scores here.")).toBeTruthy();
    expect(await screen.findByRole("link", { name: /Kim/ })).toBeTruthy();
    expect(suggestions).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/3 games · You favorited their games/)).toBeTruthy();
    expect(screen.getByText(/1 game · Popular creator/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh feed" })).toBeNull();

    vi.spyOn(client, "setFollowing").mockResolvedValue({ following: true, followers: 9 });
    fireEvent.click(screen.getByRole("button", { name: "Follow Kim" }));
    const refresh = await screen.findByRole("button", { name: "Refresh feed" });
    expect(client.setFollowing).toHaveBeenCalledWith("kim", true);
    fireEvent.click(refresh);
    await waitFor(() => expect(feed).toHaveBeenCalledTimes(2));
  });

  it("switching to New games sends kinds, remembers the tab and has its own empty text", async () => {
    const { feed } = await setup(async () => ({ items: [], nextCursor: null }));
    await screen.findByText("Your feed is empty");
    expect(feed).toHaveBeenLastCalledWith({ kinds: undefined }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("tab", { name: "New games" }));
    await waitFor(() => expect(feed).toHaveBeenLastCalledWith({ kinds: ["gamePublished", "gameUpdated"] }, expect.any(AbortSignal)));
    expect(await screen.findByText("No new games from people you follow yet.")).toBeTruthy();
    expect(screen.queryByText("Suggested creators")).toBeNull();
    expect(localStorage.getItem(FEED_TAB_KEY)).toBe("games");
    expect(screen.getByRole("tab", { name: "New games" }).getAttribute("aria-selected")).toBe("true");
  });

  it("restores the remembered tab and shows a retryable error", async () => {
    localStorage.setItem(FEED_TAB_KEY, "games");
    let fail = true;
    const { feed } = await setup(async () => {
      if (fail) throw new Error("offline");
      return { items: [item("5", "Delta")], nextCursor: null };
    });
    expect(feed.mock.calls[0][0]).toEqual({ kinds: ["gamePublished", "gameUpdated"] });
    expect(await screen.findByText("offline")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findAllByRole("link", { name: "Delta" })).length).toBe(2);
  });
});

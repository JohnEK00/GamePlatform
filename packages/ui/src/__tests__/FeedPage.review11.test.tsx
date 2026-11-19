// Review 11 M2: a feed page whose items are all unknown or filtered out must not claim the feed is empty.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { FeedItem, FeedPage as FeedPageData, GameSummary, User } from "../api/types";
import { FEED_MAX_SKIP_FETCHES, FeedPage } from "../pages/FeedPage";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

const game = (id: string, title: string): GameSummary => ({
  id,
  title,
  description: "",
  tags: [],
  owner: { id: "u2", username: "mia", displayName: "Mia", avatarUrl: null },
  thumbnailUrl: null,
  plays: 0,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek: 0,
});

const known = (id: string, title: string): FeedItem => ({
  id,
  kind: "gamePublished",
  actor: { id: "u2", username: "mia", displayName: "Mia", avatarUrl: null },
  game: game(`g${id}`, title),
  reason: "following",
  createdAt: "2026-11-01T10:00:00.000Z",
  version: 1,
  score: null,
  achievement: null,
});

/** 20 items of a kind this client doesn't know (what a pre-F030 client sees for postCreated), ids top..top-19. */
const unknownPage = (top: number): FeedItem[] =>
  Array.from(
    { length: 20 },
    (_, i) =>
      ({
        id: String(top - i),
        kind: "futureKind",
        actor: { id: "u2", username: "mia", displayName: "Mia", avatarUrl: null },
        game: null,
        reason: "following",
        createdAt: "2026-11-01T10:00:00.000Z",
      }) as unknown as FeedItem,
  );

async function setup(getFeed: (q: Parameters<ApiClient["getFeed"]>[0]) => Promise<FeedPageData>) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test", fetch: (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  vi.spyOn(client, "getFeedSuggestions").mockResolvedValue([]);
  const feed = vi.spyOn(client, "getFeed").mockImplementation(async (q) => getFeed(q));
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <FeedPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await waitFor(() => expect(feed).toHaveBeenCalled());
  for (let i = 0; i < 10; i++) await act(async () => {});
  return { feed };
}

const cursors = (feed: { mock: { calls: unknown[][] } }) => feed.mock.calls.map((c) => (c[0] as { cursor?: string } | undefined)?.cursor);

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("FeedPage: pages of unknown or filtered-out items (review 11 M2)", () => {
  it("the repro: a first page of only unknown items with nextCursor fetches the next page automatically", async () => {
    const { feed } = await setup(async (q) =>
      q?.cursor === "81" ? { items: [known("80", "Older Game")], nextCursor: null } : { items: unknownPage(100), nextCursor: "81" },
    );
    expect(cursors(feed)).toEqual([undefined, "81"]);
    expect((await screen.findAllByRole("link", { name: "Older Game" })).length).toBeGreaterThan(0);
    expect(screen.queryByText("Your feed is empty")).toBeNull();
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("keeps the fetched cursor for Load more when the skipped-to page has more", async () => {
    const { feed } = await setup(async (q) =>
      q?.cursor === "81"
        ? { items: [known("80", "Page Two Game")], nextCursor: "79" }
        : q?.cursor === "79"
          ? { items: [known("78", "Page Three Game")], nextCursor: null }
          : { items: unknownPage(100), nextCursor: "81" },
    );
    expect(cursors(feed)).toEqual([undefined, "81"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /load more/i }));
    });
    expect(cursors(feed)).toEqual([undefined, "81", "79"]);
    expect(screen.getAllByRole("link", { name: "Page Three Game" }).length).toBeGreaterThan(0);
  });

  it("caps the automatic fetches at 5 extra per load and then shows Load more, not the empty state", async () => {
    // Every page is unknown items and there is always another one.
    const { feed } = await setup(async (q) => {
      const top = q?.cursor ? Number(q.cursor) : 1000;
      return { items: unknownPage(top), nextCursor: String(top - 20) };
    });
    expect(FEED_MAX_SKIP_FETCHES).toBe(5);
    expect(feed).toHaveBeenCalledTimes(1 + 5);
    expect(screen.queryByText("Your feed is empty")).toBeNull();
    expect(screen.getByText("Nothing to show here yet. Load more to see older activity.")).toBeTruthy();
    const more = screen.getByRole("button", { name: /load more/i });
    // Load more continues from the last cursor, again with at most 5 extra fetches.
    await act(async () => {
      fireEvent.click(more);
    });
    for (let i = 0; i < 10; i++) await act(async () => {});
    expect(feed).toHaveBeenCalledTimes(2 * (1 + 5));
    expect(cursors(feed)[6]).toBe(String(1000 - 6 * 20));
    expect(screen.getByRole("button", { name: /load more/i })).toBeTruthy();
  });

  it("shows the empty state only when the server has no more pages", async () => {
    const { feed } = await setup(async (q) =>
      q?.cursor === "81" ? { items: unknownPage(80), nextCursor: null } : { items: unknownPage(100), nextCursor: "81" },
    );
    expect(cursors(feed)).toEqual([undefined, "81"]);
    expect(screen.getByText("Your feed is empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /load more/i })).toBeNull();
  });

  it("a normal first page fetches once", async () => {
    const { feed } = await setup(async () => ({ items: [known("5", "Alpha")], nextCursor: "4" }));
    expect(feed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /load more/i })).toBeTruthy();
    expect(screen.queryByText("Nothing to show here yet. Load more to see older activity.")).toBeNull();
  });
});

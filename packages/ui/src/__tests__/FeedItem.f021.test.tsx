import { render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client";
import type { FeedCollection, FeedCollectionGame, FeedItem as FeedItemData, GameSummary } from "../api/types";
import { FEED_ITEM_KINDS, FeedItem, isKnownFeedItem } from "../components/FeedItem";
import { WebGameProviders } from "../WebGameApp";

const game = (id: string, title: string, owner = "Sam"): GameSummary => ({
  id,
  title,
  description: "",
  tags: [],
  owner: { id: `o-${owner}`, username: owner.toLowerCase(), displayName: owner, avatarUrl: null },
  thumbnailUrl: `/media/thumbnails/${id}.png`,
  plays: 0,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek: 0,
});

const entry = (id: string, title: string, note = "", owner?: string): FeedCollectionGame => ({ game: game(id, title, owner), note });

const coll = (games: FeedCollectionGame[], gameCount = games.length): FeedCollection => ({
  id: "col-1",
  title: "Cozy games",
  path: "/c/col-1",
  games,
  gameCount,
});

const item = (collection: FeedCollection | null): FeedItemData => ({
  id: "50",
  kind: "collectionUpdated",
  actor: { id: "u5", username: "mia", displayName: "Mia", avatarUrl: null },
  game: collection?.games[0]?.game ?? game("g0", "Nothing"),
  reason: "following",
  createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  version: null,
  score: null,
  achievement: null,
  collection,
});

function show(feedItem: FeedItemData) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const { container } = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <div data-testid="root">
          <FeedItem item={feedItem} />
        </div>
      </MemoryRouter>
    </WebGameProviders>,
  );
  const text = container.querySelector(".pf-feeditem__text")?.textContent ?? null;
  return { container, text };
}

describe("FeedItem: collectionUpdated (F021)", () => {
  it("is a known kind", () => {
    expect(FEED_ITEM_KINDS).toContain("collectionUpdated");
    expect(isKnownFeedItem({ kind: "collectionUpdated" })).toBe(true);
  });

  it("one game: the game title is in the sentence, with links to the actor, the game and the collection", () => {
    const { container, text } = show(item(coll([entry("g1", "Space Dodge", "So relaxing")])));
    expect(text).toBe("Mia added Space Dodge to Cozy games");
    const p = container.querySelector(".pf-feeditem__text") as HTMLElement;
    expect(within(p).getByRole("link", { name: "Mia" }).getAttribute("href")).toBe("/u/mia");
    expect(within(p).getByRole("link", { name: "Space Dodge" }).getAttribute("href")).toBe("/games/g1");
    expect(within(p).getByRole("link", { name: "Cozy games" }).getAttribute("href")).toBe("/c/col-1");
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelector("article")!.getAttribute("data-kind")).toBe("collectionUpdated");
    expect(container.querySelector("time")!.textContent).toBe("3 hours ago");
    const icon = container.querySelector(".pf-feeditem__kindicon")!;
    expect(icon.textContent).toBe("📚");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
  });

  it("three games: 'added 3 games', the list with thumbnails, owners and quoted notes (omitted when empty)", () => {
    const { container, text } = show(
      item(coll([entry("g1", "Space Dodge", "So relaxing"), entry("g2", "Pixel Peaks", "", "Ava"), entry("g3", "Moon Farm", "<b>not html</b>")])),
    );
    expect(text).toBe("Mia added 3 games to Cozy games");
    const list = container.querySelector("ul.pf-feed-collection-games") as HTMLElement;
    const rows = list.querySelectorAll("li.pf-feed-collection-games__item");
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "Space Dodge" }).getAttribute("href")).toBe("/games/g1");
    expect(within(rows[1] as HTMLElement).getByRole("link", { name: "Pixel Peaks" }).getAttribute("href")).toBe("/games/g2");
    expect(rows[0].querySelector("img")!.getAttribute("alt")).toBe("");
    expect(rows[0].querySelector("img")!.getAttribute("src")).toBe("http://api.test/media/thumbnails/g1.png");
    expect(rows[0].querySelector(".pf-feed-collection-games__owner")!.textContent).toBe(" by Sam");
    expect(rows[1].querySelector(".pf-feed-collection-games__owner")!.textContent).toBe(" by Ava");
    const note = rows[0].querySelector(".pf-feed-collection-games__note")!;
    expect(note.textContent).toBe("“So relaxing”");
    expect(note.getAttribute("title")).toBe("So relaxing");
    expect(rows[1].querySelector(".pf-feed-collection-games__note")).toBeNull();
    // Notes are text, never HTML.
    expect(rows[2].querySelector(".pf-feed-collection-games__note")!.textContent).toBe("“<b>not html</b>”");
    expect(rows[2].querySelector("b")).toBeNull();
    expect(list.querySelector(".pf-feed-collection-games__more")).toBeNull();
  });

  it("'+N more' links to the collection when gameCount > games.length", () => {
    const games = [entry("g1", "A"), entry("g2", "B"), entry("g3", "C"), entry("g4", "D")];
    const { container, text } = show(item(coll(games, 7)));
    expect(text).toBe("Mia added 7 games to Cozy games");
    expect(container.querySelectorAll("li.pf-feed-collection-games__item")).toHaveLength(4);
    const more = within(container.querySelector(".pf-feed-collection-games__more") as HTMLElement).getByRole("link");
    expect(more.textContent).toBe("+3 more in Cozy games");
    expect(more.getAttribute("href")).toBe("/c/col-1");
  });

  it("collection: null, a missing collection or empty games render nothing", () => {
    expect(show(item(null)).container.querySelector("article")).toBeNull();
    const missing = item(null);
    delete (missing as Partial<FeedItemData>).collection;
    expect(show(missing).container.querySelector("article")).toBeNull();
    expect(show(item(coll([], 3))).container.querySelector("article")).toBeNull();
  });
});

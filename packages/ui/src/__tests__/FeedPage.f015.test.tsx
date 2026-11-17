import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { FeedItem, FeedPage as FeedPageData, GameSummary, Screenshot, User } from "../api/types";
import { FEED_TAB_KEY, FeedPage } from "../pages/FeedPage";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "admin" };
const mia = { id: "u5", username: "mia", displayName: "Mia", avatarUrl: null };
const kim = { id: "u6", username: "kim", displayName: "Kim", avatarUrl: null };

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

const shot = (id: string): Screenshot => ({
  id,
  gameId: "g1",
  author: mia,
  caption: "",
  imageUrl: `/media/screenshots/${id}.png`,
  thumbUrl: `/media/screenshots/${id}_t.jpg`,
  width: 1280,
  height: 720,
  gameVersion: 1,
  createdAt: "2026-11-14T15:30:12Z",
  canDelete: true,
});

const shotItem = (id: string, actor = mia): FeedItem => ({
  id,
  kind: "screenshotPosted",
  actor,
  game,
  reason: "following",
  createdAt: "2026-11-14T15:30:12Z",
  version: null,
  score: null,
  achievement: null,
  collection: null,
  screenshots: { count: 1, items: [shot(`s${id}`)] },
});

async function setup(getFeed: (q: Parameters<ApiClient["getFeed"]>[0]) => Promise<FeedPageData>) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "deleteScreenshot").mockResolvedValue(undefined);
  const feed = vi.spyOn(client, "getFeed").mockImplementation(async (q) => getFeed(q));
  const suggestions = vi
    .spyOn(client, "getFeedSuggestions")
    .mockResolvedValue([{ user: { id: "u3", username: "lee", displayName: "Lee", avatarUrl: null }, reason: "popular", games: 2 }]);
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <FeedPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  return { feed, suggestions };
}

async function deleteFirstShotOf(article: HTMLElement) {
  fireEvent.click(within(article).getAllByRole("button", { name: /^Screenshot/ })[0]);
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  const confirm = screen.getAllByRole("dialog").at(-1)!;
  await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

const articles = () => Array.from(document.querySelectorAll<HTMLElement>("article.pf-feeditem"));

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("FeedPage: Screenshots tab (F015 § 2.2)", () => {
  it("requests kinds=screenshotPosted, remembers the tab and shows its empty state with suggestions", async () => {
    const { feed } = await setup(async () => ({ items: [], nextCursor: null }));
    await screen.findByText("Your feed is empty");
    fireEvent.click(screen.getByRole("tab", { name: "Screenshots" }));
    await waitFor(() => expect(feed).toHaveBeenLastCalledWith({ kinds: ["screenshotPosted"] }, expect.any(AbortSignal)));
    expect(localStorage.getItem(FEED_TAB_KEY)).toBe("screenshots");
    expect(screen.getByRole("tab", { name: "Screenshots" }).getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel", { name: "Screenshots" });
    expect(await within(panel).findByRole("heading", { name: "No screenshots yet." })).toBeTruthy();
    expect(within(panel).getByText("Screenshots posted by people you follow appear here.")).toBeTruthy();
    expect(within(panel).getByText("📷")).toBeTruthy();
    expect(await within(panel).findByRole("heading", { name: "Suggested creators" })).toBeTruthy();
  });

  it("restores the stored Screenshots tab on mount and pages with the same kinds", async () => {
    localStorage.setItem(FEED_TAB_KEY, "screenshots");
    const { feed } = await setup(async (q) => (q?.cursor ? { items: [shotItem("3", kim)], nextCursor: null } : { items: [shotItem("9")], nextCursor: "9" }));
    expect(feed).toHaveBeenCalledWith({ kinds: ["screenshotPosted"] }, expect.any(AbortSignal));
    expect(screen.getByRole("tab", { name: "Screenshots" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText(/posted a screenshot of/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(feed).toHaveBeenLastCalledWith({ cursor: "9", kinds: ["screenshotPosted"] }, expect.any(AbortSignal)));
    await waitFor(() => expect(articles()).toHaveLength(2));
  });

  it("an unknown stored value still falls back to Everything", async () => {
    localStorage.setItem(FEED_TAB_KEY, "pictures");
    const { feed } = await setup(async () => ({ items: [], nextCursor: null }));
    expect(feed).toHaveBeenCalledWith({ kinds: undefined }, expect.any(AbortSignal));
    expect(screen.getByRole("tab", { name: "Everything" }).getAttribute("aria-selected")).toBe("true");
  });

  it("after an item disappears, focus goes to the next item's first link", async () => {
    await setup(async () => ({ items: [shotItem("9"), shotItem("8", kim)], nextCursor: null }));
    await waitFor(() => expect(articles()).toHaveLength(2));
    await deleteFirstShotOf(articles()[0]);
    expect(articles()).toHaveLength(1);
    expect(document.activeElement).toBe(within(articles()[0]).getByRole("link", { name: "Kim" }));
  });

  it("else to Load more", async () => {
    await setup(async () => ({ items: [shotItem("9")], nextCursor: "9" }));
    await waitFor(() => expect(articles()).toHaveLength(1));
    await deleteFirstShotOf(articles()[0]);
    expect(articles()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Load more/ }));
  });

  it("else to the tab panel", async () => {
    await setup(async () => ({ items: [shotItem("9")], nextCursor: null }));
    await waitFor(() => expect(articles()).toHaveLength(1));
    await deleteFirstShotOf(articles()[0]);
    expect(articles()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole("tabpanel"));
  });
});

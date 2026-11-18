import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { FeedItem, FeedPage as FeedPageData, Post, User } from "../api/types";
import { FeedItem as FeedItemView, FEED_ITEM_KINDS, isKnownFeedItem } from "../components/FeedItem";
import { FEED_TAB_KEY, FeedPage } from "../pages/FeedPage";
import { WebGameProviders } from "../WebGameApp";
import { game } from "./collectionFixtures";
import { gameAttachment, miaRef, post } from "./postFixtures";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "admin" };

const postItem = (id: string, p: Post | null = post(`p${id}`, { body: `Body ${id}` })): FeedItem => ({
  id,
  kind: "postCreated",
  actor: miaRef,
  game: null,
  reason: "following",
  createdAt: "2026-11-01T10:00:00.000Z",
  version: null,
  score: null,
  achievement: null,
  update: null,
  collection: null,
  screenshots: null,
  post: p,
});

const gameItem = (id: string, title: string): FeedItem => ({
  id,
  kind: "gamePublished",
  actor: miaRef,
  game: game(`g${id}`, title),
  reason: "following",
  createdAt: "2026-11-01T10:00:00.000Z",
  version: 1,
  score: null,
  achievement: null,
});

function makeClient() {
  localStorage.setItem("webgame.token", "tok");
  const fetchMock = async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 });
  const client = new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  const del = vi.spyOn(client, "deletePost").mockResolvedValue(undefined);
  const suggestions = vi
    .spyOn(client, "getFeedSuggestions")
    .mockResolvedValue([{ user: { id: "u3", username: "kim", displayName: "Kim", avatarUrl: null }, reason: "popular", games: 2 }]);
  return { client, del, suggestions };
}

async function setup(getFeed: (q: Parameters<ApiClient["getFeed"]>[0]) => Promise<FeedPageData>) {
  const { client, del, suggestions } = makeClient();
  const feed = vi.spyOn(client, "getFeed").mockImplementation(async (q) => getFeed(q));
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <FeedPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
  return { feed, del, suggestions };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("FeedPage: Posts tab (F030 section 0.16)", () => {
  it("is the second tab, requests kinds=postCreated and is remembered", async () => {
    const { feed } = await setup(async () => ({ items: [], nextCursor: null }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Everything", "Posts", "New games", "Collections", "Screenshots"]);
    fireEvent.click(screen.getByRole("tab", { name: "Posts" }));
    await waitFor(() => expect(feed).toHaveBeenLastCalledWith({ kinds: ["postCreated"] }, expect.any(AbortSignal)));
    expect(localStorage.getItem(FEED_TAB_KEY)).toBe("posts");
  });

  it("restores the remembered Posts tab", async () => {
    localStorage.setItem(FEED_TAB_KEY, "posts");
    const { feed } = await setup(async () => ({ items: [], nextCursor: null }));
    expect(feed.mock.calls[0][0]).toEqual({ kinds: ["postCreated"] });
    expect(screen.getByRole("tab", { name: "Posts" }).getAttribute("aria-selected")).toBe("true");
  });

  it("empty: the Write-a-post link above the empty state, then suggestions", async () => {
    localStorage.setItem(FEED_TAB_KEY, "posts");
    await setup(async () => ({ items: [], nextCursor: null }));
    const panel = screen.getByRole("tabpanel", { name: "Posts" });
    const link = within(panel).getByRole("link", { name: "✎ Write a post" });
    expect(link.getAttribute("href")).toBe("/u/bob/posts");
    expect(link.closest("p")!.className).toBe("pf-feed__compose");
    const empty = within(panel).getByRole("heading", { name: "No posts yet." });
    expect(within(panel).getByText("Posts from people you follow appear here.")).toBeTruthy();
    expect(link.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await within(panel).findByText("Suggested creators")).toBeTruthy();
  });

  it("with items: the link above the list; nothing while loading or on an error", async () => {
    localStorage.setItem(FEED_TAB_KEY, "posts");
    let fail = true;
    await setup(async () => {
      if (fail) throw new Error("offline");
      return { items: [postItem("2")], nextCursor: null };
    });
    expect(screen.getByText("offline")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "✎ Write a post" })).toBeNull();
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    const link = screen.getByRole("link", { name: "✎ Write a post" });
    const article = document.querySelector("article[data-feed-id='2']")!;
    expect(link.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("no Write-a-post link on other tabs", async () => {
    await setup(async () => ({ items: [postItem("2")], nextCursor: null }));
    expect(document.querySelector("article[data-feed-id='2']")).not.toBeNull();
    expect(screen.queryByRole("link", { name: "✎ Write a post" })).toBeNull();
  });

  it("an admin delete removes the item and focuses the next item's first link", async () => {
    const items = [postItem("3", post("p3", { body: "Third", canDelete: true })), gameItem("2", "Space Dodge"), postItem("1")];
    const { del } = await setup(async () => ({ items, nextCursor: null }));
    const article = document.querySelector<HTMLElement>("article[data-feed-id='3']")!;
    fireEvent.click(within(article).getByRole("button", { name: "Delete" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Delete this post?" })).getByRole("button", { name: "Delete" }));
    });
    await act(async () => {});
    expect(del).toHaveBeenCalledWith("p3");
    expect(document.querySelector("article[data-feed-id='3']")).toBeNull();
    const next = document.querySelector<HTMLElement>("article[data-feed-id='2']")!;
    expect(document.activeElement).toBe(next.querySelector("a[href]:not([tabindex='-1'])"));
    expect(await screen.findByText("Post deleted")).toBeTruthy();
  });

  it("deleting the only post on the Posts tab shows the empty state and focuses the panel", async () => {
    localStorage.setItem(FEED_TAB_KEY, "posts");
    await setup(async () => ({ items: [postItem("3", post("p3", { canDelete: true }))], nextCursor: null }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    });
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "No posts yet." })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("tabpanel", { name: "Posts" }));
  });

  it("deleting the last loaded post with more pages focuses Load more", async () => {
    await setup(async () => ({ items: [postItem("3", post("p3", { canDelete: true }))], nextCursor: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    });
    await act(async () => {});
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Load more" }));
  });
});

describe("FeedItem: postCreated (F030 section 0.16)", () => {
  function show(item: unknown) {
    const { client } = makeClient();
    return render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter>
          <FeedItemView item={item as FeedItem} />
        </MemoryRouter>
      </WebGameProviders>,
    );
  }

  it("is a known kind only with a valid post", () => {
    expect(FEED_ITEM_KINDS).toContain("postCreated");
    expect(isKnownFeedItem(postItem("1"))).toBe(true);
    expect(isKnownFeedItem(postItem("1", null))).toBe(false);
    expect(isKnownFeedItem({ ...postItem("1"), post: undefined } as FeedItem)).toBe(false);
    expect(isKnownFeedItem({ ...postItem("1"), post: { id: "p1" } as Post } as FeedItem)).toBe(false);
  });

  it("other kinds need a game object", () => {
    expect(isKnownFeedItem(gameItem("1", "Space Dodge"))).toBe(true);
    expect(isKnownFeedItem({ ...gameItem("1", "Space Dodge"), game: null } as FeedItem)).toBe(false);
    expect(isKnownFeedItem({ ...gameItem("1", "Space Dodge"), game: "g1" } as unknown as FeedItem)).toBe(false);
  });

  it("renders a PostCard with data-feed-id, including the attachment", async () => {
    const { container } = show(postItem("7", post("p7", { body: "Look", attachment: gameAttachment() })));
    await act(async () => {});
    const article = container.querySelector<HTMLElement>("article.pf-post")!;
    expect(article.getAttribute("data-kind")).toBe("postCreated");
    expect(article.getAttribute("data-feed-id")).toBe("7");
    expect(article.querySelector(".pf-post__body")!.textContent).toBe("Look");
    expect(article.querySelector("a.pf-post-attachment")!.getAttribute("href")).toBe("/games/g1");
    expect(container.querySelector(".pf-feeditem")).toBeNull();
  });

  it("an item with post: null renders nothing; a non-post item with game: null is dropped", async () => {
    const a = show(postItem("7", null));
    await act(async () => {});
    expect(a.container.querySelector("article")).toBeNull();
    a.unmount();
    const b = show({ ...gameItem("8", "X"), game: null });
    await act(async () => {});
    expect(b.container.querySelector("article")).toBeNull();
  });

  it("the feed drops invalid items before rendering", async () => {
    await setup(async () => ({ items: [postItem("3", null), { ...gameItem("2", "Gone"), game: null }, gameItem("1", "Kept")], nextCursor: null }));
    expect(Array.from(document.querySelectorAll("article[data-feed-id]")).map((a) => a.getAttribute("data-feed-id"))).toEqual(["1"]);
  });
});

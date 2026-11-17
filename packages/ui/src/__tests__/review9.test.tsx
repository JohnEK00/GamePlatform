import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { FeedItem as FeedItemData, FeedPage as FeedPageData, GameSummary, Page, Screenshot, User, UserScreenshot } from "../api/types";
import { FeedItem } from "../components/FeedItem";
import { ProfileScreenshots } from "../components/ProfileScreenshots";
import { ScreenshotGallery } from "../components/ScreenshotGallery";
import { FEED_TAB_KEY, FeedPage } from "../pages/FeedPage";
import { WebGameProviders } from "../WebGameApp";

// Review 9: L2 (focus after a delete in the lightbox), L3 (feed empty state after local deletes), L4 (focus ring).

const me: User = { id: "u9", username: "olga", displayName: "Olga", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "admin" };
const mia = { id: "u5", username: "mia", displayName: "Mia", avatarUrl: null };

const game: GameSummary = {
  id: "g1",
  title: "Kiln Clash",
  description: "",
  tags: [],
  owner: mia,
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

const shot = (i: number): Screenshot => ({
  id: `s${i}`,
  gameId: "g1",
  author: mia,
  caption: `C${i}`,
  imageUrl: `/m/s${i}.png`,
  thumbUrl: `/m/s${i}_t.jpg`,
  width: 1280,
  height: 720,
  gameVersion: 1,
  createdAt: "2026-11-14T15:30:12Z",
  canDelete: true,
});

const shotItem = (id: string, shots: number[]): FeedItemData => ({
  id,
  kind: "screenshotPosted",
  actor: mia,
  game,
  reason: "following",
  createdAt: "2026-11-14T15:30:12Z",
  version: null,
  score: null,
  achievement: null,
  collection: null,
  screenshots: { count: shots.length, items: shots.map(shot) },
});

function makeClient() {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "deleteScreenshot").mockResolvedValue(undefined);
  vi.spyOn(client, "getFeedSuggestions").mockResolvedValue([]);
  return client;
}

async function mount(client: ApiClient, ui: React.ReactNode) {
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </WebGameProviders>,
  );
  await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
}

/**
 * Opens the lightbox the way a real click or Enter does (jsdom's click doesn't focus the button, so the test focuses
 * the opener explicitly; otherwise `useModal`'s opener would be <body> and the bug would be invisible), moves with the
 * arrow keys, then deletes the shown shot and confirms.
 */
async function openArrowDelete(opener: HTMLElement, arrows: ("ArrowRight" | "ArrowLeft")[]) {
  opener.focus();
  expect(document.activeElement).toBe(opener);
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog");
  for (const key of arrows) fireEvent.keyDown(dialog, { key });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  const confirm = screen.getAllByRole("dialog").at(-1)!;
  await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

/** Opens and closes the lightbox without a delete. */
function openArrowClose(opener: HTMLElement, arrows: ("ArrowRight" | "ArrowLeft")[]) {
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog");
  for (const key of arrows) fireEvent.keyDown(dialog, { key });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
}

const label = () => document.activeElement?.getAttribute("aria-label") ?? null;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("review 9 L2: feed lightbox focus after a delete (F015 § 0.12)", () => {
  const feedThumb = (c: string) => screen.getByRole("button", { name: `Screenshot: ${c}` });

  it("arrowing to another shot and deleting it focuses the thumbnail now at its position, not the opener", async () => {
    const client = makeClient();
    await mount(client, <FeedItem item={shotItem("77", [1, 2, 3])} />);
    await openArrowDelete(feedThumb("C1"), ["ArrowRight"]);
    expect(client.deleteScreenshot).toHaveBeenCalledWith("s2");
    expect(label()).toBe("Screenshot: C3");
  });

  it("deleting the last shot (reached with the arrows) focuses the previous thumbnail", async () => {
    const client = makeClient();
    await mount(client, <FeedItem item={shotItem("77", [1, 2, 3])} />);
    await openArrowDelete(feedThumb("C1"), ["ArrowRight", "ArrowRight"]);
    expect(client.deleteScreenshot).toHaveBeenCalledWith("s3");
    expect(label()).toBe("Screenshot: C2");
  });

  it("deleting the opened shot itself focuses the next one", async () => {
    const client = makeClient();
    await mount(client, <FeedItem item={shotItem("77", [1, 2, 3])} />);
    await openArrowDelete(feedThumb("C2"), []);
    expect(client.deleteScreenshot).toHaveBeenCalledWith("s2");
    expect(label()).toBe("Screenshot: C3");
  });

  it("deleting the only shot falls back to the page's pick (onEmptied)", async () => {
    const client = makeClient();
    const target = document.createElement("button");
    target.textContent = "fallback";
    document.body.appendChild(target);
    try {
      await mount(client, <FeedItem item={shotItem("77", [1])} onEmptied={() => target} />);
      await openArrowDelete(feedThumb("C1"), []);
      expect(document.activeElement).toBe(target);
    } finally {
      target.remove();
    }
  });

  it("closing without a delete still returns focus to the opener", async () => {
    const client = makeClient();
    await mount(client, <FeedItem item={shotItem("77", [1, 2, 3])} />);
    openArrowClose(feedThumb("C1"), ["ArrowRight", "ArrowRight"]);
    expect(label()).toBe("Screenshot: C1");
  });

  it("a failed delete keeps the lightbox open, and closing it then returns focus to the opener", async () => {
    const client = makeClient();
    vi.mocked(client.deleteScreenshot).mockRejectedValue(new Error("nope"));
    await mount(client, <FeedItem item={shotItem("77", [1, 2, 3])} />);
    const opener = feedThumb("C1");
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    const confirm = screen.getAllByRole("dialog").at(-1)!;
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(label()).toBe("Screenshot: C1");
  });
});

describe("review 9 L2: profile and game-page gallery focus after a delete", () => {
  const userShot = (i: number): UserScreenshot => ({ ...shot(i), id: `p${i}`, gameId: `g${i}`, canDelete: true, game: { id: `g${i}`, title: `Game ${i}` } });
  const userPage = (items: UserScreenshot[]): Page<UserScreenshot> => ({ items, total: items.length, page: 1, perPage: 12 });
  const profileThumb = (i: number) => screen.getByRole("button", { name: `Screenshot of Game ${i}: C${i}` });

  it("profile: arrow + delete focuses the thumbnail now at that grid position", async () => {
    const client = makeClient();
    vi.spyOn(client, "listUserScreenshots").mockResolvedValue(userPage([1, 2, 3].map(userShot)));
    await mount(client, <ProfileScreenshots username="olga" isMe />);
    await openArrowDelete(profileThumb(1), ["ArrowRight"]);
    expect(client.deleteScreenshot).toHaveBeenCalledWith("p2");
    expect(label()).toBe("Screenshot of Game 3: C3");
  });

  it("profile: deleting the last one focuses the previous one, and the only one focuses the heading", async () => {
    const client = makeClient();
    vi.spyOn(client, "listUserScreenshots").mockResolvedValue(userPage([1, 2].map(userShot)));
    await mount(client, <ProfileScreenshots username="olga" isMe />);
    await openArrowDelete(profileThumb(1), ["ArrowRight"]);
    expect(label()).toBe("Screenshot of Game 1: C1");
    await openArrowDelete(profileThumb(1), []);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: /^Screenshots/ }));
    expect(document.activeElement?.className).toContain("pf-section-title");
  });

  it("game page gallery: arrow + delete focuses the next thumbnail, else the previous one", async () => {
    const client = makeClient();
    vi.spyOn(client, "listScreenshots").mockResolvedValue({ items: [1, 2, 3].map(shot), total: 3, page: 1, perPage: 12 });
    await mount(client, <ScreenshotGallery game={{ id: "g1", title: "Kiln Clash", isOwner: false }} />);
    const thumb = (c: string) => screen.getByRole("button", { name: `Screenshot: ${c}` });
    await openArrowDelete(thumb("C1"), ["ArrowRight"]);
    expect(client.deleteScreenshot).toHaveBeenLastCalledWith("s2");
    expect(label()).toBe("Screenshot: C3");
    await openArrowDelete(thumb("C1"), ["ArrowRight"]);
    expect(client.deleteScreenshot).toHaveBeenLastCalledWith("s3");
    expect(label()).toBe("Screenshot: C1");
  });
});

describe("review 9 L3: the feed's empty state after local deletes", () => {
  const articles = () => Array.from(document.querySelectorAll<HTMLElement>("article.pf-feeditem"));

  async function setupFeed(getFeed: (q: Parameters<ApiClient["getFeed"]>[0]) => Promise<FeedPageData>) {
    const client = makeClient();
    const feed = vi.spyOn(client, "getFeed").mockImplementation(async (q) => getFeed(q));
    await mount(client, <FeedPage />);
    return { client, feed };
  }

  it("Screenshots tab: deleting every shot of every item shows 'No screenshots yet.' and focuses the tab panel", async () => {
    localStorage.setItem(FEED_TAB_KEY, "screenshots");
    await setupFeed(async () => ({ items: [shotItem("9", [1]), shotItem("8", [2, 3])], nextCursor: null }));
    await waitFor(() => expect(articles()).toHaveLength(2));
    await openArrowDelete(within(articles()[0]).getByRole("button", { name: "Screenshot: C1" }), []);
    expect(articles()).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "No screenshots yet." })).toBeNull();
    await openArrowDelete(within(articles()[0]).getByRole("button", { name: "Screenshot: C2" }), []);
    expect(label()).toBe("Screenshot: C3");
    await openArrowDelete(within(articles()[0]).getByRole("button", { name: "Screenshot: C3" }), []);
    expect(articles()).toHaveLength(0);
    const panel = screen.getByRole("tabpanel", { name: "Screenshots" });
    expect(within(panel).getByRole("heading", { name: "No screenshots yet." })).toBeTruthy();
    expect(document.activeElement).toBe(panel);
  });

  it("Everything tab: once every loaded item is emptied, 'Your feed is empty' shows", async () => {
    await setupFeed(async () => ({ items: [shotItem("9", [1])], nextCursor: null }));
    await waitFor(() => expect(articles()).toHaveLength(1));
    await openArrowDelete(screen.getByRole("button", { name: "Screenshot: C1" }), []);
    expect(screen.getByText("Your feed is empty")).toBeTruthy();
  });

  it("with more pages, the list keeps Load more (focused) instead of the empty state, and paging still works", async () => {
    localStorage.setItem(FEED_TAB_KEY, "screenshots");
    const { feed } = await setupFeed(async (q) =>
      q?.cursor ? { items: [shotItem("7", [4])], nextCursor: null } : { items: [shotItem("9", [1])], nextCursor: "9" },
    );
    await waitFor(() => expect(articles()).toHaveLength(1));
    await openArrowDelete(screen.getByRole("button", { name: "Screenshot: C1" }), []);
    expect(screen.queryByRole("heading", { name: "No screenshots yet." })).toBeNull();
    const more = screen.getByRole("button", { name: /Load more/ });
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    await waitFor(() => expect(feed).toHaveBeenLastCalledWith({ cursor: "9", kinds: ["screenshotPosted"] }, expect.any(AbortSignal)));
    await waitFor(() => expect(articles()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Screenshot: C4" })).toBeTruthy();
    // The emptied item does not come back.
    expect(screen.queryByRole("button", { name: "Screenshot: C1" })).toBeNull();
  });

  it("a tab switch reloads and forgets the emptied items", async () => {
    await setupFeed(async () => ({ items: [shotItem("9", [1])], nextCursor: null }));
    await waitFor(() => expect(articles()).toHaveLength(1));
    await openArrowDelete(screen.getByRole("button", { name: "Screenshot: C1" }), []);
    expect(screen.getByText("Your feed is empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Screenshots" }));
    await waitFor(() => expect(articles()).toHaveLength(1));
  });
});

describe("review 9 L4: focus-target headings keep the keyboard focus ring", () => {
  // Read from disk: vitest runs with `css: false`, so a `?raw` import of a .css file comes back empty.
  const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8");

  it("the profile and F005 gallery headings hide the outline only for :focus:not(:focus-visible)", () => {
    expect(css).toContain(".pf-profile-shots .pf-section-title:focus:not(:focus-visible) {");
    expect(css).toContain(".pf-shots > .pf-panel__title:focus:not(:focus-visible) {");
    expect(css).not.toMatch(/\.pf-profile-shots \.pf-section-title:focus\s*\{/);
    expect(css).not.toMatch(/\.pf-shots > \.pf-panel__title:focus\s*\{/);
  });
});

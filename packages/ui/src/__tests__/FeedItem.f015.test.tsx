import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { FeedItem as FeedItemData, FeedScreenshots, GameSummary, Screenshot, User } from "../api/types";
import { FEED_ITEM_KINDS, FeedItem, isKnownFeedItem } from "../components/FeedItem";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u9", username: "olga", displayName: "Olga", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const mia = { id: "u5", username: "mia", displayName: "Mia", avatarUrl: null };

const game: GameSummary = {
  id: "g1",
  title: "Kiln Clash",
  description: "",
  tags: [],
  owner: { id: "u9", username: "olga", displayName: "Olga", avatarUrl: null },
  thumbnailUrl: "/media/thumbnails/g1.png",
  plays: 0,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek: 0,
};

function shot(i: number, over: Partial<Screenshot> = {}): Screenshot {
  return {
    id: `s${i}`,
    gameId: "g1",
    author: mia,
    caption: "",
    imageUrl: `/media/screenshots/s${i}.png`,
    thumbUrl: `/media/screenshots/s${i}_t.jpg`,
    width: 1280,
    height: 720,
    gameVersion: 3,
    createdAt: "2026-11-14T15:30:12Z",
    canDelete: false,
    ...over,
  };
}

const item = (screenshots: FeedScreenshots | null, over: Partial<FeedItemData> = {}): FeedItemData => ({
  id: "77",
  kind: "screenshotPosted",
  actor: mia,
  game,
  reason: "following",
  createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  version: null,
  score: null,
  achievement: null,
  collection: null,
  screenshots,
  ...over,
});

async function show(feedItem: FeedItemData, opts: { signedIn?: boolean; configure?: (c: ApiClient) => void } = {}) {
  if (opts.signedIn) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  opts.configure?.(client);
  const onEmptied = vi.fn(() => document.getElementById("after") as HTMLElement | null);
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <div data-testid="root">
          <FeedItem item={feedItem} onEmptied={onEmptied} />
        </div>
        <button type="button" id="after">
          Next thing
        </button>
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (opts.signedIn) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  const text = () => utils.container.querySelector(".pf-feeditem__text")?.textContent ?? null;
  return { ...utils, client, onEmptied, text };
}

const thumbs = () => screen.queryAllByRole("button", { name: /^Screenshot/ });

async function deleteOpen() {
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  const confirm = screen.getAllByRole("dialog").at(-1)!;
  await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FeedItem screenshotPosted (F015 § 2.1)", () => {
  it("is a known kind", () => {
    expect(FEED_ITEM_KINDS).toContain("screenshotPosted");
    expect(isKnownFeedItem(item({ count: 1, items: [shot(1)] }))).toBe(true);
  });

  it("one screenshot: singular sentence, links, caption line, caption label, 📷 meta and no game card", async () => {
    const { container, text } = await show(item({ count: 1, items: [shot(1, { caption: "  Boss down!  " })] }));
    expect(text()).toBe("Mia posted a screenshot of Kiln Clash");
    const p = container.querySelector(".pf-feeditem__text") as HTMLElement;
    expect(within(p).getByRole("link", { name: "Mia" }).getAttribute("href")).toBe("/u/mia");
    expect(within(p).getByRole("link", { name: "Kiln Clash" }).getAttribute("href")).toBe("/games/g1");
    const cap = container.querySelector(".pf-feed-shots__caption") as HTMLElement;
    expect(cap.textContent).toBe("“Boss down!”");
    expect(cap.getAttribute("title")).toBe("Boss down!");
    const btn = screen.getByRole("button", { name: "Screenshot: Boss down!" });
    expect(btn.getAttribute("aria-haspopup")).toBe("dialog");
    expect(btn.className).toBe("pf-feed-shots__item");
    const img = btn.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("http://api.test/media/screenshots/s1_t.jpg");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector(".pf-feeditem__game")).toBeNull();
    expect(container.querySelector(".pf-feeditem__meta")!.textContent).toContain("📷");
    expect(container.querySelector(".pf-feeditem__tag")).toBeNull();
  });

  it("three screenshots: plural sentence, no caption line, labels with and without a caption", async () => {
    const { container, text } = await show(item({ count: 3, items: [shot(1, { caption: "Lava" }), shot(2), shot(3)] }));
    expect(text()).toBe("Mia posted 3 screenshots of Kiln Clash");
    expect(container.querySelector(".pf-feed-shots__caption")).toBeNull();
    expect(thumbs().map((b) => b.getAttribute("aria-label"))).toEqual(["Screenshot: Lava", "Screenshot 2 of 3", "Screenshot 3 of 3"]);
    expect(screen.queryByRole("link", { name: /more on the game page/ })).toBeNull();
  });

  it("no caption line for a single screenshot without a caption", async () => {
    const { container } = await show(item({ count: 1, items: [shot(1, { caption: "   " })] }));
    expect(container.querySelector(".pf-feed-shots__caption")).toBeNull();
    expect(thumbs().map((b) => b.getAttribute("aria-label"))).toEqual(["Screenshot 1 of 1"]);
  });

  it("'+2 more on the game page' when count is 6 with 4 items", async () => {
    const { text } = await show(item({ count: 6, items: [shot(1), shot(2), shot(3), shot(4)] }));
    expect(text()).toBe("Mia posted 6 screenshots of Kiln Clash");
    expect(thumbs()).toHaveLength(4);
    const more = screen.getByRole("link", { name: "+2 more on the game page" });
    expect(more.getAttribute("href")).toBe("/games/g1?section=screenshots");
  });

  it("renders nothing for null screenshots, empty or non-array items, or only invalid entries", async () => {
    const bad = [
      item(null),
      item({ count: 2, items: [] }),
      item({ count: 2, items: "nope" as unknown as Screenshot[] }),
      item({ count: 2, items: [null, { id: 5, thumbUrl: "/x" }, { id: "s1" }] as unknown as Screenshot[] }),
      item(undefined as unknown as null),
    ];
    for (const b of bad) {
      const { getByTestId, unmount } = await show(b);
      expect(getByTestId("root").innerHTML).toBe("");
      unmount();
    }
  });

  it("count is at least the number of valid items", async () => {
    const { text } = await show(item({ count: "x" as unknown as number, items: [shot(1), shot(2)] }));
    expect(text()).toBe("Mia posted 2 screenshots of Kiln Clash");
  });

  it("clicking a thumbnail opens the lightbox at that index with View on game page and no Set as thumbnail", async () => {
    await show(item({ count: 3, items: [shot(1, { caption: "One" }), shot(2, { caption: "Two" }), shot(3, { caption: "Three" })] }), { signedIn: true });
    fireEvent.click(screen.getByRole("button", { name: "Screenshot: Two" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Two")).toBeTruthy();
    expect(within(dialog).getByText("Screenshot 2 of 3")).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "View on game page" }).getAttribute("href")).toBe("/games/g1?section=screenshots");
    expect(within(dialog).queryByRole("button", { name: /Set as thumbnail/ })).toBeNull();
    expect(within(dialog).getByRole("img").getAttribute("alt")).toBe("Two");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(within(screen.getByRole("dialog")).getByText("Three")).toBeTruthy();
  });

  it("closing without a delete returns focus to the thumbnail that opened it", async () => {
    await show(item({ count: 2, items: [shot(1), shot(2)] }), { signedIn: true });
    const second = screen.getByRole("button", { name: "Screenshot 2 of 2" });
    second.focus();
    fireEvent.click(second);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(second);
  });

  it("delete removes the thumbnail, updates the count and focuses the thumbnail now at that position", async () => {
    let del!: ReturnType<typeof vi.spyOn>;
    const { text } = await show(
      item({ count: 3, items: [shot(1, { caption: "One", canDelete: true }), shot(2, { caption: "Two", canDelete: true }), shot(3, { caption: "Three", canDelete: true })] }),
      { signedIn: true, configure: (c) => (del = vi.spyOn(c, "deleteScreenshot").mockResolvedValue(undefined)) },
    );
    fireEvent.click(screen.getByRole("button", { name: "Screenshot: Two" }));
    await deleteOpen();
    expect(del).toHaveBeenCalledWith("s2");
    expect(text()).toBe("Mia posted 2 screenshots of Kiln Clash");
    expect(thumbs().map((b) => b.getAttribute("aria-label"))).toEqual(["Screenshot: One", "Screenshot: Three"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Screenshot: Three" }));
  });

  it("deleting the last thumbnail focuses the new last one; '+N more' shrinks with the count", async () => {
    await show(item({ count: 6, items: [1, 2, 3, 4].map((i) => shot(i, { caption: `C${i}`, canDelete: true })) }), {
      signedIn: true,
      configure: (c) => vi.spyOn(c, "deleteScreenshot").mockResolvedValue(undefined),
    });
    fireEvent.click(screen.getByRole("button", { name: "Screenshot: C4" }));
    await deleteOpen();
    expect(thumbs()).toHaveLength(3);
    expect(screen.getByRole("link", { name: "+2 more on the game page" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Screenshot: C3" }));
  });

  it("the item disappears after its last shot is deleted and focus goes to the page's onEmptied target", async () => {
    const { getByTestId, onEmptied } = await show(item({ count: 1, items: [shot(1, { canDelete: true })] }), {
      signedIn: true,
      configure: (c) => vi.spyOn(c, "deleteScreenshot").mockResolvedValue(undefined),
    });
    fireEvent.click(screen.getByRole("button", { name: "Screenshot 1 of 1" }));
    await deleteOpen();
    expect(getByTestId("root").innerHTML).toBe("");
    expect(onEmptied).toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Next thing" }));
  });

  it("a failed delete keeps the item", async () => {
    const { text } = await show(item({ count: 2, items: [shot(1, { canDelete: true }), shot(2)] }), {
      signedIn: true,
      configure: (c) => vi.spyOn(c, "deleteScreenshot").mockRejectedValue(new Error("boom")),
    });
    fireEvent.click(screen.getByRole("button", { name: "Screenshot 1 of 2" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    const confirm = screen.getAllByRole("dialog").at(-1)!;
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
    expect(thumbs()).toHaveLength(2);
    expect(text()).toBe("Mia posted 2 screenshots of Kiln Clash");
  });
});

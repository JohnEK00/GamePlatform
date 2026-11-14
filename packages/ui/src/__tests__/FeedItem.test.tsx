import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client";
import type { FeedItem as FeedItemData, GameSummary } from "../api/types";
import { FeedItem } from "../components/FeedItem";
import { formatScore } from "../util";
import { WebGameProviders } from "../WebGameApp";

const game: GameSummary = {
  id: "g1",
  title: "Space Dodge",
  description: "",
  tags: [],
  owner: { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null },
  thumbnailUrl: "/media/thumbnails/g1.png",
  plays: 10,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
};

const base: FeedItemData = {
  id: "10",
  kind: "gamePublished",
  actor: { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null },
  game,
  reason: "following",
  createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  version: 1,
  score: null,
  achievement: null,
};

function show(item: Partial<FeedItemData> & Record<string, unknown>) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const { container } = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <div data-testid="root">
          <FeedItem item={{ ...base, ...item } as FeedItemData} />
        </div>
      </MemoryRouter>
    </WebGameProviders>,
  );
  const text = container.querySelector(".pf-feeditem__text")?.textContent ?? null;
  return { container, text };
}

describe("FeedItem", () => {
  it("gamePublished", () => {
    const { text, container } = show({});
    expect(text).toBe("Sam published Space Dodge");
    expect(container.querySelector("time")!.textContent).toBe("2 hours ago");
    expect(container.querySelector('a.pf-feeditem__game')!.getAttribute("href")).toBe("/games/g1");
    expect(container.querySelector('a.pf-feeditem__actor')!.getAttribute("href")).toBe("/u/sam");
    expect(container.querySelector(".pf-feeditem__game img")!.getAttribute("src")).toBe("http://api.test/media/thumbnails/g1.png");
  });

  it("gameUpdated with the version", () => {
    expect(show({ kind: "gameUpdated", version: 4 }).text).toBe("Sam updated Space Dodge to v4");
  });

  it("personalBest: first score vs new best, formatted via formatScore with the label", () => {
    const lb = { order: "asc" as const, format: "time" as const, label: "Best time" };
    expect(show({ kind: "personalBest", version: null, score: { value: 62345, first: false, leaderboard: lb } }).text).toBe(
      `Sam set a new personal best in Space Dodge: Best time ${formatScore(62345, "time")}`,
    );
    expect(formatScore(62345, "time")).toBe("1:02.345");
    expect(
      show({ kind: "personalBest", version: null, score: { value: 12400, first: true, leaderboard: { order: "desc", format: "number", label: "" } } }).text,
    ).toBe(`Sam scored ${formatScore(12400)} in Space Dodge`);
  });

  it("achievementUnlocked: single and grouped counts, icon when set", () => {
    const ach = { id: "flawless", name: "Flawless", description: "", iconUrl: null, count: 1 };
    const one = show({ kind: "achievementUnlocked", version: null, achievement: ach });
    expect(one.text).toBe("Sam unlocked Flawless in Space Dodge");
    expect(one.container.querySelector(".pf-feeditem__ach")).toBeNull();
    const many = show({ kind: "achievementUnlocked", version: null, achievement: { ...ach, count: 3, iconUrl: "/media/ach/f.png" } });
    expect(many.text).toBe("Sam unlocked Flawless and 2 more in Space Dodge");
    expect(many.container.querySelector(".pf-feeditem__ach img")!.getAttribute("src")).toBe("http://api.test/media/ach/f.png");
  });

  it("tags items shown because of a favorite", () => {
    expect(show({ kind: "gameUpdated", version: 2, reason: "favorite" }).container.textContent).toContain("From your favorites");
    expect(show({ reason: "following" }).container.textContent).not.toContain("From your favorites");
  });

  it("renders nothing for unknown kinds", () => {
    const { container } = show({ kind: "commentPosted" as never });
    expect(container.querySelector('[data-testid="root"]')!.innerHTML).toBe("");
  });
});

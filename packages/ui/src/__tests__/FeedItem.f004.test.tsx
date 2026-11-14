import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client";
import type { FeedItem as FeedItemData, GameSummary } from "../api/types";
import { FeedItem } from "../components/FeedItem";
import { WebGameProviders } from "../WebGameApp";

const game: GameSummary = {
  id: "g1",
  title: "Space Dodge",
  description: "",
  tags: [],
  owner: { id: "u2", username: "ana", displayName: "Ana", avatarUrl: null },
  thumbnailUrl: null,
  plays: 10,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek: 0,
  lastUpdatedAt: null,
};

const base: FeedItemData = {
  id: "10",
  kind: "gameUpdated",
  actor: { id: "u2", username: "ana", displayName: "Ana", avatarUrl: null },
  game,
  reason: "following",
  createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  version: 5,
  score: null,
  achievement: null,
};

function show(item: Partial<FeedItemData> & Record<string, unknown>) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  const { container } = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <FeedItem item={{ ...base, ...item } as FeedItemData} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  const text = container.querySelector(".pf-feeditem__text")?.textContent ?? null;
  return { container, text };
}

describe("FeedItem F004 gameUpdated", () => {
  it("coalesced item: '(2 updates)' and both notes, newest first", () => {
    const { container, text } = show({
      update: {
        fromVersion: 4,
        changes: [
          { version: 5, notes: "Fixed the pause bug" },
          { version: 4, notes: "Faster asteroids" },
        ],
      },
    });
    expect(text).toBe("Ana updated Space Dodge to v5 (2 updates)");
    const notes = Array.from(container.querySelectorAll(".pf-feed__notes")).map((n) => n.textContent);
    expect(notes).toEqual(["v5: Fixed the pause bug", "v4: Faster asteroids"]);
  });

  it("single update: unchanged sentence, the note quoted", () => {
    const { container, text } = show({ update: { fromVersion: 5, changes: [{ version: 5, notes: "New ship" }] } });
    expect(text).toBe("Ana updated Space Dodge to v5");
    expect(container.querySelectorAll(".pf-feed__notes").length).toBe(1);
  });

  it("shows at most 3 notes", () => {
    const changes = [8, 7, 6, 5].map((v) => ({ version: v, notes: `note ${v}` }));
    const { container, text } = show({ version: 8, update: { fromVersion: 4, changes } });
    expect(text).toBe("Ana updated Space Dodge to v8 (5 updates)");
    expect(Array.from(container.querySelectorAll(".pf-feed__notes")).map((n) => n.textContent)).toEqual(["v8: note 8", "v7: note 7", "v6: note 6"]);
  });

  it("links to the version history with ?section=versions", () => {
    const { container } = show({ update: { fromVersion: 5, changes: [{ version: 5, notes: "x" }] } });
    const link = container.querySelector<HTMLAnchorElement>("a.pf-feed__whatsnew")!;
    expect(link.textContent).toBe("What's new →");
    expect(link.getAttribute("href")).toBe("/games/g1?section=versions");
  });

  it("renders notes as plain text, never HTML", () => {
    const { container } = show({ update: { fromVersion: 5, changes: [{ version: 5, notes: "<img src=x onerror=alert(1)>" }] } });
    expect(container.querySelector(".pf-feed__notes img")).toBeNull();
    expect(container.querySelector(".pf-feed__notes")!.textContent).toBe("v5: <img src=x onerror=alert(1)>");
  });

  it("no changes: nothing extra, no link", () => {
    const { container, text } = show({ update: { fromVersion: 5, changes: [] } });
    expect(text).toBe("Ana updated Space Dodge to v5");
    expect(container.querySelector(".pf-feed__changes")).toBeNull();
    expect(container.querySelector("a.pf-feed__whatsnew")).toBeNull();
  });

  it("F002 items without update (older servers) render as before", () => {
    const a = show({});
    expect(a.text).toBe("Ana updated Space Dodge to v5");
    expect(a.container.querySelector(".pf-feed__changes")).toBeNull();
    const b = show({ update: null });
    expect(b.text).toBe("Ana updated Space Dodge to v5");
    expect(b.container.querySelectorAll("a").length).toBe(a.container.querySelectorAll("a").length);
  });

  it("other kinds ignore update", () => {
    const { text, container } = show({ kind: "gamePublished", version: 1, update: null });
    expect(text).toBe("Ana published Space Dodge");
    expect(container.querySelector(".pf-feed__changes")).toBeNull();
  });
});

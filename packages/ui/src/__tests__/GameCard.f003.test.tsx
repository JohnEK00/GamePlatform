import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client";
import type { GameSummary } from "../api/types";
import { GameCard, GameGrid } from "../components/GameCard";
import { WebGameProviders } from "../WebGameApp";

const base: GameSummary = {
  id: "g1",
  title: "Pixel Peaks",
  description: "",
  tags: ["platformer", "pixel"],
  owner: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null },
  thumbnailUrl: null,
  plays: 4321,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek: 1234,
};

function wrap(children: ReactNode) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  return render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </WebGameProviders>,
  );
}

describe("GameCard F003 highlights", () => {
  it("trending: the weekly line replaces the all-time count when playsWeek > 0", () => {
    const { container } = wrap(<GameCard game={base} highlight="trending" />);
    const trending = container.querySelector(".pf-card__trending")!;
    expect(trending.textContent).toBe("🔥 1.2k this week");
    expect(trending.getAttribute("title")).toBe("1234 plays in the last 7 days");
    expect(container.querySelector('[title="4321 plays"]')).toBeNull();
    expect(container.textContent).not.toContain("▶ 4.3k");
  });

  it("trending: falls back to the all-time count when playsWeek is 0 or missing (older servers)", () => {
    const { container, unmount } = wrap(<GameCard game={{ ...base, playsWeek: 0 }} highlight="trending" />);
    expect(container.querySelector(".pf-card__trending")).toBeNull();
    expect(container.querySelector('[title="4321 plays"]')!.textContent).toBe("▶ 4.3k");
    unmount();
    const { playsWeek: _omit, ...legacy } = base;
    const r2 = wrap(<GameCard game={legacy as GameSummary} highlight="trending" />);
    expect(r2.container.querySelector(".pf-card__trending")).toBeNull();
    expect(r2.container.querySelector('[title="4321 plays"]')).not.toBeNull();
  });

  it("related: shows up to 2 shared tags as non-link text", () => {
    const { container } = wrap(<GameCard game={base} highlight="related" sharedTags={["platformer", "pixel", "retro"]} />);
    const line = container.querySelector(".pf-card__shared")!;
    expect(line.textContent).toBe("#platformer #pixel");
    expect(line.querySelector("a")).toBeNull();
    // Still the original link count (thumbnail, title, owner).
    expect(container.querySelectorAll("a").length).toBe(3);
  });

  it("related: no tag line when sharedTags is empty or absent", () => {
    const { container } = wrap(
      <>
        <GameCard game={base} highlight="related" sharedTags={[]} />
        <GameCard game={{ ...base, id: "g2" }} highlight="related" />
      </>,
    );
    expect(container.querySelector(".pf-card__shared")).toBeNull();
  });

  it("no highlight: markup is unchanged (all-time count, no tag line, no weekly line)", () => {
    const plain = wrap(<GameCard game={base} />).container.innerHTML;
    const legacy = wrap(<GameCard game={{ ...base, playsWeek: 0 }} sharedTags={["pixel"]} />).container.innerHTML;
    expect(plain).toBe(legacy);
    expect(plain).toContain("▶ 4.3k");
    expect(plain).not.toContain("pf-card__trending");
    expect(plain).not.toContain("pf-card__shared");
  });

  it("GameGrid forwards highlight and sharedTagsById", () => {
    const g2: GameSummary = { ...base, id: "g2", title: "Other", playsWeek: 0 };
    const { container } = wrap(<GameGrid games={[base, g2]} highlight="related" sharedTagsById={{ g1: ["pixel"] }} />);
    const lines = container.querySelectorAll(".pf-card__shared");
    expect(lines.length).toBe(1);
    expect(lines[0].textContent).toBe("#pixel");
    const t = wrap(<GameGrid games={[base, g2]} highlight="trending" />).container;
    expect(t.querySelectorAll(".pf-card__trending").length).toBe(1);
  });
});

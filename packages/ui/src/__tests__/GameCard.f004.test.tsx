import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiClient } from "../api/client";
import type { GameSummary } from "../api/types";
import { GameCard, GameGrid } from "../components/GameCard";
import { WebGameProviders } from "../WebGameApp";

const recent = new Date(Date.now() - 2 * 3600_000).toISOString();
const old = new Date(Date.now() - 10 * 24 * 3600_000).toISOString();

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
  lastUpdatedAt: recent,
};

function wrap(children: ReactNode) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  return render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </WebGameProviders>,
  );
}

describe("GameCard F004 Updated badge", () => {
  it("shows the badge over the thumbnail for a recent lastUpdatedAt, with a relative title", () => {
    const { container } = wrap(<GameCard game={base} />);
    const badge = container.querySelector(".pf-badge--updated")!;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("Updated");
    expect(badge.classList.contains("pf-card__badge")).toBe(true);
    expect(badge.getAttribute("title")).toBe("Updated 2 hours ago");
    expect(badge.closest("a.pf-card__link")).not.toBeNull();
  });

  it("hides the badge when lastUpdatedAt is old, null or missing (older servers)", () => {
    const { container, unmount } = wrap(
      <>
        <GameCard game={{ ...base, lastUpdatedAt: old }} />
        <GameCard game={{ ...base, id: "g2", lastUpdatedAt: null }} />
      </>,
    );
    expect(container.querySelector(".pf-badge--updated")).toBeNull();
    unmount();
    const { lastUpdatedAt: _omit, ...legacy } = base;
    const r2 = wrap(<GameCard game={legacy as GameSummary} />);
    expect(r2.container.querySelector(".pf-badge--updated")).toBeNull();
  });

  it("Draft wins over Updated on owner dashboards", () => {
    const { container } = wrap(<GameCard game={{ ...base, published: false }} showStatus />);
    expect(container.querySelector(".pf-badge--draft")!.textContent).toBe("Draft");
    expect(container.querySelector(".pf-badge--updated")).toBeNull();
  });

  it("a published game on a dashboard (showStatus) still shows Updated", () => {
    const { container } = wrap(<GameCard game={base} showStatus />);
    expect(container.querySelector(".pf-badge--draft")).toBeNull();
    expect(container.querySelector(".pf-badge--updated")).not.toBeNull();
  });

  it("leaves the F003 highlight lines unaffected", () => {
    const { container } = wrap(
      <>
        <GameCard game={base} highlight="trending" />
        <GameCard game={{ ...base, id: "g2" }} highlight="related" sharedTags={["platformer", "pixel", "retro"]} />
      </>,
    );
    expect(container.querySelector(".pf-card__trending")!.textContent).toBe("🔥 1.2k this week");
    expect(container.querySelector(".pf-card__shared")!.textContent).toBe("#platformer #pixel");
    expect(container.querySelectorAll(".pf-badge--updated").length).toBe(2);
  });

  it("shows in every grid", () => {
    const { container } = wrap(<GameGrid games={[base, { ...base, id: "g2", lastUpdatedAt: null }]} highlight="trending" />);
    expect(container.querySelectorAll(".pf-badge--updated").length).toBe(1);
  });
});

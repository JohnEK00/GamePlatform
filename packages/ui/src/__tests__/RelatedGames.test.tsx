import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { RelatedGame } from "../api/types";
import { RelatedGames } from "../components/RelatedGames";
import { WebGameProviders } from "../WebGameApp";

const rel = (id: string, title: string, reason: RelatedGame["reason"] = "tags", sharedTags: string[] = ["platformer"]): RelatedGame => ({
  id,
  title,
  description: "",
  tags: ["platformer", "pixel"],
  owner: { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null },
  thumbnailUrl: null,
  plays: 10,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek: 3,
  reason,
  sharedTags: reason === "tags" ? sharedTags : [],
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(gameId: string, client: ApiClient) {
  const ui = (id: string) => (
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <RelatedGames gameId={id} />
      </MemoryRouter>
    </WebGameProviders>
  );
  const utils = render(ui(gameId));
  return { ...utils, rerenderWith: (id: string) => utils.rerender(ui(id)) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RelatedGames", () => {
  it("shows skeletons, then the items with shared tags (none for trending fill)", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const d = deferred<RelatedGame[]>();
    const spy = vi.spyOn(client, "getRelatedGames").mockReturnValue(d.promise);
    const { container } = setup("g1", client);
    expect(spy).toHaveBeenCalledWith("g1", { limit: 8 });
    expect(screen.getByRole("heading", { name: "More like this" })).toBeTruthy();
    expect(container.querySelectorAll(".pf-card--skeleton").length).toBe(4);
    await act(async () => d.resolve([rel("g2", "Cliff Climber", "tags", ["platformer", "pixel"]), rel("g3", "Space Dodge", "trending")]));
    expect(screen.getByText("Cliff Climber")).toBeTruthy();
    expect(screen.getByText("Space Dodge")).toBeTruthy();
    const lines = container.querySelectorAll(".pf-card__shared");
    expect(lines.length).toBe(1);
    expect(lines[0].textContent).toBe("#platformer #pixel");
    const section = container.querySelector("section.pf-related")!;
    expect(section.getAttribute("aria-labelledby")).toBe(screen.getByRole("heading", { name: "More like this" }).id);
  });

  it("is hidden when the result is empty", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "getRelatedGames").mockResolvedValue([]);
    const { container } = setup("g1", client);
    await act(async () => {});
    expect(container.querySelector(".pf-related")).toBeNull();
    expect(screen.queryByText("More like this")).toBeNull();
  });

  it("is hidden when the request fails", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "getRelatedGames").mockRejectedValue(new ApiError("not_found", "Game not found", 404));
    const { container } = setup("g1", client);
    await act(async () => {});
    expect(container.querySelector(".pf-related")).toBeNull();
  });

  it("refetches on gameId change and never shows the previous game's cards (out-of-order responses)", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const first = deferred<RelatedGame[]>();
    const second = deferred<RelatedGame[]>();
    const spy = vi
      .spyOn(client, "getRelatedGames")
      .mockImplementation((id: string) => (id === "g1" ? first.promise : second.promise));
    const { container, rerenderWith } = setup("g1", client);
    rerenderWith("g9");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith("g9", { limit: 8 });
    // The new game's response arrives first, then the stale one.
    await act(async () => second.resolve([rel("n1", "New Match")]));
    expect(screen.getByText("New Match")).toBeTruthy();
    await act(async () => first.resolve([rel("o1", "Old Match")]));
    expect(screen.queryByText("Old Match")).toBeNull();
    expect(screen.getByText("New Match")).toBeTruthy();

    // Navigating again: the previous cards are replaced by skeletons until the new response arrives.
    const third = deferred<RelatedGame[]>();
    spy.mockImplementation(() => third.promise);
    rerenderWith("g5");
    expect(screen.queryByText("New Match")).toBeNull();
    expect(container.querySelectorAll(".pf-card--skeleton").length).toBe(4);
    await act(async () => third.resolve([rel("x1", "Third Match")]));
    expect(screen.getByText("Third Match")).toBeTruthy();
  });
});

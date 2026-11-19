import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ApiError } from "../api/client";
import type { Creator, CreatorQuery, Page } from "../api/types";
import { FollowButton } from "../components/Follow";
import { CreatorsPage } from "../pages/CreatorsPage";
import { creator, viewer } from "./creatorFixtures";
import { currentLocation, makeClient, renderWith } from "./postRender";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.title = "";
});

const page = (items: unknown[], total = items.length, p = 1): Page<Creator> => ({ items: items as Creator[], total, page: p, perPage: 24 });

function routes(extra?: ReactNode) {
  return (
    <Routes>
      <Route
        path="/creators"
        element={
          <>
            <CreatorsPage />
            {extra}
          </>
        }
      />
    </Routes>
  );
}

async function setup(url: string, impl: (q: CreatorQuery | undefined) => Promise<Page<Creator>>, opts: { extra?: ReactNode; signedIn?: boolean } = {}) {
  const me = opts.signedIn ? viewer : null;
  const client = makeClient(me);
  const list = vi.spyOn(client, "listCreators").mockImplementation(async (q) => impl(q));
  const utils = await renderWith(client, routes(opts.extra), url, me);
  return { client, list, ...utils };
}

const tabs = () => screen.getByRole("navigation", { name: "Sort creators" });

describe("CreatorsPage (F035)", () => {
  it("requests page 1 without sort for Popular, with the title, h1, lead and tabs", async () => {
    const { list } = await setup("/creators", async () => page([creator("mia")]));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toEqual({ sort: undefined, page: 1, perPage: 24 });
    expect(document.title).toContain("Creators");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Creators");
    expect(screen.getByText("People who make games on Pixelforge Arcade.")).toBeTruthy();
    const links = Array.from(tabs().querySelectorAll("a"));
    expect(links.map((a) => a.textContent)).toEqual(["Popular", "Recently active", "New creators"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/creators", "/creators?sort=active", "/creators?sort=new"]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual(["page", null, null]);
    expect(links[0].className).toContain("is-active");
  });

  it("clicking Recently active → ?sort=active without page, and requests sort=active", async () => {
    const { list } = await setup("/creators?page=2", async (q) => page([creator("mia")], 30, q?.page ?? 1));
    fireEvent.click(screen.getByRole("link", { name: "Recently active" }));
    await act(async () => {});
    expect(currentLocation()).toBe("/creators?sort=active");
    expect(list.mock.calls.at(-1)![0]).toEqual({ sort: "active", page: 1, perPage: 24 });
    expect(screen.getByRole("link", { name: "Recently active" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Popular" }).getAttribute("aria-current")).toBeNull();
  });

  it("?sort=bogus shows Popular and never sends the sort", async () => {
    const { list } = await setup("/creators?sort=bogus", async () => page([creator("mia")]));
    expect(screen.getByRole("link", { name: "Popular" }).getAttribute("aria-current")).toBe("page");
    expect(list.mock.calls[0][0]).toEqual({ sort: undefined, page: 1, perPage: 24 });
  });

  it("shows 6 skeletons while loading, hidden from screen readers, with a status message", async () => {
    const { container } = await setup("/creators", () => new Promise(() => {}));
    const grid = container.querySelector(".pf-creator-grid")!;
    expect(grid.getAttribute("aria-hidden")).toBe("true");
    expect(grid.querySelectorAll(".pf-creator-card--skeleton").length).toBe(6);
    expect(screen.queryByRole("list")).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading creators…");
    expect(status.className).toBe("pf-sr-only");
  });

  // Review L1: the page sent to the server is always a safe integer in 1–1,000,000.
  for (const [query, expected] of [
    ["?page=1e400", 1],
    ["?page=1e21", 1],
    ["?page=x", 1],
    ["?page=2.5", 1],
    ["?page=0", 1],
    ["?page=-3", 1],
    ["?page=", 1],
    ["?page=7", 7],
    ["?page=1e3", 1000],
    ["?page=5000000", 1_000_000],
  ] as const) {
    it(`${query} requests page ${expected}`, async () => {
      const { list } = await setup(`/creators${query}`, async (q) => page([], 30, q?.page ?? 1));
      expect(list.mock.calls[0][0]).toEqual({ sort: undefined, page: expected, perPage: 24 });
    });
  }

  it("page 1 with creators but no readable item shows an error with Retry, not 'No more creators.'", async () => {
    const { list } = await setup("/creators", async () => page([null, { user: {} }], 2));
    expect(screen.queryByText("No more creators.")).toBeNull();
    expect(screen.queryByText("No creators yet.")).toBeNull();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("Couldn't read the list of creators.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("ErrorState with a working Retry", async () => {
    let fail = true;
    const { list } = await setup("/creators", async () => {
      if (fail) throw new ApiError("not_found", "Not found", 404);
      return page([creator("mia")]);
    });
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Try again" });
    fail = false;
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(list).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole("article", { name: "Mia" })).toBeTruthy());
  });

  it("empty: No creators yet. with Make a game → /docs", async () => {
    await setup("/creators", async () => page([], 0));
    expect(screen.getByText("No creators yet.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Make a game" });
    expect(link.getAttribute("href")).toBe("/docs");
    expect(link.className).toBe("pf-btn pf-btn--primary");
  });

  it("past the end: No more creators. with Back to the first page", async () => {
    const { list } = await setup("/creators?sort=new&page=5", async () => page([], 30, 5));
    expect(list.mock.calls[0][0]).toEqual({ sort: "new", page: 5, perPage: 24 });
    expect(screen.getByText("No more creators.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to the first page" }).getAttribute("href")).toBe("/creators?sort=new");
  });

  it("Pagination writes ?page=2 and drops it for page 1", async () => {
    const { list } = await setup("/creators?sort=new", async (q) => page(Array.from({ length: 24 }, (_, i) => creator(`c${i}`)), 30, q?.page ?? 1));
    expect(screen.getAllByRole("article").length).toBe(24);
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await act(async () => {});
    expect(currentLocation()).toBe("/creators?sort=new&page=2");
    expect(list.mock.calls.at(-1)![0]).toEqual({ sort: "new", page: 2, perPage: 24 });
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    await act(async () => {});
    expect(currentLocation()).toBe("/creators?sort=new");
  });

  it("drops invalid items", async () => {
    await setup("/creators", async () => page([creator("mia"), null, { user: { id: "x" } }, { ...creator("kai"), games: "2" }, creator("leo")], 5));
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-labelledby"))).toEqual(["creator-id-mia-name", "creator-id-leo-name"]);
  });

  it("seeds the follow store from each item", async () => {
    await setup("/creators", async () => page([creator("mia", { isFollowing: true, followers: 9 })]), {
      signedIn: true,
      extra: (
        <div data-testid="elsewhere">
          <FollowButton username="MIA" isFollowing={false} displayName="Mia elsewhere" />
        </div>
      ),
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Following Mia elsewhere" }).getAttribute("data-following")).toBe("true"));
    expect(screen.getByRole("button", { name: "Following Mia" })).toBeTruthy();
  });
});

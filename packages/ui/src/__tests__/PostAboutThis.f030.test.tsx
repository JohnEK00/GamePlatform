// GamePage and CollectionPage "✎ Post about this" entry points (F030 section 0.12).
import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Collection, Game, User } from "../api/types";
import { CollectionPage } from "../pages/CollectionPage";
import { GamePage } from "../pages/GamePage";
import { collection, game } from "./collectionFixtures";
import { leoUser } from "./postFixtures";
import { makeClient, renderWith } from "./postRender";

afterEach(() => vi.restoreAllMocks());

const fullGame = (over: Partial<Game> = {}): Game =>
  ({
    ...game("g/1", "Space Dodge"),
    width: 320,
    height: 240,
    version: 1,
    entry: "main.js",
    playUrl: "/play/g1",
    myRating: null,
    isOwner: false,
    isFavorite: false,
    achievements: [],
    leaderboard: { order: "desc", format: "number", label: "" },
    ...over,
  }) as Game;

async function showGame(g: Game, me: User | null) {
  const client = makeClient(me);
  vi.spyOn(client, "getGame").mockResolvedValue(g);
  vi.spyOn(client, "listScreenshots").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 12 });
  vi.spyOn(client, "listComments").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    perPage: 20,
    totalAll: 0,
    pinned: null,
    settings: { mode: "on", slowModeSecs: 0, canManage: false, waitSecs: 0 },
  });
  vi.spyOn(client, "getLeaderboard").mockRejectedValue(new Error("skip"));
  vi.spyOn(client, "listGameAchievements").mockResolvedValue([]);
  vi.spyOn(client, "getRelatedGames").mockResolvedValue([]);
  vi.spyOn(client, "listGameCollections").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(client, "listGameVersions").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 10 });
  vi.spyOn(client, "getUser").mockRejectedValue(new Error("skip"));
  await renderWith(
    client,
    <Routes>
      <Route path="/games/:id" element={<GamePage />} />
    </Routes>,
    `/games/${encodeURIComponent(g.id)}`,
    me,
  );
  await waitFor(() => expect(document.querySelector(".pf-gamepage__actions")).not.toBeNull());
  await act(async () => {});
  return document.querySelector<HTMLElement>(".pf-gamepage__actions")!;
}

async function showCollection(c: Collection, me: User | null) {
  const client = makeClient(me);
  vi.spyOn(client, "getCollection").mockImplementation(async () => structuredClone(c));
  await renderWith(
    client,
    <Routes>
      <Route path="/c/:id" element={<CollectionPage />} />
    </Routes>,
    "/c/c1",
    me,
  );
  return document.querySelector<HTMLElement>(".pf-collection-head__actions")!;
}

describe("GamePage: ✎ Post about this", () => {
  it("signed in, published: links to your Posts section with ?attach=game:{id}, right after Add to collection", async () => {
    const actions = await showGame(fullGame(), leoUser);
    const link = within(actions).getByRole("link", { name: "✎ Post about this" });
    expect(link.getAttribute("href")).toBe("/u/leo/posts?attach=game:g%2F1");
    expect(link.className).toBe("pf-btn pf-btn--ghost pf-btn--sm");
    const prev = link.previousElementSibling as HTMLElement;
    expect(prev.textContent).toMatch(/collection/i);
  });

  it("not for an unpublished game", async () => {
    const actions = await showGame(fullGame({ published: false, isOwner: true, owner: leoUser }), leoUser);
    expect(within(actions).queryByRole("link", { name: "✎ Post about this" })).toBeNull();
  });

  it("not when signed out", async () => {
    const actions = await showGame(fullGame(), null);
    expect(within(actions).queryByRole("link", { name: "✎ Post about this" })).toBeNull();
  });
});

describe("CollectionPage: ✎ Post about this", () => {
  it("signed in, public: links with ?attach=collection:{id}, right after Copy link", async () => {
    const actions = await showCollection(collection(), leoUser);
    const link = within(actions).getByRole("link", { name: "✎ Post about this" });
    expect(link.getAttribute("href")).toBe("/u/leo/posts?attach=collection:c1");
    expect((link.previousElementSibling as HTMLElement).textContent).toContain("Copy link");
  });

  it("not for a private collection", async () => {
    const actions = await showCollection(collection({ visibility: "private", isOwner: true, owner: leoUser }), leoUser);
    expect(within(actions).queryByRole("link", { name: "✎ Post about this" })).toBeNull();
  });

  it("not when signed out", async () => {
    await showCollection(collection(), null);
    expect(screen.queryByRole("link", { name: "✎ Post about this" })).toBeNull();
  });
});

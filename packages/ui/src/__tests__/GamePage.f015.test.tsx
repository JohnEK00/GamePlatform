import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HashRouter, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Game } from "../api/types";
import { GamePage } from "../pages/GamePage";
import { WebGameProviders } from "../WebGameApp";

function makeGame(over: Partial<Game> = {}): Game {
  return {
    id: "g1",
    title: "Kiln Clash",
    description: "",
    tags: [],
    owner: { id: "u1", username: "ana", displayName: "Ana", avatarUrl: null },
    thumbnailUrl: null,
    plays: 0,
    ratingAvg: 0,
    ratingCount: 0,
    published: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    favorites: 0,
    playsWeek: 0,
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
  };
}

/** A client whose un-mocked calls get a harmless 404 (no network in tests). */
function makeClient() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 }));
  const client = new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch });
  vi.spyOn(client, "getGame").mockResolvedValue(makeGame());
  vi.spyOn(client, "listScreenshots").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 12 });
  return client;
}

function renderWith(client: ApiClient, router: (routes: ReactNode) => ReactNode) {
  const routes = (
    <Routes>
      <Route path="/games/:id" element={<GamePage />} />
    </Routes>
  );
  return render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      {router(routes)}
    </WebGameProviders>,
  );
}

let scroll: ReturnType<typeof vi.fn>;
let orig: typeof Element.prototype.scrollIntoView;

beforeEach(() => {
  scroll = vi.fn();
  orig = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll as unknown as typeof Element.prototype.scrollIntoView;
});

afterEach(() => {
  Element.prototype.scrollIntoView = orig;
  window.location.hash = "";
  vi.restoreAllMocks();
});

describe("GamePage ?section=screenshots (F015 § 2.5)", () => {
  it("scrolls #screenshots into view after the game loads, without moving focus", async () => {
    const client = makeClient();
    renderWith(client, (r) => <MemoryRouter initialEntries={["/games/g1?section=screenshots"]}>{r}</MemoryRouter>);
    await screen.findByRole("heading", { name: "Kiln Clash" });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    const target = scroll.mock.contexts[0] as Element;
    expect(target.id).toBe("screenshots");
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(target.contains(document.activeElement)).toBe(false);
  });

  it("works under the desktop HashRouter", async () => {
    window.location.hash = "#/games/g1?section=screenshots";
    const client = makeClient();
    renderWith(client, (r) => <HashRouter>{r}</HashRouter>);
    await screen.findByRole("heading", { name: "Kiln Clash" });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect((scroll.mock.contexts[0] as Element).id).toBe("screenshots");
  });

  it("an unknown section value does nothing", async () => {
    const client = makeClient();
    renderWith(client, (r) => <MemoryRouter initialEntries={["/games/g1?section=toString"]}>{r}</MemoryRouter>);
    await screen.findByRole("heading", { name: "Kiln Clash" });
    await screen.findByRole("region", { name: /^Screenshots/ });
    expect(scroll).not.toHaveBeenCalled();
  });

  it("?section=versions still targets #versions", async () => {
    const client = makeClient();
    vi.mocked(client.getGame).mockResolvedValue(
      makeGame({ lastUpdatedAt: "2026-03-01T00:00:00Z", latestVersion: { version: 1, notes: "First", createdAt: "2026-03-01T00:00:00Z", current: true } }),
    );
    renderWith(client, (r) => <MemoryRouter initialEntries={["/games/g1?section=versions"]}>{r}</MemoryRouter>);
    await screen.findByRole("heading", { name: "Kiln Clash" });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect((scroll.mock.contexts[0] as Element).id).toBe("versions");
  });
});

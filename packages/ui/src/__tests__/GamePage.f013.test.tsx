import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Game } from "../api/types";
import type { PlatformConfig } from "../context/config";
import { EditGamePage } from "../pages/EditGamePage";
import { GamePage } from "../pages/GamePage";
import { WebGameProviders } from "../WebGameApp";

function makeGame(over: Partial<Game> = {}): Game {
  return {
    id: "g1",
    title: "Space Dodge",
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
    version: 4,
    entry: "main.js",
    playUrl: "/play/g1",
    myRating: null,
    isOwner: true,
    isFavorite: false,
    achievements: [],
    leaderboard: { order: "desc", format: "number", label: "" },
    ...over,
  };
}

function setup(path: string, platform?: PlatformConfig) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 }));
  const client = new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch });
  vi.spyOn(client, "getGame").mockResolvedValue(makeGame());
  const download = vi.spyOn(client, "downloadBundle").mockResolvedValue({ blob: new Blob(["zip"]), version: 4, filename: "space-dodge-v4.zip" });
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser", platform }} client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/games/:id" element={<GamePage />} />
          <Route path="/games/:id/edit" element={<EditGamePage />} />
        </Routes>
      </MemoryRouter>
    </WebGameProviders>,
  );
  return { client, download };
}

afterEach(() => vi.restoreAllMocks());

describe("Open in Studio (F013)", () => {
  it("game page owner panel links to /studio?open={id}", async () => {
    setup("/games/g1");
    const link = await screen.findByRole("link", { name: /Open in Studio/ });
    expect(link.getAttribute("href")).toBe("/studio?open=g1");
  });

  it("edit page links to /studio?open={id}", async () => {
    setup("/games/g1/edit");
    const link = await screen.findByRole("link", { name: /Open in Studio/ });
    expect(link.getAttribute("href")).toBe("/studio?open=g1");
  });
});

describe("Download current bundle (F013)", () => {
  it("uses platform.saveFile when present", async () => {
    const saveFile = vi.fn(async () => true);
    const { download } = setup("/games/g1/edit", { saveFile });
    const btn = await screen.findByRole("button", { name: /Download current bundle/ });
    await act(async () => fireEvent.click(btn));
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    expect(download).toHaveBeenCalledWith("g1");
    expect(saveFile.mock.calls[0]).toEqual(["space-dodge-v4.zip", expect.anything()]);
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("falls back to an <a download> link", async () => {
    const createUrl = URL.createObjectURL;
    const revokeUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      setup("/games/g1/edit");
      const btn = await screen.findByRole("button", { name: /Download current bundle/ });
    await act(async () => fireEvent.click(btn));
      await waitFor(() => expect(click).toHaveBeenCalled());
      expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("space-dodge-v4.zip");
    } finally {
      URL.createObjectURL = createUrl;
      URL.revokeObjectURL = revokeUrl;
    }
  });

  it("shows the API message on errors", async () => {
    const { download } = setup("/games/g1/edit");
    download.mockRejectedValue(new ApiError("rate_limited", "Slow down, try again in 30s.", 429, 30));
    const btn = await screen.findByRole("button", { name: /Download current bundle/ });
    await act(async () => fireEvent.click(btn));
    expect(await screen.findByText("Couldn't download the bundle")).toBeTruthy();
    expect(screen.getByText("Slow down, try again in 30s.")).toBeTruthy();
  });
});

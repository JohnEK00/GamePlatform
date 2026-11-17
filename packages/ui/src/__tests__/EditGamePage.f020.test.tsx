import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Game } from "../api/types";
import { EditGamePage } from "../pages/EditGamePage";
import { WebGameProviders } from "../WebGameApp";

function makeGame(over: Partial<Game> = {}): Game {
  return {
    id: "g1",
    title: "Pixel Peaks",
    description: "Jump!",
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
    lastUpdatedAt: "2026-03-01T00:00:00Z",
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
  } as Game;
}

function makeClient() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 }));
  return new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch });
}

function renderEdit(client: ApiClient) {
  return render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/games/g1/edit"]}>
        <Routes>
          <Route path="/games/:id/edit" element={<EditGamePage />} />
        </Routes>
      </MemoryRouter>
    </WebGameProviders>,
  );
}

afterEach(() => vi.restoreAllMocks());

const panelTitles = () => Array.from(document.querySelectorAll(".pf-panel > .pf-panel__title")).map((h) => h.textContent);

describe("EditGamePage F020: Comments panel", () => {
  it("renders between Details and Files with the form for game.commentSettings", async () => {
    const client = makeClient();
    vi.spyOn(client, "getGame").mockResolvedValue(makeGame({ commentSettings: { mode: "repliesOnly", slowModeSecs: 60 } }));
    renderEdit(client);
    const panel = (await screen.findByRole("region", { name: "Comments" })) as HTMLElement;
    expect(panel.id).toBe("comment-settings");
    expect(panel.tagName).toBe("SECTION");
    expect(panelTitles()).toEqual(["Details", "Comments", "Files", "Danger zone"]);
    expect(within(panel).getByRole("radio", { name: "Replies only: no new threads" })).toHaveProperty("checked", true);
    expect((within(panel).getByLabelText("Slow mode") as HTMLSelectElement).value).toBe("60");
    expect(within(panel).getByRole("button", { name: /Save comment settings/ }).getAttribute("aria-disabled")).toBe("true");
  });

  it("saves, merges the result into the game, and leaves unsaved Details values alone", async () => {
    const client = makeClient();
    vi.spyOn(client, "getGame").mockResolvedValue(makeGame({ commentSettings: { mode: "on", slowModeSecs: 0 } }));
    const put = vi.spyOn(client, "updateCommentSettings").mockResolvedValue({ mode: "off", slowModeSecs: 300 });
    const update = vi.spyOn(client, "updateGame");
    renderEdit(client);
    const panel = (await screen.findByRole("region", { name: "Comments" })) as HTMLElement;

    // An unsaved Details edit.
    const title = screen.getByLabelText(/Title/) as HTMLInputElement;
    fireEvent.change(title, { target: { value: "Pixel Peaks II" } });

    fireEvent.click(within(panel).getByRole("radio", { name: "Off: no new comments or replies" }));
    fireEvent.change(within(panel).getByLabelText("Slow mode"), { target: { value: "300" } });
    const save = within(panel).getByRole("button", { name: /Save comment settings/ });
    save.focus();
    await act(async () => fireEvent.click(save));

    expect(put).toHaveBeenCalledWith("g1", { mode: "off", slowModeSecs: 300 });
    expect(update).not.toHaveBeenCalled();
    expect(await screen.findByText("Comment settings saved")).toBeTruthy();
    // The saved values are now the baseline: nothing changed → Save disabled, values kept.
    expect(within(panel).getByRole("radio", { name: "Off: no new comments or replies" })).toHaveProperty("checked", true);
    expect((within(panel).getByLabelText("Slow mode") as HTMLSelectElement).value).toBe("300");
    // Review 8 L3: aria-disabled, not disabled, so keyboard focus stays on Save instead of falling to <body>.
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect((save as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(save);
    expect((screen.getByLabelText(/Title/) as HTMLInputElement).value).toBe("Pixel Peaks II");
  });

  it("is hidden when the server doesn't send commentSettings", async () => {
    const client = makeClient();
    vi.spyOn(client, "getGame").mockResolvedValue(makeGame());
    renderEdit(client);
    await screen.findByRole("heading", { name: "Edit game" });
    expect(screen.queryByRole("region", { name: "Comments" })).toBeNull();
    expect(document.getElementById("comment-settings")).toBeNull();
    expect(panelTitles()).toEqual(["Details", "Files", "Danger zone"]);
  });
});

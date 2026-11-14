import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Game, GameVersion } from "../api/types";
import { EditGamePage } from "../pages/EditGamePage";
import { GamePage } from "../pages/GamePage";
import { UploadPage } from "../pages/UploadPage";
import { REPLACE_CONFLICT_MESSAGE } from "../util";
import { WebGameProviders } from "../WebGameApp";

const row = (version: number, notes = "", current = true): GameVersion => ({ version, notes, createdAt: "2026-03-01T00:00:00Z", current });

function makeGame(over: Partial<Game> = {}): Game {
  const version = over.version ?? 4;
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
    version,
    entry: "main.js",
    playUrl: "/play/g1",
    myRating: null,
    isOwner: true,
    isFavorite: false,
    achievements: [],
    leaderboard: { order: "desc", format: "number", label: "" },
    latestVersion: row(version, "v4 notes"),
    ...over,
  };
}

const zipFile = () => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])], "peaks-v5.zip", { type: "application/zip" });

/** A client whose un-mocked calls get a harmless 404 (no network in tests). */
function makeClient() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 }));
  return new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch });
}

function renderAt(path: string, client: ApiClient, pickFile?: () => Promise<File | null>) {
  return render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser", platform: { pickFile } }} client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/games/:id" element={<GamePage />} />
          <Route path="/games/:id/edit" element={<EditGamePage />} />
          <Route path="/upload" element={<UploadPage />} />
        </Routes>
      </MemoryRouter>
    </WebGameProviders>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditGamePage F004: replace with notes + expectedVersion", () => {
  it("sends notes and expectedVersion = game.version; success clears the notes", async () => {
    const client = makeClient();
    vi.spyOn(client, "getGame").mockResolvedValue(makeGame());
    const replace = vi.spyOn(client, "replaceBundle").mockResolvedValue(makeGame({ version: 5, latestVersion: row(5, "New levels") }));
    renderAt("/games/g1/edit", client, async () => zipFile());
    await screen.findByRole("heading", { name: "Edit game" });

    const upload = screen.getByRole("button", { name: "Upload new version" }) as HTMLButtonElement;
    expect(upload.disabled).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New bundle (.zip)" })));
    expect(upload.disabled).toBe(false);
    const notes = screen.getByLabelText("What's new in this version (optional)") as HTMLTextAreaElement;
    // N8: the limit is enforced in code points by the field, not by the UTF-16 `maxlength` attribute.
    expect(notes.hasAttribute("maxlength")).toBe(false);
    expect(notes.rows).toBe(4);
    fireEvent.change(notes, { target: { value: "New levels" } });
    await act(async () => fireEvent.click(upload));

    expect(replace).toHaveBeenCalledTimes(1);
    const [id, file, , opts] = replace.mock.calls[0];
    expect(id).toBe("g1");
    expect((file as File).name).toBe("peaks-v5.zip");
    expect(opts).toEqual({ notes: "New levels", expectedVersion: 4 });
    expect(await screen.findByText("Version 5 is live")).toBeTruthy();
    expect((screen.getByLabelText("What's new in this version (optional)") as HTMLTextAreaElement).value).toBe("");
  });

  it("409: shows the reload message; Reload refetches and keeps the file and typed notes", async () => {
    const client = makeClient();
    const get = vi.spyOn(client, "getGame").mockResolvedValueOnce(makeGame()).mockResolvedValueOnce(makeGame({ version: 6, latestVersion: row(6) }));
    const replace = vi
      .spyOn(client, "replaceBundle")
      .mockRejectedValueOnce(new ApiError("conflict", "The game is at v6; reload and retry", 409))
      .mockResolvedValueOnce(makeGame({ version: 7, latestVersion: row(7, "Boss fight") }));
    renderAt("/games/g1/edit", client, async () => zipFile());
    await screen.findByRole("heading", { name: "Edit game" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New bundle (.zip)" })));
    fireEvent.change(screen.getByLabelText("What's new in this version (optional)"), { target: { value: "Boss fight" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Upload new version" })));

    expect(screen.getByText(REPLACE_CONFLICT_MESSAGE)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reload" })));
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(REPLACE_CONFLICT_MESSAGE)).toBeNull();
    expect((screen.getByLabelText("What's new in this version (optional)") as HTMLTextAreaElement).value).toBe("Boss fight");
    expect(screen.getByText("peaks-v5.zip")).toBeTruthy();
    expect(screen.getByText(/Version 6 · entry/)).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Upload new version" })));
    expect(replace.mock.calls[1][3]).toEqual({ notes: "Boss fight", expectedVersion: 6 });
  });

  it("422 about notes shows under the textarea", async () => {
    const client = makeClient();
    vi.spyOn(client, "getGame").mockResolvedValue(makeGame());
    vi.spyOn(client, "replaceBundle").mockRejectedValue(new ApiError("validation", "notes must be at most 1000 characters", 422));
    const { container } = renderAt("/games/g1/edit", client, async () => zipFile());
    await screen.findByRole("heading", { name: "Edit game" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New bundle (.zip)" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Upload new version" })));
    expect(container.querySelector(".pf-notesfield .pf-field__error")!.textContent).toBe("notes must be at most 1000 characters");
  });

  it("shows the counter from 900 characters", async () => {
    const client = makeClient();
    vi.spyOn(client, "getGame").mockResolvedValue(makeGame());
    const { container } = renderAt("/games/g1/edit", client);
    await screen.findByRole("heading", { name: "Edit game" });
    const ta = screen.getByLabelText("What's new in this version (optional)");
    fireEvent.change(ta, { target: { value: "a".repeat(899) } });
    expect(container.querySelector(".pf-notesfield__count")).toBeNull();
    fireEvent.change(ta, { target: { value: "a".repeat(900) } });
    expect(container.querySelector(".pf-notesfield__count")!.textContent).toBe("900/1000");
  });
});

describe("GamePage F004: owner-panel replace modal", () => {
  it("pick → modal with notes → Upload sends notes + expectedVersion; 409 → Reload keeps the notes", async () => {
    const client = makeClient();
    const get = vi
      .spyOn(client, "getGame")
      .mockResolvedValueOnce(makeGame())
      .mockResolvedValueOnce(makeGame({ version: 6, latestVersion: row(6, "someone else") }));
    const replace = vi
      .spyOn(client, "replaceBundle")
      .mockRejectedValueOnce(new ApiError("conflict", "The game is at v6; reload and retry", 409))
      .mockResolvedValueOnce(makeGame({ version: 7, latestVersion: row(7, "Added 3 new levels") }));
    renderAt("/games/g1", client, async () => zipFile());
    await screen.findByRole("heading", { name: "Pixel Peaks", level: 1 });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "⬆ Replace bundle" })));
    const dialog = await screen.findByRole("dialog", { name: "Upload a new version" });
    expect(dialog.textContent).toContain("peaks-v5.zip");
    fireEvent.change(screen.getByLabelText("What's new in this version (optional)"), { target: { value: "Added 3 new levels" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Upload" })));
    expect(replace.mock.calls[0][0]).toBe("g1");
    expect(replace.mock.calls[0][3]).toEqual({ notes: "Added 3 new levels", expectedVersion: 4 });

    expect(screen.getByText(REPLACE_CONFLICT_MESSAGE)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reload" })));
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(REPLACE_CONFLICT_MESSAGE)).toBeNull();
    // Still in the modal, file and notes kept.
    expect(screen.getByRole("dialog").textContent).toContain("peaks-v5.zip");
    expect((screen.getByLabelText("What's new in this version (optional)") as HTMLTextAreaElement).value).toBe("Added 3 new levels");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Upload" })));
    expect(replace.mock.calls[1][3]).toEqual({ notes: "Added 3 new levels", expectedVersion: 6 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Version 7 is live")).toBeTruthy();
    // The "What's new" panel shows the new version's notes.
    expect(document.querySelector("#versions .pf-versions__notes")!.textContent).toBe("Added 3 new levels");
  });

  it("Cancel closes the modal without uploading; Game info shows the Updated row", async () => {
    const client = makeClient();
    vi.spyOn(client, "getGame").mockResolvedValue(makeGame());
    const replace = vi.spyOn(client, "replaceBundle");
    renderAt("/games/g1", client, async () => zipFile());
    await screen.findByRole("heading", { name: "Pixel Peaks", level: 1 });
    const info = screen.getByRole("region", { name: "Game info" });
    expect(Array.from(info.querySelectorAll("dt")).map((d) => d.textContent)).toContain("Updated");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "⬆ Replace bundle" })));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("?section=versions scrolls the What's new panel into view", async () => {
    const client = makeClient();
    vi.spyOn(client, "getGame").mockResolvedValue(makeGame({ isOwner: false }));
    const scroll = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      renderAt("/games/g1?section=versions", client);
      await screen.findByRole("heading", { name: "What's new" });
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect((scroll.mock.contexts[0] as Element).id).toBe("versions");
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});

describe("UploadPage F004: release notes", () => {
  it("collapsed behind '+ Add release notes'; sent as notes", async () => {
    const client = makeClient();
    const create = vi.spyOn(client, "createGame").mockResolvedValue(makeGame({ version: 1 }));
    renderAt("/upload", client, async () => zipFile());
    expect(screen.queryByLabelText("Release notes (optional)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+ Add release notes" }));
    fireEvent.change(screen.getByLabelText("Release notes (optional)"), { target: { value: "First release" } });
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "My game" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Game bundle (.zip) *" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Upload game" })));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ title: "My game", notes: "First release" });
  });
});

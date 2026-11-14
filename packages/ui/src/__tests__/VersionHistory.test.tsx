import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Game, GameVersion, Page } from "../api/types";
import { VersionHistory } from "../components/VersionHistory";
import { WebGameProviders } from "../WebGameApp";

const row = (version: number, notes = "", current = false): GameVersion => ({
  version,
  notes,
  createdAt: `2026-0${Math.min(9, version)}-01T00:00:00Z`,
  current,
});

function makeGame(over: Partial<Game> = {}): Game {
  const version = over.version ?? 3;
  return {
    id: "g1",
    title: "Pixel Peaks",
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
    lastUpdatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    width: 320,
    height: 240,
    version,
    entry: "main.js",
    playUrl: "/play/g1",
    myRating: null,
    isOwner: false,
    isFavorite: false,
    achievements: [],
    leaderboard: { order: "desc", format: "number", label: "" },
    latestVersion: row(version, "Added 3 new levels", true),
    ...over,
  };
}

function page(items: GameVersion[], total: number, p = 1): Page<GameVersion> {
  return { items, total, page: p, perPage: 20 };
}

function setup(game: Game, client = new ApiClient({ baseUrl: "http://api.test" }), onUpdated = vi.fn()) {
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <VersionHistory game={game} onUpdated={onUpdated} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  return { ...utils, client, onUpdated };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VersionHistory", () => {
  it("is hidden for v1 with empty notes, and for older servers without latestVersion", () => {
    const a = setup(makeGame({ version: 1, latestVersion: row(1, "", true), lastUpdatedAt: null }));
    expect(a.container.querySelector("#versions")).toBeNull();
    a.unmount();
    const b = setup(makeGame({ latestVersion: undefined }));
    expect(b.container.querySelector("#versions")).toBeNull();
  });

  it("shows v1 with notes ('Released' date), and later versions with 'Updated …'", () => {
    const a = setup(makeGame({ version: 1, latestVersion: row(1, "First!", true), lastUpdatedAt: null }));
    const sec = a.container.querySelector("section#versions")!;
    expect(sec.getAttribute("aria-labelledby")).toBe(screen.getByRole("heading", { name: "What's new" }).id);
    expect(sec.querySelector(".pf-versions__summary")!.textContent).toMatch(/^v1 · Released /);
    a.unmount();
    const b = setup(makeGame());
    expect(b.container.querySelector(".pf-versions__summary")!.textContent).toBe("v3 · Updated 3 hours ago");
    expect(b.container.querySelector(".pf-versions__notes")!.textContent).toBe("Added 3 new levels");
  });

  it("muted empty text when the latest version has no notes", () => {
    const { container } = setup(makeGame({ latestVersion: row(3, "", true) }));
    expect(container.querySelector(".pf-versions__empty")!.textContent).toBe("No release notes for this version.");
  });

  it("renders notes as literal text (a <script> string appears as typed)", () => {
    const evil = '<script>alert("x")</script>\n<b>bold</b>';
    const { container } = setup(makeGame({ latestVersion: row(3, evil, true) }));
    const notes = container.querySelector(".pf-versions__notes")!;
    expect(notes.textContent).toBe(evil);
    expect(notes.querySelector("script, b")).toBeNull();
  });

  it("lazily loads the history on expand and pages with 'Show older'", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    const spy = vi
      .spyOn(client, "listGameVersions")
      .mockResolvedValueOnce(page([row(25, "latest", true), ...Array.from({ length: 19 }, (_, i) => row(24 - i))], 25, 1))
      .mockResolvedValueOnce(page([row(5), row(4), row(3), row(2, "two"), row(1, "one")], 25, 2));
    const { container } = setup(makeGame({ version: 25, latestVersion: row(25, "latest", true) }), client);
    expect(spy).not.toHaveBeenCalled();
    const toggle = screen.getByRole("button", { name: /Version history/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => fireEvent.click(toggle));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(spy).toHaveBeenCalledWith("g1", { page: 1, perPage: 20 });
    expect(container.querySelectorAll(".pf-versions__row").length).toBe(20);
    expect(container.querySelector('.pf-versions__row[data-current] .pf-versions__current')!.textContent).toBe("Current");
    expect(container.querySelectorAll(".pf-versions__current").length).toBe(1);
    expect(container.querySelector(".pf-versions__earlier")).toBeNull();
    const time = container.querySelector(".pf-versions__row time")!;
    expect(time.getAttribute("title")).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Show older" })));
    expect(spy).toHaveBeenLastCalledWith("g1", { page: 2, perPage: 20 });
    expect(container.querySelectorAll(".pf-versions__row").length).toBe(25);
    expect(screen.queryByRole("button", { name: "Show older" })).toBeNull();
    // History reaches v1: no "earlier versions" line.
    expect(container.querySelector(".pf-versions__earlier")).toBeNull();
    // Collapsing and re-expanding does not refetch.
    fireEvent.click(toggle);
    await act(async () => fireEvent.click(toggle));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("ends with the 'earlier versions' line when the oldest row is above v1", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "listGameVersions").mockResolvedValue(page([row(3, "x", true), row(2)], 2));
    const { container } = setup(makeGame(), client);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Version history/ })));
    expect(container.querySelector(".pf-versions__earlier")!.textContent).toBe("Earlier versions were published before release notes existed.");
    // Rows without notes show the muted empty text.
    expect(container.querySelectorAll(".pf-versions__row .pf-versions__empty").length).toBe(1);
  });

  it("non-owners see no Edit buttons", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "listGameVersions").mockResolvedValue(page([row(3, "x", true), row(2)], 2));
    setup(makeGame({ isOwner: false }), client);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Version history/ })));
    expect(screen.queryByRole("button", { name: /Edit notes/ })).toBeNull();
  });

  it("owner edits the current version: PATCH, row updated in place, onUpdated with latestVersion", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "listGameVersions").mockResolvedValue(page([row(3, "Added 3 new levels", true), row(2, "old")], 2));
    const patch = vi.spyOn(client, "updateVersionNotes").mockImplementation(async (_id, v, notes) => ({ ...row(v, notes, v === 3) }));
    const game = makeGame({ isOwner: true });
    const { container, onUpdated } = setup(game, client);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Version history/ })));

    fireEvent.click(screen.getByRole("button", { name: "Edit notes for v3" }));
    const ta = container.querySelector<HTMLTextAreaElement>(".pf-versions__row textarea")!;
    expect(ta.value).toBe("Added 3 new levels");
    expect(ta.maxLength).toBe(1000);
    fireEvent.change(ta, { target: { value: "Added 3 new levels and a boss" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(patch).toHaveBeenCalledWith("g1", 3, "Added 3 new levels and a boss");
    expect(container.querySelector(".pf-versions__row textarea")).toBeNull();
    expect(container.querySelector(".pf-versions__row .pf-versions__notes")!.textContent).toBe("Added 3 new levels and a boss");
    expect(onUpdated).toHaveBeenCalledTimes(1);
    expect(onUpdated.mock.calls[0][0].latestVersion).toMatchObject({ version: 3, notes: "Added 3 new levels and a boss", current: true });
    expect(onUpdated.mock.calls[0][0].id).toBe("g1");
  });

  it("owner edits an older version: no onUpdated; Cancel discards", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "listGameVersions").mockResolvedValue(page([row(3, "x", true), row(2, "old")], 2));
    const patch = vi.spyOn(client, "updateVersionNotes").mockImplementation(async (_id, v, notes) => row(v, notes));
    const { container, onUpdated } = setup(makeGame({ isOwner: true }), client);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Version history/ })));

    fireEvent.click(screen.getByRole("button", { name: "Edit notes for v2" }));
    fireEvent.change(container.querySelector(".pf-versions__row textarea")!, { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(container.querySelector(".pf-versions__row textarea")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit notes for v2" }));
    fireEvent.change(container.querySelector(".pf-versions__row textarea")!, { target: { value: "older fixed" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("g1", 2, "older fixed");
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("shows a 422 under the textarea and a 429 as a toast", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "listGameVersions").mockResolvedValue(page([row(3, "x", true)], 1));
    vi.spyOn(client, "updateVersionNotes")
      .mockRejectedValueOnce(new ApiError("validation", "notes contain invalid characters", 422))
      .mockRejectedValueOnce(new ApiError("rate_limited", "Slow down", 429, 12));
    const { container } = setup(makeGame({ isOwner: true }), client);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Version history/ })));
    fireEvent.click(screen.getByRole("button", { name: "Edit notes for v3" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(container.querySelector(".pf-versions__row .pf-field__error")!.textContent).toBe("notes contain invalid characters");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(await screen.findByText("Slow down — try again in 12s")).toBeTruthy();
  });
});

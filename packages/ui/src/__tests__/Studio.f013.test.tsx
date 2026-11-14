import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Game, GameSummary, User } from "../api/types";
import type { PlatformConfig } from "../context/config";
import { StudioPage } from "../pages/StudioPage";
import { deserializeSession, serializeProject, STUDIO_STORAGE_KEY, type StudioLink, type StudioProject } from "../studio/project";
import { createZip } from "../studio/zip";
import { WebGameProviders } from "../WebGameApp";

const API = "http://api.test";
const me: User = { id: "u1", username: "ana", displayName: "Ana", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const manifest = { name: "Space Dodge", entry: "main.js", width: 320, height: 240 };
const localProject: StudioProject = { manifest, files: { "main.js": "// local edits" } };

function summary(over: Partial<GameSummary> = {}): GameSummary {
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
    ...over,
  };
}

function game(over: Partial<Game> = {}): Game {
  const version = over.version ?? 4;
  return {
    ...summary(over),
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
    latestVersion: { version, notes: "", createdAt: "2026-03-01T00:00:00Z", current: true },
    ...over,
  };
}

const bundleZip = (code = "// from server") => new Blob([createZip({ "game.json": JSON.stringify(manifest), "main.js": code })], { type: "application/zip" });

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

type SetupOpts = {
  path?: string;
  signedIn?: boolean;
  platform?: PlatformConfig;
  session?: { project?: StudioProject; link?: StudioLink | null; dirty?: boolean };
  apiBase?: string;
  games?: GameSummary[];
  server?: Game;
};

function setup(opts: SetupOpts = {}) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 }));
  const client = new ApiClient({ baseUrl: opts.apiBase ?? API, fetch: fetchMock as unknown as typeof fetch });
  if (opts.signedIn !== false) {
    localStorage.setItem("webgame.token", "tok");
    vi.spyOn(client, "me").mockResolvedValue(me);
  }
  if (opts.session) {
    localStorage.setItem(
      STUDIO_STORAGE_KEY,
      serializeProject(opts.session.project ?? localProject, { link: opts.session.link ?? null, dirty: opts.session.dirty ?? false }),
    );
  }
  let server = opts.server ?? game();
  const getGame = vi.spyOn(client, "getGame").mockImplementation(async () => server);
  const download = vi.spyOn(client, "downloadBundle").mockImplementation(async () => ({ blob: bundleZip(), version: server.version, filename: "space-dodge-v4.zip" }));
  const listGames = vi.spyOn(client, "listGames").mockResolvedValue({ items: opts.games ?? [summary()], total: 1, page: 1, perPage: 100 });
  const replace = vi.spyOn(client, "replaceBundle");
  const create = vi.spyOn(client, "createGame");
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: API, routerMode: "browser", platform: opts.platform }} client={client}>
      <MemoryRouter initialEntries={[opts.path ?? "/studio"]}>
        <Routes>
          <Route
            path="/studio"
            element={
              <>
                <StudioPage />
                <LocationProbe />
              </>
            }
          />
          <Route path="/login" element={<LocationProbe />} />
          <Route path="/games/:id" element={<div>Game page</div>} />
        </Routes>
      </MemoryRouter>
    </WebGameProviders>,
  );
  return { ...utils, client, getGame, download, listGames, replace, create, setServer: (g: Game) => (server = g) };
}

const loc = () => screen.getByTestId("loc").textContent;
const editor = (name = "Edit main.js") => screen.getByRole("textbox", { name }) as HTMLTextAreaElement;
const chip = () => screen.queryByTestId("studio-link");
const stored = () => deserializeSession(localStorage.getItem(STUDIO_STORAGE_KEY) ?? "")!;
const linkTo = (version: number, apiBase = API): StudioLink => ({ gameId: "g1", title: "Space Dodge", version, apiBase });

async function openPublish() {
  const btn = await screen.findByRole("button", { name: /⬆ Publish/ });
  await act(async () => fireEvent.click(btn));
  return screen.getByRole("dialog", { name: "Publish" });
}

async function openMenuItem(name: string) {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /Open/, expanded: false })));
  await act(async () => fireEvent.click(screen.getByRole("menuitem", { name })));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Studio ?open= (F013)", () => {
  it("downloads the game, loads it, shows the link chip and removes the query", async () => {
    const { download } = setup({ path: "/studio?open=g1" });
    await waitFor(() => expect(editor().value).toBe("// from server"));
    expect(download).toHaveBeenCalledWith("g1");
    expect(loc()).toBe("/studio");
    const c = chip()!;
    expect(c.textContent).toMatch(/Linked to\s*Space Dodge · v4/);
    expect(within(c).getByRole("link", { name: "Space Dodge" }).getAttribute("href")).toBe("/games/g1");
    expect(screen.getByText("Opened “Space Dodge” v4.")).toBeTruthy();
    await waitFor(() => expect(stored().link).toEqual(linkTo(4)));
    expect(stored().dirty).toBe(false);
  });

  it("asks before replacing a dirty project", async () => {
    const { download } = setup({ path: "/studio?open=g1", session: { dirty: true } });
    const dialog = await screen.findByRole("dialog", { name: "Replace the current project?" });
    expect(download).not.toHaveBeenCalled();
    expect(editor().value).toBe("// local edits");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Replace" })));
    await waitFor(() => expect(editor().value).toBe("// from server"));
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("redirects anonymous users to login with next", async () => {
    const { download } = setup({ path: "/studio?open=g1", signedIn: false });
    await waitFor(() => expect(loc()).toBe("/login?next=%2Fstudio%3Fopen%3Dg1"));
    expect(download).not.toHaveBeenCalled();
  });

  it("says Already open when linked at the server's version and clean", async () => {
    const { download } = setup({ path: "/studio?open=g1", session: { link: linkTo(4) } });
    expect(await screen.findByText("Already open")).toBeTruthy();
    expect(download).not.toHaveBeenCalled();
  });

  it("leaves the project alone on 404/403", async () => {
    const { download } = setup({ path: "/studio?open=g1", session: {} });
    download.mockRejectedValue(new ApiError("not_found", "Game not found", 404));
    expect(await screen.findByText("Couldn't open the game")).toBeTruthy();
    expect(screen.getByText("It may have been deleted, or it isn't yours.")).toBeTruthy();
    expect(editor().value).toBe("// local edits");
    expect(chip()).toBeNull();
  });

  it("retries a 409 once", async () => {
    const { download } = setup({ path: "/studio?open=g1" });
    download.mockRejectedValueOnce(new ApiError("conflict", "changed", 409));
    await waitFor(() => expect(editor().value).toBe("// from server"));
    expect(download).toHaveBeenCalledTimes(2);
  });
});

describe("Studio Publish dialog (F013)", () => {
  it("defaults to Update when linked; at the current version there is no checkbox and replaceBundle gets expectedVersion + notes", async () => {
    const { replace } = setup({ session: { link: linkTo(4), dirty: true } });
    replace.mockResolvedValue(game({ version: 5 }));
    const dialog = await openPublish();
    expect((within(dialog).getByRole("radio", { name: "Update an existing game" }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect((within(dialog).getByRole("combobox", { name: "Game" }) as HTMLSelectElement).value).toBe("g1"));
    await within(dialog).findByText(/Currently v4 · Published/);
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    fireEvent.change(within(dialog).getByRole("textbox", { name: /What's new/ }), { target: { value: "Faster asteroids" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Publish update/ })));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const [id, file, , opts] = replace.mock.calls[0];
    expect(id).toBe("g1");
    expect((file as File).name).toBe("space-dodge.zip");
    expect(opts).toEqual({ notes: "Faster asteroids", expectedVersion: 4 });
    // Success: chip shows v5, dirty is cleared, we stay in the Studio.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(chip()!.textContent).toMatch(/v5/);
    expect(screen.getByText("Version 5 of Space Dodge is live")).toBeTruthy();
    expect(loc()).toBe("/studio");
    expect(stored().dirty).toBe(false);
    expect(stored().link).toEqual(linkTo(5));
  });

  it("warns about a stale link and requires the checkbox", async () => {
    const { replace } = setup({ session: { link: linkTo(3) }, server: game({ version: 4 }) });
    replace.mockResolvedValue(game({ version: 5 }));
    const dialog = await openPublish();
    expect(await within(dialog).findByText(/was updated to v4 outside this project \(you last opened or published v3\)/)).toBeTruthy();
    const box = within(dialog).getByRole("checkbox", { name: /Replace all files of “Space Dodge” \(v4\) with this project/ });
    const submit = within(dialog).getByRole("button", { name: /Publish update/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(box);
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(replace.mock.calls[0][3]).toEqual({ notes: "", expectedVersion: 4 });
  });

  it("unlinked: preselects the only game whose title matches game.json name, and requires the checkbox", async () => {
    setup({ session: {}, games: [summary({ id: "g2", title: "Other" }), summary(), summary({ id: "g3", title: "Draft one", published: false })] });
    const dialog = await openPublish();
    expect((within(dialog).getByRole("radio", { name: "New game" }) as HTMLInputElement).checked).toBe(true);
    await act(async () => fireEvent.click(within(dialog).getByRole("radio", { name: "Update an existing game" })));
    const select = within(dialog).getByRole("combobox", { name: "Game" }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("g1"));
    expect(within(dialog).getByRole("option", { name: "Draft one (draft)" })).toBeTruthy();
    expect(await within(dialog).findByRole("checkbox", { name: /Replace all files of “Space Dodge”/ })).toBeTruthy();
    expect(within(dialog).queryByText(/outside this project/)).toBeNull();
  });

  it("409: refetches, explains, asks for the checkbox again and keeps the notes", async () => {
    const { replace, getGame, setServer } = setup({ session: { link: linkTo(4) } });
    replace.mockImplementation(async () => {
      setServer(game({ version: 6 }));
      throw new ApiError("conflict", "version mismatch", 409);
    });
    const dialog = await openPublish();
    await within(dialog).findByText(/Currently v4/);
    fireEvent.change(within(dialog).getByRole("textbox", { name: /What's new/ }), { target: { value: "Keep me" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Publish update/ })));
    expect(await within(dialog).findByText("“Space Dodge” changed while you were publishing (now v6). Check and try again.")).toBeTruthy();
    expect(getGame.mock.calls.length).toBeGreaterThanOrEqual(2);
    const box = within(dialog).getByRole("checkbox", { name: /Replace all files of “Space Dodge” \(v6\)/ }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect((within(dialog).getByRole("textbox", { name: /What's new/ }) as HTMLTextAreaElement).value).toBe("Keep me");
    fireEvent.click(box);
    replace.mockResolvedValue(game({ version: 7 }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Publish update/ })));
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
    expect(replace.mock.calls[1][3]).toEqual({ notes: "Keep me", expectedVersion: 6 });
  });

  it("404 on update unlinks the project", async () => {
    const { replace, listGames } = setup({ session: { link: linkTo(4) } });
    replace.mockRejectedValue(new ApiError("not_found", "Game not found", 404));
    const dialog = await openPublish();
    await within(dialog).findByText(/Currently v4/);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Publish update/ })));
    expect(await within(dialog).findByText("You can't update this game. It may have been deleted.")).toBeTruthy();
    await waitFor(() => expect(chip()).toBeNull());
    expect(listGames.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a new publish sets the link with version 1", async () => {
    const { create } = setup({ session: {} });
    create.mockResolvedValue(game({ id: "g9", title: "Space Dodge", version: 1 }));
    const dialog = await openPublish();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "+ Add release notes" })));
    fireEvent.change(within(dialog).getByRole("textbox", { name: /What's new/ }), { target: { value: "First!" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /^Publish$/ })));
    await waitFor(() => expect(screen.getByText("Game page")).toBeTruthy());
    expect(create.mock.calls[0][0]).toMatchObject({ title: "Space Dodge", notes: "First!" });
    expect(stored().link).toEqual({ gameId: "g9", title: "Space Dodge", version: 1, apiBase: API });
    expect(stored().dirty).toBe(false);
  });

  it("ignores a link from another server: no chip, Publish defaults to New", async () => {
    setup({ session: { link: linkTo(4, "http://other.test") } });
    await screen.findByRole("heading", { name: "Studio" });
    expect(chip()).toBeNull();
    const dialog = await openPublish();
    expect((within(dialog).getByRole("radio", { name: "New game" }) as HTMLInputElement).checked).toBe(true);
    // The link is kept for when the server setting switches back.
    expect(stored().link).toEqual(linkTo(4, "http://other.test"));
  });
});

describe("Studio Open menu, link and reload (F013)", () => {
  it("unlink button clears the link", async () => {
    setup({ session: { link: linkTo(4) } });
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Unlink from Space Dodge" })));
    expect(chip()).toBeNull();
  });

  it("opening a template clears the link (no confirm when clean)", async () => {
    setup({ session: { link: linkTo(4) } });
    expect(await screen.findByTestId("studio-link")).toBeTruthy();
    await act(async () => fireEvent.change(screen.getByLabelText("New from template"), { target: { value: "blank" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(chip()).toBeNull();
  });

  it("opening a folder clears the link", async () => {
    const openLocalProject = vi.fn(async () => ({ manifest, files: { "main.js": "// folder" } }));
    setup({ session: { link: linkTo(4) }, platform: { openLocalProject } });
    expect(await screen.findByTestId("studio-link")).toBeTruthy();
    await openMenuItem("Local folder…");
    await waitFor(() => expect(editor().value).toBe("// folder"));
    expect(chip()).toBeNull();
  });

  it("opens a .zip through platform.pickFile, clears the link, and confirms first when dirty", async () => {
    const pickFile = vi.fn(async () => new File([createZip({ "game/game.json": JSON.stringify(manifest), "game/main.js": "// zip" })], "game.zip"));
    setup({ session: { link: linkTo(4), dirty: true }, platform: { pickFile } });
    expect(await screen.findByTestId("studio-link")).toBeTruthy();
    await openMenuItem(".zip file…");
    const dialog = screen.getByRole("dialog", { name: "Replace the current project?" });
    expect(pickFile).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Replace" })));
    await waitFor(() => expect(editor().value).toBe("// zip"));
    expect(pickFile).toHaveBeenCalledWith(".zip,application/zip");
    expect(chip()).toBeNull();
  });

  it("My game… is disabled when logged out, and opens the game list when signed in", async () => {
    setup({ signedIn: false });
    await screen.findByRole("heading", { name: "Studio" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Open/ })));
    const item = screen.getByRole("menuitem", { name: "My game…" }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe("Log in to open your games");
  });

  it("Open → My game… lists games and opens the chosen one", async () => {
    const { download } = setup({ games: [summary(), summary({ id: "g2", title: "Pixel Peaks", published: false })] });
    await screen.findByRole("button", { name: /⬆ Publish/ });
    await openMenuItem("My game…");
    const dialog = screen.getByRole("dialog", { name: "Open one of your games" });
    expect(await within(dialog).findByText("Draft")).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "pixel" } });
    expect(within(dialog).queryByText("Space Dodge")).toBeNull();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Pixel Peaks/ })));
    await waitFor(() => expect(download).toHaveBeenCalledWith("g2"));
  });

  it("the Open menu works from the keyboard", async () => {
    setup();
    await screen.findByRole("heading", { name: "Studio" });
    const btn = screen.getByRole("button", { name: /Open/ });
    btn.focus();
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  describe("Reload folder (desktop)", () => {
    const folder = { id: "f1", name: "pixel-peaks" };

    it("is hidden without localFolder", async () => {
      const openLocalProject = vi.fn(async () => ({ manifest, files: { "main.js": "// v1" } }));
      setup({ platform: { openLocalProject, reloadLocalProject: vi.fn() } });
      await screen.findByRole("heading", { name: "Studio" });
      await openMenuItem("Local folder…");
      await waitFor(() => expect(editor().value).toBe("// v1"));
      expect(screen.queryByRole("button", { name: /Reload folder/ })).toBeNull();
    });

    it("keeps the link, replaces files, confirms when dirty, and hides after 'no longer available'", async () => {
      const openLocalProject = vi.fn(async () => ({ manifest, files: { "main.js": "// v1", "lib/a.js": "// a" }, localFolder: folder }));
      const reloadLocalProject = vi.fn(async () => ({ manifest, files: { "main.js": "// v2 from disk", "lib/a.js": "// a2" }, localFolder: folder }));
      const { replace } = setup({ platform: { openLocalProject, reloadLocalProject } });
      replace.mockResolvedValue(game({ version: 5 }));
      await screen.findByRole("button", { name: /⬆ Publish/ });
      await openMenuItem("Local folder…");
      await waitFor(() => expect(editor().value).toBe("// v1"));
      const reloadBtn = screen.getByRole("button", { name: /Reload folder/ });
      expect(reloadBtn.title).toBe("Reload pixel-peaks from disk");

      // Publish an update so the project gets a link (preselected by title, checkbox required).
      const dialog = await openPublish();
      await act(async () => fireEvent.click(within(dialog).getByRole("radio", { name: "Update an existing game" })));
      fireEvent.click(await within(dialog).findByRole("checkbox", { name: /Replace all files/ }));
      await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Publish update/ })));
      await waitFor(() => expect(chip()?.textContent).toMatch(/v5/));

      // Clean → reload without a confirm; the selected file is kept.
      fireEvent.click(screen.getByTitle("lib/a.js"));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: /Reload folder/ })));
      expect(reloadLocalProject).toHaveBeenCalledWith("f1");
      await waitFor(() => expect(editor("Edit lib/a.js").value).toBe("// a2"));
      expect(chip()?.textContent).toMatch(/v5/);
      expect(screen.getByText("Reloaded pixel-peaks from disk.")).toBeTruthy();

      // Dirty → confirm first; the hint about edits not being written back shows.
      fireEvent.change(editor("Edit lib/a.js"), { target: { value: "// edited here" } });
      expect(screen.getByText(/Edits made here aren't saved to pixel-peaks/)).toBeTruthy();
      await act(async () => fireEvent.click(screen.getByRole("button", { name: /Reload folder/ })));
      const confirm = screen.getByRole("dialog", { name: "Discard Studio edits and reload pixel-peaks from disk?" });
      expect(reloadLocalProject).toHaveBeenCalledTimes(1);
      await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Reload" })));
      await waitFor(() => expect(editor("Edit lib/a.js").value).toBe("// a2"));
      expect(reloadLocalProject).toHaveBeenCalledTimes(2);
      expect(chip()?.textContent).toMatch(/v5/);

      // The folder is gone → toast, and the button hides.
      reloadLocalProject.mockRejectedValueOnce(new Error("The folder is no longer available. Open it again."));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: /Reload folder/ })));
      expect(await screen.findByText("Couldn't reload the folder")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Reload folder/ })).toBeNull();
    });
  });
});

// F029 picker (F032 section 0.15). Kept ASCII-only: non-ASCII characters are built with String.fromCodePoint.
import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { GameSummary, Page } from "../api/types";
import { FeaturedGamesDialog } from "../components/FeaturedGamesDialog";
import { game } from "./collectionFixtures";
import { deferred } from "./postReplyFixtures";
import { makeClient, renderWith } from "./postRender";
import { miaUser } from "./postFixtures";

const kai = { id: "u3", username: "kai", displayName: "Kai", avatarUrl: null };
const own = (id: string, title: string, over: Partial<GameSummary> = {}) => game(id, title, { owner: miaUser, ...over });
const fav = (id: string, title: string, over: Partial<GameSummary> = {}) => game(id, title, { owner: kai, ...over });
const pageOf = (items: GameSummary[]): Page<GameSummary> => ({ items, total: items.length, page: 1, perPage: 100 });

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

type Opts = {
  initial?: GameSummary[];
  mine?: GameSummary[] | (() => Promise<Page<GameSummary>>);
  favorites?: GameSummary[];
};

function Harness({ initial, onSaved, onClose }: { initial: GameSummary[]; onSaved: (g: GameSummary[]) => void; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open picker
      </button>
      <FeaturedGamesDialog
        open={open}
        initial={initial}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        onSaved={onSaved}
      />
    </>
  );
}

async function setup(opts: Opts = {}) {
  const client = makeClient(miaUser);
  const listGames = vi
    .spyOn(client, "listGames")
    .mockImplementation(typeof opts.mine === "function" ? opts.mine : async () => pageOf((opts.mine as GameSummary[] | undefined) ?? [own("g1", "Alpha"), own("g2", "Beta"), own("g9", "Draft", { published: false })]));
  vi.mocked(client.listMyFavorites).mockResolvedValue(pageOf(opts.favorites ?? [fav("f1", "Kai Fav"), own("g1", "Alpha"), fav("f2", "Hidden", { published: false })]));
  const save = vi.spyOn(client, "setFeaturedGames");
  const onSaved = vi.fn();
  const onClose = vi.fn();
  await renderWith(client, <Harness initial={opts.initial ?? []} onSaved={onSaved} onClose={onClose} />, "/u/mia", miaUser);
  const opener = screen.getByRole("button", { name: "Open picker" });
  opener.focus();
  await act(async () => fireEvent.click(opener));
  await act(async () => {});
  return { client, listGames, save, onSaved, onClose, opener };
}

const dialog = () => screen.getByRole("dialog", { name: "Featured games" });
const btn = (name: string) => within(dialog()).getByRole("button", { name });
const selectedTitles = () => Array.from(dialog().querySelectorAll(".pf-featured-selected .pf-featured-row__name")).map((e) => e.textContent);

describe("FeaturedGamesDialog: semantics", () => {
  it("modal dialog labelled by its h2, initial focus on the title, the lead text", async () => {
    const { listGames, client } = await setup();
    const d = dialog();
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.getAttribute("aria-labelledby")).toBe("featured-dialog-title");
    const title = document.getElementById("featured-dialog-title")!;
    expect(title.tagName).toBe("H2");
    expect(title.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(title);
    expect(within(d).getByText("Pick up to 4 games. They show first on your profile, in this order.")).toBeTruthy();
    expect(listGames).toHaveBeenCalledWith({ owner: "me", sort: "new", perPage: 100 });
    expect(client.listMyFavorites).toHaveBeenCalledWith({ perPage: 100 });
  });

  it("Escape closes and focus returns to the opener", async () => {
    const { onClose, opener } = await setup();
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("Escape does nothing while saving", async () => {
    const { save, onClose } = await setup({ initial: [own("g1", "Alpha")] });
    const d = deferred<{ featured: GameSummary[] }>();
    save.mockReturnValue(d.promise);
    await act(async () => fireEvent.click(btn("Save")));
    const saveBtn = within(dialog()).getByRole("button", { name: `Saving${String.fromCodePoint(0x2026)}` });
    expect(saveBtn.getAttribute("aria-disabled")).toBe("true");
    expect(saveBtn.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
    await act(async () => d.resolve({ featured: [own("g1", "Alpha")] }));
  });
});

describe("FeaturedGamesDialog: candidates", () => {
  it("own published games only; favorites published, minus own duplicates; owner names on favorites", async () => {
    await setup();
    const d = dialog();
    expect(within(d).getByRole("heading", { level: 3, name: "Your games" })).toBeTruthy();
    expect(within(d).getByRole("heading", { level: 3, name: "Your favorites" })).toBeTruthy();
    expect(within(d).getByRole("button", { name: "Add Alpha" })).toBeTruthy();
    expect(within(d).getByRole("button", { name: "Add Beta" })).toBeTruthy();
    expect(within(d).queryByRole("button", { name: "Add Draft" })).toBeNull();
    expect(within(d).queryByRole("button", { name: "Add Hidden" })).toBeNull();
    expect(within(d).getAllByRole("button", { name: "Add Alpha" })).toHaveLength(1);
    const favRow = within(d).getByRole("button", { name: "Add Kai Fav" }).closest("li")!;
    expect(favRow.textContent).toContain("by Kai");
    const ownRow = within(d).getByRole("button", { name: "Add Alpha" }).closest("li")!;
    expect(ownRow.textContent).not.toContain("by ");
  });

  it("empty texts", async () => {
    await setup({ mine: [], favorites: [] });
    expect(within(dialog()).getByText("You haven't published any games yet.")).toBeTruthy();
    expect(within(dialog()).getByText("Games you favorite show up here.")).toBeTruthy();
    expect(within(dialog()).getByText("No games selected. Your profile won't show a Featured row.")).toBeTruthy();
    expect(within(dialog()).getByRole("heading", { level: 3, name: "Selected (0/4)" })).toBeTruthy();
  });

  it("loading spinner, then LoadError with Retry", async () => {
    const d = deferred<Page<GameSummary>>();
    let calls = 0;
    const { listGames } = await setup({
      mine: () => {
        calls++;
        return calls === 1 ? d.promise : Promise.resolve(pageOf([own("g1", "Alpha")]));
      },
    });
    expect(within(dialog()).getByRole("status", { name: "Loading your games" })).toBeTruthy();
    await act(async () => d.reject(new Error("boom")));
    expect(within(dialog()).getByText("Couldn't load your games.")).toBeTruthy();
    await act(async () => fireEvent.click(btn("Retry")));
    expect(listGames).toHaveBeenCalledTimes(2);
    expect(btn("Add Alpha")).toBeTruthy();
  });
});

describe("FeaturedGamesDialog: add, remove, move", () => {
  it("Add keeps focus, turns into Added (aria-disabled) and pressing it again changes nothing", async () => {
    await setup();
    const add = btn("Add Beta");
    add.focus();
    await act(async () => fireEvent.click(add));
    expect(selectedTitles()).toEqual(["Beta"]);
    expect(document.activeElement).toBe(add);
    expect(add.textContent).toBe("Added");
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.hasAttribute("disabled")).toBe(false);
    await act(async () => fireEvent.click(add));
    expect(selectedTitles()).toEqual(["Beta"]);
    expect(within(dialog()).getByRole("heading", { level: 3, name: "Selected (1/4)" })).toBeTruthy();
  });

  it("at 4 selected every other Add is aria-disabled, with the limit note", async () => {
    await setup({ initial: [fav("f7", "One"), fav("f8", "Two"), fav("f9", "Three")] });
    expect(within(dialog()).queryByText("You can feature up to 4 games. Remove one to add another.")).toBeNull();
    await act(async () => fireEvent.click(btn("Add Alpha")));
    expect(within(dialog()).getByText("You can feature up to 4 games. Remove one to add another.")).toBeTruthy();
    for (const name of ["Add Beta", "Add Kai Fav"]) expect(btn(name).getAttribute("aria-disabled")).toBe("true");
    await act(async () => fireEvent.click(btn("Add Beta")));
    expect(selectedTitles()).toEqual(["One", "Two", "Three", "Alpha"]);
    expect(within(dialog()).getByRole("heading", { level: 3, name: "Selected (4/4)" })).toBeTruthy();
  });

  it("Move up / down with exact labels, boundaries aria-disabled, focus stays on the same button of the moved row", async () => {
    await setup({ initial: [own("g1", "Alpha"), own("g2", "Beta"), fav("f1", "Kai Fav")] });
    expect(btn("Move Alpha up").getAttribute("aria-disabled")).toBe("true");
    expect(btn("Move Kai Fav down").getAttribute("aria-disabled")).toBe("true");
    expect(btn("Move Beta up").getAttribute("aria-disabled")).toBeNull();
    // A boundary press changes nothing.
    await act(async () => fireEvent.click(btn("Move Alpha up")));
    expect(selectedTitles()).toEqual(["Alpha", "Beta", "Kai Fav"]);
    const down = btn("Move Alpha down");
    down.focus();
    await act(async () => fireEvent.click(down));
    expect(selectedTitles()).toEqual(["Beta", "Alpha", "Kai Fav"]);
    expect(document.activeElement).toBe(btn("Move Alpha down"));
    await act(async () => fireEvent.click(btn("Move Kai Fav up")));
    expect(selectedTitles()).toEqual(["Beta", "Kai Fav", "Alpha"]);
    expect(document.activeElement).toBe(btn("Move Kai Fav up"));
    expect(btn("Move Alpha down").getAttribute("aria-disabled")).toBe("true");
  });

  it("Remove focuses the Selected heading", async () => {
    await setup({ initial: [own("g1", "Alpha"), own("g2", "Beta")] });
    await act(async () => fireEvent.click(btn("Remove Alpha")));
    expect(selectedTitles()).toEqual(["Beta"]);
    const h = document.getElementById("featured-selected-title")!;
    expect(h.getAttribute("tabindex")).toBe("-1");
    expect(h.textContent).toBe("Selected (1/4)");
    expect(document.activeElement).toBe(h);
    expect(btn("Add Alpha").textContent).toBe("Add");
  });
});

describe("FeaturedGamesDialog: save", () => {
  it("sends the shown order, toasts, closes and calls onSaved", async () => {
    const { save, onSaved, onClose } = await setup({ initial: [own("g1", "Alpha"), own("g2", "Beta")] });
    const saved = [own("g2", "Beta"), own("g1", "Alpha")];
    save.mockResolvedValue({ featured: saved });
    await act(async () => fireEvent.click(btn("Move Beta up")));
    await act(async () => fireEvent.click(btn("Save")));
    expect(save).toHaveBeenCalledWith(["g2", "g1"]);
    expect(await screen.findByText("Featured games saved.")).toBeTruthy();
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Save always sends the list, even unchanged (and [] when empty)", async () => {
    const { save } = await setup();
    save.mockResolvedValue({ featured: [] });
    await act(async () => fireEvent.click(btn("Save")));
    expect(save).toHaveBeenCalledWith([]);
  });

  it("an error shows the server message and keeps the selection", async () => {
    const { save, onSaved } = await setup({ initial: [own("g1", "Alpha")] });
    save.mockRejectedValue(new ApiError("validation", "gameIds[0] is not a published game", 422));
    await act(async () => fireEvent.click(btn("Save")));
    expect(within(dialog()).getByRole("alert").textContent).toBe("gameIds[0] is not a published game");
    expect(selectedTitles()).toEqual(["Alpha"]);
    expect(onSaved).not.toHaveBeenCalled();
    expect(btn("Save").getAttribute("aria-disabled")).toBeNull();
  });

  it("Cancel discards and closes", async () => {
    const { save, onClose } = await setup({ initial: [own("g1", "Alpha")] });
    await act(async () => fireEvent.click(btn("Remove Alpha")));
    await act(async () => fireEvent.click(btn("Cancel")));
    expect(onClose).toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open picker" })));
    expect(selectedTitles()).toEqual(["Alpha"]);
  });
});

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Collection, CollectionItemResponse, CollectionRemoveResponse, User } from "../api/types";
import { COLLECTION_CONFLICT_MESSAGE, CollectionPage } from "../pages/CollectionPage";
import { WebGameProviders } from "../WebGameApp";
import { adminUser, anaUser, collection, deferred, item, samUser } from "./collectionFixtures";

function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="location">{loc.pathname + loc.search}</p>;
}

async function setup(coll: Collection | Error, { user = null, path = "/c/c1" }: { user?: User | null; path?: string } = {}) {
  if (user) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockImplementation(async () => {
    if (!user) throw new ApiError("unauthorized", "no", 401);
    return user;
  });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  const get = vi.spyOn(client, "getCollection");
  if (coll instanceof Error) get.mockRejectedValue(coll);
  else get.mockImplementation(async () => structuredClone(coll));
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/c/:id" element={<CollectionPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (user) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
  return { ...utils, client, get };
}

const owned = (over: Partial<Collection> = {}) =>
  collection({
    isOwner: true,
    canDelete: true,
    items: [item("g1", "Space Dodge", "Best soundtrack"), item("g2", "Brick Breaker"), item("g3", "Pixel Peaks", "Hard!"), item("g4", null, "gone")],
    ...over,
  });

function reordered(c: Collection, ids: string[]): Collection {
  return { ...c, items: ids.map((id) => c.items.find((i) => i.gameId === id)!) };
}

const btn = (name: string) => screen.getByRole("button", { name });
const queryBtn = (name: string) => screen.queryByRole("button", { name });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CollectionPage: visitor", () => {
  it("renders the header, the ordered list with notes, and Copy link only", async () => {
    const { container } = await setup(collection());
    expect(screen.getByRole("heading", { level: 1, name: "Cozy games" })).toBeTruthy();
    expect(screen.getByText(/A collection by/).textContent).toContain("Ana");
    expect(screen.getByRole("link", { name: "Ana" }).getAttribute("href")).toBe("/u/ana");
    expect(screen.getByText(/3 games · Updated/)).toBeTruthy();
    const desc = container.querySelector(".pf-collection-head__desc")!;
    expect(desc.textContent).toBe("Short and sweet.\nPlay these first.");
    expect(document.title).toContain("Cozy games");

    const list = screen.getByRole("list", { name: "Games in this collection" });
    expect(list.tagName).toBe("OL");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("heading").textContent)).toEqual(["Space Dodge", "Brick Breaker", "Pixel Peaks"]);
    expect(rows[0].querySelector(".pf-collection-item__pos")!.getAttribute("aria-hidden")).toBe("true");
    expect(rows[0].querySelector(".pf-collection-note")!.textContent).toBe("Best soundtrack");
    expect(rows[1].querySelector(".pf-collection-note")).toBeNull();
    expect(within(rows[0]).getByRole("link", { name: "Play Space Dodge" }).getAttribute("href")).toBe("/games/g1");

    expect(btn("Copy link")).toBeTruthy();
    expect(queryBtn("✎ Edit")).toBeNull();
    expect(queryBtn("Delete")).toBeNull();
    expect(queryBtn("⚑ Report")).toBeNull(); // anonymous
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("Copy link: copies the absolute /c/{id} URL and shows 'Link copied' for 2 s", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await setup(collection());
    await act(async () => fireEvent.click(btn("Copy link")));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/c/c1`);
    expect(btn("Link copied")).toBeTruthy();
    expect(document.querySelector(".pf-collection-page > p[role=status]")!.textContent).toBe("Link copied");
    expect(screen.queryByRole("textbox", { name: "Copy this link" })).toBeNull();
    await waitFor(() => expect(btn("Copy link")).toBeTruthy(), { timeout: 3000 });
  });

  it("Copy link: falls back to a focused, selected read-only input when the Clipboard API is missing or rejects", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    await setup(collection());
    await act(async () => fireEvent.click(btn("Copy link")));
    const input = screen.getByRole("textbox", { name: "Copy this link" }) as HTMLInputElement;
    expect(input.value).toBe(`${window.location.origin}/c/c1`);
    expect(input.readOnly).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("Copy link: a rejected writeText also shows the fallback", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) } });
    await setup(collection());
    await act(async () => fireEvent.click(btn("Copy link")));
    expect(screen.getByRole("textbox", { name: "Copy this link" })).toBeTruthy();
  });

  it("signed-in non-owners get Report; admins who aren't the owner get Delete only", async () => {
    const a = await setup(collection(), { user: samUser });
    expect(btn("⚑ Report")).toBeTruthy();
    expect(queryBtn("Delete")).toBeNull();
    expect(queryBtn("✎ Edit")).toBeNull();
    a.unmount();
    localStorage.clear();

    await setup(collection({ canDelete: true }), { user: adminUser });
    expect(btn("Delete")).toBeTruthy();
    expect(queryBtn("✎ Edit")).toBeNull();
    expect(queryBtn("⚑ Report")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
  });

  it("empty collection: visitor text", async () => {
    await setup(collection({ items: [], gameCount: 0 }));
    expect(screen.getByText("This collection is empty.")).toBeTruthy();
    expect(screen.getByText("0 games · Updated", { exact: false })).toBeTruthy();
  });

  it("404 shows the not-found page; other errors show a retry", async () => {
    const a = await setup(new ApiError("not_found", "Collection not found", 404));
    expect(screen.getByRole("heading", { name: /collection not found/ })).toBeTruthy();
    a.unmount();
    const b = await setup(new ApiError("internal", "boom", 500));
    expect(screen.getByText("boom")).toBeTruthy();
    b.get.mockResolvedValue(collection());
    await act(async () => fireEvent.click(btn("Try again")));
    expect(screen.getByRole("heading", { level: 1, name: "Cozy games" })).toBeTruthy();
  });
});

describe("CollectionPage: owner", () => {
  it("private: shows the private note instead of Copy link, plus Edit and Delete", async () => {
    await setup(owned({ visibility: "private" }), { user: anaUser });
    expect(screen.getByText("Private: only you can see this collection.")).toBeTruthy();
    expect(queryBtn("Copy link")).toBeNull();
    expect(screen.getAllByText("Private", { exact: false }).some((el) => el.classList.contains("pf-badge--private"))).toBe(true);
    expect(btn("✎ Edit")).toBeTruthy();
    expect(btn("Delete")).toBeTruthy();
  });

  it("boundary move buttons are hidden; the unavailable row only has Remove", async () => {
    await setup(owned(), { user: anaUser });
    expect(queryBtn("Move up: Space Dodge")).toBeNull();
    expect(btn("Move down: Space Dodge")).toBeTruthy();
    expect(btn("Move up: Pixel Peaks")).toBeTruthy();
    expect(btn("Move down: Pixel Peaks")).toBeTruthy();
    const rows = within(screen.getByRole("list", { name: "Games in this collection" })).getAllByRole("listitem");
    const gone = rows[3];
    expect(within(gone).getByRole("heading").textContent).toBe("Unavailable game");
    expect(within(gone).getByText("This game was unpublished or removed by its creator.")).toBeTruthy();
    expect(within(gone).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Remove Unavailable game from collection"]);
    expect(within(gone).queryByRole("link")).toBeNull();
  });

  it("Move up sends the full order (unavailable ids included), keeps focus and announces the position", async () => {
    const { client } = await setup(owned(), { user: anaUser });
    const d = deferred<Collection>();
    const spy = vi.spyOn(client, "reorderCollection").mockReturnValue(d.promise);
    const up = btn("Move up: Brick Breaker");
    up.focus();
    await act(async () => fireEvent.click(up));
    expect(spy).toHaveBeenCalledWith("c1", ["g2", "g1", "g3", "g4"]);
    // Another move while one is in flight is ignored.
    await act(async () => fireEvent.click(btn("Move up: Pixel Peaks")));
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve(reordered(owned(), ["g2", "g1", "g3", "g4"])));
    const titles = within(screen.getByRole("list", { name: "Games in this collection" }))
      .getAllByRole("heading")
      .map((h) => h.textContent);
    expect(titles).toEqual(["Brick Breaker", "Space Dodge", "Pixel Peaks", "Unavailable game"]);
    // "Move up" vanished at the top boundary: focus goes to the row's other move button.
    expect(queryBtn("Move up: Brick Breaker")).toBeNull();
    expect(document.activeElement).toBe(btn("Move down: Brick Breaker"));
    expect(screen.getByText("Moved Brick Breaker to position 1 of 4")).toBeTruthy();
  });

  it("Move down keeps focus on the same button of the moved row", async () => {
    const { client } = await setup(owned(), { user: anaUser });
    const spy = vi.spyOn(client, "reorderCollection").mockResolvedValue(reordered(owned(), ["g2", "g1", "g3", "g4"]));
    await act(async () => fireEvent.click(btn("Move down: Space Dodge")));
    expect(spy).toHaveBeenCalledWith("c1", ["g2", "g1", "g3", "g4"]);
    expect(document.activeElement).toBe(btn("Move down: Space Dodge"));
    expect(screen.getByText("Moved Space Dodge to position 2 of 4")).toBeTruthy();
  });

  it("409 on reorder reloads the collection, toasts and focuses the list heading", async () => {
    const { client, get } = await setup(owned(), { user: anaUser });
    vi.spyOn(client, "reorderCollection").mockRejectedValue(new ApiError("conflict", "The collection has changed; reload and try again", 409));
    const calls = get.mock.calls.length;
    get.mockResolvedValue(owned({ items: [item("g3", "Pixel Peaks"), item("g1", "Space Dodge")] }));
    await act(async () => fireEvent.click(btn("Move down: Space Dodge")));
    await act(async () => {});
    expect(get.mock.calls.length).toBe(calls + 1);
    expect(screen.getByText(COLLECTION_CONFLICT_MESSAGE)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Games" }));
    const titles = within(screen.getByRole("list", { name: "Games in this collection" }))
      .getAllByRole("heading")
      .map((h) => h.textContent);
    expect(titles).toEqual(["Pixel Peaks", "Space Dodge"]);
  });

  it("Edit note: Enter (submit) saves via PUT with the note and returns focus to Edit note", async () => {
    const { client } = await setup(owned(), { user: anaUser });
    const res: CollectionItemResponse = { added: false, item: item("g1", "Space Dodge", "Loved it"), gameCount: 3, updatedAt: "2026-11-16T00:00:00Z" };
    const spy = vi.spyOn(client, "putCollectionGame").mockResolvedValue(res);
    await act(async () => fireEvent.click(btn("Edit note for Space Dodge")));
    const input = screen.getByRole("textbox", { name: "Note for Space Dodge" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Best soundtrack");
    expect(input.maxLength).toBe(140);
    fireEvent.change(input, { target: { value: "  Loved it " } });
    expect(screen.getByText("8/140")).toBeTruthy();
    await act(async () => fireEvent.submit(input.form!));
    expect(spy).toHaveBeenCalledWith("c1", "g1", { note: "Loved it" });
    expect(screen.queryByRole("textbox", { name: "Note for Space Dodge" })).toBeNull();
    expect(screen.getByText("Loved it")).toBeTruthy();
    expect(document.activeElement).toBe(btn("Edit note for Space Dodge"));
  });

  it("Edit note: Escape cancels without saving and returns focus", async () => {
    const { client } = await setup(owned(), { user: anaUser });
    const spy = vi.spyOn(client, "putCollectionGame");
    await act(async () => fireEvent.click(btn("Edit note for Pixel Peaks")));
    const input = screen.getByRole("textbox", { name: "Note for Pixel Peaks" });
    fireEvent.change(input, { target: { value: "changed" } });
    await act(async () => fireEvent.keyDown(input, { key: "Escape" }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText("Hard!")).toBeTruthy();
    expect(document.activeElement).toBe(btn("Edit note for Pixel Peaks"));
  });

  it("Edit note: a server error stays inline", async () => {
    const { client } = await setup(owned(), { user: anaUser });
    vi.spyOn(client, "putCollectionGame").mockRejectedValue(new ApiError("validation", "note must be a single line of plain text", 422));
    await act(async () => fireEvent.click(btn("Edit note for Space Dodge")));
    await act(async () => fireEvent.submit(screen.getByRole("textbox", { name: "Note for Space Dodge" }).closest("form")!));
    expect(screen.getByRole("alert").textContent).toBe("Note must be a single line of plain text.");
    expect(screen.getByRole("textbox", { name: "Note for Space Dodge" })).toBeTruthy();
  });

  it("Remove: an inline Undo row replaces the item and gets focus; Undo restores the order", async () => {
    const { client } = await setup(owned(), { user: anaUser });
    const rm: CollectionRemoveResponse = { removed: true, gameCount: 2, updatedAt: "2026-11-16T00:00:00Z" };
    const del = vi.spyOn(client, "deleteCollectionGame").mockResolvedValue(rm);
    await act(async () => fireEvent.click(btn("Remove Brick Breaker from collection")));
    expect(del).toHaveBeenCalledWith("c1", "g2");
    expect(queryBtn("Remove Brick Breaker from collection")).toBeNull();
    // The removed row stays in place as "Removed … Undo", and focus is on its Undo button.
    const list = screen.getByRole("list", { name: "Games in this collection" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[1].textContent).toContain("Removed Brick Breaker from the collection.");
    expect(document.activeElement).toBe(btn("Undo remove: Brick Breaker"));
    expect(screen.getByText("Removed Brick Breaker")).toBeTruthy();
    expect(screen.getByText("2 games · Updated", { exact: false })).toBeTruthy();

    const put = vi.spyOn(client, "putCollectionGame").mockResolvedValue({
      added: true,
      item: item("g2", "Brick Breaker"),
      gameCount: 3,
      updatedAt: "2026-11-16T00:00:01Z",
    });
    const order = vi.spyOn(client, "reorderCollection").mockResolvedValue(owned());
    await act(async () => fireEvent.click(btn("Undo remove: Brick Breaker")));
    await act(async () => {});
    expect(put).toHaveBeenCalledWith("c1", "g2", { note: "" });
    expect(order).toHaveBeenCalledWith("c1", ["g1", "g2", "g3", "g4"]);
    const titles = within(screen.getByRole("list", { name: "Games in this collection" }))
      .getAllByRole("heading")
      .map((h) => h.textContent);
    expect(titles).toEqual(["Space Dodge", "Brick Breaker", "Pixel Peaks", "Unavailable game"]);
    expect(queryBtn("Undo remove: Brick Breaker")).toBeNull();
    expect(document.activeElement).toBe(btn("Remove Brick Breaker from collection"));
  });

  it("Remove: Dismiss drops the Undo row and moves focus on; the last one to the list heading", async () => {
    const { client } = await setup(owned({ items: [item("g1", "Space Dodge"), item("g2", "Brick Breaker")] }), { user: anaUser });
    vi.spyOn(client, "deleteCollectionGame").mockResolvedValue({ removed: true, gameCount: 1, updatedAt: "x" });
    await act(async () => fireEvent.click(btn("Remove Brick Breaker from collection")));
    expect(document.activeElement).toBe(btn("Undo remove: Brick Breaker"));
    await act(async () => fireEvent.click(btn("Dismiss: removed Brick Breaker")));
    expect(queryBtn("Undo remove: Brick Breaker")).toBeNull();
    expect(document.activeElement).toBe(btn("Remove Space Dodge from collection"));
    await act(async () => fireEvent.click(btn("Remove Space Dodge from collection")));
    expect(document.activeElement).toBe(btn("Undo remove: Space Dodge"));
    await act(async () => fireEvent.click(btn("Dismiss: removed Space Dodge")));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Games" }));
    expect(screen.getByText(/Use/).textContent).toContain("+ Collection");
    expect(screen.getByRole("link", { name: "Browse games" })).toBeTruthy();
  });

  it("Delete: confirm dialog, DELETE, toast and navigation to my collections", async () => {
    const { client } = await setup(owned(), { user: anaUser });
    const spy = vi.spyOn(client, "deleteCollection").mockResolvedValue(undefined);
    await act(async () => fireEvent.click(btn("Delete")));
    const dialog = screen.getByRole("dialog", { name: "Delete this collection?" });
    expect(within(dialog).getByText("The games stay on the site; only this list is removed.")).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Delete collection" })));
    expect(spy).toHaveBeenCalledWith("c1");
    expect(screen.getByTestId("location").textContent).toBe("/u/ana/collections");
    expect(screen.getByText("Collection deleted")).toBeTruthy();
  });

  it("Edit: the form dialog saves only changed fields and updates the header in place", async () => {
    const { client } = await setup(owned(), { user: anaUser });
    const spy = vi.spyOn(client, "updateCollection").mockResolvedValue(owned({ title: "Cozier games", visibility: "private" }));
    const edit = btn("✎ Edit");
    edit.focus();
    await act(async () => fireEvent.click(edit));
    const dialog = screen.getByRole("dialog", { name: "Edit collection" });
    const title = within(dialog).getByRole("textbox", { name: /Title/ }) as HTMLInputElement;
    expect(document.activeElement).toBe(title);
    expect(title.value).toBe("Cozy games");
    fireEvent.change(title, { target: { value: "Cozier games" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Private/ }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" })));
    expect(spy).toHaveBeenCalledWith("c1", { title: "Cozier games", visibility: "private" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Cozier games" })).toBeTruthy();
    expect(screen.getByText("Private: only you can see this collection.")).toBeTruthy();
    expect(document.activeElement).toBe(btn("✎ Edit"));
  });
});

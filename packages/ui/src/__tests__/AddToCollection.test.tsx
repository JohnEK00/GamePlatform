import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { CollectionItemResponse, MyCollection, User } from "../api/types";
import { AddToCollectionButton } from "../components/AddToCollectionDialog";
import { WebGameProviders } from "../WebGameApp";
import { anaUser, collection, deferred, item, mine } from "./collectionFixtures";

async function setup(list: MyCollection[] | Error, { user = anaUser as User | null } = {}) {
  if (user) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockImplementation(async () => {
    if (!user) throw new ApiError("unauthorized", "no", 401);
    return user;
  });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  const listSpy = vi.spyOn(client, "listMyCollections");
  if (list instanceof Error) listSpy.mockRejectedValue(list);
  else listSpy.mockImplementation(async () => structuredClone(list));
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/games/g1"]}>
        <AddToCollectionButton gameId="g1" gameTitle="Space Dodge" />
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (user) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  return { ...utils, client, listSpy };
}

async function open() {
  const opener = screen.getByRole("button", { name: "+ Collection" });
  opener.focus();
  await act(async () => fireEvent.click(opener));
  await act(async () => {});
  return { opener, dialog: screen.getByRole("dialog", { name: "Add to collection" }) };
}

const three = () => [
  mine("c1", "Cozy games", { containsGame: true, itemCount: 3 }),
  mine("c2", "Play later", { visibility: "private", itemCount: 2 }),
  mine("c3", "Everything", { itemCount: 100 }),
];

const live = (dialog: HTMLElement) => dialog.querySelector("p[role=status]")!.textContent;

afterEach(() => vi.restoreAllMocks());

describe("AddToCollectionButton", () => {
  it("anonymous: a log-in link back to the game", async () => {
    await setup([], { user: null });
    const link = screen.getByRole("link", { name: "+ Collection" });
    expect(link.getAttribute("href")).toBe("/login?next=%2Fgames%2Fg1");
  });

  it("checkboxes reflect containsGame; private and count in muted text; full collections are disabled with a hint", async () => {
    const { listSpy } = await setup(three());
    const { dialog } = await open();
    expect(listSpy).toHaveBeenCalledWith("g1");
    const cozy = within(dialog).getByRole("checkbox", { name: /Cozy games/ }) as HTMLInputElement;
    const later = within(dialog).getByRole("checkbox", { name: /Play later/ }) as HTMLInputElement;
    const full = within(dialog).getByRole("checkbox", { name: /Everything/ }) as HTMLInputElement;
    expect(cozy.checked).toBe(true);
    expect(later.checked).toBe(false);
    expect(later.labels![0].textContent).toContain("(private)");
    expect(later.labels![0].textContent).toContain("2/100");
    expect(full.disabled).toBe(true);
    const hint = document.getElementById(full.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe("Full (100 games)");
    expect(cozy.hasAttribute("aria-describedby")).toBe(false);
  });

  it("toggling adds with PUT and removes with DELETE, busy while in flight, announced", async () => {
    const { client } = await setup(three());
    const { dialog } = await open();
    const d = deferred<CollectionItemResponse>();
    const put = vi.spyOn(client, "putCollectionGame").mockReturnValue(d.promise);
    const later = within(dialog).getByRole("checkbox", { name: /Play later/ }) as HTMLInputElement;
    await act(async () => fireEvent.click(later));
    expect(put).toHaveBeenCalledWith("c2", "g1");
    expect(later.getAttribute("aria-busy")).toBe("true");
    expect(later.checked).toBe(true);
    // Ignored while in flight.
    await act(async () => fireEvent.click(later));
    expect(put).toHaveBeenCalledTimes(1);
    expect(later.checked).toBe(true);
    await act(async () => d.resolve({ added: true, item: item("g1", "Space Dodge"), gameCount: 3, updatedAt: "x" }));
    expect(later.hasAttribute("aria-busy")).toBe(false);
    expect(later.labels![0].textContent).toContain("3/100");
    expect(live(dialog)).toBe("Added to Play later");

    const del = vi.spyOn(client, "deleteCollectionGame").mockResolvedValue({ removed: true, gameCount: 2, updatedAt: "y" });
    const cozy = within(dialog).getByRole("checkbox", { name: /Cozy games/ }) as HTMLInputElement;
    await act(async () => fireEvent.click(cozy));
    expect(del).toHaveBeenCalledWith("c1", "g1");
    expect(cozy.checked).toBe(false);
    expect(live(dialog)).toBe("Removed from Cozy games");
  });

  it("reverts on error and shows it inline; 429 shows the Retry-After text", async () => {
    const { client } = await setup(three());
    const { dialog } = await open();
    vi.spyOn(client, "putCollectionGame").mockRejectedValueOnce(new ApiError("internal", "Server exploded", 500));
    const later = within(dialog).getByRole("checkbox", { name: /Play later/ }) as HTMLInputElement;
    await act(async () => fireEvent.click(later));
    expect(later.checked).toBe(false);
    expect(within(dialog).getByRole("alert").textContent).toBe("Server exploded.");

    vi.spyOn(client, "deleteCollectionGame").mockRejectedValueOnce(ApiError.fromResponse(429, null, "", "12"));
    const cozy = within(dialog).getByRole("checkbox", { name: /Cozy games/ }) as HTMLInputElement;
    await act(async () => fireEvent.click(cozy));
    expect(cozy.checked).toBe(true);
    expect(within(dialog).getByRole("alert").textContent).toBe("Slow down, try again in 12s.");
  });

  it("New collection…: creates with the game, shows it checked at the top and focuses its checkbox", async () => {
    const { client } = await setup(three());
    const { dialog } = await open();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "New collection…" })));
    const title = within(dialog).getByRole("textbox", { name: "New collection title" });
    expect(document.activeElement).toBe(title);
    expect((within(dialog).getByRole("radio", { name: "Public" }) as HTMLInputElement).checked).toBe(true);
    const create = vi.spyOn(client, "createCollection").mockResolvedValue(
      collection({ id: "c9", title: "Arcade", path: "/c/c9", visibility: "private", items: [item("g1", "Space Dodge")], isOwner: true, canDelete: true }),
    );
    fireEvent.change(title, { target: { value: " Arcade " } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Private" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Create and add" })));
    expect(create).toHaveBeenCalledWith({ title: "Arcade", visibility: "private", gameId: "g1" });
    const boxes = within(dialog).getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes[0].labels![0].textContent).toContain("Arcade");
    expect(boxes[0].checked).toBe(true);
    expect(document.activeElement).toBe(boxes[0]);
    expect(within(dialog).queryByRole("textbox", { name: "New collection title" })).toBeNull();
    expect(live(dialog)).toBe("Added to Arcade");
  });

  it("an empty title is rejected client-side", async () => {
    const { client } = await setup([]);
    const { dialog } = await open();
    const create = vi.spyOn(client, "createCollection");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Create and add" })));
    expect(create).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert").textContent).toBe("Title must be 1–60 characters.");
  });

  it("no collections: the inline form is expanded and focused", async () => {
    await setup([]);
    const { dialog } = await open();
    const title = within(dialog).getByRole("textbox", { name: "New collection title" });
    expect(document.activeElement).toBe(title);
    expect(within(dialog).queryByRole("button", { name: "New collection…" })).toBeNull();
  });

  it("at 50 collections the form is replaced by the cap note", async () => {
    await setup(Array.from({ length: 50 }, (_, i) => mine(`c${i}`, `List ${i}`)));
    const { dialog } = await open();
    expect(within(dialog).getByText("You have 50 collections, the maximum.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "New collection…" })).toBeNull();
  });

  it("Done closes and returns focus to + Collection; Escape too", async () => {
    await setup(three());
    let { opener, dialog } = await open();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Done" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    ({ opener, dialog } = await open());
    await act(async () => fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("load errors show a retry; a server without collections says so", async () => {
    const { listSpy, unmount } = await setup(new ApiError("internal", "boom", 500));
    const { dialog } = await open();
    expect(within(dialog).getByText("boom")).toBeTruthy();
    listSpy.mockResolvedValue(three());
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Try again" })));
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(3);
    unmount();
    localStorage.clear();
    await setup(new ApiError("not_found", "No such API endpoint", 404));
    const second = await open();
    expect(within(second.dialog).getByText("Collections aren't available on this server yet.")).toBeTruthy();
  });
});

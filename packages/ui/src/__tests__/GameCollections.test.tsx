import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { GameCollectionsPage } from "../api/types";
import { AddToCollectionButton } from "../components/AddToCollectionDialog";
import { GameCollections } from "../components/GameCollections";
import { WebGameProviders } from "../WebGameApp";
import { anaUser, summary } from "./collectionFixtures";

async function setup(result: GameCollectionsPage | Error, { withButton = false } = {}) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(anaUser);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  const spy = vi.spyOn(client, "listGameCollections");
  if (result instanceof Error) spy.mockRejectedValue(result);
  else spy.mockResolvedValue(result);
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        {withButton && <AddToCollectionButton gameId="g1" gameTitle="Space Dodge" />}
        <GameCollections gameId="g1" />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  return { ...utils, client, spy };
}

afterEach(() => vi.restoreAllMocks());

describe("GameCollections shelf", () => {
  it("'Featured in 1 collection' with a card by its curator", async () => {
    const { spy } = await setup({ items: [summary("c1", "Cozy games")], total: 1 });
    expect(spy).toHaveBeenCalledWith("g1", 6);
    const region = screen.getByRole("region", { name: "Featured in 1 collection" });
    const cards = region.querySelectorAll("article");
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("by Ana");
    expect(within(region).getByRole("link", { name: "Cozy games" }).getAttribute("href")).toBe("/c/c1");
  });

  it("uses the total for the heading, not the page size", async () => {
    const items = Array.from({ length: 6 }, (_, i) => summary(`c${i}`, `List ${i}`));
    await setup({ items, total: 11 });
    expect(screen.getByRole("heading", { name: "Featured in 11 collections" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Featured in 11 collections" }).querySelectorAll("article")).toHaveLength(6);
  });

  it("is hidden when no public collection features the game", async () => {
    const { container } = await setup({ items: [], total: 0 });
    expect(container.querySelector(".pf-gamecollections")).toBeNull();
  });

  it("is hidden (and logs) when the request fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = await setup(new ApiError("internal", "boom", 500), { withButton: true });
    expect(container.querySelector(".pf-gamecollections")).toBeNull();
    expect(warn).toHaveBeenCalled();
    // A plain failure does not hide the rest of the collection UI.
    expect(screen.getByRole("button", { name: "+ Collection" })).toBeTruthy();
  });

  it("a server without the endpoints hides the shelf and the + Collection button", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = await setup(new ApiError("not_found", "No such API endpoint", 404), { withButton: true });
    expect(container.querySelector(".pf-gamecollections")).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Collection" })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

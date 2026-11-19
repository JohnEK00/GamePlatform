import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedPage } from "../pages/FeedPage";
import { viewer } from "./creatorFixtures";
import { makeClient, renderWith } from "./postRender";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

async function setup(suggestions: Awaited<ReturnType<ReturnType<typeof makeClient>["getFeedSuggestions"]>>) {
  const client = makeClient(viewer);
  vi.spyOn(client, "getFeed").mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(client, "getFeedSuggestions").mockResolvedValue(suggestions);
  return renderWith(client, <FeedPage />, "/feed", viewer);
}

describe("FeedPage: Explore all creators (F035)", () => {
  it("links to /creators under the suggestions list", async () => {
    await setup([{ user: { id: "u3", username: "kim", displayName: "Kim", avatarUrl: null }, reason: "popular", games: 2 }]);
    const panel = screen.getByRole("region", { name: "Suggested creators" });
    const link = within(panel).getByRole("link", { name: "Explore all creators →" });
    expect(link.getAttribute("href")).toBe("/creators");
    expect(link.parentElement!.className).toBe("pf-suggest__more pf-small");
    // After the list.
    expect(panel.querySelector(".pf-suggest__list")!.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still links to /creators when there are no suggestions", async () => {
    await setup([]);
    expect(screen.queryByRole("region", { name: "Suggested creators" })).toBeNull();
    expect(screen.getByRole("link", { name: "Explore all creators →" }).getAttribute("href")).toBe("/creators");
  });
});

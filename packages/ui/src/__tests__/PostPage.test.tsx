import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useNavigationType } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Post, User } from "../api/types";
import { WebGameProviders, WebGameRoutes } from "../WebGameApp";
import { game } from "./collectionFixtures";
import { gameAttachment, leoUser, miaUser, page, post } from "./postFixtures";
import { currentLocation, currentState, LocationProbe, makeClient } from "./postRender";

function NavTypeProbe() {
  return <p data-testid="navtype">{useNavigationType()}</p>;
}

const clipboardDesc = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (clipboardDesc) Object.defineProperty(navigator, "clipboard", clipboardDesc);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

async function setup(getPost: (id: string) => Promise<Post>, me: User | null = null) {
  const client = makeClient(me);
  const get = vi.spyOn(client, "getPost").mockImplementation(async (id) => getPost(id));
  const del = vi.spyOn(client, "deletePost").mockResolvedValue(undefined);
  vi.spyOn(client, "getUser").mockResolvedValue({
    user: miaUser,
    games: [],
    gamesTotal: 0,
    followers: 0,
    following: 0,
    isFollowing: false,
    stats: { plays: 0, achievements: 0, screenshots: 0, collections: 0, posts: 0 },
  });
  vi.spyOn(client, "listUserPosts").mockResolvedValue(page([], 0));
  vi.spyOn(client, "listUserAchievements").mockResolvedValue([]);
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/feed", "/p/p1"]} initialIndex={1}>
        <WebGameRoutes />
        <LocationProbe />
        <NavTypeProbe />
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (me) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
  return { client, get, del };
}

describe("PostPage /p/:id (F030 section 0.15)", () => {
  it("shows the post with the title, the sr-only h1, Copy link and More posts", async () => {
    const { get } = await setup(async () => post("p1", { body: "New level! https://example.com/devlog.", attachment: gameAttachment() }));
    expect(get).toHaveBeenCalledWith("p1");
    expect(document.title).toBe("Post by Mia · Pixelforge Arcade");
    const h1 = screen.getByRole("heading", { level: 1, name: "Post by Mia" });
    expect(h1.className).toBe("pf-sr-only");
    const pageEl = document.querySelector(".pf-container.pf-page.pf-post-page")!;
    expect(pageEl.querySelector("article.pf-post")).not.toBeNull();
    const more = within(pageEl as HTMLElement).getByRole("link", { name: "More posts by Mia →" });
    expect(more.getAttribute("href")).toBe("/u/mia/posts");
    expect(more.className).toBe("pf-small");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/p/p1`);
  });

  it("shows a skeleton while loading", async () => {
    await setup(() => new Promise<Post>(() => {}));
    const pageEl = document.querySelector(".pf-post-page")!;
    expect(pageEl.getAttribute("aria-busy")).toBe("true");
    expect(pageEl.querySelector(".pf-post--skeleton")).not.toBeNull();
  });

  it("a 404 shows the post not-found page", async () => {
    await setup(async () => {
      throw new ApiError("not_found", "Post not found", 404);
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Game over — post not found");
    expect(screen.getByText("The post you're looking for doesn't exist or was deleted.")).toBeTruthy();
  });

  it("other errors show a retryable error", async () => {
    let fail = true;
    await setup(async () => {
      if (fail) throw new Error("offline");
      return post("p1");
    });
    expect(screen.getByText("offline")).toBeTruthy();
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Post by Mia" })).toBeTruthy();
  });

  it("deleting navigates to the author's Posts section with replace and focuses its heading", async () => {
    const { del } = await setup(async () => post("p1", { canDelete: true }), miaUser);
    fireEvent.click(screen.getByRole("button", { name: /^Delete post by / }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog", { name: "Delete this post?" })).getByRole("button", { name: "Delete" }));
    });
    await act(async () => {});
    expect(del).toHaveBeenCalledWith("p1");
    expect(currentLocation()).toBe("/u/mia/posts");
    expect(currentState()).toEqual({ focusPostsHeading: true });
    expect(screen.getByTestId("navtype").textContent).toBe("REPLACE");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Posts" })));
    expect(await screen.findByText("Post deleted")).toBeTruthy();
  });

  it("another viewer sees Report, not Delete", async () => {
    await setup(async () => post("p1", { attachment: { type: "game", game: game("g1", "Space Dodge"), collection: null } }), leoUser);
    expect(screen.queryByRole("button", { name: /^Delete post by / })).toBeNull();
    expect(screen.getByRole("button", { name: /^Report post by / })).toBeTruthy();
  });
});

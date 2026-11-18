import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Game, Page, Post, ProfileStats, User, UserProfileResponse } from "../api/types";
import { WebGameProviders, WebGameRoutes } from "../WebGameApp";
import { game } from "./collectionFixtures";
import { leoUser, miaUser, page, post, rootUser } from "./postFixtures";
import { currentLocation, LocationProbe } from "./postRender";

const STATS: ProfileStats = { plays: 10, achievements: 1, screenshots: 3, collections: 2, posts: 5 };

function profileOf(user: User, over: Partial<UserProfileResponse> = {}, stats: Partial<ProfileStats> | null = {}): UserProfileResponse {
  return {
    user,
    games: [game("g0", "Game 0", { owner: user })],
    gamesTotal: 1,
    followers: 1,
    following: 1,
    isFollowing: false,
    stats: stats === null ? undefined : { ...STATS, ...stats },
    ...over,
  };
}

const posts = (n: number, over: Partial<Post> = {}) => Array.from({ length: n }, (_, i) => post(`p${i + 1}`, { body: `Body ${i + 1}`, ...over }));

type Opts = {
  me?: User | null;
  profile?: UserProfileResponse;
  list?: (username: string, q: { page?: number; perPage?: number }) => Promise<Page<Post>>;
  state?: unknown;
};

async function setup(url: string, { me = null, profile = profileOf(miaUser), list, state }: Opts = {}) {
  if (me) localStorage.setItem("webgame.token", "tok");
  const fetchMock = async () => new Response(JSON.stringify({ error: { code: "not_found", message: "nope" } }), { status: 404 });
  const client = new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch });
  vi.spyOn(client, "me").mockImplementation(async () => {
    if (!me) throw new ApiError("unauthorized", "no", 401);
    return me;
  });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  vi.spyOn(client, "listUserAchievements").mockResolvedValue([]);
  vi.spyOn(client, "listUserScreenshots").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 4 });
  vi.spyOn(client, "listUserCollections").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 6 });
  vi.spyOn(client, "listGames").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 24 });
  const getUser = vi.spyOn(client, "getUser").mockImplementation(async (u) => {
    if (u.toLowerCase() === profile.user.username.toLowerCase()) return profile;
    throw new ApiError("not_found", "User not found", 404);
  });
  const listUserPosts = vi
    .spyOn(client, "listUserPosts")
    .mockImplementation(async (u, q = {}) => (list ? list(u, q) : page(posts(Math.min(q.perPage ?? 20, 5)), 5, q.page ?? 1, q.perPage ?? 20)));
  const createPost = vi.spyOn(client, "createPost").mockImplementation(async (req) => post("new", { body: req.body, canDelete: true }));
  const deletePost = vi.spyOn(client, "deletePost").mockResolvedValue(undefined);
  const getGame = vi.spyOn(client, "getGame").mockResolvedValue({ ...game("g1", "Space Dodge"), isOwner: false } as Game);
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[state === undefined ? url : { pathname: url.split("?")[0], search: url.includes("?") ? `?${url.split("?")[1]}` : "", state }]}>
        <WebGameRoutes />
        <LocationProbe />
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (me) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
  return { client, getUser, listUserPosts, createPost, deletePost, getGame };
}

const nav = () => screen.getByRole("navigation", { name: "Profile sections" });
const cards = () => Array.from(document.querySelectorAll<HTMLElement>("article.pf-post"));
const bodies = () => cards().map((c) => c.querySelector(".pf-post__body")!.textContent);

async function deleteCard(card: HTMLElement) {
  fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
  await act(async () => {
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete this post?" })).getByRole("button", { name: "Delete" }));
  });
  await act(async () => {});
}

afterEach(() => vi.restoreAllMocks());

describe("Profile shell: Posts link (F030 section 0.8)", () => {
  it("is the second link, with the count, at /u/{u}/posts", async () => {
    await setup("/u/mia");
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    const links = within(nav()).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Overview", "Posts 5", "Games 1", "Screenshots 3", "Collections 2"]);
    expect(links[1].getAttribute("href")).toBe("/u/mia/posts");
  });

  it("is hidden without stats.posts (older server), and so is the shelf", async () => {
    const { listUserPosts } = await setup("/u/mia", { profile: profileOf(miaUser, {}, { posts: undefined }) });
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(within(nav()).queryByRole("link", { name: /^Posts/ })).toBeNull();
    expect(listUserPosts).not.toHaveBeenCalled();
  });

  it("is marked current on the Posts section", async () => {
    await setup("/u/mia/posts");
    expect(within(nav()).getByRole("link", { name: "Posts 5" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("Posts section (F030 section 0.10)", () => {
  it("loads 20 per page, newest first, with Load more at the next offset; the title is Posts · Mia", async () => {
    const all = posts(25);
    const { listUserPosts } = await setup("/u/mia/posts", {
      list: async (_u, q) => {
        const per = q.perPage ?? 20;
        const p = q.page ?? 1;
        return page(all.slice((p - 1) * per, p * per), all.length, p, per);
      },
    });
    expect(listUserPosts).toHaveBeenCalledWith("mia", { page: 1, perPage: 20 });
    expect(document.title).toBe("Posts · Mia · Pixelforge Arcade");
    expect(screen.getByRole("heading", { level: 2, name: "Posts" }).getAttribute("tabindex")).toBe("-1");
    expect(cards()).toHaveLength(20);
    // Anonymous: no composer.
    expect(screen.queryByRole("form", { name: "New post" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    });
    expect(listUserPosts).toHaveBeenLastCalledWith("mia", { page: 2, perPage: 20 });
    expect(cards()).toHaveLength(25);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("after a local delete, Load more fetches both pages that cover the offset (no post skipped)", async () => {
    const all = posts(25, { canDelete: true });
    const { listUserPosts } = await setup("/u/mia/posts", {
      me: miaUser,
      list: async (_u, q) => {
        const per = q.perPage ?? 20;
        const p = q.page ?? 1;
        return page(all.slice((p - 1) * per, p * per), all.length, p, per);
      },
    });
    await deleteCard(cards()[0]);
    all.shift();
    listUserPosts.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    });
    expect(listUserPosts.mock.calls.map((c) => c[1])).toEqual([
      { page: 1, perPage: 20 },
      { page: 2, perPage: 20 },
    ]);
    expect(cards()).toHaveLength(24);
  });

  it("first-load and load-more errors", async () => {
    let fail = true;
    await setup("/u/mia/posts", {
      list: async (_u, q) => {
        if (fail) throw new Error("offline");
        return page(posts(20), 25, q.page ?? 1);
      },
    });
    expect(screen.getByText("Couldn't load posts.")).toBeTruthy();
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(cards()).toHaveLength(20);
    fail = true;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    });
    expect(screen.getByText("Couldn't load more: offline")).toBeTruthy();
  });

  it("own profile: the composer comes before the list; posting prepends and reloads the shell without remounting the header", async () => {
    const { getUser, createPost } = await setup("/u/mia/posts", { me: miaUser, list: async () => page(posts(2, { canDelete: true }), 2) });
    const section = document.querySelector(".pf-profile-posts-section")!;
    const form = within(section as HTMLElement).getByRole("form", { name: "New post" });
    expect(form.compareDocumentPosition(cards()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const header = document.querySelector(".pf-profile")!;
    const calls = getUser.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Post text"), { target: { value: "Fresh news" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(createPost).toHaveBeenCalledWith({ body: "Fresh news" });
    expect(bodies()).toEqual(["Fresh news", "Body 1", "Body 2"]);
    await waitFor(() => expect(getUser.mock.calls.length).toBe(calls + 1));
    expect(document.querySelector(".pf-profile")).toBe(header);
    expect(document.activeElement).toBe(screen.getByLabelText("Post text"));
  });

  it("own profile with no posts: the empty state below the composer", async () => {
    await setup("/u/mia/posts", { me: miaUser, profile: profileOf(miaUser, {}, { posts: 0 }), list: async () => page([], 0) });
    expect(screen.getByRole("form", { name: "New post" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No posts yet" })).toBeTruthy();
    expect(screen.getByText("Posts appear here and in your followers' feeds.")).toBeTruthy();
  });

  it("another profile with stats.posts 0: '{name} hasn't posted anything yet.'", async () => {
    const { listUserPosts } = await setup("/u/mia/posts", { me: leoUser, profile: profileOf(miaUser, {}, { posts: 0 }) });
    expect(screen.getByRole("heading", { name: "No posts yet" })).toBeTruthy();
    expect(screen.getByText("Mia hasn't posted anything yet.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "New post" })).toBeNull();
    expect(listUserPosts).not.toHaveBeenCalled();
  });

  it("delete focus: the next card, else the previous, else the textarea (own)", async () => {
    await setup("/u/mia/posts", { me: miaUser, profile: profileOf(miaUser, {}, { posts: 3 }), list: async () => page(posts(3, { canDelete: true }), 3) });
    await deleteCard(cards()[1]);
    expect(bodies()).toEqual(["Body 1", "Body 3"]);
    expect(await screen.findByText("Post deleted")).toBeTruthy();
    expect(document.activeElement).toBe(cards()[1]);
    await deleteCard(cards()[1]);
    expect(bodies()).toEqual(["Body 1"]);
    expect(document.activeElement).toBe(cards()[0]);
    await deleteCard(cards()[0]);
    expect(cards()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByLabelText("Post text"));
    expect(screen.getByText("Posts appear here and in your followers' feeds.")).toBeTruthy();
  });

  it("delete focus on another profile (admin): the heading when no card is left", async () => {
    const { getUser } = await setup("/u/mia/posts", { me: rootUser, profile: profileOf(miaUser, {}, { posts: 1 }), list: async () => page(posts(1, { canDelete: true }), 1) });
    const calls = getUser.mock.calls.length;
    await deleteCard(cards()[0]);
    expect(cards()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Posts" }));
    // The shell reloads so the count updates.
    await waitFor(() => expect(getUser.mock.calls.length).toBe(calls + 1));
  });

  it("?attach=game:g1 on your own profile loads the game, shows the preview and focuses the textarea", async () => {
    const { getGame } = await setup("/u/mia/posts?attach=game:g1", { me: miaUser });
    expect(getGame).toHaveBeenCalledWith("g1");
    const form = screen.getByRole("form", { name: "New post" });
    await waitFor(() => expect(form.querySelector("a.pf-post-attachment")).not.toBeNull());
    expect(form.querySelector("a.pf-post-attachment")!.getAttribute("href")).toBe("/games/g1");
    expect(document.activeElement).toBe(screen.getByLabelText("Post text"));
    expect(currentLocation()).toBe("/u/mia/posts?attach=game:g1");
  });

  it("?attach is ignored on another profile", async () => {
    const other = await setup("/u/mia/posts?attach=game:g1", { me: leoUser });
    expect(other.getGame).not.toHaveBeenCalled();
    expect(screen.queryByRole("form", { name: "New post" })).toBeNull();
  });

  it("a malformed ?attach on your own profile is ignored silently", async () => {
    const { getGame } = await setup("/u/mia/posts?attach=foo:1", { me: miaUser });
    expect(getGame).not.toHaveBeenCalled();
    expect(screen.getByRole("form", { name: "New post" }).querySelector(".pf-alert")).toBeNull();
  });

  it("state.focusPostsHeading focuses the h2", async () => {
    await setup("/u/mia/posts", { me: miaUser, state: { focusPostsHeading: true } });
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Posts" }));
  });

  it("without the state the heading isn't focused", async () => {
    await setup("/u/mia/posts", { me: miaUser });
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { level: 2, name: "Posts" }));
  });
});

describe("Overview shelf (F030 section 0.9)", () => {
  it("shows 3 posts and 'See all 5 posts →', after the achievements and before the games", async () => {
    const { listUserPosts } = await setup("/u/mia");
    expect(listUserPosts).toHaveBeenCalledWith("mia", { page: 1, perPage: 3 });
    const shelf = document.querySelector<HTMLElement>(".pf-shelf.pf-profile-posts")!;
    expect(within(shelf).getByRole("heading", { level: 2, name: "Posts" })).toBeTruthy();
    expect(shelf.querySelectorAll("article.pf-post")).toHaveLength(3);
    const more = within(shelf).getByRole("link", { name: "See all 5 posts →" });
    expect(more.getAttribute("href")).toBe("/u/mia/posts");
    // No composer on the Overview.
    expect(screen.queryByRole("form", { name: "New post" })).toBeNull();
    const titles = Array.from(document.querySelectorAll(".pf-profile-section .pf-section-title")).map((h) => h.textContent);
    expect(titles.indexOf("Posts")).toBeLessThan(titles.indexOf("Games"));
  });

  it("no 'See all' link with 3 or fewer posts", async () => {
    await setup("/u/mia", { profile: profileOf(miaUser, {}, { posts: 3 }), list: async () => page(posts(3), 3, 1, 3) });
    const shelf = document.querySelector<HTMLElement>(".pf-shelf.pf-profile-posts")!;
    expect(shelf.querySelectorAll("article.pf-post")).toHaveLength(3);
    expect(within(shelf).queryByRole("link", { name: /See all/ })).toBeNull();
  });

  it("your own profile with 0 posts: 'Write a post'", async () => {
    await setup("/u/mia", { me: miaUser, profile: profileOf(miaUser, {}, { posts: 0 }), list: async () => page([], 0, 1, 3) });
    const shelf = document.querySelector<HTMLElement>(".pf-shelf.pf-profile-posts")!;
    expect(within(shelf).getByRole("heading", { name: "No posts yet" })).toBeTruthy();
    expect(within(shelf).getByText("Share an update with your followers.")).toBeTruthy();
    expect(within(shelf).getByRole("link", { name: "Write a post" }).getAttribute("href")).toBe("/u/mia/posts");
  });

  it("another profile with 0 posts: no shelf (also while loading and on errors)", async () => {
    await setup("/u/mia", { me: leoUser, list: async () => page([], 0, 1, 3) });
    expect(document.querySelector(".pf-profile-posts")).toBeNull();
  });

  it("another profile: no shelf on an error", async () => {
    await setup("/u/mia", {
      list: async () => {
        throw new Error("offline");
      },
    });
    expect(document.querySelector(".pf-profile-posts")).toBeNull();
    expect(screen.queryByText("Couldn't load posts.")).toBeNull();
  });

  it("a 404 (older server) hides the shelf even on your own profile", async () => {
    await setup("/u/mia", {
      me: miaUser,
      list: async () => {
        throw new ApiError("not_found", "Not found", 404);
      },
    });
    expect(document.querySelector(".pf-profile-posts")).toBeNull();
  });

  it("the all-zero overview also needs posts: 0", async () => {
    const zero = { plays: 0, achievements: 0, screenshots: 0, collections: 0 };
    await setup("/u/mia", { me: leoUser, profile: profileOf(miaUser, { games: [], gamesTotal: 0 }, { ...zero, posts: 2 }), list: async () => page(posts(2), 2, 1, 3) });
    expect(screen.queryByText("Mia hasn't shared anything yet.")).toBeNull();
    expect(document.querySelectorAll(".pf-profile-posts article.pf-post")).toHaveLength(2);
  });

  it("all zero including posts: 'Nothing here yet'", async () => {
    const zero = { plays: 0, achievements: 0, screenshots: 0, collections: 0, posts: 0 };
    await setup("/u/mia", { me: leoUser, profile: profileOf(miaUser, { games: [], gamesTotal: 0 }, zero) });
    expect(screen.getByText("Mia hasn't shared anything yet.")).toBeTruthy();
  });
});

// Review 11: M1 (profile link labels always show the real host), L3 (the Overview posts shelf reloads the shell after
// a delete) and L4 (a failed background refetch keeps the loaded profile on screen).
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { Post, ProfileLink, ProfileStats, User, UserProfileResponse } from "../api/types";
import { profileLinkDisplay } from "../components/ProfileHeader";
import { WebGameRoutes } from "../WebGameApp";
import { game } from "./collectionFixtures";
import { miaUser, page, post } from "./postFixtures";
import { makeClient, renderWith } from "./postRender";

const DOT = String.fromCodePoint(0xb7);
const STATS: ProfileStats = { plays: 10, achievements: 1, screenshots: 0, collections: 0, posts: 3 };

function profileOf(user: User, stats: Partial<ProfileStats> = {}): UserProfileResponse {
  return {
    user,
    games: [game("g0", "Game 0", { owner: user })],
    gamesTotal: 1,
    followers: 1,
    following: 1,
    isFollowing: false,
    stats: { ...STATS, ...stats },
  };
}

type Opts = {
  me?: User | null;
  getUser?: (username: string, call: number) => Promise<UserProfileResponse>;
  posts?: Post[];
};

async function setup(url: string, { me = null, getUser, posts = [] }: Opts = {}) {
  const client = makeClient(me);
  vi.spyOn(client, "listUserAchievements").mockResolvedValue([]);
  vi.spyOn(client, "listUserScreenshots").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 4 });
  vi.spyOn(client, "listUserCollections").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 6 });
  vi.spyOn(client, "listGames").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 24 });
  let calls = 0;
  const fetchUser = vi.spyOn(client, "getUser").mockImplementation(async (u) => (getUser ? getUser(u, calls++) : profileOf(miaUser)));
  const items = [...posts];
  vi.spyOn(client, "listUserPosts").mockImplementation(async (_u, q = {}) => page(items.slice(0, q.perPage ?? 20), items.length, 1, q.perPage ?? 20));
  vi.spyOn(client, "createPost").mockImplementation(async (req) => post("new", { body: req.body, canDelete: true }));
  const deletePost = vi.spyOn(client, "deletePost").mockImplementation(async (id) => {
    const i = items.findIndex((p) => p.id === id);
    if (i >= 0) items.splice(i, 1);
  });
  await renderWith(client, <WebGameRoutes />, url, me);
  return { client, getUser: fetchUser, deletePost };
}

const linksOf = () => within(within(document.querySelector<HTMLElement>(".pf-profile")!).getByRole("list", { name: "Links" })).getAllByRole("link");
const nav = () => screen.getByRole("navigation", { name: "Profile sections" });
const cards = () => Array.from(document.querySelectorAll<HTMLElement>("article.pf-post"));

async function deleteCard(card: HTMLElement) {
  fireEvent.click(within(card).getByRole("button", { name: /^Delete post by / }));
  await act(async () => {
    fireEvent.click(within(screen.getByRole("dialog", { name: "Delete this post?" })).getByRole("button", { name: "Delete" }));
  });
  await act(async () => {});
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("profileLinkDisplay (review 11 M1)", () => {
  const show = (label: string, url: string) => profileLinkDisplay({ label, url } as ProfileLink);

  it("always returns the real host, without a leading www.", () => {
    expect(show("YouTube", "https://www.youtube.com/@mia")).toEqual({ label: "YouTube", host: "youtube.com" });
    expect(show("", "https://WWW.Mia.dev/x")).toEqual({ label: null, host: "mia.dev" });
    expect(show("Blog", "http://blog.mia.dev:8080/a?b#c")).toEqual({ label: "Blog", host: "blog.mia.dev" });
  });

  it("a label that looks like another domain keeps the real host next to it", () => {
    expect(show("github.com/mia", "https://evil.example/login")).toEqual({ label: "github.com/mia", host: "evil.example" });
    expect(show("www.github.com", "https://github.com.evil.example")).toEqual({ label: "www.github.com", host: "github.com.evil.example" });
  });

  it("a label equal to the host (case-insensitive) shows only the host", () => {
    expect(show("Mia.DEV", "https://www.mia.dev")).toEqual({ label: null, host: "mia.dev" });
    expect(show("  mia.dev  ", "https://mia.dev/")).toEqual({ label: null, host: "mia.dev" });
  });
});

describe("Profile header links (review 11 M1)", () => {
  const withLinks = (links: ProfileLink[]) => async () => profileOf({ ...miaUser, links });

  it("renders `{label} · {host}`, title = the full URL, and the host in the accessible name", async () => {
    await setup("/u/mia", {
      getUser: withLinks([
        { label: "github.com/mia", url: "https://evil.example/login" },
        { label: "mia.dev", url: "https://www.mia.dev" },
        { label: "", url: "https://www.youtube.com/@mia" },
      ]),
    });
    const [spoof, same, bare] = linksOf();
    expect(spoof.textContent).toBe(`\u{1f517} github.com/mia ${DOT} evil.example (opens in a new tab)`);
    expect(spoof.getAttribute("title")).toBe("https://evil.example/login");
    expect(spoof.getAttribute("href")).toBe("https://evil.example/login");
    expect(within(spoof).getByText("evil.example").className).toBe("pf-profile__link-host");
    // Accessible name: label plus host (the emoji is aria-hidden).
    expect(screen.getByRole("link", { name: (n) => n.startsWith(`github.com/mia ${DOT} evil.example`) })).toBe(spoof);

    expect(same.textContent).toBe("\u{1f517} mia.dev (opens in a new tab)");
    expect(same.getAttribute("title")).toBe("https://www.mia.dev");
    expect(same.querySelector(".pf-profile__link-label")).toBeNull();

    expect(bare.textContent).toBe("\u{1f517} youtube.com (opens in a new tab)");
    expect(bare.getAttribute("title")).toBe("https://www.youtube.com/@mia");
  });
});

describe("Overview posts shelf (review 11 L3)", () => {
  it("a delete on the shelf reloads the shell, so 'Posts N' updates", async () => {
    let count = 3;
    const { getUser } = await setup("/u/mia", {
      me: miaUser,
      getUser: async () => profileOf(miaUser, { posts: count }),
      posts: [post("p1", { canDelete: true }), post("p2", { canDelete: true }), post("p3", { canDelete: true })],
    });
    expect(within(nav()).getByRole("link", { name: "Posts 3" })).toBeTruthy();
    const shelf = document.querySelector<HTMLElement>(".pf-shelf.pf-profile-posts")!;
    expect(shelf.querySelectorAll("article.pf-post")).toHaveLength(3);
    const calls = getUser.mock.calls.length;
    count = 2;
    await deleteCard(cards()[0]);
    await waitFor(() => expect(getUser.mock.calls.length).toBe(calls + 1));
    await waitFor(() => expect(within(nav()).getByRole("link", { name: "Posts 2" })).toBeTruthy());
  });
});

describe("Profile shell background refresh (review 11 L4)", () => {
  it("a failed refetch after posting keeps the profile, the section and the list on screen, with a toast", async () => {
    let fail = false;
    const { getUser } = await setup("/u/mia/posts", {
      me: miaUser,
      getUser: async () => {
        if (!fail) return profileOf(miaUser);
        throw new ApiError("unavailable", "Service unavailable", 503);
      },
      posts: [post("p1", { body: "Body 1", canDelete: true })],
    });
    const header = document.querySelector(".pf-profile")!;
    const calls = getUser.mock.calls.length;
    fail = true;
    fireEvent.change(screen.getByLabelText("Post text"), { target: { value: "Fresh news" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "New post" }));
    });
    await waitFor(() => expect(getUser.mock.calls.length).toBe(calls + 1));
    expect(await screen.findByText("Couldn't refresh the profile")).toBeTruthy();
    expect(document.querySelector(".pf-profile")).toBe(header);
    expect(screen.getByRole("heading", { level: 1, name: "Mia" })).toBeTruthy();
    expect(cards().map((c) => c.querySelector(".pf-post__body")!.textContent)).toEqual(["Fresh news", "Body 1"]);
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("a 404 on a background refetch after a delete doesn't replace the page with Not found", async () => {
    let fail = false;
    const { getUser } = await setup("/u/mia/posts", {
      me: miaUser,
      getUser: async () => {
        if (!fail) return profileOf(miaUser, { posts: 2 });
        throw new ApiError("not_found", "User not found", 404);
      },
      posts: [post("p1", { body: "Body 1", canDelete: true }), post("p2", { body: "Body 2", canDelete: true })],
    });
    const calls = getUser.mock.calls.length;
    fail = true;
    await deleteCard(cards()[0]);
    await waitFor(() => expect(getUser.mock.calls.length).toBe(calls + 1));
    expect(await screen.findByText("Couldn't refresh the profile")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Mia" })).toBeTruthy();
    expect(cards()).toHaveLength(1);
  });

  it("the first load still shows the error page", async () => {
    await setup("/u/mia", {
      getUser: async () => {
        throw new ApiError("unavailable", "Service unavailable", 503);
      },
    });
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(document.querySelector(".pf-profile")).toBeNull();
    expect(screen.queryByText("Couldn't refresh the profile")).toBeNull();
  });
});

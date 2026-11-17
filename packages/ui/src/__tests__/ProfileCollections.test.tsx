import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { CollectionSummary, Page, User, UserProfileResponse } from "../api/types";
import { ProfilePage } from "../pages/ProfilePage";
import { WebGameProviders, WebGameRoutes } from "../WebGameApp";
import { anaUser, collection, samUser, summary } from "./collectionFixtures";

function LocationProbe() {
  const loc = useLocation();
  return <p data-testid="location">{loc.pathname + loc.search}</p>;
}

const profile = (u: User): UserProfileResponse => ({ user: u, games: [], gamesTotal: 0, followers: 0, following: 0, isFollowing: false });
const page = (items: CollectionSummary[], total = items.length): Page<CollectionSummary> => ({ items, total, page: 1, perPage: 6 });

function makeClient(me: User | null) {
  if (me) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockImplementation(async () => {
    if (!me) throw new ApiError("unauthorized", "no", 401);
    return me;
  });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
  vi.spyOn(client, "listUserAchievements").mockResolvedValue([]);
  vi.spyOn(client, "listUserScreenshots").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 12 });
  return client;
}

async function setup(viewed: User, list: Page<CollectionSummary> | Error, me: User | null = null) {
  const client = makeClient(me);
  vi.spyOn(client, "getUser").mockResolvedValue(profile(viewed));
  const spy = vi.spyOn(client, "listUserCollections");
  if (list instanceof Error) spy.mockRejectedValue(list);
  else spy.mockResolvedValue(list);
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[`/u/${viewed.username}`]}>
        <Routes>
          <Route path="/u/:username" element={<ProfilePage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (me) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
  return { ...utils, client, spy };
}

const section = () => screen.getByRole("region", { name: "Collections" });

afterEach(() => vi.restoreAllMocks());

describe("Profile collections section", () => {
  it("shows up to 6 cards (one link each, decorative covers) without 'See all' when everything fits", async () => {
    const { spy } = await setup(
      samUser,
      page([
        summary("c1", "Cozy games", { owner: samUser, gameCount: 1, coverUrls: ["/media/thumbnails/g1.png", "/media/thumbnails/g2.png"] }),
        summary("c2", "Puzzles", { owner: samUser, gameCount: 4 }),
      ]),
    );
    expect(spy).toHaveBeenCalledWith("sam", { perPage: 6 });
    const s = section();
    const cards = s.querySelectorAll("article.pf-collection-card");
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getAllByRole("link")).toHaveLength(1);
    expect(within(cards[0] as HTMLElement).getByRole("link").getAttribute("href")).toBe("/c/c1");
    expect(cards[0].textContent).toContain("1 game");
    expect(cards[0].textContent).not.toContain("by Sam");
    const cover = cards[0].querySelector(".pf-collection-cover")!;
    expect(cover.getAttribute("aria-hidden")).toBe("true");
    expect(cover.querySelectorAll(".pf-collection-cover__tile")).toHaveLength(4);
    const imgs = cover.querySelectorAll("img");
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute("alt")).toBe("");
    expect(imgs[0].getAttribute("src")).toBe("http://api.test/media/thumbnails/g1.png");
    expect(cards[1].querySelector(".pf-collection-cover--empty")!.textContent).toBe("📚");
    expect(within(s).queryByRole("link", { name: /See all/ })).toBeNull();
    expect(within(s).queryByRole("button", { name: /New collection/ })).toBeNull();
  });

  it("'See all {total} collections' when there are more than 6", async () => {
    const items = Array.from({ length: 6 }, (_, i) => summary(`c${i}`, `List ${i}`, { owner: samUser }));
    await setup(samUser, page(items, 9));
    const link = within(section()).getByRole("link", { name: "See all 9 collections →" });
    expect(link.getAttribute("href")).toBe("/u/sam/collections");
  });

  it("is hidden on other profiles when empty, and on servers without collections", async () => {
    const a = await setup(samUser, page([]));
    expect(screen.queryByRole("region", { name: "Collections" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Collections" })).toBeNull();
    a.unmount();
    await setup(samUser, new ApiError("not_found", "No such API endpoint", 404), anaUser);
    expect(screen.queryByRole("heading", { name: "Collections" })).toBeNull();
  });

  it("own profile: private badge, New collection in the header, which creates and navigates", async () => {
    const { client } = await setup(anaUser, page([summary("c1", "Play later", { visibility: "private" })]), anaUser);
    const s = section();
    const badge = s.querySelector(".pf-badge--private")!;
    expect(badge.textContent).toContain("Private");
    expect(badge.querySelector("[aria-hidden=true]")!.textContent).toBe("🔒");
    const create = vi.spyOn(client, "createCollection").mockResolvedValue(collection({ id: "c7", path: "/c/c7", title: "Arcade", isOwner: true }));
    await act(async () => fireEvent.click(within(s).getByRole("button", { name: "New collection" })));
    const dialog = screen.getByRole("dialog", { name: "New collection" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Title/ }), { target: { value: "Arcade" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Description/ }), { target: { value: "Line 1\r\nLine 2" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Create collection" })));
    expect(create).toHaveBeenCalledWith({ title: "Arcade", description: "Line 1\nLine 2", visibility: "public" });
    expect(screen.getByTestId("location").textContent).toBe("/c/c7");
  });

  it("own profile, no collections: the empty state with New collection; the form shows server 422s inline", async () => {
    const { client } = await setup(anaUser, page([]), anaUser);
    const s = section();
    expect(within(s).getByText("Group games into lists to share or to play later.")).toBeTruthy();
    vi.spyOn(client, "createCollection").mockRejectedValue(new ApiError("validation", "You can have at most 50 collections", 422));
    const opener = within(s).getByRole("button", { name: "New collection" });
    opener.focus();
    await act(async () => fireEvent.click(opener));
    const dialog = screen.getByRole("dialog", { name: "New collection" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Title/ }), { target: { value: "One more" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Create collection" })));
    expect(within(dialog).getByRole("alert").textContent).toBe("You can have at most 50 collections.");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
    expect(document.activeElement).toBe(opener);
  });
});

describe("Collections routes", () => {
  it("/collections redirects to the signed-in user's list, which the user menu links to", async () => {
    const client = makeClient(anaUser);
    const spy = vi.spyOn(client, "listUserCollections").mockResolvedValue({ ...page([summary("c1", "Cozy games")]), perPage: 24 });
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter initialEntries={["/collections"]}>
          <WebGameRoutes />
        </MemoryRouter>
      </WebGameProviders>,
    );
    await screen.findByRole("heading", { level: 1, name: "My collections" });
    // The heading can be found (MutationObserver) before the page's passive fetch effect has run: wait for the call.
    await waitFor(() => expect(spy).toHaveBeenCalledWith("ana", { page: 1, perPage: 24 }));
    expect((await screen.findByRole("link", { name: "Cozy games" })).getAttribute("href")).toBe("/c/c1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Ana/ })));
    expect(screen.getByRole("menuitem", { name: "Collections" }).getAttribute("href")).toBe("/collections");
  });

  it("/collections sends anonymous visitors to log in", async () => {
    const client = makeClient(null);
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter initialEntries={["/collections"]}>
          <Routes>
            <Route path="/login" element={<LocationProbe />} />
            <Route path="*" element={<WebGameRoutes />} />
          </Routes>
        </MemoryRouter>
      </WebGameProviders>,
    );
    expect((await screen.findByTestId("location")).textContent).toBe("/login?next=%2Fcollections");
  });
});

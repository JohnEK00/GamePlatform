import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Page, User, UserProfileResponse, UserScreenshot } from "../api/types";
import { useAuth } from "../context/auth";
import { PROFILE_SCREENSHOTS_PER_PAGE, ProfileScreenshots } from "../components/ProfileScreenshots";
import { ProfilePage } from "../pages/ProfilePage";
import { WebGameProviders } from "../WebGameApp";

const ana: User = { id: "u1", username: "ana", displayName: "Ana", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const sam: User = { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

function shot(i: number, over: Partial<UserScreenshot> = {}): UserScreenshot {
  return {
    id: `p${i}`,
    gameId: `g${i}`,
    author: { id: ana.id, username: ana.username, displayName: ana.displayName, avatarUrl: null },
    caption: "",
    imageUrl: `/media/screenshots/p${i}.png`,
    thumbUrl: `/media/screenshots/p${i}_t.jpg`,
    width: 1280,
    height: 720,
    gameVersion: 1,
    createdAt: "2026-11-14T15:30:12Z",
    canDelete: false,
    game: { id: `g${i}`, title: `Game ${i}` },
    ...over,
  };
}

const page = (items: UserScreenshot[], total = items.length, p = 1): Page<UserScreenshot> => ({ items, total, page: p, perPage: 12 });

type ListImpl = (username: string, q: { page?: number; perPage?: number }) => Promise<Page<UserScreenshot>>;

function LogoutButton() {
  const { logout } = useAuth();
  return (
    <button type="button" onClick={logout}>
      Sign out
    </button>
  );
}

async function setup(list: ListImpl, { me = null as User | null, isMe = false, username = "ana" } = {}) {
  if (me) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockImplementation(async () => {
    if (!me) throw new ApiError("unauthorized", "no", 401);
    return me;
  });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "deleteScreenshot").mockResolvedValue(undefined);
  const spy = vi.spyOn(client, "listUserScreenshots").mockImplementation(async (u, q = {}) => list(u, q));
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <ProfileScreenshots username={username} isMe={isMe} />
        <LogoutButton />
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (me) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  await act(async () => {});
  return { ...utils, client, spy };
}

const region = () => screen.queryByRole("region", { name: /^Screenshots/ });
const thumbs = () => screen.queryAllByRole("button", { name: /^Screenshot of / });

async function deleteOpen() {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
  const confirm = screen.getAllByRole("dialog").at(-1)!;
  await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ProfileScreenshots (F015 § 2.3)", () => {
  it("own profile, empty: the empty state", async () => {
    const { spy } = await setup(async () => page([]), { me: ana, isMe: true });
    expect(spy).toHaveBeenCalledWith("ana", { page: 1, perPage: PROFILE_SCREENSHOTS_PER_PAGE });
    const r = region()!;
    expect(within(r).getByRole("heading", { level: 2 }).textContent).toBe("Screenshots");
    expect(within(r).getByRole("heading", { name: "No screenshots yet" })).toBeTruthy();
    expect(within(r).getByText("Press 📷 while playing a game and post the shot to its page. Your screenshots appear here.")).toBeTruthy();
  });

  it("own profile, error: LoadError with Retry that reloads", async () => {
    let fail = true;
    const { spy } = await setup(async () => {
      if (fail) throw new ApiError("internal", "boom", 500);
      return page([shot(1)]);
    }, { me: ana, isMe: true });
    const r = region()!;
    expect(within(r).getByText("Couldn't load your screenshots.")).toBeTruthy();
    fail = false;
    await act(async () => fireEvent.click(within(r).getByRole("button", { name: "Retry" })));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(thumbs()).toHaveLength(1);
  });

  it("own profile, loading: three skeletons; other profile: hidden while loading", async () => {
    const never = () => new Promise<Page<UserScreenshot>>(() => {});
    const own = await setup(never, { me: ana, isMe: true });
    expect(region()!.querySelectorAll(".pf-shots__skeleton")).toHaveLength(3);
    own.unmount();
    await setup(never, { me: sam });
    expect(region()).toBeNull();
  });

  it("other profile: hidden when empty", async () => {
    await setup(async () => page([]), { me: sam });
    expect(region()).toBeNull();
  });

  it("other profile: hidden on error", async () => {
    await setup(async () => {
      throw new ApiError("internal", "boom", 500);
    });
    expect(region()).toBeNull();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("hidden on a 404 on other profiles and on your own", async () => {
    const notFound = async (): Promise<Page<UserScreenshot>> => {
      throw new ApiError("not_found", "User not found", 404);
    };
    const other = await setup(notFound, { me: sam });
    expect(region()).toBeNull();
    other.unmount();
    localStorage.clear();
    await setup(notFound, { me: ana, isMe: true });
    expect(region()).toBeNull();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });

  it("grid labels, decorative images, game links and the total badge", async () => {
    await setup(async () => page([shot(1, { caption: "Lava level" }), shot(2, { game: { id: "a b", title: "Kiln Clash" } })], 2));
    const r = region()!;
    expect(within(r).getByRole("heading", { level: 2 }).textContent).toBe("Screenshots2");
    expect(r.querySelector(".pf-tab__count")!.textContent).toBe("2");
    expect(thumbs().map((b) => b.getAttribute("aria-label"))).toEqual(["Screenshot of Game 1: Lava level", "Screenshot of Kiln Clash"]);
    for (const b of thumbs()) {
      expect(b.getAttribute("aria-haspopup")).toBe("dialog");
      expect(b.querySelector("img")!.getAttribute("alt")).toBe("");
    }
    expect(within(r).getByRole("link", { name: "Game 1" }).getAttribute("href")).toBe("/games/g1?section=screenshots");
    expect(within(r).getByRole("link", { name: "Kiln Clash" }).getAttribute("href")).toBe("/games/a%20b?section=screenshots");
    expect(within(r).queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("the lightbox names the game, links to its gallery and never offers Set as thumbnail", async () => {
    await setup(async () => page([shot(1), shot(2, { caption: "Two" })], 2), { me: sam });
    fireEvent.click(screen.getByRole("button", { name: "Screenshot of Game 1" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("img").getAttribute("alt")).toBe("Screenshot of Game 1 by Ana");
    expect(within(dialog).getByRole("link", { name: "View on game page" }).getAttribute("href")).toBe("/games/g1?section=screenshots");
    expect(within(dialog).queryByRole("button", { name: /Set as thumbnail/ })).toBeNull();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(within(screen.getByRole("dialog")).getByRole("link", { name: "View on game page" }).getAttribute("href")).toBe("/games/g2?section=screenshots");
  });

  it("Load more after a local delete uses pagesForOffset: no duplicates, no gaps", async () => {
    // 25 shots p1..p25; p5 gets deleted, after which the server pages shift up by one.
    let deleted = false;
    const all = () => Array.from({ length: 25 }, (_, i) => shot(i + 1, { canDelete: true })).filter((s) => !(deleted && s.id === "p5"));
    const { spy, client } = await setup(
      async (_u, q) => {
        const rows = all();
        const p = q.page ?? 1;
        return page(rows.slice((p - 1) * 12, p * 12), rows.length, p);
      },
      { me: ana, isMe: true },
    );
    expect(thumbs()).toHaveLength(12);
    expect(region()!.querySelector(".pf-tab__count")!.textContent).toBe("25");
    vi.mocked(client.deleteScreenshot).mockImplementation(async () => {
      deleted = true;
    });
    fireEvent.click(thumbs()[4]);
    await deleteOpen();
    expect(thumbs()).toHaveLength(11);
    expect(region()!.querySelector(".pf-tab__count")!.textContent).toBe("24");
    spy.mockClear();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Load more/ })));
    expect(spy.mock.calls.map((c) => c[1])).toEqual([
      { page: 1, perPage: 12 },
      { page: 2, perPage: 12 },
    ]);
    const ids = Array.from(region()!.querySelectorAll(".pf-shots__item")).map((b) => b.closest("li")!.querySelector("a")!.textContent);
    expect(ids).toEqual(all().map((s) => s.game.title));
    expect(new Set(ids).size).toBe(24);
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("delete focus: the thumbnail now at that position, else the previous one, else the heading", async () => {
    await setup(async () => page([1, 2, 3].map((i) => shot(i, { canDelete: true }))), { me: ana, isMe: true });
    fireEvent.click(screen.getByRole("button", { name: "Screenshot of Game 2" }));
    await deleteOpen();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Screenshot of Game 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Screenshot of Game 3" }));
    await deleteOpen();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Screenshot of Game 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Screenshot of Game 1" }));
    await deleteOpen();
    const heading = within(region()!).getByRole("heading", { level: 2 });
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole("heading", { name: "No screenshots yet" })).toBeTruthy();
  });

  it("delete focus on someone else's profile also falls back to the heading", async () => {
    await setup(async () => page([shot(1, { canDelete: true })]), { me: { ...sam, role: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Screenshot of Game 1" }));
    await deleteOpen();
    const heading = within(region()!).getByRole("heading", { level: 2 });
    expect(document.activeElement).toBe(heading);
  });

  it("reloads from page 1 when the signed-in user changes", async () => {
    const { spy } = await setup(async () => page([shot(1)]), { me: sam });
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Sign out" })));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy).toHaveBeenLastCalledWith("ana", { page: 1, perPage: 12 });
  });

  it("waits for auth before loading", async () => {
    localStorage.setItem("webgame.token", "tok");
    const client = new ApiClient({ baseUrl: "http://api.test" });
    let resolveMe!: (u: User) => void;
    vi.spyOn(client, "me").mockImplementation(() => new Promise<User>((r) => (resolveMe = r)));
    vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
    const spy = vi.spyOn(client, "listUserScreenshots").mockResolvedValue(page([]));
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter>
          <ProfileScreenshots username="ana" isMe={false} />
        </MemoryRouter>
      </WebGameProviders>,
    );
    await act(async () => {});
    expect(spy).not.toHaveBeenCalled();
    await act(async () => resolveMe(sam));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("ProfilePage placement (F015 § 0.10)", () => {
  it("renders Screenshots between Games and Collections", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "me").mockRejectedValue(new ApiError("unauthorized", "no", 401));
    vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
    vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
    vi.spyOn(client, "listUserAchievements").mockResolvedValue([]);
    const profile: UserProfileResponse = { user: ana, games: [], gamesTotal: 0, followers: 0, following: 0, isFollowing: false };
    vi.spyOn(client, "getUser").mockResolvedValue(profile);
    const coll = vi.spyOn(client, "listUserCollections").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 6 });
    const shots = vi.spyOn(client, "listUserScreenshots").mockResolvedValue(page([shot(1)]));
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter initialEntries={["/u/ana"]}>
          <Routes>
            <Route path="/u/:username" element={<ProfilePage />} />
          </Routes>
        </MemoryRouter>
      </WebGameProviders>,
    );
    await screen.findByRole("heading", { name: "Ana" });
    await waitFor(() => expect(shots).toHaveBeenCalledWith("ana", { page: 1, perPage: 12 }));
    await waitFor(() => expect(coll).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Screenshot of Game 1" });
    const titles = Array.from(document.querySelectorAll("h2.pf-section-title")).map((h) => h.textContent);
    expect(titles.indexOf("Games")).toBeLessThan(titles.indexOf("Screenshots1"));
    // Collections is hidden on someone else's profile when empty, so check the DOM order against its slot instead.
    const shotsSection = region()!;
    const gamesHeading = Array.from(document.querySelectorAll("h2")).find((h) => h.textContent === "Games")!;
    expect(gamesHeading.compareDocumentPosition(shotsSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("own profile: Screenshots comes before Collections (and the sibling keys don't clash)", async () => {
    const consoleError = vi.spyOn(console, "error");
    localStorage.setItem("webgame.token", "tok");
    const client = new ApiClient({ baseUrl: "http://api.test" });
    vi.spyOn(client, "me").mockResolvedValue(ana);
    vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
    vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 0, latestAt: null, pollAfterSecs: 60 });
    vi.spyOn(client, "listUserAchievements").mockResolvedValue([]);
    vi.spyOn(client, "getUser").mockResolvedValue({ user: ana, games: [], gamesTotal: 0, followers: 0, following: 0, isFollowing: false });
    vi.spyOn(client, "listUserCollections").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 6 });
    vi.spyOn(client, "listUserScreenshots").mockResolvedValue(page([]));
    render(
      <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
        <MemoryRouter initialEntries={["/u/ana"]}>
          <Routes>
            <Route path="/u/:username" element={<ProfilePage />} />
          </Routes>
        </MemoryRouter>
      </WebGameProviders>,
    );
    await screen.findByRole("heading", { name: "No screenshots yet" });
    await screen.findByRole("heading", { name: "Collections" });
    const titles = Array.from(document.querySelectorAll("h2.pf-section-title")).map((h) => h.textContent);
    expect(titles).toEqual(["Games", "Screenshots", "Collections"]);
    expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/same key/);
  });
});

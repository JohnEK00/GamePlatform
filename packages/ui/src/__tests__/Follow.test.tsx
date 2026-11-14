import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { FollowResponse, User } from "../api/types";
import { FollowButton } from "../components/Follow";
import { ProfilePage } from "../pages/ProfilePage";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

function LoginProbe() {
  const loc = useLocation();
  return <p data-testid="login">{loc.pathname + loc.search}</p>;
}

async function setup(
  children: ReactNode,
  { loggedIn = true, path = "/u/sam", before }: { loggedIn?: boolean; path?: string; before?: (c: ApiClient) => void } = {},
) {
  if (loggedIn) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  before?.(client);
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route path="*" element={children} />
        </Routes>
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (loggedIn) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  return { ...utils, client };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FollowButton", () => {
  it("toggles optimistically, then shows the confirmed state", async () => {
    const { client } = await setup(<FollowButton username="sam" displayName="Sam" isFollowing={false} followers={3} />);
    const d = deferred<FollowResponse>();
    const spy = vi.spyOn(client, "setFollowing").mockReturnValue(d.promise);
    const btn = screen.getByRole("button", { name: "Follow Sam" });
    expect(btn.className).toContain("pf-btn--primary");
    fireEvent.click(btn);
    expect(spy).toHaveBeenCalledWith("sam", true);
    // Optimistic: already "Following" (focus/hover turns the label into "Unfollow").
    expect(btn.getAttribute("data-following")).toBe("true");
    expect(btn.className).toContain("pf-btn--ghost");
    fireEvent.mouseLeave(btn);
    fireEvent.blur(btn);
    expect(btn.textContent).toContain("Following");
    fireEvent.mouseEnter(btn);
    expect(btn.textContent).toContain("Unfollow");
    await act(async () => d.resolve({ following: true, followers: 4 }));
    expect(btn.getAttribute("data-following")).toBe("true");
    expect(btn.getAttribute("aria-busy")).toBeNull();
  });

  it("calls onChange with the server response", async () => {
    const onChange = vi.fn();
    const { client } = await setup(<FollowButton username="sam" isFollowing={true} followers={4} onChange={onChange} />);
    vi.spyOn(client, "setFollowing").mockResolvedValue({ following: false, followers: 3 });
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ following: false, followers: 3 }));
    expect(screen.getByRole("button").getAttribute("data-following")).toBe("false");
  });

  it("reverts and toasts on error; 429 shows the retry hint", async () => {
    const { client } = await setup(<FollowButton username="sam" isFollowing={false} />);
    const spy = vi.spyOn(client, "setFollowing").mockRejectedValueOnce(new ApiError("internal", "Boom", 500));
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(btn.getAttribute("data-following")).toBe("true");
    await waitFor(() => expect(btn.getAttribute("data-following")).toBe("false"));
    expect(await screen.findByText("Couldn't follow")).toBeTruthy();
    expect(screen.getByText("Boom")).toBeTruthy();

    spy.mockRejectedValueOnce(new ApiError("rate_limited", "Slow down", 429, 12));
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("data-following")).toBe("false"));
    expect(await screen.findByText("Slow down — try again in 12s")).toBeTruthy();
  });

  it("sends anonymous viewers to the login page with ?next", async () => {
    const { client } = await setup(<FollowButton username="sam" isFollowing={false} />, { loggedIn: false, path: "/games/g1?x=1" });
    const spy = vi.spyOn(client, "setFollowing");
    fireEvent.click(screen.getByRole("button", { name: /Follow/ }));
    expect(screen.getByTestId("login").textContent).toBe(`/login?next=${encodeURIComponent("/games/g1?x=1")}`);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is hidden when the viewer is that user (case-insensitive)", async () => {
    await setup(
      <div data-testid="wrap">
        <FollowButton username="BOB" isFollowing={false} />
      </div>,
    );
    expect(screen.getByTestId("wrap").innerHTML).toBe("");
  });

  it("keeps two buttons for the same user in sync via the provider", async () => {
    const { client } = await setup(
      <>
        <FollowButton username="sam" displayName="Sam A" isFollowing={false} />
        <FollowButton username="SAM" displayName="Sam B" isFollowing={false} variant="compact" />
        <FollowButton username="kim" displayName="Kim" isFollowing={false} />
      </>,
    );
    vi.spyOn(client, "setFollowing").mockResolvedValue({ following: true, followers: 1 });
    const a = screen.getByRole("button", { name: /Sam A/ });
    const b = screen.getByRole("button", { name: /Sam B/ });
    const k = screen.getByRole("button", { name: /Kim/ });
    fireEvent.click(a);
    expect(b.getAttribute("data-following")).toBe("true");
    await waitFor(() => expect(client.setFollowing).toHaveBeenCalledTimes(1));
    expect(a.getAttribute("data-following")).toBe("true");
    expect(b.getAttribute("data-following")).toBe("true");
    expect(k.getAttribute("data-following")).toBe("false");
    expect(b.className).toContain("pf-follow--compact");
  });

  it("ProfilePage shows follower counts, links to the lists and updates the count on follow", async () => {
    const sam = { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" as const };
    const { client } = await setup(
      <Routes>
        <Route path="/u/:username" element={<ProfilePage />} />
      </Routes>,
      {
        before: (c) => {
          vi.spyOn(c, "getUser").mockResolvedValue({ user: sam, games: [], gamesTotal: 0, followers: 128, following: 12, isFollowing: false });
          vi.spyOn(c, "listUserAchievements").mockResolvedValue([]);
        },
      },
    );
    expect(await screen.findByRole("heading", { name: "Sam" })).toBeTruthy();
    const followers = screen.getByRole("link", { name: "128 followers" });
    expect(followers.getAttribute("href")).toBe("/u/sam/followers");
    expect(screen.getByRole("link", { name: "12 following" }).getAttribute("href")).toBe("/u/sam/following");
    vi.spyOn(client, "setFollowing").mockResolvedValue({ following: true, followers: 129 });
    fireEvent.click(screen.getByRole("button", { name: "Follow Sam" }));
    expect(await screen.findByRole("link", { name: "129 followers" })).toBeTruthy();
    expect(client.setFollowing).toHaveBeenCalledWith("sam", true);
  });
});

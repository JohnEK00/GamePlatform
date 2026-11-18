import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Page, UserScreenshot } from "../api/types";
import { ProfileScreenshots } from "../components/ProfileScreenshots";
import { WebGameProviders } from "../WebGameApp";

function shot(i: number): UserScreenshot {
  return {
    id: `p${i}`,
    gameId: `g${i}`,
    author: { id: "u1", username: "mia", displayName: "Mia", avatarUrl: null },
    caption: "",
    imageUrl: `/media/screenshots/p${i}.png`,
    thumbUrl: `/media/screenshots/p${i}_t.jpg`,
    width: 1280,
    height: 720,
    gameVersion: 1,
    createdAt: "2026-11-14T15:30:12Z",
    canDelete: false,
    game: { id: `g${i}`, title: `Game ${i}` },
  };
}

const page = (n: number, total: number, perPage: number): Page<UserScreenshot> => ({
  items: Array.from({ length: n }, (_, i) => shot(i + 1)),
  total,
  page: 1,
  perPage,
});

async function setup(list: Page<UserScreenshot>, preview?: number) {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockRejectedValue(new ApiError("unauthorized", "no", 401));
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  const spy = vi.spyOn(client, "listUserScreenshots").mockResolvedValue(list);
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <ProfileScreenshots username="mia" isMe={false} preview={preview} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await waitFor(() => expect(spy).toHaveBeenCalled());
  await act(async () => {});
  return { spy };
}

afterEach(() => vi.restoreAllMocks());

describe("ProfileScreenshots preview (F028 § 0.9)", () => {
  it("preview={4}: perPage 4, no Load more, 'See all 9 screenshots →' to the Screenshots section", async () => {
    const { spy } = await setup(page(4, 9, 4), 4);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("mia", { page: 1, perPage: 4 });
    const region = await screen.findByRole("region", { name: /^Screenshots/ });
    expect(within(region).getAllByRole("button", { name: /^Screenshot of / })).toHaveLength(4);
    expect(within(region).queryByRole("button", { name: /Load more/ })).toBeNull();
    const link = within(region).getByRole("link", { name: "See all 9 screenshots →" });
    expect(link.getAttribute("href")).toBe("/u/mia/screenshots");
    expect(link.className).toBe("pf-shelf__more");
    expect(link.closest(".pf-shelf__head")).not.toBeNull();
  });

  it("preview with everything shown: no See all link", async () => {
    await setup(page(3, 3, 4), 4);
    const region = await screen.findByRole("region", { name: /^Screenshots/ });
    expect(within(region).queryByRole("link", { name: /See all/ })).toBeNull();
  });

  it("without preview: the full gallery (perPage 12, Load more, no See all)", async () => {
    const { spy } = await setup(page(12, 20, 12));
    expect(spy).toHaveBeenCalledWith("mia", { page: 1, perPage: 12 });
    const region = await screen.findByRole("region", { name: /^Screenshots/ });
    expect(within(region).getByRole("button", { name: /Load more/ })).toBeTruthy();
    expect(within(region).queryByRole("link", { name: /See all/ })).toBeNull();
  });
});

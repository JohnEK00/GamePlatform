import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { MuteState } from "../api/types";
import { useNotifications } from "../context/notifications";
import { MuteGameButton } from "../components/MuteGameButton";
import { WebGameProviders } from "../WebGameApp";
import { me } from "./notifFixtures";

function Bell() {
  const n = useNotifications();
  return <output data-testid="unread">{n.unread}</output>;
}

async function setup(opts: { muted?: boolean; signedIn?: boolean; countStatus?: number; mute?: () => Promise<MuteState>; unmute?: () => Promise<MuteState> } = {}) {
  if (opts.signedIn !== false) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockImplementation(async () => {
    if (opts.countStatus === 404) throw new ApiError("not_found", "nope", 404);
    return { unread: 9, latestAt: "2026-11-15T11:00:00.000Z", pollAfterSecs: 60 };
  });
  const mute = vi.spyOn(client, "muteGame").mockImplementation(opts.mute ?? (async () => ({ muted: true, unread: 4 })));
  const unmute = vi.spyOn(client, "unmuteGame").mockImplementation(opts.unmute ?? (async () => ({ muted: false, unread: 4 })));
  const props = "muted" in opts ? { muted: opts.muted } : { muted: false };
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <MuteGameButton gameId="g1" gameTitle="Space Dodge" {...props} />
        <Bell />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  await act(async () => {});
  return { mute, unmute };
}

const muteBtn = () => screen.queryByRole("button", { name: /Mute notifications|Notifications muted/ }) as HTMLButtonElement | null;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MuteGameButton", () => {
  it("is hidden when the server omits notificationsMuted", async () => {
    await setup({ muted: undefined });
    expect(muteBtn()).toBeNull();
  });

  it("is hidden for anonymous viewers", async () => {
    await setup({ signedIn: false });
    expect(muteBtn()).toBeNull();
  });

  it("is hidden when the server has no notifications API", async () => {
    await setup({ countStatus: 404 });
    expect(muteBtn()).toBeNull();
  });

  it("mutes optimistically, adopts the unread count and offers Undo", async () => {
    let resolve!: (s: MuteState) => void;
    const { mute, unmute } = await setup({ mute: () => new Promise((r) => (resolve = r)) });
    const b = muteBtn()!;
    expect(b.textContent).toBe("Mute notifications");
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(b.title).toBe("Stop notifications about this game: comments, replies, hearts and pins");
    expect(screen.getByTestId("unread").textContent).toBe("9");
    fireEvent.click(b);
    expect(mute).toHaveBeenCalledWith("g1");
    expect(muteBtn()!.textContent).toBe("Notifications muted");
    expect(muteBtn()!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => resolve({ muted: true, unread: 4 }));
    expect(screen.getByTestId("unread").textContent).toBe("4");
    expect(await screen.findByText("Muted notifications for Space Dodge")).toBeTruthy();
    expect(muteBtn()!.title).toBe("Click to get notifications about this game again");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(unmute).toHaveBeenCalledWith("g1"));
    await waitFor(() => expect(muteBtn()!.getAttribute("aria-pressed")).toBe("false"));
    expect(await screen.findByText("You'll get notifications for Space Dodge again")).toBeTruthy();
  });

  it("unmutes from the muted state", async () => {
    const { unmute } = await setup({ muted: true });
    expect(muteBtn()!.textContent).toBe("Notifications muted");
    fireEvent.click(muteBtn()!);
    expect(unmute).toHaveBeenCalledWith("g1");
    expect(await screen.findByText("You'll get notifications for Space Dodge again")).toBeTruthy();
    expect(muteBtn()!.getAttribute("aria-pressed")).toBe("false");
  });

  it("reverts on error and shows the server message (cap)", async () => {
    await setup({
      mute: async () => Promise.reject(new ApiError("validation", "You can mute at most 500 games and threads; unmute some in Settings", 422)),
    });
    fireEvent.click(muteBtn()!);
    expect(muteBtn()!.getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByText("You can mute at most 500 games and threads; unmute some in Settings")).toBeTruthy();
    expect(muteBtn()!.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("unread").textContent).toBe("9");
  });
});

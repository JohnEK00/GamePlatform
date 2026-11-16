import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Game, Screenshot, User } from "../api/types";
import { ScreenshotDialog, SCREENSHOTS_CHANGED_EVENT, type ScreenshotDialogGame } from "../components/ScreenshotDialog";
import type { ScreenshotItem } from "../components/useScreenshotCapture";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
const item: ScreenshotItem = { id: 1, blob: png, url: "blob:test/1", width: 1280, height: 720, capturedAt: new Date(2026, 10, 14, 15, 30, 12).getTime(), source: "game", caption: "New best: 12,340" };

async function setup({ loggedIn = true, mode = "player" as "player" | "studio", game = { id: "g1", title: "Space Dodge", published: true, isOwner: false } as ScreenshotDialogGame, saveFile }: { loggedIn?: boolean; mode?: "player" | "studio"; game?: ScreenshotDialogGame; saveFile?: (n: string, b: Blob) => Promise<boolean> } = {}) {
  if (loggedIn) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  const onClose = vi.fn();
  const onRemove = vi.fn();
  const onGameUpdated = vi.fn();
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser", platform: saveFile ? { saveFile } : undefined }} client={client}>
      <MemoryRouter>
        <ScreenshotDialog item={item} index={1} mode={mode} game={game} onClose={onClose} onRemove={onRemove} onGameUpdated={onGameUpdated} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  if (loggedIn) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  return { client, onClose, onRemove, onGameUpdated };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const shot: Screenshot = {
  id: "s1",
  gameId: "g1",
  author: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null },
  caption: "x",
  imageUrl: "/media/screenshots/s1.png",
  thumbUrl: "/media/screenshots/s1_t.jpg",
  width: 1280,
  height: 720,
  gameVersion: 3,
  createdAt: "2026-11-14T15:30:12Z",
  canDelete: true,
};

describe("ScreenshotDialog (F005)", () => {
  it("shows the image, dimensions and the game's caption", async () => {
    await setup();
    const img = screen.getByRole("img", { name: "New best: 12,340" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:test/1");
    expect(screen.getByText("1280×720")).toBeTruthy();
    expect((screen.getByLabelText(/Caption/) as HTMLInputElement).value).toBe("New best: 12,340");
    expect(screen.getByText("16/140")).toBeTruthy();
    expect(screen.getByText("Visible to everyone on the game page")).toBeTruthy();
  });

  it("hides Post and Set as thumbnail in the Studio", async () => {
    await setup({ mode: "studio", game: { title: "My game" } });
    expect(screen.queryByRole("button", { name: /Post to game page/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Set as thumbnail/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Download/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("disables Post when anonymous", async () => {
    await setup({ loggedIn: false });
    const btn = screen.getByRole("button", { name: /Post to game page/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText("Sign in to post")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Set as thumbnail/ })).toBeNull();
  });

  it("shows Post on an unpublished game only to the owner", async () => {
    await setup({ game: { id: "g1", title: "Draft", published: false, isOwner: false } });
    expect(screen.queryByRole("button", { name: /Post to game page/ })).toBeNull();
  });

  it("shows the publish hint to the owner of an unpublished game", async () => {
    await setup({ game: { id: "g1", title: "Draft", published: false, isOwner: true } });
    expect(screen.getByRole("button", { name: /Post to game page/ })).toBeTruthy();
    expect(screen.getByText("Visible after you publish")).toBeTruthy();
  });

  it("posts the image with the caption and notifies the gallery", async () => {
    const { client } = await setup();
    const postSpy = vi.spyOn(client, "postScreenshot").mockResolvedValue(shot);
    const changed = vi.fn();
    window.addEventListener(SCREENSHOTS_CHANGED_EVENT, changed);
    fireEvent.change(screen.getByLabelText(/Caption/), { target: { value: "Finally!" } });
    fireEvent.click(screen.getByRole("button", { name: /Post to game page/ }));
    await waitFor(() => expect(screen.getByText("Posted")).toBeTruthy());
    expect(postSpy).toHaveBeenCalledWith("g1", png, "Finally!");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
    window.removeEventListener(SCREENSHOTS_CHANGED_EVENT, changed);
  });

  it.each([
    [new ApiError("rate_limited", "slow", 429, 120), "You're posting too many screenshots, try again in 120s"],
    [new ApiError("validation", "You can post at most 20 screenshots per game", 422), "You've posted 20 screenshots for this game; delete one first"],
    [new ApiError("unavailable", "busy", 503), "The server is busy, try again in a few seconds"],
    [new ApiError("not_found", "game not found", 404), "This game is no longer available"],
  ])("maps post errors to messages (%#)", async (err, text) => {
    const { client } = await setup();
    vi.spyOn(client, "postScreenshot").mockRejectedValue(err);
    fireEvent.click(screen.getByRole("button", { name: /Post to game page/ }));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("sets the thumbnail after the confirm (owner)", async () => {
    const { client, onGameUpdated } = await setup({ game: { id: "g1", title: "Space Dodge", published: true, isOwner: true } });
    const updated = { id: "g1", title: "Space Dodge", thumbnailUrl: "/media/thumbnails/g1.png?v=2" } as Game;
    const put = vi.spyOn(client, "replaceThumbnail").mockResolvedValue(updated);
    fireEvent.click(screen.getByRole("button", { name: /Set as thumbnail/ }));
    expect(screen.getByText("Replace the thumbnail of Space Dodge?")).toBeTruthy();
    expect(put).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Replace thumbnail/ }));
    await waitFor(() => expect(onGameUpdated).toHaveBeenCalledWith(updated));
    // A small laundered PNG is uploaded as-is.
    expect(put).toHaveBeenCalledWith("g1", png);
  });

  it("downloads through platform.saveFile with the slug + local time name", async () => {
    const saveFile = vi.fn(async () => true);
    await setup({ saveFile });
    fireEvent.click(screen.getByRole("button", { name: /Download/ }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith("space-dodge-20261114-153012.png", png));
  });

  it("Remove removes and closes", async () => {
    const { onRemove, onClose } = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Screenshot, User } from "../api/types";
import { ScreenshotLightbox, type ScreenshotLightboxProps } from "../components/ScreenshotLightbox";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const alice = { id: "u2", username: "alice", displayName: "Alice", avatarUrl: null };

function shot(i: number, over: Partial<Screenshot> = {}): Screenshot {
  return {
    id: `s${i}`,
    gameId: "g 1",
    author: alice,
    caption: `Caption ${i}`,
    imageUrl: `/media/screenshots/s${i}.png`,
    thumbUrl: `/media/screenshots/s${i}_t.jpg`,
    width: 1280,
    height: 720,
    gameVersion: 2,
    createdAt: "2026-11-14T15:30:12Z",
    canDelete: false,
    ...over,
  };
}

type Extra = Partial<Pick<ScreenshotLightboxProps, "thumbnailGame" | "showGameLink" | "onDeleted">>;

function Harness({ items, extra }: { items: Screenshot[]; extra: Extra }) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(true);
  if (!open) return <p>closed</p>;
  return (
    <ScreenshotLightbox
      items={items}
      index={index}
      onIndex={setIndex}
      onClose={() => setOpen(false)}
      onDeleted={extra.onDeleted ?? (() => setOpen(false))}
      returnFocus={() => null}
      gameTitle={() => "Space Dodge"}
      thumbnailGame={extra.thumbnailGame}
      showGameLink={extra.showGameLink}
    />
  );
}

async function setup(items: Screenshot[], extra: Extra = {}, configure?: (c: ApiClient) => void) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  configure?.(client);
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <Harness items={items} extra={extra} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  return { client };
}

afterEach(() => vi.restoreAllMocks());

describe("ScreenshotLightbox (F015 § 2.4)", () => {
  it("thumbnailGame shows 🖼 Set as thumbnail; no View on game page by default", async () => {
    await setup([shot(1)], { thumbnailGame: { id: "g 1", title: "Space Dodge" } });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "🖼 Set as thumbnail" })).toBeTruthy();
    expect(within(dialog).queryByRole("link", { name: "View on game page" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "🖼 Set as thumbnail" }));
    expect(screen.getByText("Replace the thumbnail of Space Dodge?")).toBeTruthy();
  });

  it("without thumbnailGame there is no Set as thumbnail; showGameLink links the gallery before Open image", async () => {
    await setup([shot(1)], { showGameLink: true });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /Set as thumbnail/ })).toBeNull();
    const view = within(dialog).getByRole("link", { name: "View on game page" });
    expect(view.getAttribute("href")).toBe("/games/g%201?section=screenshots");
    expect(view.className).toContain("pf-btn--sm");
    const links = within(dialog).getAllByRole("link").map((l) => l.textContent);
    expect(links.indexOf("View on game page")).toBe(links.indexOf("Open image") - 1);
  });

  it("alt text uses gameTitle when there is no caption", async () => {
    await setup([shot(1, { caption: "" })]);
    expect(within(screen.getByRole("dialog")).getByRole("img").getAttribute("alt")).toBe("Screenshot of Space Dodge by Alice");
  });

  it("arrow keys and the ←/→ buttons move between screenshots and stop at the ends", async () => {
    await setup([shot(1), shot(2)]);
    const dialog = () => screen.getByRole("dialog");
    expect(within(dialog()).getByText("Caption 1")).toBeTruthy();
    fireEvent.keyDown(dialog(), { key: "ArrowLeft" });
    expect(within(dialog()).getByText("Caption 1")).toBeTruthy();
    fireEvent.keyDown(dialog(), { key: "ArrowRight" });
    expect(within(dialog()).getByText("Caption 2")).toBeTruthy();
    fireEvent.keyDown(dialog(), { key: "ArrowRight" });
    expect(within(dialog()).getByText("Caption 2")).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "Next screenshot" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Previous screenshot" }));
    expect(within(dialog()).getByText("Caption 1")).toBeTruthy();
  });

  it("delete asks with the new confirmation text, then calls deleteScreenshot and onDeleted", async () => {
    const onDeleted = vi.fn();
    let del!: ReturnType<typeof vi.spyOn>;
    await setup([shot(1, { canDelete: true })], { onDeleted }, (c) => {
      del = vi.spyOn(c, "deleteScreenshot").mockResolvedValue(undefined);
    });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("It is removed from the game page and everywhere else permanently.")).toBeTruthy();
    expect(screen.queryByText("It is removed from the game page permanently.")).toBeNull();
    const confirm = screen.getAllByRole("dialog").at(-1)!;
    await act(async () => fireEvent.click(within(confirm).getByRole("button", { name: "Delete" })));
    expect(del).toHaveBeenCalledWith("s1");
    expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });
});

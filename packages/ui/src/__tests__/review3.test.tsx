// Review 3 (2026-11-15) frontend fixes: L1 (focus / announcements), L2 (paging after a delete), L6 (64 px minimum).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Page, Screenshot, User } from "../api/types";
import { ScreenshotDialog } from "../components/ScreenshotDialog";
import { pagesForOffset, ScreenshotGallery } from "../components/ScreenshotGallery";
import { ScreenshotTray } from "../components/ScreenshotTray";
import type { ScreenshotItem } from "../components/useScreenshotCapture";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
const mkItem = (id: number, over: Partial<ScreenshotItem> = {}): ScreenshotItem => ({
  id,
  blob: png,
  url: `blob:test/${id}`,
  width: 1280,
  height: 720,
  capturedAt: new Date(2026, 10, 14, 15, 30, id).getTime(),
  source: "player",
  caption: "",
  ...over,
});

function shot(i: number, over: Partial<Screenshot> = {}): Screenshot {
  return {
    id: `s${i}`,
    gameId: "g1",
    author: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null },
    caption: `Caption ${i}`,
    imageUrl: `/media/screenshots/s${i}.png`,
    thumbUrl: `/media/screenshots/s${i}_t.jpg`,
    width: 1280,
    height: 720,
    gameVersion: 3,
    createdAt: "2026-11-14T15:30:12Z",
    canDelete: true,
    ...over,
  };
}

async function renderWith(client: ApiClient, ui: React.ReactNode) {
  localStorage.setItem("webgame.token", "tok");
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </WebGameProviders>,
  );
  await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  return utils;
}

function makeClient() {
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("L6: screenshots under 64 px can't be posted", () => {
  it("disables Post with an explanation", async () => {
    const client = makeClient();
    const post = vi.spyOn(client, "postScreenshot");
    await renderWith(
      client,
      <ScreenshotDialog item={mkItem(1, { width: 1920, height: 30 })} index={1} mode="player" game={{ id: "g1", title: "Space Dodge", published: true }} onClose={() => {}} onRemove={() => {}} />,
    );
    const btn = screen.getByRole("button", { name: /Post to game page/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText("Too small to post: each side must be at least 64 px")).toBeTruthy();
    fireEvent.click(btn);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("L1e: caption counter", () => {
  it("is not a live region; only the last 20 characters are announced", async () => {
    const client = makeClient();
    const { container } = await renderWith(
      client,
      <ScreenshotDialog item={mkItem(1)} index={1} mode="player" game={{ id: "g1", title: "Space Dodge", published: true }} onClose={() => {}} onRemove={() => {}} />,
    );
    const counter = screen.getByText("0/140");
    expect(counter.closest("[aria-live]")).toBeNull();
    const live = container.ownerDocument.querySelector(".pf-shot-dialog .pf-sr-only[aria-live='polite']")!;
    expect(live.textContent).toBe("");
    fireEvent.change(screen.getByLabelText(/Caption/), { target: { value: "x".repeat(100) } });
    expect(live.textContent).toBe("");
    fireEvent.change(screen.getByLabelText(/Caption/), { target: { value: "x".repeat(125) } });
    expect(live.textContent).toBe("15 characters left");
  });
});

function TrayHost({ initial }: { initial: ScreenshotItem[] }) {
  const cam = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState(initial);
  return (
    <>
      <button type="button" ref={cam}>
        Camera
      </button>
      <ScreenshotTray items={items} mode="studio" game={{ title: "T" }} onRemove={(id) => setItems((xs) => xs.filter((x) => x.id !== id))} onClear={() => setItems([])} emptyFocusRef={cam} />
    </>
  );
}

describe("L1c/d: tray focus and labels", () => {
  it("announces 'from game' in the item label", async () => {
    const client = makeClient();
    await renderWith(client, <TrayHost initial={[mkItem(2, { source: "game" }), mkItem(1)]} />);
    expect(screen.getByRole("button", { name: /^Screenshot 2, captured .*, from game$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Screenshot 1, captured [^,]*$/ })).toBeTruthy();
  });

  it("after Remove, focus moves to the next item, then to the camera button when the tray empties", async () => {
    const client = makeClient();
    await renderWith(client, <TrayHost initial={[mkItem(2), mkItem(1)]} />);
    const items = () => screen.queryAllByRole("button", { name: /^Screenshot \d+, captured / });
    items()[0].focus();
    fireEvent.click(items()[0]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect(items()).toHaveLength(1);
    expect(document.activeElement).toBe(items()[0]);
    fireEvent.click(items()[0]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    expect(items()).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Camera" }));
  });

  it("Clear all moves focus to the camera button", async () => {
    const client = makeClient();
    await renderWith(client, <TrayHost initial={[mkItem(1)]} />);
    const clear = screen.getByRole("button", { name: "Clear all" });
    clear.focus();
    fireEvent.click(clear);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Camera" }));
  });
});

const page = (items: Screenshot[], total: number, p = 1): Page<Screenshot> => ({ items, total, page: p, perPage: 12 });

describe("L2: gallery paging after a delete", () => {
  it("pagesForOffset", () => {
    expect(pagesForOffset(12, 24)).toEqual([2]);
    expect(pagesForOffset(11, 23)).toEqual([1, 2]);
    expect(pagesForOffset(11, 12)).toEqual([1]);
    expect(pagesForOffset(23, 40)).toEqual([2, 3]);
  });

  it("Load more after a delete shows the row that moved up (no skip)", async () => {
    // Server: 24 shots. Page 1 is loaded, then s3 is deleted: server rows are s1,s2,s4..s24 (23).
    const all = Array.from({ length: 24 }, (_, i) => shot(i + 1));
    let server = all;
    const client = makeClient();
    const list = vi.spyOn(client, "listScreenshots").mockImplementation(async (_g, q = {}) => {
      const p = q.page ?? 1;
      const n = q.perPage ?? 12;
      return page(server.slice((p - 1) * n, p * n), server.length, p);
    });
    vi.spyOn(client, "deleteScreenshot").mockImplementation(async (id) => {
      server = server.filter((s) => s.id !== id);
    });
    await renderWith(client, <ScreenshotGallery game={{ id: "g1", title: "Space Dodge", isOwner: true }} />);
    const grid = () => screen.queryAllByRole("button", { name: /^Screenshot: / });
    await waitFor(() => expect(grid()).toHaveLength(12));

    screen.getByRole("button", { name: "Screenshot: Caption 3" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Screenshot: Caption 3" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getAllByRole("dialog").at(-1)!).getByRole("button", { name: /Delete/ }));
    await waitFor(() => expect(grid()).toHaveLength(11));
    // L1c: focus lands on the item that took the deleted one's place. The delete resolves outside act(), so the
    // dialogs' effect cleanups (which restore focus) may run after the DOM update: wait for them (review 4, L8).
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Screenshot: Caption 4" })));

    list.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(grid()).toHaveLength(23));
    expect(list.mock.calls.map((c) => c[1])).toEqual([
      { page: 1, perPage: 12 },
      { page: 2, perPage: 12 },
    ]);
    const captions = grid().map((b) => b.getAttribute("aria-label"));
    expect(captions).toContain("Screenshot: Caption 13");
    expect(new Set(captions).size).toBe(23);
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("deleting the only item focuses the section heading", async () => {
    const client = makeClient();
    vi.spyOn(client, "listScreenshots").mockResolvedValue(page([shot(1)], 1));
    vi.spyOn(client, "deleteScreenshot").mockResolvedValue(undefined);
    await renderWith(client, <ScreenshotGallery game={{ id: "g1", title: "Space Dodge", isOwner: true }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Screenshot: Caption 1" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getAllByRole("dialog").at(-1)!).getByRole("button", { name: /Delete/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Focus is restored in the nested dialogs' effect cleanups, which may run after the DOM removal (review 4, L8).
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: /Screenshots/ })));
  });
});

describe("L1b: lightbox arrows at the ends", () => {
  it("stay focusable (aria-disabled) and the arrow keys keep working", async () => {
    const client = makeClient();
    vi.spyOn(client, "listScreenshots").mockResolvedValue(page([shot(1), shot(2)], 2));
    await renderWith(client, <ScreenshotGallery game={{ id: "g1", title: "Space Dodge" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Screenshot: Caption 1" }));
    const dialog = () => screen.getByRole("dialog");
    const next = within(dialog()).getByRole("button", { name: "Next screenshot" }) as HTMLButtonElement;
    const prev = within(dialog()).getByRole("button", { name: "Previous screenshot" }) as HTMLButtonElement;
    expect(prev.disabled).toBe(false);
    expect(prev.getAttribute("aria-disabled")).toBe("true");
    next.focus();
    fireEvent.click(next);
    expect(within(dialog()).getByText("Caption 2")).toBeTruthy();
    expect(next.getAttribute("aria-disabled")).toBe("true");
    // Clicking it at the end is a no-op, focus stays on it, and ArrowLeft still navigates.
    fireEvent.click(next);
    expect(within(dialog()).getByText("Caption 2")).toBeTruthy();
    expect(document.activeElement).toBe(next);
    fireEvent.keyDown(next, { key: "ArrowLeft" });
    expect(within(dialog()).getByText("Caption 1")).toBeTruthy();
  });
});

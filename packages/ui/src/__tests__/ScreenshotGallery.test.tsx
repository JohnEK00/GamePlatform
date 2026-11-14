import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { Page, Report, Screenshot, User } from "../api/types";
import { ScreenshotGallery } from "../components/ScreenshotGallery";
import { AdminPage } from "../pages/AdminPage";
import { WebGameProviders } from "../WebGameApp";

const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const alice = { id: "u2", username: "alice", displayName: "Alice", avatarUrl: null };

function shot(i: number, over: Partial<Screenshot> = {}): Screenshot {
  return {
    id: `s${i}`,
    gameId: "g1",
    author: alice,
    caption: `Caption ${i}`,
    imageUrl: `/media/screenshots/s${i}.png`,
    thumbUrl: `/media/screenshots/s${i}_t.jpg`,
    width: 1280,
    height: 720,
    gameVersion: 3,
    createdAt: "2026-11-14T15:30:12Z",
    canDelete: false,
    ...over,
  };
}
const page = (items: Screenshot[], total: number, p = 1): Page<Screenshot> => ({ items, total, page: p, perPage: 12 });

async function setup(
  list: (c: ApiClient) => void,
  { loggedIn = true, user = me, isOwner = false, children }: { loggedIn?: boolean; user?: User; isOwner?: boolean; children?: React.ReactNode } = {},
) {
  if (loggedIn) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(user);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  list(client);
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>{children ?? <ScreenshotGallery game={{ id: "g1", title: "Space Dodge", isOwner }} />}</MemoryRouter>
    </WebGameProviders>,
  );
  if (loggedIn) await waitFor(() => expect(client.me).toHaveBeenCalled());
  await act(async () => {});
  return { client };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ScreenshotGallery (F005)", () => {
  it("shows the empty state", async () => {
    await setup((c) => vi.spyOn(c, "listScreenshots").mockResolvedValue(page([], 0)));
    expect(await screen.findByText("No screenshots yet. Press 📷 while playing to capture one.")).toBeTruthy();
  });

  it("pages with Load more and shows the total", async () => {
    let spy!: ReturnType<typeof vi.spyOn>;
    await setup((c) => {
      spy = vi
        .spyOn(c, "listScreenshots")
        .mockResolvedValueOnce(page(Array.from({ length: 12 }, (_, i) => shot(i + 1)), 13))
        .mockResolvedValueOnce(page([shot(13)], 13, 2));
    });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Screenshot: / })).toHaveLength(12));
    expect(spy).toHaveBeenLastCalledWith("g1", { page: 1, perPage: 12 });
    expect(screen.getByRole("heading", { name: /Screenshots/ }).textContent).toContain("13");
    const thumb = screen.getAllByRole("button", { name: /^Screenshot: / })[0].querySelector("img")!;
    expect(thumb.getAttribute("src")).toBe("http://api.test/media/screenshots/s1_t.jpg");
    expect(thumb.getAttribute("loading")).toBe("lazy");
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Screenshot: / })).toHaveLength(13));
    expect(spy).toHaveBeenLastCalledWith("g1", { page: 2, perPage: 12 });
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  it("lightbox: caption as text, arrow keys, Report for others, no Delete without canDelete", async () => {
    await setup((c) => vi.spyOn(c, "listScreenshots").mockResolvedValue(page([shot(1, { caption: "<b>hi</b>" }), shot(2)], 2)));
    fireEvent.click(await screen.findByRole("button", { name: "Screenshot: <b>hi</b>" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("<b>hi</b>")).toBeTruthy();
    expect(within(dialog).getByText("v3")).toBeTruthy();
    expect((within(dialog).getByRole("img") as HTMLImageElement).getAttribute("src")).toBe("http://api.test/media/screenshots/s1.png");
    const open = within(dialog).getByRole("link", { name: "Open image" });
    expect(open.getAttribute("rel")).toBe("noopener");
    expect(within(dialog).getByRole("button", { name: /Report/ })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Set as thumbnail/ })).toBeNull();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(within(screen.getByRole("dialog")).getByText("Caption 2")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
    expect(within(screen.getByRole("dialog")).getByText("<b>hi</b>")).toBeTruthy();
    // Report opens the ReportDialog with the screenshot target.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Report/ }));
    expect(await screen.findByText(/Report screenshot/)).toBeTruthy();
  });

  it("delete is offered with canDelete and removes the item after the confirm", async () => {
    let del!: ReturnType<typeof vi.spyOn>;
    await setup(
      (c) => {
        vi.spyOn(c, "listScreenshots").mockResolvedValue(page([shot(1, { author: { ...me }, canDelete: true }), shot(2)], 2));
        del = vi.spyOn(c, "deleteScreenshot").mockResolvedValue(undefined);
      },
      { isOwner: true },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Screenshot: Caption 1" }));
    const dialog = screen.getByRole("dialog");
    // Own screenshot: no Report; owner: Set as thumbnail.
    expect(within(dialog).queryByRole("button", { name: /Report/ })).toBeNull();
    expect(within(dialog).getByRole("button", { name: /Set as thumbnail/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this screenshot?")).toBeTruthy();
    const confirm = screen.getAllByRole("dialog").at(-1)!;
    fireEvent.click(within(confirm).getByRole("button", { name: /Delete/ }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Screenshot: / })).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("anonymous visitors see no Report or Delete", async () => {
    await setup((c) => vi.spyOn(c, "listScreenshots").mockResolvedValue(page([shot(1)], 1)), { loggedIn: false });
    fireEvent.click(await screen.findByRole("button", { name: "Screenshot: Caption 1" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /Report/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Delete" })).toBeNull();
  });
});

describe("AdminPage screenshot reports (F005)", () => {
  const admin: User = { ...me, role: "admin" };
  const base: Report = {
    id: "r1",
    targetType: "screenshot",
    targetId: "s1",
    targetPreview: "Screenshot by Alice",
    targetGameId: "g1",
    reason: "offensive",
    details: "",
    reporter: alice,
    status: "open",
    resolution: null,
    createdAt: "2026-11-14T15:30:12Z",
    resolvedAt: null,
    targetImageUrl: "/media/screenshots/s1_t.jpg",
  };

  it("renders the thumbnail, the preview and Dismiss/Delete only", async () => {
    await setup((c) => vi.spyOn(c, "listReports").mockResolvedValue({ items: [base, { ...base, id: "r2", targetId: "s2", targetImageUrl: null }], total: 2, page: 1, perPage: 25 }), {
      user: admin,
      children: <AdminPage />,
    });
    const img = (await screen.findByRole("img", { name: /Reported screenshot/ })) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("http://api.test/media/screenshots/s1_t.jpg");
    const link = img.closest("a")!;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
    expect(screen.getAllByText("Screenshot by Alice")).toHaveLength(2);
    expect(screen.getByText("(deleted)")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    expect(screen.getByText("Delete this screenshot?")).toBeTruthy();
  });
});

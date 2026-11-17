// Review 4 (2026-11-15) frontend fixes: L6 (focus after Clear / Reset / Reset all / Load more, conflict warnings
// on the key buttons and announced), L8 (nested dialogs closing in one commit). L4/L5 are in NotificationBell.test.tsx,
// L7 in NotificationsProvider.test.tsx.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import type { ControlAction, ControlBindings, ControlOverrides, NotificationListQuery, NotificationPage } from "../api/types";
import { ControlsPanel } from "../components/ControlsPanel";
import { useModal } from "../components/useModal";
import { NotificationsPage } from "../pages/NotificationsPage";
import { WebGameProviders } from "../WebGameApp";
import { ava, me, mia, noah, notif } from "./notifFixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- L6: controls panel

const ACTIONS: ControlAction[] = [
  { id: "jump", name: "Jump", keys: ["Space", "ArrowUp"], gamepad: ["A"] },
  { id: "fire", name: "Fire", keys: ["KeyZ"], gamepad: [] },
];

function ControlsHarness({ initial = {} }: { initial?: ControlOverrides }) {
  const [b, setB] = useState<ControlBindings>({ keys: initial, gamepad: {} });
  return <ControlsPanel mode="player" title="Pixel Peaks" actions={ACTIONS} bindings={b} onChange={setB} onClose={() => {}} />;
}

const slot = (action: string, n: number) => screen.getByRole("button", { name: new RegExp(`^${action}, key ${n}: `) });
const live = () => document.querySelector(".pf-controls [aria-live='polite'][aria-atomic='true']")?.textContent ?? "";

describe("L6a: controls panel keeps focus", () => {
  it("Clear on the last filled slot moves focus to that slot's key button", () => {
    render(<ControlsHarness />);
    const clear = screen.getByRole("button", { name: "Clear Z from Fire" });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByRole("button", { name: /^Clear Z/ })).toBeNull();
    expect(document.activeElement).toBe(slot("Fire", 1));
    expect(slot("Fire", 1).getAttribute("aria-label")).toBe("Fire, key 1: none");
  });

  it("Clear on a slot that stays filled also lands on its key button", () => {
    render(<ControlsHarness />);
    const clear = screen.getByRole("button", { name: "Clear Space from Jump" });
    clear.focus();
    fireEvent.click(clear);
    expect(document.activeElement).toBe(slot("Jump", 1));
    expect(slot("Jump", 1).textContent).toBe("↑");
  });

  it("Reset moves focus to the row's first key button", () => {
    render(<ControlsHarness initial={{ jump: ["KeyW"] }} />);
    const reset = screen.getByRole("button", { name: "Reset Jump" });
    reset.focus();
    fireEvent.click(reset);
    expect(screen.queryByRole("button", { name: "Reset Jump" })).toBeNull();
    expect(document.activeElement).toBe(slot("Jump", 1));
  });

  it("Reset all moves focus to Done", () => {
    render(<ControlsHarness initial={{ jump: ["KeyW"], fire: [] }} />);
    const all = screen.getByRole("button", { name: "Reset all" });
    all.focus();
    fireEvent.click(all);
    expect(screen.queryByRole("button", { name: "Reset all" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));
  });
});

describe("L6b: conflict warnings reach the key buttons", () => {
  it("every key button of a conflicting row is described by the warning", () => {
    render(<ControlsHarness initial={{ fire: ["Space"] }} />);
    const warn = screen.getByText("Also used by Fire");
    for (const n of [1, 2, 3]) expect(slot("Jump", n).getAttribute("aria-describedby")).toBe(warn.id);
    const fireWarn = screen.getByText("Also used by Jump");
    expect(slot("Fire", 1).getAttribute("aria-describedby")).toBe(fireWarn.id);
  });

  it("no warning: no description (and capture mode keeps its own prompt)", () => {
    render(<ControlsHarness />);
    expect(slot("Jump", 1).hasAttribute("aria-describedby")).toBe(false);
    fireEvent.click(slot("Jump", 3));
    const ids = slot("Jump", 3).getAttribute("aria-describedby")!.split(" ");
    expect(ids).toHaveLength(1);
    expect(document.getElementById(ids[0])!.textContent).toBe("Press a key for Jump, or Escape to cancel");
  });

  it("a conflict created by an assignment is announced politely; a non-conflicting one is not", () => {
    render(<ControlsHarness />);
    expect(live()).toBe("");
    const s3 = slot("Jump", 3);
    fireEvent.click(s3);
    fireEvent.keyDown(s3, { code: "KeyK", key: "k" });
    expect(live()).toBe("");
    const s2 = slot("Fire", 2);
    fireEvent.click(s2);
    fireEvent.keyDown(s2, { code: "Space", key: " " });
    expect(live()).toBe("Space is also used by Jump");
    // While capturing, the slot is described by both its prompt and the (now present) warning.
    fireEvent.click(slot("Fire", 3));
    const ids = slot("Fire", 3).getAttribute("aria-describedby")!.split(" ");
    expect(ids).toHaveLength(2);
    expect(document.getElementById(ids[1])!.textContent).toBe("Also used by Jump");
  });
});

// ---------------------------------------------------------------- L6a: /notifications

async function setupPage(listImpl: (q: NotificationListQuery) => Promise<NotificationPage>) {
  localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "unreadNotificationCount").mockResolvedValue({ unread: 2, latestAt: "2026-11-15T11:00:00.000Z", pollAfterSecs: 60 });
  const list = vi.spyOn(client, "listNotifications").mockImplementation(async (q) => listImpl(q ?? {}));
  const mark = vi.spyOn(client, "markNotificationsRead").mockResolvedValue({ unread: 0 });
  render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter initialEntries={["/notifications"]}>
        <NotificationsPage />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await act(async () => {});
  return { list, mark };
}

const loadMoreBtn = () => screen.getByRole("button", { name: /Load more/ });

describe("L6a: /notifications Load more and Mark all keep focus", () => {
  it("busy Load more stays focusable (aria-disabled); the last page focuses the first new item", async () => {
    let release!: () => void;
    await setupPage((q) =>
      q.cursor === "p2"
        ? new Promise((res) => {
            release = () =>
              res({
                items: [
                  notif({ id: "3", actors: [ava], updatedAt: "2026-11-15T11:00:00.000Z" }), // moved up, not new
                  notif({ id: "1", actors: [mia], kind: "follow", game: null, updatedAt: "2026-11-15T08:00:00.000Z" }),
                ],
                nextCursor: null,
                unread: 2,
              });
          })
        : Promise.resolve({
            items: [notif({ id: "3", actors: [ava], updatedAt: "2026-11-15T10:00:00.000Z" }), notif({ id: "2", actors: [noah], updatedAt: "2026-11-15T09:00:00.000Z" })],
            nextCursor: "p2",
            unread: 2,
          }),
    );
    await waitFor(() => expect(document.querySelectorAll(".pf-notif")).toHaveLength(2));
    const btn = loadMoreBtn() as HTMLButtonElement;
    btn.focus();
    fireEvent.click(btn);
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(btn);
    await act(async () => release());
    await waitFor(() => expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: /Mia followed you/ })));
  });

  it("a last page with nothing new focuses the page heading", async () => {
    await setupPage(async (q) =>
      q.cursor === "p2"
        ? { items: [notif({ id: "2", actors: [noah] })], nextCursor: null, unread: 1 }
        : { items: [notif({ id: "2", actors: [noah] })], nextCursor: "p2", unread: 1 },
    );
    await waitFor(() => expect(document.querySelectorAll(".pf-notif")).toHaveLength(1));
    loadMoreBtn().focus();
    fireEvent.click(loadMoreBtn());
    await waitFor(() => expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Notifications" })));
  });

  it("a middle page keeps focus on Load more", async () => {
    await setupPage(async (q) =>
      q.cursor === "p2"
        ? { items: [notif({ id: "1", actors: [mia] })], nextCursor: "p3", unread: 1 }
        : { items: [notif({ id: "2", actors: [noah] })], nextCursor: "p2", unread: 1 },
    );
    await waitFor(() => expect(document.querySelectorAll(".pf-notif")).toHaveLength(1));
    loadMoreBtn().focus();
    fireEvent.click(loadMoreBtn());
    await waitFor(() => expect(document.querySelectorAll(".pf-notif")).toHaveLength(2));
    expect(document.activeElement).toBe(loadMoreBtn());
  });

  it("Mark all as read moves focus to the heading before the button unmounts", async () => {
    await setupPage(async () => ({ items: [notif({ id: "2", actors: [noah] })], nextCursor: null, unread: 1 }));
    const btn = await screen.findByRole("button", { name: /Mark all as read/ });
    btn.focus();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    await waitFor(() => expect(screen.queryByRole("button", { name: /Mark all as read/ })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Notifications" }));
  });
});

// ---------------------------------------------------------------- L8: nested dialogs

function Inner({ onClose }: { onClose: () => void }) {
  const ref = useModal<HTMLDivElement>(true, onClose);
  return (
    <div role="dialog" aria-modal="true" aria-label="Confirm" ref={ref}>
      <button type="button">Inner OK</button>
    </div>
  );
}

function Outer({ fallback, onClose }: { fallback: () => HTMLElement | null; onClose: () => void }) {
  const [inner, setInner] = useState(false);
  const ref = useModal<HTMLDivElement>(true, onClose, { returnFocus: fallback });
  return (
    <div role="dialog" aria-modal="true" aria-label="Lightbox" ref={ref}>
      <button type="button" onClick={() => setInner(true)}>
        Open inner
      </button>
      {inner && <Inner onClose={() => setInner(false)} />}
    </div>
  );
}

function NestedHost() {
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);
  return (
    <div>
      <h2 tabIndex={-1} id="fallback">
        Section
      </h2>
      {!gone && (
        <button type="button" onClick={() => setOpen(true)}>
          Opener
        </button>
      )}
      <button
        type="button"
        data-testid="close-both"
        onClick={() => {
          // Both dialogs and the opener go away in one commit (like deleting the only screenshot).
          setGone(true);
          setOpen(false);
        }}
      >
        close
      </button>
      {open && <Outer fallback={() => document.getElementById("fallback")} onClose={() => setOpen(false)} />}
    </div>
  );
}

describe("L8: nested dialogs closing together", () => {
  it("the outer dialog's fallback wins; the inner one does not move focus afterwards", async () => {
    render(<NestedHost />);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Lightbox" })).getByRole("button", { name: "Open inner" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    // Close from outside the dialogs' handlers (as an async result would).
    act(() => {
      (screen.getByTestId("close-both") as HTMLButtonElement).click();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Section" })));
  });

  it("closing only the inner dialog still returns focus to its opener inside the outer one", () => {
    render(<NestedHost />);
    fireEvent.click(screen.getByRole("button", { name: "Opener" }));
    const openInner = within(screen.getByRole("dialog", { name: "Lightbox" })).getByRole("button", { name: "Open inner" });
    openInner.focus();
    fireEvent.click(openInner);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inner OK" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Confirm" })).toBeNull();
    expect(document.activeElement).toBe(openInner);
  });
});

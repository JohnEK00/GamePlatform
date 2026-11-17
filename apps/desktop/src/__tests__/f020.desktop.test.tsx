/**
 * F020 (game comment settings) inside the desktop shell: the real `App` (HashRouter, the user-configured server,
 * the offline banner, the native-menu capture keydown listener) against a mocked server.
 *
 * - The ⚙ Settings dialog traps Tab and gives focus back to its button, with the shell's listeners installed.
 * - The edit page's Comments panel PUTs to the configured server, not to a default or relative URL.
 * - The slow-mode countdown is derived from a monotonic deadline: WebView2 throttles background timers (intensive
 *   throttling wakes chained timers about once a minute) and stops them while minimised, so the clock moves on
 *   while ticks are lost. Here `performance.now()` is driven by hand and `setTimeout` only fires when the test says.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
  isTauri: vi.fn(() => true),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke, isTauri: m.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({ listen: m.listen }));

import { App } from "../App";
import { SERVER_STORAGE_KEY } from "../server";

const SERVER = "http://192.168.1.5:8080";

type Settings = { mode: string; slowModeSecs: number; canManage: boolean; waitSecs: number };
type Call = { method: string; url: string; body: unknown };

const me = { id: "u1", username: "ana", displayName: "Ana", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

function game(isOwner: boolean) {
  return {
    id: "g1",
    title: "Pixel Peaks",
    description: "Jump!",
    tags: [],
    owner: isOwner ? { id: "u1", username: "ana", displayName: "Ana", avatarUrl: null } : { id: "u9", username: "zed", displayName: "Zed", avatarUrl: null },
    thumbnailUrl: null,
    plays: 0,
    ratingAvg: 0,
    ratingCount: 0,
    published: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-03-01T00:00:00Z",
    favorites: 0,
    playsWeek: 0,
    lastUpdatedAt: "2026-03-01T00:00:00Z",
    width: 320,
    height: 240,
    version: 4,
    entry: "main.js",
    playUrl: "/play/g1",
    myRating: null,
    isOwner,
    isFavorite: false,
    achievements: [],
    leaderboard: { order: "desc", format: "number", label: "" },
    commentSettings: { mode: "on", slowModeSecs: isOwner ? 0 : 300 },
  };
}

const thread = {
  id: "c1",
  gameId: "g1",
  author: { id: "u2", username: "alice", displayName: "Alice", avatarUrl: null },
  body: "first",
  createdAt: "2026-11-15T10:00:00Z",
  parentId: null,
  replyTo: null,
  isCreator: false,
  hearts: 0,
  myHeart: false,
  creatorHeart: false,
  canDelete: false,
  pinned: false,
  locked: false,
  canModerate: false,
  replies: [],
  replyCount: 0,
};

let calls: Call[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installServer(opts: { isOwner: boolean; settings: Settings }) {
  calls = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    const path = new URL(url).pathname;
    if (path === "/api/health") return json({ ok: true });
    if (path === "/api/auth/me") return json(me);
    if (path === "/api/games/g1" && method === "GET") return json(game(opts.isOwner));
    if (path === "/api/games/g1/comments" && method === "GET") {
      return json({ items: [thread], total: 1, totalAll: 1, page: 1, perPage: 20, pinned: null, settings: opts.settings });
    }
    if (path === "/api/games/g1/comment-settings" && method === "PUT") return json(body);
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await act(async () => {});
}

async function mount(hash: string) {
  window.location.hash = hash;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<App />));
  await flush();
}

async function waitFor<T>(get: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const v = get();
    if (v) return v;
    await flush(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function press(key: string, shiftKey = false) {
  const target = document.activeElement ?? document.body;
  const e = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  // useModal only prevents the default at the edges; emulate the browser's own Tab move otherwise.
  return e.defaultPrevented;
}

function noticeText(): string {
  const el = document.getElementById("pf-comment-body-notice");
  if (!el) return "";
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[aria-hidden=true]").forEach((x) => x.remove());
  return (copy.textContent ?? "").trim();
}

const submit = () => document.getElementById("pf-comment-body")!.closest("form")!.querySelector("button[type=submit]") as HTMLButtonElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem(SERVER_STORAGE_KEY, SERVER);
  localStorage.setItem("webgame.token", "tok");
  m.isTauri.mockReturnValue(true);
  // jsdom has no scrollTo (the router scrolls to top on navigation).
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.location.hash = "";
});

describe("F020 desktop: ⚙ Settings dialog focus", () => {
  it("moves focus in, traps Tab both ways, returns focus to the button on Escape; F11 still reaches Rust", async () => {
    installServer({ isOwner: true, settings: { mode: "on", slowModeSecs: 0, canManage: true, waitSecs: 0 } });
    await mount("#/games/g1");
    const btn = await waitFor(() => document.getElementById("comment-settings-btn") as HTMLButtonElement | null, "⚙ Settings");
    btn.focus();
    await act(async () => btn.click());
    const dialog = await waitFor(() => document.querySelector<HTMLElement>("[role=dialog][aria-modal=true]"), "dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Tab from the last control wraps to the first, Shift+Tab from the first wraps to the last.
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), select, input[type=radio]:checked"));
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    expect(press("Tab")).toBe(true);
    expect(document.activeElement).toBe(first);
    first.focus();
    expect(press("Tab", true)).toBe(true);
    expect(document.activeElement).toBe(last);

    // Focus that escapes to the shell (for example the offline banner or the page behind) is pulled back.
    await act(async () => btn.focus());
    expect(dialog.contains(document.activeElement)).toBe(true);

    // The shell's capture-phase F11 listener coexists with the trap.
    press("F11");
    expect(m.invoke).toHaveBeenCalledWith("toggle_fullscreen");
    expect(document.querySelector("[role=dialog]")).not.toBeNull();

    await act(async () => {
      press("Escape");
    });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("comment-settings-btn"));
    expect(window.location.hash).toBe("#/games/g1");
  });
});

describe("F020 desktop: edit page Comments panel", () => {
  it("saves with PUT to the configured server under the hash router", async () => {
    installServer({ isOwner: true, settings: { mode: "on", slowModeSecs: 0, canManage: true, waitSecs: 0 } });
    await mount("#/games/g1/edit");
    const panel = await waitFor(() => document.getElementById("comment-settings"), "Comments panel");
    const off = Array.from(panel.querySelectorAll<HTMLInputElement>("input[type=radio]")).find((r) => r.value === "off")!;
    await act(async () => off.click());
    const select = panel.querySelector("select")!;
    await act(async () => {
      select.value = "300";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const save = Array.from(panel.querySelectorAll("button")).find((b) => /Save comment settings/.test(b.textContent ?? ""))!;
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await flush();

    const put = calls.filter((c) => c.method === "PUT");
    expect(put).toEqual([{ method: "PUT", url: `${SERVER}/api/games/g1/comment-settings`, body: { mode: "off", slowModeSecs: 300 } }]);
    await waitFor(() => (document.body.textContent?.includes("Comment settings saved") ? true : null), "saved message");
    // Review 8 L3: Save is aria-disabled (never `disabled`) after saving, so focus isn't dropped.
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(window.location.hash).toBe("#/games/g1/edit");
  });
});

describe("F020 desktop: slow-mode countdown under WebView2 timer throttling", () => {
  let now = 0;

  async function mountSlow(waitSecs: number) {
    now = 1_000_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    installServer({ isOwner: false, settings: { mode: "on", slowModeSecs: 300, canManage: false, waitSecs } });
    await mount("#/games/g1");
    await waitFor(() => document.getElementById("pf-comment-body"), "comment form");
  }

  /** The window was hidden for `ms` and the throttled timer got no wakeup; then it gets exactly one. */
  async function hiddenFor(ms: number) {
    now += ms;
    await act(async () => {
      vi.advanceTimersToNextTimer();
    });
  }

  it("background: one wakeup a minute still shows the time left from the deadline", async () => {
    await mountSlow(300);
    expect(noticeText()).toBe("Slow mode: you can post once every 5 minutes. You can post again in 5:00.");
    expect(submit().getAttribute("aria-disabled")).toBe("true");

    await hiddenFor(60_000);
    expect(noticeText()).toContain("You can post again in 4:00.");
    await hiddenFor(61_500);
    expect(noticeText()).toContain("You can post again in 2:59.");
    await hiddenFor(170_000);
    expect(noticeText()).toContain("You can post again in 0:09.");
    expect(submit().getAttribute("aria-disabled")).toBe("true");
  });

  it("minimised past the deadline: the first wakeup after restore ends the wait and announces once", async () => {
    await mountSlow(300);
    await hiddenFor(20 * 60_000);
    expect(noticeText()).toBe("Slow mode: you can post once every 5 minutes.");
    expect(submit().hasAttribute("aria-disabled")).toBe(false);
    expect(document.body.textContent).toContain("You can post again.");
    // No timer left behind once the wait is over.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("minimised briefly: restore shows the remaining time, not the time when the window was hidden", async () => {
    await mountSlow(120);
    await hiddenFor(1_000);
    expect(noticeText()).toContain("You can post again in 1:59.");
    await hiddenFor(90_000);
    expect(noticeText()).toContain("You can post again in 0:29.");
    expect(submit().getAttribute("aria-disabled")).toBe("true");
  });
});

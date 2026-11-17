/**
 * F015 (screenshots in the feed and on profiles) inside the desktop shell: the real `App` (HashRouter, the
 * user-configured server) against a mocked server.
 *
 * - The feed's Screenshots tab asks the configured server for `kinds=screenshotPosted`.
 * - Thumbnails and the lightbox image are absolute URLs on the configured server that the desktop CSP `img-src`
 *   allows (a relative `/media/...` URL would resolve against the app origin and fail).
 * - "View on game page" and "+N more on the game page" are `#/games/{id}?section=screenshots` links that land on
 *   the game page and scroll (not focus) to the gallery.
 * - "Open image" is a `target="_blank"` link to the full image on the server: in Tauri that is a new-window
 *   request, which src-tauri/src/external.rs hands to the system browser (the main window is built in Rust with
 *   that handler, hence `create: false` in tauri.conf.json).
 * - The profile gallery renders with game links under the hash router.
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

import { FEED_TAB_KEY } from "@webgame/ui";
import { App } from "../App";
import { SERVER_STORAGE_KEY } from "../server";
import confRaw from "../../src-tauri/tauri.conf.json?raw";

const SERVER = "http://192.168.1.5:8080";
const conf = JSON.parse(confRaw) as { app: { windows: Array<Record<string, unknown>>; security: { csp: Record<string, string> } } };

/** CSP scheme / host source matching for the forms img-src uses. */
function imgAllowed(url: string): boolean {
  const u = new URL(url);
  return conf.app.security.csp["img-src"]
    .split(/\s+/)
    .filter(Boolean)
    .some((src) => {
      if (/^[a-z][a-z0-9+.-]*:$/i.test(src)) return u.protocol === src || (src === "http:" && u.protocol === "https:");
      if (src === "'self'") return false; // the app origin (tauri://localhost / http://tauri.localhost), not the server
      const m2 = /^(https?):\/\/([^/:]+)(?::(\d+|\*))?$/.exec(src);
      return !!m2 && `${m2[1]}:` === u.protocol && m2[2] === u.hostname && (m2[3] === "*" || (m2[3] ?? "") === u.port);
    });
}

const me = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const mia = { id: "u5", username: "mia", displayName: "Mia", avatarUrl: null };

const summary = {
  id: "g1",
  title: "Space Dodge",
  description: "",
  tags: [],
  owner: { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null },
  thumbnailUrl: null,
  plays: 0,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  favorites: 0,
  playsWeek: 0,
};

const fullGame = {
  ...summary,
  lastUpdatedAt: "2026-03-01T00:00:00Z",
  width: 320,
  height: 240,
  version: 1,
  entry: "main.js",
  playUrl: "/play/g1",
  myRating: null,
  isOwner: false,
  isFavorite: false,
  achievements: [],
  leaderboard: { order: "desc", format: "number", label: "" },
  commentSettings: { mode: "on", slowModeSecs: 0 },
};

const shot = (id: string) => ({
  id,
  gameId: "g1",
  author: mia,
  caption: "",
  imageUrl: `/media/screenshots/${id}.png`,
  thumbUrl: `/media/screenshots/${id}_t.jpg`,
  width: 1280,
  height: 720,
  gameVersion: 1,
  createdAt: "2026-11-14T15:30:12Z",
  canDelete: false,
});

const feedItem = {
  id: "41",
  kind: "screenshotPosted",
  actor: mia,
  game: summary,
  reason: "following",
  createdAt: "2026-11-14T15:30:12Z",
  version: null,
  score: null,
  achievement: null,
  collection: null,
  screenshots: { count: 6, items: [shot("s1"), shot("s2"), shot("s3"), shot("s4")] },
};

let urls: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let scrolled: Element[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installServer() {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      urls.push(url);
      const u = new URL(url);
      const path = u.pathname;
      if (path === "/api/health") return json({ ok: true });
      if (path === "/api/auth/me") return json(me);
      if (path === "/api/feed") return json({ items: [feedItem], nextCursor: null });
      if (path === "/api/feed/suggestions") return json([]);
      if (path === "/api/games/g1") return json(fullGame);
      if (path === "/api/games/g1/screenshots") return json({ items: [1, 2, 3, 4, 5, 6].map((i) => shot(`s${i}`)), total: 6, page: 1, perPage: 24 });
      if (path === "/api/users/mia") return json({ user: { ...mia, bio: "", createdAt: "2026-01-01T00:00:00Z" }, games: [], gamesTotal: 0, followers: 1, following: 0, isFollowing: true });
      if (path === "/api/users/mia/screenshots") {
        return json({ items: [{ ...shot("s1"), game: { id: "g1", title: "Space Dodge" } }], total: 1, page: 1, perPage: 12 });
      }
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    }),
  );
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

const byText = <T extends HTMLElement>(sel: string, text: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<T>(sel)).find((el) => (el.textContent ?? "").trim() === text) ?? null;

/** Clicks a router link the way a user does (react-router intercepts the click and updates the hash). */
async function follow(a: HTMLAnchorElement) {
  await act(async () => {
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush();
}

async function expectGalleryScroll() {
  expect(window.location.hash).toBe("#/games/g1?section=screenshots");
  const gallery = await waitFor(() => document.getElementById("screenshots"), "game page gallery");
  await waitFor(() => scrolled.includes(gallery), "scroll to the gallery");
  // Scroll only: focus is not moved into the gallery.
  expect(gallery.contains(document.activeElement)).toBe(false);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem(SERVER_STORAGE_KEY, SERVER);
  localStorage.setItem("webgame.token", "tok");
  m.isTauri.mockReturnValue(true);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  scrolled = [];
  // jsdom has no scrollIntoView; GamePage only calls it when it exists.
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  installServer();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  localStorage.clear();
  window.location.hash = "";
});

describe("F015 desktop: feed Screenshots tab", () => {
  it("loads kinds=screenshotPosted from the configured server; thumbnails pass img-src", async () => {
    await mount("#/feed");
    const tab = await waitFor(() => byText<HTMLElement>("[role=tab]", "Screenshots"), "Screenshots tab");
    await act(async () => tab.click());
    await flush();
    expect(localStorage.getItem(FEED_TAB_KEY)).toBe("screenshots");
    expect(window.location.hash).toBe("#/feed");
    const feedUrl = urls.map((u) => new URL(u)).find((u) => u.pathname === "/api/feed" && u.searchParams.get("kinds") === "screenshotPosted");
    expect(feedUrl?.origin).toBe(SERVER);

    const thumbs = await waitFor(() => {
      const l = document.querySelectorAll<HTMLImageElement>(".pf-feed-shots__item img");
      return l.length ? Array.from(l) : null;
    }, "thumbnails");
    expect(thumbs).toHaveLength(4);
    for (const img of thumbs) {
      expect(img.getAttribute("src")).toMatch(new RegExp(`^${SERVER.replace(/\./g, "\\.")}/media/screenshots/s\\d_t\\.jpg$`));
      expect(imgAllowed(img.src)).toBe(true);
    }
  });

  it("the stored tab survives a remount under the hash router", async () => {
    localStorage.setItem(FEED_TAB_KEY, "screenshots");
    await mount("#/feed");
    await waitFor(() => document.querySelector(".pf-feed-shots__item"), "thumbnails");
    expect(urls.some((u) => new URL(u).searchParams.get("kinds") === "screenshotPosted")).toBe(true);
  });

  it("+N more is a hash link to the game page and scrolls to the gallery", async () => {
    localStorage.setItem(FEED_TAB_KEY, "screenshots");
    await mount("#/feed");
    const more = await waitFor(() => byText<HTMLAnchorElement>("a", "+2 more on the game page"), "+2 more link");
    expect(more.getAttribute("href")).toBe("#/games/g1?section=screenshots");
    await follow(more);
    await expectGalleryScroll();
  });

  it("lightbox: full image passes img-src, Open image targets a new window, View on game page scrolls to the gallery", async () => {
    localStorage.setItem(FEED_TAB_KEY, "screenshots");
    await mount("#/feed");
    const first = await waitFor(() => document.querySelector<HTMLButtonElement>(".pf-feed-shots__item"), "thumbnail");
    await act(async () => first.click());
    const dialog = await waitFor(() => document.querySelector<HTMLElement>("[role=dialog]"), "lightbox");

    const full = dialog.querySelector<HTMLImageElement>(".pf-lightbox__figure img")!;
    expect(full.getAttribute("src")).toBe(`${SERVER}/media/screenshots/s1.png`);
    expect(imgAllowed(full.src)).toBe(true);

    const open = byText<HTMLAnchorElement>("a", "Open image", dialog)!;
    expect(open.getAttribute("href")).toBe(`${SERVER}/media/screenshots/s1.png`);
    expect(open.target).toBe("_blank");
    expect(open.rel).toContain("noopener");

    const view = byText<HTMLAnchorElement>("a", "View on game page", dialog)!;
    expect(view.getAttribute("href")).toBe("#/games/g1?section=screenshots");
    await follow(view);
    expect(document.querySelector(".pf-lightbox__figure")).toBeNull();
    await expectGalleryScroll();
  });
});

describe("F015 desktop: profile gallery", () => {
  it("renders the user's screenshots from the configured server with hash game links", async () => {
    await mount("#/u/mia");
    const img = await waitFor(() => document.querySelector<HTMLImageElement>(".pf-profile-shots__cell .pf-shots__item img"), "profile gallery");
    expect(img.getAttribute("src")).toBe(`${SERVER}/media/screenshots/s1_t.jpg`);
    expect(imgAllowed(img.src)).toBe(true);
    const shotsUrl = urls.find((u) => new URL(u).pathname === "/api/users/mia/screenshots");
    expect(shotsUrl && new URL(shotsUrl).origin).toBe(SERVER);

    const gameLink = document.querySelector<HTMLAnchorElement>(".pf-profile-shots__game")!;
    expect(gameLink.textContent).toBe("Space Dodge");
    expect(gameLink.getAttribute("href")).toBe("#/games/g1?section=screenshots");
    await follow(gameLink);
    await expectGalleryScroll();
  });
});

describe("F015 desktop: new-window links reach Rust's handler", () => {
  it("the main window is built in Rust (create: false) so on_new_window applies", () => {
    const main = conf.app.windows.find((w) => w.label === "main");
    expect(main?.create).toBe(false);
  });
});

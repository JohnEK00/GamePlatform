/**
 * F035 (Explore creators) inside the desktop shell: the real `App` (HashRouter, the user-configured server) against
 * a mocked server, signed in as `mia` (docs/features/F035-explore-creators.md, § 4 desktop-dev).
 *
 * - `#/creators` requests `GET {server}/api/creators?page=1&perPage=24`.
 * - A creator's banner is an absolute URL on the configured server that the desktop CSP `img-src` allows.
 * - The header's `Creators` link is the hash link `#/creators`.
 * - The `Recently active` tab requests `sort=active`.
 * - View → Creators (`app-menu` event `"creators"`) opens the page through the app's menu listener.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const m = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
  isTauri: vi.fn(() => true),
  menu: null as Handler | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke, isTauri: m.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, fn: Handler) => {
    if (event === "app-menu") m.menu = fn;
    return () => {
      if (m.menu === fn) m.menu = null;
    };
  }),
}));

import { App } from "../App";
import { SERVER_STORAGE_KEY } from "../server";
import confRaw from "../../src-tauri/tauri.conf.json?raw";

const SERVER = "http://192.168.1.5:8080";
const BANNER = "/media/banners/u1.jpg?v=2";
const conf = JSON.parse(confRaw) as { app: { security: { csp: Record<string, string> } } };

/** CSP scheme / host source matching for the forms img-src uses (as in f015/f028.desktop.test.tsx). */
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

const mia = {
  id: "u9",
  username: "mia",
  displayName: "Mia",
  avatarUrl: null,
  bannerUrl: null,
  bio: "",
  links: [],
  createdAt: "2026-01-01T00:00:00Z",
  role: "user",
};

const ava = {
  user: { id: "u1", username: "ava", displayName: "Ava", avatarUrl: null },
  bannerUrl: BANNER,
  bioExcerpt: "Pixel art and platformers.",
  games: 1,
  plays: 1200,
  followers: 45,
  isFollowing: false,
  firstPublishedAt: "2026-02-01T00:00:00.000Z",
  lastActiveAt: "2026-11-01T00:00:00.000Z",
};

const bo = {
  user: { id: "u2", username: "bo", displayName: "Bo", avatarUrl: null },
  bannerUrl: null,
  bioExcerpt: "",
  games: 2,
  plays: 3,
  followers: 1,
  isFollowing: true,
  firstPublishedAt: "2026-03-01T00:00:00.000Z",
  lastActiveAt: "2026-11-10T00:00:00.000Z",
};

let urls: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

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
      if (path === "/api/auth/me") return json(mia);
      if (path === "/api/creators") {
        const items = u.searchParams.get("sort") === "active" ? [bo, ava] : [ava, bo];
        return json({ items, total: 2, page: 1, perPage: 24 });
      }
      if (path === "/api/notifications/unread-count") return json({ unread: 0, latestAt: null, pollAfterSecs: 60 });
      if (path === "/api/games") return json({ items: [], total: 0, page: 1, perPage: 12 });
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

const creatorRequests = () => urls.filter((u) => new URL(u).pathname === "/api/creators");
const cards = () => Array.from(document.querySelectorAll<HTMLElement>(".pf-creators .pf-creator-card:not(.pf-creator-card--skeleton)"));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem(SERVER_STORAGE_KEY, SERVER);
  localStorage.setItem("webgame.token", "tok");
  m.isTauri.mockReturnValue(true);
  m.menu = null;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Element.prototype.scrollIntoView = function () {};
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

describe("F035 desktop: #/creators", () => {
  it("requests GET {server}/api/creators?page=1&perPage=24", async () => {
    await mount("#/creators");
    await waitFor(() => cards().length === 2, "creator cards");
    expect(creatorRequests()).toContain(`${SERVER}/api/creators?page=1&perPage=24`);
    expect(creatorRequests().every((u) => new URL(u).origin === SERVER)).toBe(true);
  });

  it("a creator's banner is loaded from the configured server and passes img-src", async () => {
    await mount("#/creators");
    await waitFor(() => cards().length === 2, "creator cards");
    const img = await waitFor(() => cards()[0].querySelector<HTMLImageElement>(".pf-creator-card__banner img"), "banner");
    expect(img.getAttribute("src")).toBe(`${SERVER}${BANNER}`);
    expect(imgAllowed(img.src)).toBe(true);
    // No banner: no <img> (the empty-banner gradient).
    expect(cards()[1].querySelector(".pf-creator-card__banner img")).toBeNull();
  });

  it("profile links on the cards are hash links", async () => {
    await mount("#/creators");
    await waitFor(() => cards().length === 2, "creator cards");
    const name = cards()[0].querySelector<HTMLAnchorElement>(".pf-creator-card__name a");
    expect(name?.getAttribute("href")).toBe("#/u/ava");
  });

  it("the header contains a Creators link with href #/creators", async () => {
    await mount("#/creators");
    const header = await waitFor(() => document.querySelector<HTMLElement>("header.pf-header"), "app header");
    const link = Array.from(header.querySelectorAll<HTMLAnchorElement>("a")).find((a) => (a.textContent ?? "").trim() === "Creators");
    expect(link?.getAttribute("href")).toBe("#/creators");
  });

  it("pressing the Recently active tab requests sort=active", async () => {
    await mount("#/creators");
    await waitFor(() => cards().length === 2, "creator cards");
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Sort creators"]')!;
    const tab = Array.from(nav.querySelectorAll<HTMLAnchorElement>("a")).find((a) => (a.textContent ?? "").trim() === "Recently active")!;
    expect(tab.getAttribute("href")).toBe("#/creators?sort=active");
    await act(async () => tab.click());
    await waitFor(() => creatorRequests().find((u) => new URL(u).searchParams.get("sort") === "active"), "sort=active request");
    const req = creatorRequests().find((u) => new URL(u).searchParams.get("sort") === "active")!;
    expect(new URL(req).origin).toBe(SERVER);
    expect(window.location.hash).toBe("#/creators?sort=active");
    await waitFor(() => cards()[0]?.querySelector(".pf-creator-card__name")?.textContent === "Bo", "re-sorted cards");
  });
});

describe("F035 desktop: View → Creators", () => {
  it("the menu event 'creators' opens #/creators and loads the page", async () => {
    await mount("#/");
    const menu = await waitFor(() => m.menu, "app-menu listener");
    await act(async () => menu({ payload: "creators" }));
    expect(window.location.hash).toBe("#/creators");
    await waitFor(() => cards().length === 2, "creator cards");
    expect(document.querySelector(".pf-creators h1")?.textContent).toBe("Creators");
  });
});

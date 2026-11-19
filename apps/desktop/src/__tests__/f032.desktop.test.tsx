/**
 * F032 (home and discover 2) inside the desktop shell: the real `App` (HashRouter, the user-configured server)
 * against a mocked server, signed in as `mia` (docs/features/F032-home-and-discover-2.md, § 4 desktop-dev).
 *
 * - `#/` requests the creator spotlight, `collections?perPage=3` and a `sort=updated&perPage=4` games shelf, all on
 *   the configured server.
 * - The spotlight creator's banner is an absolute URL on the configured server that the desktop CSP `img-src` allows.
 * - The legacy `#/?tag=arcade` ends at `#/browse?tag=arcade` and the browse grid requests `tag=arcade`.
 * - The header's `Browse` link is the hash link `#/browse`.
 * - View → Browse games / Home (`app-menu` events `"browse"` / `"home"`) open the pages through the app's menu listener.
 *
 * Tests that need the F032 UI (`BrowsePage` / `legacyHomeRedirect` in the built @webgame/ui) are skipped until that
 * build lands; they are written against the F032 spec, not the current UI. The menu-to-hash tests always run.
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

import * as ui from "@webgame/ui";
import { App } from "../App";
import { SERVER_STORAGE_KEY } from "../server";
import confRaw from "../../src-tauri/tauri.conf.json?raw";

/** True once the built @webgame/ui contains the F032 home sections, `/browse` and the legacy redirect. */
const exportsUi = ui as Record<string, unknown>;
const F032_UI = typeof exportsUi.BrowsePage === "function" || typeof exportsUi.legacyHomeRedirect === "function";

const SERVER = "http://192.168.1.5:8080";
const BANNER = "/media/banners/u1.jpg?v=2";
const conf = JSON.parse(confRaw) as { app: { security: { csp: Record<string, string> } } };

/** CSP scheme / host source matching for the forms img-src uses (as in f015/f028/f035.desktop.test.tsx). */
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

const avaRef = { id: "u1", username: "ava", displayName: "Ava", avatarUrl: null };

const ava = {
  user: avaRef,
  bannerUrl: BANNER,
  bioExcerpt: "Pixel art and platformers.",
  games: 1,
  plays: 1200,
  followers: 45,
  isFollowing: false,
  firstPublishedAt: "2026-02-01T00:00:00.000Z",
  lastActiveAt: "2026-11-01T00:00:00.000Z",
};

const game = {
  id: "g1",
  title: "Star Hop",
  description: "",
  tags: ["arcade"],
  owner: avaRef,
  thumbnailUrl: null,
  plays: 3,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  favorites: 0,
  playsWeek: 2,
  lastUpdatedAt: "2026-11-02T00:00:00Z",
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
      if (path === "/api/notifications/unread-count") return json({ unread: 0, latestAt: null, pollAfterSecs: 60 });
      if (path === "/api/games") {
        const perPage = Number(u.searchParams.get("perPage") ?? 24);
        return json({ items: [game], total: 1, page: 1, perPage });
      }
      if (path === "/api/creators/spotlight") return json({ day: "2026-11-19", creator: ava, games: [game] });
      if (path === "/api/collections") return json({ items: [], total: 0, page: 1, perPage: 3 });
      if (path === "/api/tags") return json([{ tag: "arcade", count: 1 }]);
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

const requests = (path: string) => urls.filter((u) => new URL(u).pathname === path);
const browseHeading = () => document.querySelector<HTMLElement>("#pf-browse-title");

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

describe("F032 desktop: View → Home / Browse games", () => {
  it("the menu event 'browse' sets #/browse, and 'home' sets #/", async () => {
    await mount("#/feed");
    const menu = await waitFor(() => m.menu, "app-menu listener");
    await act(async () => menu({ payload: "browse" }));
    expect(window.location.hash).toBe("#/browse");
    await act(async () => menu({ payload: "home" }));
    expect(window.location.hash).toBe("#/");
  });
});

describe.skipIf(!F032_UI)("F032 desktop: home and browse (needs the F032 @webgame/ui build)", () => {
  it("#/ requests the spotlight, collections?perPage=3 and a sort=updated&perPage=4 shelf from the server", async () => {
    await mount("#/");
    await waitFor(() => requests("/api/creators/spotlight").length > 0, "spotlight request");
    await waitFor(() => requests("/api/collections").length > 0, "collections request");
    expect(requests("/api/creators/spotlight")).toContain(`${SERVER}/api/creators/spotlight`);
    expect(requests("/api/collections")).toContain(`${SERVER}/api/collections?perPage=3`);
    const updated = await waitFor(
      () =>
        requests("/api/games").find((u) => {
          const p = new URL(u).searchParams;
          return p.get("sort") === "updated" && p.get("perPage") === "4";
        }),
      "sort=updated&perPage=4 request",
    );
    expect(new URL(updated).origin).toBe(SERVER);
    expect(urls.every((u) => new URL(u).origin === SERVER)).toBe(true);
  });

  it("the spotlight creator's banner is loaded from the configured server and passes img-src", async () => {
    await mount("#/");
    const img = await waitFor(
      () =>
        document.querySelector<HTMLImageElement>(
          'section[aria-labelledby="pf-home-spotlight-title"] .pf-creator-card__banner img',
        ),
      "spotlight banner",
    );
    expect(img.getAttribute("src")).toBe(`${SERVER}${BANNER}`);
    expect(imgAllowed(img.src)).toBe(true);
  });

  it("the legacy #/?tag=arcade ends at #/browse?tag=arcade and requests tag=arcade", async () => {
    await mount("#/?tag=arcade");
    await waitFor(() => window.location.hash === "#/browse?tag=arcade", "redirect to #/browse?tag=arcade");
    const req = await waitFor(
      () => requests("/api/games").find((u) => new URL(u).searchParams.get("tag") === "arcade"),
      "tag=arcade request",
    );
    expect(new URL(req).origin).toBe(SERVER);
    await waitFor(() => browseHeading(), "browse h1");
    expect(browseHeading()!.tagName).toBe("H1");
  });

  it("the header contains a Browse link with href #/browse", async () => {
    await mount("#/");
    const header = await waitFor(() => document.querySelector<HTMLElement>("header.pf-header"), "app header");
    const link = Array.from(header.querySelectorAll<HTMLAnchorElement>("a")).find(
      (a) => (a.textContent ?? "").trim() === "Browse",
    );
    expect(link?.getAttribute("href")).toBe("#/browse");
  });

  it("the menu event 'browse' opens #/browse and loads the page", async () => {
    await mount("#/");
    const menu = await waitFor(() => m.menu, "app-menu listener");
    await act(async () => menu({ payload: "browse" }));
    expect(window.location.hash).toBe("#/browse");
    const h1 = await waitFor(() => browseHeading(), "browse h1");
    expect(h1.textContent).toContain("Browse games");
    await waitFor(() => requests("/api/games").length > 0, "games request");
  });
});

/**
 * F028 (public profiles 2) inside the desktop shell: the real `App` (HashRouter, the user-configured server)
 * against a mocked server, signed in as `mia`.
 *
 * - The profile banner is an absolute URL on the configured server that the desktop CSP `img-src` allows.
 * - Profile links are `target="_blank"` with `noopener noreferrer`, so src-tauri/src/external.rs opens them in the
 *   system browser.
 * - Copy link writes `{server}/u/mia`, a link that works in any browser (not a `#/` app URL).
 * - View → My Profile (`app-menu` event `"profile"`) navigates to `#/me`, which the UI redirects to `#/u/mia`.
 * - The section strip's Games link is a hash link, `#/u/mia/games`.
 *
 * Tests that need the F028 UI (`MyProfileRedirect` and the profile shell in the built @webgame/ui) are skipped
 * until that build lands; they are written against docs/features/F028-public-profiles-2.md, not the current UI.
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

/** True once the built @webgame/ui contains the F028 profile shell and `/me` route. */
const F028_UI = typeof (ui as Record<string, unknown>).MyProfileRedirect === "function";

const SERVER = "http://192.168.1.5:8080";
const BANNER = "/media/banners/u1.jpg?v=2";
const conf = JSON.parse(confRaw) as { app: { security: { csp: Record<string, string> } } };

/** CSP scheme / host source matching for the forms img-src uses (as in f015.desktop.test.tsx). */
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
  id: "u1",
  username: "mia",
  displayName: "Mia",
  avatarUrl: null,
  bannerUrl: BANNER,
  bio: "",
  links: [{ label: "", url: "https://www.example.com/me" }],
  createdAt: "2026-01-01T00:00:00Z",
  role: "user",
};

let urls: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
const clipboardDesc = Object.getOwnPropertyDescriptor(navigator, "clipboard");

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
      const path = new URL(url).pathname;
      if (path === "/api/health") return json({ ok: true });
      if (path === "/api/auth/me") return json(mia);
      if (path === "/api/users/mia") {
        return json({
          user: mia,
          games: [],
          gamesTotal: 3,
          followers: 1,
          following: 0,
          isFollowing: false,
          stats: { plays: 10, achievements: 0, screenshots: 0, collections: 0 },
        });
      }
      if (path === "/api/users/mia/screenshots") return json({ items: [], total: 0, page: 1, perPage: 4 });
      if (path === "/api/users/mia/collections") return json({ items: [], total: 0, page: 1, perPage: 12 });
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

const byTextIncludes = <T extends HTMLElement>(sel: string, text: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<T>(sel)).find((el) => (el.textContent ?? "").includes(text)) ?? null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem(SERVER_STORAGE_KEY, SERVER);
  localStorage.setItem("webgame.token", "tok");
  m.isTauri.mockReturnValue(true);
  m.menu = null;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  // jsdom has no scrollIntoView; the section strip scrolls the active link into view.
  Element.prototype.scrollIntoView = function () {};
  writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
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
  if (clipboardDesc) Object.defineProperty(navigator, "clipboard", clipboardDesc);
  else delete (navigator as { clipboard?: unknown }).clipboard;
  localStorage.clear();
  window.location.hash = "";
});

describe("F028 desktop: CSP and native menu", () => {
  it("the desktop CSP img-src allows a banner on the configured server", () => {
    expect(imgAllowed(`${SERVER}${BANNER}`)).toBe(true);
  });

  it("View → My Profile sets the hash to #/me through the app's menu listener", async () => {
    await mount("#/feed");
    const menu = await waitFor(() => m.menu, "app-menu listener");
    // Synchronous effect of the menu event, before the router reacts.
    menu({ payload: "profile" });
    expect(window.location.hash).toBe("#/me");
    await flush();
    // Pre-F028 UI leaves #/me; the F028 UI then redirects to #/u/mia (asserted in the shell suite below).
    expect(["#/me", "#/u/mia"]).toContain(window.location.hash);
  });
});

describe.skipIf(!F028_UI)("F028 desktop: profile shell (needs the F028 @webgame/ui build)", () => {
  it("#/me (from the menu) redirects to #/u/mia", async () => {
    await mount("#/feed");
    const menu = await waitFor(() => m.menu, "app-menu listener");
    const seen: string[] = [];
    const onHash = () => seen.push(window.location.hash);
    window.addEventListener("hashchange", onHash);
    try {
      await act(async () => menu({ payload: "profile" }));
      expect(window.location.hash === "#/me" || seen.includes("#/me")).toBe(true);
      await waitFor(() => window.location.hash === "#/u/mia", "redirect to #/u/mia");
      await waitFor(() => document.querySelector(".pf-profile__banner"), "profile header");
    } finally {
      window.removeEventListener("hashchange", onHash);
    }
  });

  it("the banner is loaded from the configured server and passes img-src", async () => {
    await mount("#/u/mia");
    const img = await waitFor(() => document.querySelector<HTMLImageElement>(".pf-profile__banner img"), "banner");
    expect(img.getAttribute("src")).toBe(`${SERVER}${BANNER}`);
    expect(imgAllowed(img.src)).toBe(true);
    const profileUrl = urls.find((u) => new URL(u).pathname === "/api/users/mia");
    expect(profileUrl && new URL(profileUrl).origin).toBe(SERVER);
  });

  it("profile links open in a new window (system browser) without opener or referrer", async () => {
    await mount("#/u/mia");
    const link = await waitFor(() => document.querySelector<HTMLAnchorElement>(".pf-profile__links a"), "profile link");
    expect(link.textContent).toContain("example.com");
    expect(link.getAttribute("href")).toBe("https://www.example.com/me");
    expect(link.target).toBe("_blank");
    expect(link.rel.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  });

  it("Copy link writes the server's /u/mia URL, not a hash URL", async () => {
    await mount("#/u/mia");
    const button = await waitFor(() => byTextIncludes<HTMLButtonElement>("button", "Copy link"), "Copy link button");
    await act(async () => button.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith(`${SERVER}/u/mia`);
    await waitFor(() => byTextIncludes<HTMLButtonElement>("button", "Link copied"), "Link copied");
  });

  it("the section strip's Games link is #/u/mia/games", async () => {
    await mount("#/u/mia");
    const nav = await waitFor(() => document.querySelector<HTMLElement>("nav.pf-profile-tabs"), "section strip");
    expect(nav.getAttribute("aria-label")).toBe("Profile sections");
    const games = Array.from(nav.querySelectorAll<HTMLAnchorElement>("a")).find((a) => (a.textContent ?? "").trim().startsWith("Games"));
    expect(games?.getAttribute("href")).toBe("#/u/mia/games");
  });
});

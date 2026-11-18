/**
 * F030 (user posts) inside the desktop shell: the real `App` (HashRouter, the user-configured server) against a
 * mocked server, signed in as `mia`. Verification only; no desktop source changes (docs/features/F030-user-posts.md,
 * § 4 desktop-dev).
 *
 * - On the permalink `#/p/p1`, URLs in the post body are `target="_blank"` links with
 *   `rel="noopener noreferrer nofollow ugc"`, so src-tauri/src/external.rs opens them in the system browser; the
 *   trailing `.` stays plain text.
 * - The game attachment's thumbnail is an absolute URL on the configured server that the desktop CSP `img-src` allows.
 * - Copy link writes `{server}/p/p1`, a link that works in any browser (not a `#/` app URL).
 * - The profile's Posts section link reads `Posts 1` and is the hash link `#/u/mia/posts`.
 * - On your own `#/u/mia/posts`, the composer (a textarea labelled `Post text`) is shown.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke, isTauri: m.isTauri }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { App } from "../App";
import { SERVER_STORAGE_KEY } from "../server";
import confRaw from "../../src-tauri/tauri.conf.json?raw";

const SERVER = "http://192.168.1.5:8080";
const THUMB = "/media/thumbnails/g1.png?v=3";
const DEVLOG = "https://example.com/devlog";
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

const miaRef = { id: "u1", username: "mia", displayName: "Mia", avatarUrl: null };
const mia = {
  ...miaRef,
  bannerUrl: null,
  bio: "",
  links: [],
  createdAt: "2026-01-01T00:00:00Z",
  role: "user",
};

const game = {
  id: "g1",
  title: "Star Hop",
  description: "",
  tags: [],
  owner: miaRef,
  thumbnailUrl: THUMB,
  plays: 3,
  ratingAvg: 0,
  ratingCount: 0,
  published: true,
  createdAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  favorites: 0,
  playsWeek: 0,
  lastUpdatedAt: null,
};

const post = {
  id: "p1",
  author: miaRef,
  body: `New level! ${DEVLOG}.`,
  attachment: { type: "game", game, collection: null },
  createdAt: "2026-11-01T12:00:00.000Z",
  canDelete: true,
  path: "/p/p1",
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
      if (path === "/api/posts/p1") return json(post);
      if (path === "/api/users/mia") {
        return json({
          user: mia,
          games: [game],
          gamesTotal: 1,
          followers: 0,
          following: 0,
          isFollowing: false,
          stats: { plays: 3, achievements: 0, screenshots: 0, collections: 0, posts: 1 },
        });
      }
      if (path === "/api/users/mia/posts") return json({ items: [post], total: 1, page: 1, perPage: 20 });
      if (path === "/api/users/mia/screenshots") return json({ items: [], total: 0, page: 1, perPage: 4 });
      if (path === "/api/users/mia/collections") return json({ items: [], total: 0, page: 1, perPage: 12 });
      if (path === "/api/games") return json({ items: [game], total: 1, page: 1, perPage: 12 });
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

describe("F030 desktop: post permalink #/p/p1", () => {
  it("external URLs in the body are new-window links without opener or referrer; the trailing '.' is text", async () => {
    await mount("#/p/p1");
    const body = await waitFor(() => document.querySelector<HTMLElement>(".pf-post-page .pf-post__body"), "post body");
    const link = await waitFor(() => body.querySelector<HTMLAnchorElement>("a"), "body link");
    expect(link.getAttribute("href")).toBe(DEVLOG);
    expect((link.firstChild?.textContent ?? "").trim()).toBe(DEVLOG);
    expect(link.target).toBe("_blank");
    expect(link.rel.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer", "nofollow", "ugc"]));
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow ugc");
    // The trailing period is outside the link, as plain text.
    expect(link.nextSibling?.nodeName).toBe("SPAN");
    expect(link.nextSibling?.textContent).toBe(".");
    expect(body.querySelectorAll("a")).toHaveLength(1);
    const postUrl = urls.find((u) => new URL(u).pathname === "/api/posts/p1");
    expect(postUrl && new URL(postUrl).origin).toBe(SERVER);
  });

  it("the attachment thumbnail is absolute on the configured server and passes img-src", async () => {
    await mount("#/p/p1");
    const img = await waitFor(
      () => document.querySelector<HTMLImageElement>(".pf-post-page .pf-post-attachment img"),
      "attachment thumbnail",
    );
    const src = img.getAttribute("src") ?? "";
    expect(new URL(src).origin).toBe(SERVER);
    expect(src).toBe(`${SERVER}${THUMB}`);
    expect(imgAllowed(src)).toBe(true);
  });

  it("Copy link writes the server's /p/p1 URL, not a hash URL", async () => {
    await mount("#/p/p1");
    const button = await waitFor(() => byTextIncludes<HTMLButtonElement>("button", "Copy link"), "Copy link button");
    await act(async () => button.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith(`${SERVER}/p/p1`);
  });
});

describe("F030 desktop: profile Posts section", () => {
  it("the section strip's Posts link reads 'Posts 1' and is #/u/mia/posts", async () => {
    await mount("#/u/mia");
    const nav = await waitFor(() => document.querySelector<HTMLElement>("nav.pf-profile-tabs"), "section strip");
    const posts = await waitFor(
      () => Array.from(nav.querySelectorAll<HTMLAnchorElement>("a")).find((a) => (a.textContent ?? "").trim().startsWith("Posts")),
      "Posts link",
    );
    expect((posts.textContent ?? "").replace(/\s+/g, " ").trim()).toBe("Posts 1");
    expect(posts.getAttribute("href")).toBe("#/u/mia/posts");
  });

  it("the composer (textarea labelled 'Post text') shows on your own #/u/mia/posts", async () => {
    await mount("#/u/mia/posts");
    const label = await waitFor(
      () => Array.from(document.querySelectorAll<HTMLLabelElement>("label")).find((l) => l.textContent?.trim() === "Post text"),
      "Post text label",
    );
    const id = label.htmlFor;
    expect(id).toBeTruthy();
    const textarea = document.getElementById(id);
    expect(textarea?.tagName).toBe("TEXTAREA");
  });
});

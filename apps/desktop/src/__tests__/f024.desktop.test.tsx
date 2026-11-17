/**
 * F024 ("screenshot of your game" notifications) inside the desktop shell: the real `App` (HashRouter, the
 * user-configured server) against a mocked server, signed in as the creator `sam`.
 *
 * Verification only (docs/features/F024-screenshot-notifications.md § 4 desktop-dev); no desktop source changes.
 * - The notification's thumbnail is an absolute URL on the configured server that the desktop CSP `img-src` allows
 *   (a relative `/media/...` URL would resolve against the app origin and fail).
 * - The item links to `#/games/g1?section=screenshots` under the hash router.
 * - The OS notification is the in-app summary under `OS_NOTIFICATION_TITLE`, with no caption and no URL.
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

import { OS_NOTIFICATION_TITLE, osNotificationsFor, type Notification } from "@webgame/ui";
import { App } from "../App";
import { SERVER_STORAGE_KEY } from "../server";
import confRaw from "../../src-tauri/tauri.conf.json?raw";

const SERVER = "http://192.168.1.5:8080";
const THUMB = "/media/screenshots/s1_t.jpg";
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

const sam = { id: "u2", username: "sam", displayName: "Sam", avatarUrl: null, bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };
const mia = { id: "u5", username: "mia", displayName: "Mia", avatarUrl: null };

/** The API § F024 shape: no caption anywhere, `excerpt` null. */
const item: Notification = {
  id: "77",
  kind: "screenshotPosted",
  actors: [mia],
  actorCount: 1,
  eventCount: 1,
  game: { id: "g1", title: "Pixel Peaks", thumbnailUrl: null },
  commentId: null,
  excerpt: null,
  ownsThread: false,
  creatorHeart: false,
  read: false,
  createdAt: "2026-11-14T15:30:12.000Z",
  updatedAt: "2026-11-14T15:30:12.000Z",
  path: "/games/g1?section=screenshots",
  threadId: null,
  collection: null,
  screenshot: { id: "s1", thumbUrl: THUMB },
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
      const path = new URL(url).pathname;
      if (path === "/api/health") return json({ ok: true });
      if (path === "/api/auth/me") return json(sam);
      if (path === "/api/notifications") return json({ items: [item], nextCursor: null, unread: 1 });
      if (path === "/api/notifications/unread-count") return json({ unread: 1, latestAt: item.updatedAt, pollAfterSecs: 60 });
      if (path === "/api/notifications/read") return json({ unread: 0 });
      if (path === "/api/notifications/mutes") return json({ items: [], total: 0 });
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

const pageItem = () => document.querySelector<HTMLLIElement>('.pf-notif-list--page li.pf-notif[data-notif-id="77"]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem(SERVER_STORAGE_KEY, SERVER);
  localStorage.setItem("webgame.token", "tok");
  m.isTauri.mockReturnValue(true);
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

describe("F024 desktop: #/notifications screenshotPosted item", () => {
  it("lists notifications from the configured server", async () => {
    await mount("#/notifications");
    await waitFor(pageItem, "notification item");
    const listUrl = urls.find((u) => new URL(u).pathname === "/api/notifications");
    expect(listUrl && new URL(listUrl).origin).toBe(SERVER);
  });

  it("the thumbnail is absolute on the configured server and passes the CSP img-src", async () => {
    await mount("#/notifications");
    const li = await waitFor(pageItem, "notification item");
    const imgs = li.querySelectorAll<HTMLImageElement>("img.pf-notif__shot");
    expect(imgs).toHaveLength(1);
    const img = imgs[0];
    expect(img.getAttribute("src")).toBe(`${SERVER}${THUMB}`);
    expect(img.getAttribute("alt")).toBe("");
    expect(imgAllowed(img.src)).toBe(true);
    // The thumbnail is inside the item's single link.
    expect(img.closest("a.pf-notif__link")).not.toBeNull();
  });

  it("the link is #/games/g1?section=screenshots under the hash router", async () => {
    await mount("#/notifications");
    const li = await waitFor(pageItem, "notification item");
    const link = li.querySelector<HTMLAnchorElement>("a.pf-notif__link")!;
    expect(link.getAttribute("href")).toBe("#/games/g1?section=screenshots");
    expect(link.textContent).toContain("Mia posted a screenshot of Pixel Peaks");
    expect(li.querySelector(".pf-notif__excerpt")).toBeNull();
  });
});

describe("F024 desktop: OS notification text", () => {
  it("exactly one entry with the app title and the in-app summary, no caption and no URL", () => {
    const out = osNotificationsFor([item]);
    expect(out).toEqual([{ title: OS_NOTIFICATION_TITLE, body: "Mia posted a screenshot of Pixel Peaks" }]);
    expect(OS_NOTIFICATION_TITLE).toBe("Pixelforge Arcade");
    expect(out[0].body).not.toContain("/media/");
    expect(out[0].body).not.toContain("s1");
    expect(out[0].body).not.toContain("http");
  });

  it("the payload carries no caption field anywhere", () => {
    expect(JSON.stringify(item).toLowerCase()).not.toContain("caption");
    expect(item.excerpt).toBeNull();
  });
});

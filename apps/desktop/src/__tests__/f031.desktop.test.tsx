/**
 * F031 (post replies and hearts) inside the desktop shell: the real `App` (HashRouter, the user-configured server)
 * against a mocked server, signed in as `mia`. Verification only; no desktop source changes and no menu item
 * (docs/features/F031-post-replies-and-hearts.md, § 4 desktop-dev).
 *
 * - On `#/p/p1?reply=r1` (the `?reply=` deep link under the hash router): the heading reads `Replies (2)`,
 *   `#reply-r1` is highlighted and focused, its URL is a `target="_blank"` link without opener or referrer (so
 *   src-tauri/src/external.rs opens it in the system browser), and `r2` shows `Author` and `Replying to @leo`.
 * - `Turn off replies` is shown to the author and sends `PUT {server}/api/posts/p1/lock`.
 * - A `postReply` notification renders on `#/notifications` as the hash link `#/p/p1?reply=r1`.
 * - The OS notification text is the summary only, never the reply text.
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

import { OS_NOTIFICATION_TITLE, osNotificationsFor, type Notification } from "@webgame/ui";
import { App } from "../App";
import { SERVER_STORAGE_KEY } from "../server";

const SERVER = "http://192.168.1.5:8080";
const LINK = "https://example.com/x";
const R1_BODY = `Nice! ${LINK}`;

const miaRef = { id: "u1", username: "mia", displayName: "Mia", avatarUrl: null };
const leoRef = { id: "u2", username: "leo", displayName: "Leo", avatarUrl: null };
const mia = {
  ...miaRef,
  bannerUrl: null,
  bio: "",
  links: [],
  createdAt: "2026-01-01T00:00:00Z",
  role: "user",
};

const post = {
  id: "p1",
  author: miaRef,
  body: "World 3 is coming.",
  attachment: null,
  createdAt: "2026-11-01T12:00:00.000Z",
  canDelete: true,
  path: "/p/p1",
  hearts: 2,
  myHeart: false,
  replyCount: 2,
  locked: false,
};

const r1 = {
  id: "r1",
  postId: "p1",
  author: leoRef,
  replyTo: null,
  body: R1_BODY,
  createdAt: "2026-11-02T10:00:00.000Z",
  byPostAuthor: false,
  canDelete: true,
  path: "/p/p1?reply=r1",
};

const r2 = {
  id: "r2",
  postId: "p1",
  author: miaRef,
  replyTo: leoRef,
  body: "Thanks Leo!",
  createdAt: "2026-11-02T11:00:00.000Z",
  byPostAuthor: true,
  canDelete: true,
  path: "/p/p1?reply=r2",
};

/** API § F031: a postReply notification to the post's author. */
const item = {
  id: "91",
  kind: "postReply",
  actors: [leoRef],
  actorCount: 1,
  eventCount: 1,
  game: null,
  commentId: null,
  excerpt: R1_BODY,
  ownsThread: true,
  creatorHeart: false,
  read: false,
  createdAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
  path: "/p/p1?reply=r1",
  threadId: null,
  collection: null,
  screenshot: null,
  postId: "p1",
} as unknown as Notification;

type Call = { method: string; url: string };
let calls: Call[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installServer() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      calls.push({ method, url });
      const path = new URL(url).pathname;
      if (path === "/api/health") return json({ ok: true });
      if (path === "/api/auth/me") return json(mia);
      if (path === "/api/posts/p1") return json(post);
      if (path === "/api/posts/p1/replies" && method === "GET") return json({ items: [r1, r2], total: 2, page: 1, perPage: 200 });
      if (path === "/api/posts/p1/lock" && method === "PUT") return json({ ...post, locked: true });
      if (path === "/api/posts/p1/lock" && method === "DELETE") return json({ ...post, locked: false });
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

const byTextIncludes = <T extends HTMLElement>(sel: string, text: string, scope: ParentNode = document) =>
  Array.from(scope.querySelectorAll<T>(sel)).find((el) => (el.textContent ?? "").includes(text)) ?? null;

const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem(SERVER_STORAGE_KEY, SERVER);
  localStorage.setItem("webgame.token", "tok");
  m.isTauri.mockReturnValue(true);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  // jsdom has no scrollIntoView; the thread scrolls the deep-linked reply into view.
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

describe("F031 desktop: reply thread on #/p/p1?reply=r1", () => {
  it("loads the thread from the configured server; heading 'Replies (2)'", async () => {
    await mount("#/p/p1?reply=r1");
    const heading = await waitFor(() => document.getElementById("pf-post-replies-title"), "thread heading");
    await waitFor(() => document.getElementById("reply-r1"), "reply r1");
    expect(squash(heading.textContent)).toBe("Replies (2)");
    const list = calls.find((c) => c.method === "GET" && new URL(c.url).pathname === "/api/posts/p1/replies");
    expect(list && new URL(list.url).origin).toBe(SERVER);
  });

  it("#reply-r1 is highlighted and focused", async () => {
    await mount("#/p/p1?reply=r1");
    const el = await waitFor(() => document.getElementById("reply-r1"), "reply r1");
    await waitFor(() => document.activeElement === el, "focus on reply r1");
    expect(el.classList.contains("pf-post-reply--highlight")).toBe(true);
    expect(document.activeElement).toBe(el);
    expect(document.getElementById("reply-r2")?.classList.contains("pf-post-reply--highlight")).toBe(false);
  });

  it("the URL in r1 opens in a new window (system browser) without opener or referrer", async () => {
    await mount("#/p/p1?reply=r1");
    const el = await waitFor(() => document.getElementById("reply-r1"), "reply r1");
    const link = await waitFor(
      () => Array.from(el.querySelectorAll<HTMLAnchorElement>("a")).find((a) => a.getAttribute("href") === LINK),
      "reply body link",
    );
    expect(link.target).toBe("_blank");
    expect(link.rel.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
  });

  it("r2 shows the Author badge and 'Replying to @leo'", async () => {
    await mount("#/p/p1?reply=r1");
    const el = await waitFor(() => document.getElementById("reply-r2"), "reply r2");
    const badge = byTextIncludes<HTMLElement>(".pf-badge", "Author", el);
    expect(squash(badge?.textContent)).toBe("Author");
    expect(squash(el.querySelector(".pf-post-reply__replyto")?.textContent)).toBe("Replying to @leo");
    // r1 (by leo, answering the post) has neither.
    const r1El = document.getElementById("reply-r1")!;
    expect(byTextIncludes<HTMLElement>(".pf-badge", "Author", r1El)).toBeNull();
    expect(r1El.querySelector(".pf-post-reply__replyto")).toBeNull();
  });

  it("'Turn off replies' is shown to the author and sends PUT {server}/api/posts/p1/lock", async () => {
    await mount("#/p/p1?reply=r1");
    const button = await waitFor(() => byTextIncludes<HTMLButtonElement>("button", "Turn off replies"), "Turn off replies");
    await act(async () => button.click());
    await waitFor(() => calls.find((c) => c.method === "PUT" && new URL(c.url).pathname === "/api/posts/p1/lock"), "lock request");
    const put = calls.find((c) => c.method === "PUT" && new URL(c.url).pathname === "/api/posts/p1/lock")!;
    expect(put.url).toBe(`${SERVER}/api/posts/p1/lock`);
    await waitFor(() => byTextIncludes<HTMLButtonElement>("button", "Turn on replies"), "Turn on replies");
  });
});

describe("F031 desktop: postReply notification", () => {
  const pageItem = () => document.querySelector<HTMLLIElement>('.pf-notif-list--page li.pf-notif[data-notif-id="91"]');

  it("renders on #/notifications as the hash link #/p/p1?reply=r1", async () => {
    await mount("#/notifications");
    const li = await waitFor(pageItem, "notification item");
    const link = li.querySelector<HTMLAnchorElement>("a.pf-notif__link")!;
    expect(link.getAttribute("href")).toBe("#/p/p1?reply=r1");
    expect(link.textContent).toContain("Leo replied to your post");
  });

  it("the OS notification body is the summary only, without the reply text", () => {
    const out = osNotificationsFor([item]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ title: OS_NOTIFICATION_TITLE, body: "Leo replied to your post" });
    expect(out[0].body).not.toContain("Nice");
    expect(out[0].body).not.toContain("http");
  });
});

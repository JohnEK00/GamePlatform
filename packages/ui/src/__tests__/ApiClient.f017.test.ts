import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import {
  COMMENT_SORT_STORAGE_KEY,
  isF017CommentPage,
  normalizeComment,
  normalizeCommentListPage,
  readCommentSort,
  writeCommentSort,
} from "../api/comments";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeClient(make: () => Response = () => jsonResponse(200, {})) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => make());
  const client = new ApiClient({ baseUrl: "http://api.test", token: "tok", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", body: init?.body };
  };
  return { client, fetchMock, call };
}

const alice = { id: "u2", username: "alice", displayName: "Alice", avatarUrl: null };
const v1 = { id: "c1", gameId: "g1", author: alice, body: "hi", createdAt: "2026-11-15T10:00:00Z" };

describe("ApiClient F017 comment routes", () => {
  it("listComments sends sort only when given", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { items: [], total: 0, totalAll: 0, page: 1, perPage: 20, pinned: null }));
    await client.listComments("g1", { page: 1, perPage: 20, sort: "top" });
    await client.listComments("g1", { page: 2, perPage: 20, sort: "new" });
    await client.listComments("g1", { page: 1, perPage: 20 });
    await client.listComments("g1");
    expect(call(0)).toMatchObject({ url: "http://api.test/api/games/g1/comments?page=1&perPage=20&sort=top", method: "GET" });
    expect(call(1).url).toBe("http://api.test/api/games/g1/comments?page=2&perPage=20&sort=new");
    expect(call(2).url).toBe("http://api.test/api/games/g1/comments?page=1&perPage=20");
    expect(call(3).url).toBe("http://api.test/api/games/g1/comments");
  });

  it("pin, unpin, lock and unlock: PUT / DELETE without a body, returning ThreadState", async () => {
    const state = { id: "c/1", pinned: true, locked: false, unpinnedId: "c0" };
    const { client, call, fetchMock } = makeClient(() => jsonResponse(200, state));
    expect(await client.pinComment("c/1")).toEqual(state);
    await client.unpinComment("c/1");
    await client.lockComment("c/1");
    await client.unlockComment("c/1");
    expect(call(0)).toEqual({ url: "http://api.test/api/comments/c%2F1/pin", method: "PUT", body: undefined });
    expect(call(1)).toEqual({ url: "http://api.test/api/comments/c%2F1/pin", method: "DELETE", body: undefined });
    expect(call(2)).toEqual({ url: "http://api.test/api/comments/c%2F1/lock", method: "PUT", body: undefined });
    expect(call(3)).toEqual({ url: "http://api.test/api/comments/c%2F1/lock", method: "DELETE", body: undefined });
    for (const [, init] of fetchMock.mock.calls) expect(init!.headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("surfaces 403 / 422 / 429 as ApiError", async () => {
    const responses = [
      jsonResponse(403, { error: { code: "forbidden", message: "Only the game's owner can do that" } }),
      jsonResponse(422, { error: { code: "validation", message: "Only top-level comments can be pinned" } }),
      jsonResponse(429, { error: { code: "rate_limited", message: "Too many" } }, { "Retry-After": "30" }),
    ];
    const { client } = makeClient(() => responses.shift()!);
    await expect(client.pinComment("c1")).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(client.pinComment("r1")).rejects.toMatchObject({ status: 422, message: "Only top-level comments can be pinned" });
    const err = await client.lockComment("c1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, retryAfter: 30 });
  });
});

describe("F017 normalisation and sort storage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("missing pinned/locked/canModerate → false; values pass through", () => {
    expect(normalizeComment(v1)).toMatchObject({ pinned: false, locked: false, canModerate: false });
    expect(normalizeComment({ ...v1, pinned: true, locked: true, canModerate: true })).toMatchObject({ pinned: true, locked: true, canModerate: true });
  });

  it("page: missing pinned → null, a pinned thread is normalised; isF017CommentPage looks for the key", () => {
    const old = { items: [v1], total: 1, page: 1, perPage: 20 };
    expect(normalizeCommentListPage(old).pinned).toBeNull();
    expect(isF017CommentPage(old)).toBe(false);
    const f017 = { ...old, totalAll: 3, pinned: { ...v1, id: "p1", pinned: true } };
    const p = normalizeCommentListPage(f017);
    expect(p.pinned).toMatchObject({ id: "p1", pinned: true, locked: false, replies: [], replyCount: 0 });
    expect(isF017CommentPage(f017)).toBe(true);
    expect(isF017CommentPage({ ...old, pinned: null })).toBe(true);
    expect(isF017CommentPage(null)).toBe(false);
  });

  it("reads and writes the per-device sort; anything else (or a storage error) reads as new", () => {
    expect(readCommentSort()).toBe("new");
    writeCommentSort("top");
    expect(localStorage.getItem(COMMENT_SORT_STORAGE_KEY)).toBe("top");
    expect(readCommentSort()).toBe("top");
    localStorage.setItem(COMMENT_SORT_STORAGE_KEY, "hot");
    expect(readCommentSort()).toBe("new");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(readCommentSort()).toBe("new");
    expect(() => writeCommentSort("top")).not.toThrow();
  });
});

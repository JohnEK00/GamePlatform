import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { commentPermalink, normalizeComment, normalizeCommentListPage, normalizeThread } from "../api/comments";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(make: () => Response = () => jsonResponse(200, {})) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => make());
  const client = new ApiClient({ baseUrl: "http://api.test", token: "tok", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
  };
  return { client, fetchMock, call };
}

const alice = { id: "u2", username: "alice", displayName: "Alice", avatarUrl: null };

describe("ApiClient F006 comment routes", () => {
  it("listComments pages top-level comments", async () => {
    const page = { items: [], total: 0, totalAll: 0, page: 2, perPage: 20 };
    const { client, call } = makeClient(() => jsonResponse(200, page));
    expect(await client.listComments("g 1", { page: 2, perPage: 20 })).toEqual(page);
    expect(call(0)).toMatchObject({ url: "http://api.test/api/games/g%201/comments?page=2&perPage=20", method: "GET" });
  });

  it("postComment sends parentId only when given", async () => {
    const { client, call } = makeClient(() => jsonResponse(201, { id: "c1" }));
    await client.postComment("g1", "hello");
    await client.postComment("g1", "a reply", "c9");
    await client.postComment("g1", "top again", null);
    expect(call(0)).toEqual({ url: "http://api.test/api/games/g1/comments", method: "POST", body: { body: "hello" } });
    expect(call(1)).toEqual({ url: "http://api.test/api/games/g1/comments", method: "POST", body: { body: "a reply", parentId: "c9" } });
    expect(call(2).body).toEqual({ body: "top again" });
  });

  it("getComment and listReplies", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, {}));
    await client.getComment("c/1");
    await client.listReplies("c1", { page: 2, perPage: 50 });
    await client.listReplies("c1");
    expect(call(0)).toMatchObject({ url: "http://api.test/api/comments/c%2F1", method: "GET" });
    expect(call(1)).toMatchObject({ url: "http://api.test/api/comments/c1/replies?page=2&perPage=50", method: "GET" });
    expect(call(2).url).toBe("http://api.test/api/comments/c1/replies");
  });

  it("hearts: PUT and DELETE", async () => {
    const { client, call, fetchMock } = makeClient(() => jsonResponse(200, { hearted: true, hearts: 2, creatorHeart: false }));
    expect(await client.heartComment("c1")).toEqual({ hearted: true, hearts: 2, creatorHeart: false });
    await client.unheartComment("c1");
    await client.setCommentHeart("c1", true);
    await client.setCommentHeart("c1", false);
    expect(call(0)).toMatchObject({ url: "http://api.test/api/comments/c1/heart", method: "PUT", body: undefined });
    expect(call(1)).toMatchObject({ url: "http://api.test/api/comments/c1/heart", method: "DELETE" });
    expect(call(2).method).toBe("PUT");
    expect(call(3).method).toBe("DELETE");
    expect(fetchMock.mock.calls[0][1]!.headers).toMatchObject({ Authorization: "Bearer tok" });
  });
});

describe("F006 normalisation (older servers)", () => {
  const v1 = { id: "c1", gameId: "g1", author: alice, body: "hi", createdAt: "2026-11-15T10:00:00Z" };

  it("fills missing comment fields with defaults", () => {
    expect(normalizeComment(v1)).toEqual({
      ...v1,
      parentId: null,
      replyTo: null,
      isCreator: false,
      hearts: 0,
      myHeart: false,
      creatorHeart: false,
      canDelete: false,
    });
    expect(normalizeComment(v1, () => true).canDelete).toBe(true);
    expect(normalizeComment({ ...v1, canDelete: false }, () => true).canDelete).toBe(false);
  });

  it("threads and pages: replies ?? [], replyCount ?? 0, totalAll ?? total", () => {
    const t = normalizeThread(v1);
    expect(t.replies).toEqual([]);
    expect(t.replyCount).toBe(0);
    // replyCount never below the preview length
    expect(normalizeThread({ ...v1, replies: [{ ...v1, id: "r1", parentId: "c1" }] }).replyCount).toBe(1);
    const p = normalizeCommentListPage({ items: [v1], total: 7, page: 1, perPage: 20 });
    expect(p.totalAll).toBe(7);
    expect(normalizeCommentListPage({ items: [], total: 7, totalAll: 12, page: 1, perPage: 20 }).totalAll).toBe(12);
  });

  it("builds permalinks with a query (HashRouter-safe)", () => {
    expect(commentPermalink("g1", "c 1")).toBe("/games/g1?comment=c%201");
  });
});

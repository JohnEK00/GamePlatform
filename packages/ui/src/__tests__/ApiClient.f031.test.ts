import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";
import { reply, socialPost } from "./postReplyFixtures";

function makeClient(status = 200, body: unknown = {}) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  const client = new ApiClient({ baseUrl: "http://api.test/", token: "tok", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", body: init?.body, headers: new Headers(init?.headers) };
  };
  return { client, fetchMock, call };
}

describe("ApiClient F031 post replies and hearts", () => {
  it("listPostReplies: GET /api/posts/{id}/replies with page and perPage and a signal", async () => {
    const { client, call, fetchMock } = makeClient(200, { items: [reply("r1")], total: 1, page: 1, perPage: 200 });
    const ctrl = new AbortController();
    const p = await client.listPostReplies("a/b", { page: 1, perPage: 200 }, ctrl.signal);
    expect(p.items[0].id).toBe("r1");
    expect(call().url).toBe("http://api.test/api/posts/a%2Fb/replies?page=1&perPage=200");
    expect(call().method).toBe("GET");
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(ctrl.signal);
    await client.listPostReplies("p1");
    expect(call(1).url).toBe("http://api.test/api/posts/p1/replies");
  });

  it("createPostReply: POST /api/posts/{id}/replies with the JSON body", async () => {
    const { client, call } = makeClient(201, reply("r2"));
    const r = await client.createPostReply("p1", { body: "hi", replyToId: "r1" });
    expect(r.id).toBe("r2");
    expect(call().url).toBe("http://api.test/api/posts/p1/replies");
    expect(call().method).toBe("POST");
    expect(JSON.parse(String(call().body))).toEqual({ body: "hi", replyToId: "r1" });
    expect(call().headers.get("Authorization")).toBe("Bearer tok");
  });

  it("deletePostReply: DELETE /api/post-replies/{id}, 204", async () => {
    const { client, call } = makeClient(204);
    await expect(client.deletePostReply("r/1")).resolves.toBeUndefined();
    expect(call().url).toBe("http://api.test/api/post-replies/r%2F1");
    expect(call().method).toBe("DELETE");
  });

  it("heartPost / unheartPost / setPostHeart: PUT and DELETE /api/posts/{id}/heart", async () => {
    const { client, call } = makeClient(200, { hearted: true, hearts: 3 });
    await expect(client.heartPost("p1")).resolves.toEqual({ hearted: true, hearts: 3 });
    expect(call(0).url).toBe("http://api.test/api/posts/p1/heart");
    expect(call(0).method).toBe("PUT");
    await client.unheartPost("p1");
    expect(call(1).url).toBe("http://api.test/api/posts/p1/heart");
    expect(call(1).method).toBe("DELETE");
    await client.setPostHeart("p1", true);
    expect(call(2).method).toBe("PUT");
    await client.setPostHeart("p1", false);
    expect(call(3).method).toBe("DELETE");
  });

  it("lockPost / unlockPost: PUT and DELETE /api/posts/{id}/lock, returning the post", async () => {
    const { client, call } = makeClient(200, socialPost("p1", { locked: true }));
    const p = await client.lockPost("p1");
    expect(p.locked).toBe(true);
    expect(call(0).url).toBe("http://api.test/api/posts/p1/lock");
    expect(call(0).method).toBe("PUT");
    await client.unlockPost("p1");
    expect(call(1).url).toBe("http://api.test/api/posts/p1/lock");
    expect(call(1).method).toBe("DELETE");
  });
});

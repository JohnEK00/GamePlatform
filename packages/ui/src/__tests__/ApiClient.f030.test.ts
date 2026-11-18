import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import { post } from "./postFixtures";

function makeClient(status = 200, body: unknown = post("p1")) {
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

describe("ApiClient F030 posts", () => {
  it("createPost: POST /api/posts with the JSON body", async () => {
    const { client, call } = makeClient(201, post("p1", { canDelete: true }));
    const p = await client.createPost({ body: "hi", gameId: "g1" });
    expect(p.id).toBe("p1");
    const c = call();
    expect(c.url).toBe("http://api.test/api/posts");
    expect(c.method).toBe("POST");
    expect(JSON.parse(String(c.body))).toEqual({ body: "hi", gameId: "g1" });
    expect(c.headers.get("Content-Type")).toContain("application/json");
    expect(c.headers.get("Authorization")).toBe("Bearer tok");
  });

  it("getPost: GET /api/posts/{id} (encoded) with a signal", async () => {
    const { client, call } = makeClient();
    const ctrl = new AbortController();
    await client.getPost("a/b", ctrl.signal);
    expect(call().url).toBe("http://api.test/api/posts/a%2Fb");
    expect(call().method).toBe("GET");
  });

  it("deletePost: DELETE /api/posts/{id}, 204", async () => {
    const { client, call } = makeClient(204);
    await expect(client.deletePost("p1")).resolves.toBeUndefined();
    expect(call().url).toBe("http://api.test/api/posts/p1");
    expect(call().method).toBe("DELETE");
  });

  it("listUserPosts: GET /api/users/{u}/posts with page and perPage", async () => {
    const { client, call, fetchMock } = makeClient(200, { items: [], total: 0, page: 1, perPage: 20 });
    await client.listUserPosts("m ia", { page: 2, perPage: 20 });
    expect(call().url).toBe("http://api.test/api/users/m%20ia/posts?page=2&perPage=20");
    await client.listUserPosts("mia");
    expect(String(fetchMock.mock.calls[1][0])).toBe("http://api.test/api/users/mia/posts");
  });

  it("errors carry the server message", async () => {
    const { client } = makeClient(422, { error: { code: "validation", message: "You can post at most 25 times in 24 hours" } });
    const err = await client.createPost({ body: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.message).toBe("You can post at most 25 times in 24 hours");
  });
});

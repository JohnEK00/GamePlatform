import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeClient(body: unknown = {}) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, body));
  const client = new ApiClient({ baseUrl: "http://api.test", token: "tok", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", body: init?.body };
  };
  return { client, fetchMock, call };
}

describe("ApiClient F002 routes", () => {
  it("follow / unfollow / setFollowing with encoded usernames", async () => {
    const { client, call } = makeClient({ following: true, followers: 5 });
    expect(await client.followUser("sam")).toEqual({ following: true, followers: 5 });
    await client.unfollowUser("sam");
    await client.setFollowing("a b/c", true);
    await client.setFollowing("a b/c", false);
    expect(call(0)).toMatchObject({ url: "http://api.test/api/users/sam/follow", method: "PUT", body: undefined });
    expect(call(1)).toMatchObject({ url: "http://api.test/api/users/sam/follow", method: "DELETE" });
    expect(call(2)).toMatchObject({ url: "http://api.test/api/users/a%20b%2Fc/follow", method: "PUT" });
    expect(call(3)).toMatchObject({ url: "http://api.test/api/users/a%20b%2Fc/follow", method: "DELETE" });
  });

  it("follower and following lists page and encode", async () => {
    const { client, call } = makeClient({ items: [], total: 0, page: 1, perPage: 24 });
    await client.listFollowers("sam");
    await client.listFollowers("sam", { page: 2, perPage: 24 });
    await client.listFollowing("é?x", { page: 3 });
    expect(call(0)).toMatchObject({ url: "http://api.test/api/users/sam/followers", method: "GET" });
    expect(call(1).url).toBe("http://api.test/api/users/sam/followers?page=2&perPage=24");
    expect(call(2).url).toBe("http://api.test/api/users/%C3%A9%3Fx/following?page=3");
  });

  it("getFeed serialises kinds with commas, passes the cursor and limit, omits empty kinds", async () => {
    const { client, call, fetchMock } = makeClient({ items: [], nextCursor: null });
    expect(await client.getFeed()).toEqual({ items: [], nextCursor: null });
    await client.getFeed({ kinds: [] });
    await client.getFeed({ kinds: ["gamePublished", "gameUpdated"] });
    await client.getFeed({ cursor: "42", limit: 10, kinds: ["personalBest"] });
    const ctrl = new AbortController();
    await client.getFeed({ cursor: "7" }, ctrl.signal);
    expect(call(0)).toMatchObject({ url: "http://api.test/api/feed", method: "GET" });
    expect(call(1).url).toBe("http://api.test/api/feed");
    expect(call(2).url).toBe("http://api.test/api/feed?kinds=gamePublished%2CgameUpdated");
    expect(decodeURIComponent(call(2).url)).toBe("http://api.test/api/feed?kinds=gamePublished,gameUpdated");
    expect(call(3).url).toBe("http://api.test/api/feed?cursor=42&limit=10&kinds=personalBest");
    expect(call(4).url).toBe("http://api.test/api/feed?cursor=7");
    expect(fetchMock.mock.calls[4][1]?.signal).toBe(ctrl.signal);
  });

  it("getFeedSuggestions and the paged profile", async () => {
    const { client, call } = makeClient([]);
    expect(await client.getFeedSuggestions()).toEqual([]);
    await client.getUser("Sam");
    await client.getUser("Sam", { page: 2, perPage: 24 });
    expect(call(0)).toMatchObject({ url: "http://api.test/api/feed/suggestions", method: "GET" });
    expect(call(1).url).toBe("http://api.test/api/users/Sam");
    expect(call(2).url).toBe("http://api.test/api/users/Sam?page=2&perPage=24");
  });
});

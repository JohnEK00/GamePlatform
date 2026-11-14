import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, KEEPALIVE_MAX_BODY_BYTES, parseRetryAfter } from "../api/client";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 || body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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

describe("ApiClient v2 routes", () => {
  it("favorites", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { favorited: true, favorites: 3 }));
    expect(await client.favoriteGame("g1")).toEqual({ favorited: true, favorites: 3 });
    await client.unfavoriteGame("g1");
    await client.setFavorite("g1", true);
    await client.setFavorite("g1", false);
    await client.listMyFavorites({ page: 2, perPage: 10 });
    expect(call(0)).toMatchObject({ url: "http://api.test/api/games/g1/favorite", method: "PUT" });
    expect(call(1)).toMatchObject({ url: "http://api.test/api/games/g1/favorite", method: "DELETE" });
    expect(call(2).method).toBe("PUT");
    expect(call(3).method).toBe("DELETE");
    expect(call(4)).toMatchObject({ url: "http://api.test/api/users/me/favorites?page=2&perPage=10", method: "GET" });
  });

  it("achievements", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, []));
    await client.listGameAchievements("g1");
    await client.unlockAchievement("g1", "first_blood");
    await client.listUserAchievements("bob smith", 20);
    expect(call(0)).toMatchObject({ url: "http://api.test/api/games/g1/achievements", method: "GET" });
    expect(call(1)).toMatchObject({ url: "http://api.test/api/games/g1/achievements/first_blood", method: "POST" });
    expect(call(2).url).toBe("http://api.test/api/users/bob%20smith/achievements?limit=20");
  });

  it("cloud saves", async () => {
    const { client, call, fetchMock } = makeClient(() => jsonResponse(200, { data: { a: 1 }, updatedAt: "x" }));
    expect(await client.getSave("g1")).toEqual({ data: { a: 1 }, updatedAt: "x" });
    await client.putSave("g1", { level: 2 });
    fetchMock.mockImplementationOnce(async () => jsonResponse(204, undefined));
    expect(await client.deleteSave("g1")).toBeUndefined();
    expect(call(0)).toMatchObject({ url: "http://api.test/api/games/g1/save", method: "GET" });
    expect(call(1)).toMatchObject({ url: "http://api.test/api/games/g1/save", method: "PUT", body: { data: { level: 2 } } });
    expect(call(2)).toMatchObject({ url: "http://api.test/api/games/g1/save", method: "DELETE" });
  });

  it("R10: putSave keepalive only when asked and only for bodies within the keepalive quota", async () => {
    const { client, fetchMock } = makeClient(() => jsonResponse(200, { updatedAt: "x" }));
    await client.putSave("g1", { level: 2 });
    await client.putSave("g1", { level: 3 }, { keepalive: true });
    await client.putSave("g1", { blob: "x".repeat(KEEPALIVE_MAX_BODY_BYTES) }, { keepalive: true });
    const inits = fetchMock.mock.calls.map((c) => c[1]!);
    expect(inits[0].keepalive).toBeUndefined();
    expect(inits[1].keepalive).toBe(true);
    expect(inits[1].method).toBe("PUT");
    expect(JSON.parse(String(inits[1].body))).toEqual({ data: { level: 3 } });
    // > quota: sent as a normal request instead of being dropped
    expect(inits[2].keepalive).toBeUndefined();
    expect(String(inits[2].body).length).toBeGreaterThan(KEEPALIVE_MAX_BODY_BYTES);
  });

  it("stats", async () => {
    const { client, call } = makeClient();
    await client.getMyStats();
    await client.getGameStats("g1");
    expect(call(0).url).toBe("http://api.test/api/users/me/stats");
    expect(call(1).url).toBe("http://api.test/api/games/g1/stats");
  });

  it("reports and admin", async () => {
    const { client, call } = makeClient();
    await client.createReport({ targetType: "comment", targetId: "c1", reason: "spam", details: "buy now" });
    await client.listReports({ status: "resolved", page: 1, perPage: 25 });
    await client.resolveReport("r1", "unpublish");
    expect(call(0)).toMatchObject({
      url: "http://api.test/api/reports",
      method: "POST",
      body: { targetType: "comment", targetId: "c1", reason: "spam", details: "buy now" },
    });
    expect(call(1)).toMatchObject({ url: "http://api.test/api/admin/reports?status=resolved&page=1&perPage=25", method: "GET" });
    expect(call(2)).toMatchObject({ url: "http://api.test/api/admin/reports/r1/resolve", method: "POST", body: { action: "unpublish" } });
  });

  it("sort=favorites is passed through", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { items: [], total: 0, page: 1, perPage: 24 }));
    await client.listGames({ sort: "favorites" });
    expect(call(0).url).toBe("http://api.test/api/games?sort=favorites");
  });
});

describe("429 rate limiting", () => {
  it("maps 429 to rate_limited with Retry-After seconds and a friendly message", async () => {
    const { client } = makeClient(() =>
      jsonResponse(429, { error: { code: "rate_limited", message: "Too many requests" } }, { "Retry-After": "17" }),
    );
    const err = (await client.postComment("g1", "hi").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("rate_limited");
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(17);
    expect(err.message).toBe("Slow down, try again in 17s.");
  });

  it("handles a 429 without a body or header", async () => {
    const { client } = makeClient(() => new Response("", { status: 429 }));
    const err = (await client.listTags().catch((e) => e)) as ApiError;
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfter).toBeUndefined();
    expect(err.message).toMatch(/^Slow down/);
  });

  it("parses Retry-After values", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter("0")).toBe(1);
    expect(parseRetryAfter("2.2")).toBe(3);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("garbage")).toBeUndefined();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:30 GMT", now)).toBe(30);
  });

  it("upload() surfaces 429 with Retry-After from XHR", async () => {
    const client = new ApiClient({ baseUrl: "http://api.test", token: "t" });
    class FakeXHR {
      status = 429;
      statusText = "Too Many Requests";
      responseText = JSON.stringify({ error: { code: "rate_limited", message: "x" } });
      upload = { onprogress: null as unknown };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      getResponseHeader(h: string) {
        return h.toLowerCase() === "retry-after" ? "42" : null;
      }
      send() {
        setTimeout(() => this.onload?.(), 0);
      }
    }
    const orig = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
    try {
      const err = (await client.createGame({ title: "t", bundle: new Blob(["PK"]) }).catch((e) => e)) as ApiError;
      expect(err.code).toBe("rate_limited");
      expect(err.retryAfter).toBe(42);
      expect(err.message).toBe("Slow down, try again in 42s.");
    } finally {
      globalThis.XMLHttpRequest = orig;
    }
  });
});

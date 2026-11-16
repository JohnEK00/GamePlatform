import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";

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
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return {
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization,
      contentType: headers["Content-Type"],
    };
  };
  return { client, fetchMock, call };
}

describe("ApiClient F007 notification routes", () => {
  it("listNotifications: path, cursor/limit and unread only when true", async () => {
    const page = { items: [], nextCursor: null, unread: 0 };
    const { client, call } = makeClient(() => jsonResponse(200, page));
    expect(await client.listNotifications()).toEqual(page);
    await client.listNotifications({ cursor: "abc=", limit: 10, unread: true });
    await client.listNotifications({ unread: false, limit: 20 });
    expect(call(0)).toMatchObject({ url: "http://api.test/api/notifications", method: "GET", auth: "Bearer tok" });
    expect(call(1).url).toBe("http://api.test/api/notifications?cursor=abc%3D&limit=10&unread=true");
    expect(call(2).url).toBe("http://api.test/api/notifications?limit=20");
  });

  it("unreadNotificationCount: GET unread-count", async () => {
    const body = { unread: 3, latestAt: "2026-11-15T10:00:00.000Z", pollAfterSecs: 60 };
    const { client, call } = makeClient(() => jsonResponse(200, body));
    expect(await client.unreadNotificationCount()).toEqual(body);
    expect(call(0)).toMatchObject({ url: "http://api.test/api/notifications/unread-count", method: "GET", body: undefined });
  });

  it("markNotificationsRead: POST with ids + upTo, or upTo only", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { unread: 1 }));
    expect(await client.markNotificationsRead({ ids: ["7"], upTo: "2026-11-15T10:00:00.000Z" })).toEqual({ unread: 1 });
    await client.markNotificationsRead({ upTo: "2026-11-15T11:00:00.000Z" });
    expect(call(0)).toEqual({
      url: "http://api.test/api/notifications/read",
      method: "POST",
      body: { ids: ["7"], upTo: "2026-11-15T10:00:00.000Z" },
      auth: "Bearer tok",
      contentType: "application/json",
    });
    expect(call(1).body).toEqual({ upTo: "2026-11-15T11:00:00.000Z" });
    expect("ids" in call(1).body).toBe(false);
  });

  it("get/updateNotificationSettings: GET and PUT with only the given fields", async () => {
    const all = { comments: true, replies: true, hearts: false, follows: true, newGames: true };
    const { client, call } = makeClient(() => jsonResponse(200, all));
    expect(await client.getNotificationSettings()).toEqual(all);
    expect(await client.updateNotificationSettings({ hearts: false })).toEqual(all);
    expect(call(0)).toMatchObject({ url: "http://api.test/api/notifications/settings", method: "GET" });
    expect(call(1)).toMatchObject({ url: "http://api.test/api/notifications/settings", method: "PUT", body: { hearts: false } });
  });

  it("429 carries retryAfter; 404 keeps its status (older servers)", async () => {
    let res = jsonResponse(429, { error: { code: "rate_limited", message: "slow" } }, { "Retry-After": "42" });
    const { client } = makeClient(() => res);
    const e1 = await client.unreadNotificationCount().catch((e) => e);
    expect(e1).toBeInstanceOf(ApiError);
    expect(e1).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 42 });
    res = jsonResponse(404, { error: { code: "not_found", message: "nope" } });
    const e2 = await client.unreadNotificationCount().catch((e) => e);
    expect(e2).toMatchObject({ status: 404, code: "not_found" });
  });
});

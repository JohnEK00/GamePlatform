import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import { normalizeComment } from "../api/comments";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeClient(make: () => Response = () => jsonResponse(200, { muted: true, unread: 3 })) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => make());
  const client = new ApiClient({ baseUrl: "http://api.test", token: "tok", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", body: init?.body };
  };
  return { client, fetchMock, call };
}

describe("ApiClient F018: mutes", () => {
  it("GET /api/notifications/mutes", async () => {
    const list = { items: [], total: 0 };
    const { client, call } = makeClient(() => jsonResponse(200, list));
    expect(await client.listNotificationMutes()).toEqual(list);
    expect(call()).toMatchObject({ url: "http://api.test/api/notifications/mutes", method: "GET" });
  });

  it("PUT / DELETE game and thread mutes, ids encoded, no body", async () => {
    const { client, call } = makeClient();
    expect(await client.muteGame("g/1")).toEqual({ muted: true, unread: 3 });
    await client.unmuteGame("g1");
    await client.muteThread("c 1");
    await client.unmuteThread("c1");
    expect(call(0)).toEqual({ url: "http://api.test/api/notifications/mutes/games/g%2F1", method: "PUT", body: undefined });
    expect(call(1)).toEqual({ url: "http://api.test/api/notifications/mutes/games/g1", method: "DELETE", body: undefined });
    expect(call(2)).toEqual({ url: "http://api.test/api/notifications/mutes/threads/c%201", method: "PUT", body: undefined });
    expect(call(3)).toEqual({ url: "http://api.test/api/notifications/mutes/threads/c1", method: "DELETE", body: undefined });
  });

  it("surfaces the 422 cap message", async () => {
    const { client } = makeClient(() =>
      jsonResponse(422, { error: { code: "validation", message: "You can mute at most 500 games and threads; unmute some in Settings" } }),
    );
    const e = await client.muteGame("g1").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(422);
    expect((e as ApiError).message).toBe("You can mute at most 500 games and threads; unmute some in Settings");
  });

  it("sends `pins` in the settings PUT", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { comments: true, replies: true, hearts: true, follows: true, newGames: true, pins: false }));
    const s = await client.updateNotificationSettings({ pins: false });
    expect(s.pins).toBe(false);
    expect(call()).toMatchObject({ url: "http://api.test/api/notifications/settings", method: "PUT" });
    expect(JSON.parse(String(call().body))).toEqual({ pins: false });
  });
});

describe("normalizeComment F018", () => {
  const base = { id: "c1", gameId: "g1", author: { id: "u2", username: "a", displayName: "A", avatarUrl: null }, body: "hi", createdAt: "2026-11-15T10:00:00Z" };
  it("keeps a boolean threadMuted and leaves it undefined on older servers", () => {
    expect(normalizeComment({ ...base, threadMuted: true }).threadMuted).toBe(true);
    expect(normalizeComment({ ...base, threadMuted: false }).threadMuted).toBe(false);
    expect(normalizeComment(base).threadMuted).toBeUndefined();
    expect(normalizeComment({ ...base, threadMuted: "yes" as unknown as boolean }).threadMuted).toBeUndefined();
  });
});

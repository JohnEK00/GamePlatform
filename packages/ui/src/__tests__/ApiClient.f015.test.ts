import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import { gameScreenshotsPath, SCREENSHOTS_SECTION } from "../util";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeClient(make: () => Response) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => make());
  const client = new ApiClient({ baseUrl: "http://api.test/", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET" };
  };
  return { client, fetchMock, call };
}

const shot = {
  id: "s1",
  gameId: "g1",
  author: { id: "u1", username: "mia", displayName: "Mia", avatarUrl: null },
  caption: "",
  imageUrl: "/media/screenshots/s1.png",
  thumbUrl: "/media/screenshots/s1_t.jpg",
  width: 1280,
  height: 720,
  gameVersion: 1,
  createdAt: "2026-11-14T15:30:12Z",
  canDelete: false,
  game: { id: "g1", title: "Kiln Clash" },
};

describe("ApiClient F015: listUserScreenshots", () => {
  it("GET /api/users/{username}/screenshots with page and perPage", async () => {
    const body = { items: [shot], total: 1, page: 2, perPage: 12 };
    const { client, call } = makeClient(() => jsonResponse(200, body));
    expect(await client.listUserScreenshots("mia", { page: 2, perPage: 12 })).toEqual(body);
    expect(call()).toEqual({ url: "http://api.test/api/users/mia/screenshots?page=2&perPage=12", method: "GET" });
  });

  it("omits absent paging params and encodes the username", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { items: [], total: 0, page: 1, perPage: 12 }));
    await client.listUserScreenshots("a b/c");
    expect(call()).toEqual({ url: "http://api.test/api/users/a%20b%2Fc/screenshots", method: "GET" });
  });

  it("passes the abort signal", async () => {
    const { client, fetchMock } = makeClient(() => jsonResponse(200, { items: [], total: 0, page: 1, perPage: 12 }));
    const ctrl = new AbortController();
    await client.listUserScreenshots("mia", {}, ctrl.signal);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(ctrl.signal);
  });

  it("a 404 rejects with an ApiError (older server / unknown user)", async () => {
    const { client } = makeClient(() => jsonResponse(404, { error: { code: "not_found", message: "User not found" } }));
    const err = await client.listUserScreenshots("ghost").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(404);
  });
});

describe("gameScreenshotsPath (F015)", () => {
  it("uses ?section=screenshots (HashRouter-safe) and encodes the id", () => {
    expect(SCREENSHOTS_SECTION).toBe("screenshots");
    expect(gameScreenshotsPath("g1")).toBe("/games/g1?section=screenshots");
    expect(gameScreenshotsPath("a b")).toBe("/games/a%20b?section=screenshots");
  });
});

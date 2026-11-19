import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";

function makeClient(body: unknown = { items: [], total: 0, page: 1, perPage: 12 }) {
  const fetchMock = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  const client = new ApiClient({ baseUrl: "http://api.test/", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", body: init?.body };
  };
  return { client, call };
}

describe("ApiClient F032", () => {
  it("listCollections({ perPage: 3 }) -> GET /api/collections?perPage=3", async () => {
    const { client, call } = makeClient();
    const page = await client.listCollections({ perPage: 3 });
    expect(page.total).toBe(0);
    expect(call()).toMatchObject({ url: "http://api.test/api/collections?perPage=3", method: "GET" });
  });

  it("listCollections sends only present keys, page before perPage", async () => {
    const { client, call } = makeClient();
    await client.listCollections();
    await client.listCollections({ perPage: 12, page: 2 });
    expect(call(0).url).toBe("http://api.test/api/collections");
    expect(call(1).url).toBe("http://api.test/api/collections?page=2&perPage=12");
  });

  it("getCreatorSpotlight() -> GET /api/creators/spotlight", async () => {
    const { client, call } = makeClient({ day: "2026-11-19", creator: null, games: [] });
    const s = await client.getCreatorSpotlight();
    expect(s.day).toBe("2026-11-19");
    expect(call()).toMatchObject({ url: "http://api.test/api/creators/spotlight", method: "GET" });
  });

  it('setFeaturedGames(["a"]) -> PUT /api/users/me/featured with {"gameIds":["a"]}', async () => {
    const { client, call } = makeClient({ featured: [] });
    const res = await client.setFeaturedGames(["a"]);
    expect(res.featured).toEqual([]);
    expect(call()).toMatchObject({ url: "http://api.test/api/users/me/featured", method: "PUT", body: '{"gameIds":["a"]}' });
  });

  it('listGames({ sort: "updated" }) sends sort=updated', async () => {
    const { client, call } = makeClient();
    await client.listGames({ sort: "updated" });
    expect(call().url).toBe("http://api.test/api/games?sort=updated");
  });
});

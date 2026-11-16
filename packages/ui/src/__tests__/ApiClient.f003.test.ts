import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function makeClient(body: unknown = {}) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, body));
  const client = new ApiClient({ baseUrl: "http://api.test", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", signal: init?.signal };
  };
  return { client, fetchMock, call };
}

describe("ApiClient F003 routes", () => {
  it("getRelatedGames builds the path, encodes the id and omits an undefined limit", async () => {
    const related = [{ id: "g2", reason: "tags", sharedTags: ["platformer"] }];
    const { client, call } = makeClient(related);
    expect(await client.getRelatedGames("g1")).toEqual(related);
    await client.getRelatedGames("g1", { limit: 8 });
    await client.getRelatedGames("a b/c?", { limit: undefined });
    const ctrl = new AbortController();
    await client.getRelatedGames("g1", { limit: 24 }, ctrl.signal);
    expect(call(0)).toMatchObject({ url: "http://api.test/api/games/g1/related", method: "GET" });
    expect(call(1).url).toBe("http://api.test/api/games/g1/related?limit=8");
    expect(call(2).url).toBe("http://api.test/api/games/a%20b%2Fc%3F/related");
    expect(call(3).url).toBe("http://api.test/api/games/g1/related?limit=24");
    expect(call(3).signal).toBe(ctrl.signal);
  });

  it("listGames sends sort=trending", async () => {
    const { client, call } = makeClient({ items: [], total: 0, page: 1, perPage: 8 });
    await client.listGames({ sort: "trending", perPage: 8 });
    await client.listGames({ sort: "trending", tag: "pixel", q: "peaks" });
    const u0 = new URL(call(0).url);
    expect(u0.pathname).toBe("/api/games");
    expect(u0.searchParams.get("sort")).toBe("trending");
    expect(u0.searchParams.get("perPage")).toBe("8");
    const u1 = new URL(call(1).url);
    expect(u1.searchParams.get("sort")).toBe("trending");
    expect(u1.searchParams.get("tag")).toBe("pixel");
    expect(u1.searchParams.get("q")).toBe("peaks");
  });
});

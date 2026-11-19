import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";

function makeClient() {
  const fetchMock = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ items: [], total: 0, page: 1, perPage: 24 }), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  const client = new ApiClient({ baseUrl: "http://api.test/", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET" };
  };
  return { client, call };
}

describe("ApiClient F035 creators", () => {
  it("listCreators(): GET /api/creators with no query", async () => {
    const { client, call } = makeClient();
    const page = await client.listCreators();
    expect(page.total).toBe(0);
    expect(call()).toEqual({ url: "http://api.test/api/creators", method: "GET" });
  });

  it("sends sort, page, perPage in that order", async () => {
    const { client, call } = makeClient();
    await client.listCreators({ sort: "new", page: 2, perPage: 24 });
    expect(call().url).toBe("http://api.test/api/creators?sort=new&page=2&perPage=24");
  });

  it("only sends present keys", async () => {
    const { client, call } = makeClient();
    await client.listCreators({ page: 1, perPage: 24 });
    expect(call().url).toBe("http://api.test/api/creators?page=1&perPage=24");
  });
});

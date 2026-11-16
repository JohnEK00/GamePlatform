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
  const client = new ApiClient({ baseUrl: "http://api.test/", token: "tok", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
  };
  return { client, fetchMock, call };
}

describe("ApiClient F008 collection routes", () => {
  it("createCollection: POST /api/collections with the JSON body", async () => {
    const { client, call, fetchMock } = makeClient(() => jsonResponse(201, { id: "c1" }));
    const r = await client.createCollection({ title: "Cozy", visibility: "private", gameId: "g1" });
    expect(r).toEqual({ id: "c1" });
    expect(call()).toEqual({ url: "http://api.test/api/collections", method: "POST", body: { title: "Cozy", visibility: "private", gameId: "g1" } });
    const init = fetchMock.mock.calls[0][1]!;
    expect(init.headers).toMatchObject({ Authorization: "Bearer tok", "Content-Type": "application/json" });
  });

  it("get / update / delete encode the id", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { id: "a/b" }));
    await client.getCollection("a/b?x");
    await client.updateCollection("a/b", { title: "New", visibility: "public" });
    expect(call(0)).toEqual({ url: "http://api.test/api/collections/a%2Fb%3Fx", method: "GET", body: undefined });
    expect(call(1)).toEqual({ url: "http://api.test/api/collections/a%2Fb", method: "PATCH", body: { title: "New", visibility: "public" } });
    const del = makeClient(() => jsonResponse(204, undefined));
    expect(await del.client.deleteCollection("c 1")).toBeUndefined();
    expect(del.call()).toEqual({ url: "http://api.test/api/collections/c%201", method: "DELETE", body: undefined });
  });

  it("putCollectionGame sends the note only when given; deleteCollectionGame has no body", async () => {
    const res = { added: true, item: { gameId: "g/1", game: null, note: "", addedAt: "x" }, gameCount: 1, updatedAt: "y" };
    const { client, call, fetchMock } = makeClient(() => jsonResponse(200, res));
    expect(await client.putCollectionGame("c1", "g/1")).toEqual(res);
    await client.putCollectionGame("c1", "g/1", { note: "Great" });
    await client.putCollectionGame("c1", "g1", { note: "" });
    await client.deleteCollectionGame("c/1", "g#1");
    expect(call(0)).toEqual({ url: "http://api.test/api/collections/c1/games/g%2F1", method: "PUT", body: undefined });
    expect(fetchMock.mock.calls[0][1]!.headers).not.toHaveProperty("Content-Type");
    expect(call(1)).toEqual({ url: "http://api.test/api/collections/c1/games/g%2F1", method: "PUT", body: { note: "Great" } });
    expect(call(2).body).toEqual({ note: "" });
    expect(call(3)).toEqual({ url: "http://api.test/api/collections/c%2F1/games/g%231", method: "DELETE", body: undefined });
  });

  it("reorderCollection: PUT …/order with every id", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { id: "c1", items: [] }));
    await client.reorderCollection("c1", ["g3", "g1", "g2"]);
    expect(call()).toEqual({ url: "http://api.test/api/collections/c1/order", method: "PUT", body: { gameIds: ["g3", "g1", "g2"] } });
  });

  it("list endpoints: paths, encoding and query parameters", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { items: [], total: 0, page: 1, perPage: 6 }));
    await client.listUserCollections("ana b", { perPage: 6 });
    await client.listUserCollections("ana", { page: 2, perPage: 24 });
    await client.listUserCollections("ana");
    await client.listMyCollections("g/1");
    await client.listMyCollections();
    await client.listGameCollections("g/1", 6);
    await client.listGameCollections("g1");
    expect(call(0)).toEqual({ url: "http://api.test/api/users/ana%20b/collections?perPage=6", method: "GET", body: undefined });
    expect(call(1).url).toBe("http://api.test/api/users/ana/collections?page=2&perPage=24");
    expect(call(2).url).toBe("http://api.test/api/users/ana/collections");
    expect(call(3).url).toBe("http://api.test/api/users/me/collections?gameId=g%2F1");
    expect(call(4).url).toBe("http://api.test/api/users/me/collections");
    expect(call(5).url).toBe("http://api.test/api/games/g%2F1/collections?limit=6");
    expect(call(6).url).toBe("http://api.test/api/games/g1/collections");
  });

  it("surfaces 404 / 409 / 422 / 429 as ApiError", async () => {
    const responses = [
      jsonResponse(404, { error: { code: "not_found", message: "Collection not found" } }),
      jsonResponse(409, { error: { code: "conflict", message: "The collection has changed; reload and try again" } }),
      jsonResponse(422, { error: { code: "validation", message: "A collection can hold at most 100 games" } }),
      jsonResponse(429, { error: { code: "rate_limited", message: "x" } }, { "Retry-After": "7" }),
    ];
    let i = 0;
    const { client } = makeClient(() => responses[i++]);
    await expect(client.getCollection("c1")).rejects.toMatchObject({ status: 404, code: "not_found", message: "Collection not found" });
    await expect(client.reorderCollection("c1", [])).rejects.toMatchObject({ status: 409, code: "conflict" });
    await expect(client.putCollectionGame("c1", "g1")).rejects.toMatchObject({ status: 422, message: "A collection can hold at most 100 games" });
    const e = await client.deleteCollectionGame("c1", "g1").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 429, retryAfter: 7, message: "Slow down, try again in 7s." });
  });
});

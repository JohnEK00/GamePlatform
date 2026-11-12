import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, buildQuery, resolveApiUrl } from "../api/client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(response: Response | (() => Response | Promise<Response>), token: string | null = null) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
    typeof response === "function" ? response() : response,
  );
  const client = new ApiClient({ baseUrl: "http://api.test/", token, fetch: fetchMock as unknown as typeof fetch });
  return { client, fetchMock };
}

describe("ApiClient", () => {
  it("sends the bearer token when set", async () => {
    const { client, fetchMock } = makeClient(jsonResponse(200, { id: "u1", username: "bob" }), "tok123");
    await client.me();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/api/auth/me");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer tok123");
  });

  it("omits Authorization without a token and picks up setToken()", async () => {
    const { client, fetchMock } = makeClient(() => jsonResponse(200, []));
    await client.listTags();
    expect((fetchMock.mock.calls[0][1]!.headers as Record<string, string>).Authorization).toBeUndefined();
    client.setToken("abc");
    await client.listTags();
    expect((fetchMock.mock.calls[1][1]!.headers as Record<string, string>).Authorization).toBe("Bearer abc");
  });

  it("builds list query strings, skipping empty values", async () => {
    const { client, fetchMock } = makeClient(jsonResponse(200, { items: [], total: 0, page: 2, perPage: 24 }));
    await client.listGames({ q: "space dodge", tag: "", sort: "top", page: 2, perPage: 24, owner: undefined });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/games");
    expect(url.searchParams.get("q")).toBe("space dodge");
    expect(url.searchParams.get("sort")).toBe("top");
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("perPage")).toBe("24");
    expect(url.searchParams.has("tag")).toBe(false);
    expect(url.searchParams.has("owner")).toBe(false);
  });

  it("sends JSON bodies with method and content-type", async () => {
    const { client, fetchMock } = makeClient(jsonResponse(200, { ratingAvg: 4, ratingCount: 1, myRating: 4 }), "t");
    const r = await client.rateGame("g1", 4);
    expect(r.myRating).toBe(4);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/api/games/g1/rating");
    expect(init!.method).toBe("PUT");
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init!.body))).toEqual({ score: 4 });
  });

  it("parses the error envelope into ApiError", async () => {
    const { client } = makeClient(jsonResponse(422, { error: { code: "validation", message: "game.json missing" } }));
    const err = await client.getGame("x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("validation");
    expect(err.status).toBe(422);
    expect(err.message).toBe("game.json missing");
  });

  it("falls back to a status-derived code for non-JSON errors", async () => {
    const { client } = makeClient(() => new Response("<html>oops</html>", { status: 404 }));
    const err = await client.getGame("x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("not_found");
    expect(err.status).toBe(404);
  });

  it("maps 503 without an envelope to code 'unavailable'", async () => {
    const { client } = makeClient(() => new Response("Service Unavailable", { status: 503 }));
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("unavailable");
    expect(err.status).toBe(503);
  });

  it("maps network failures to code 'network'", async () => {
    const { client } = makeClient(() => {
      throw new TypeError("Failed to fetch");
    });
    const err = await client.health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("network");
    expect(err.status).toBe(0);
  });

  it("returns undefined for 204", async () => {
    const { client, fetchMock } = makeClient(new Response(null, { status: 204 }), "t");
    await expect(client.deleteComment("c1")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe("http://api.test/api/comments/c1");
    expect(fetchMock.mock.calls[0][1]!.method).toBe("DELETE");
  });

  it("resolves server-relative URLs against baseUrl", () => {
    const c = new ApiClient({ baseUrl: "http://localhost:8080/" });
    expect(c.url("/media/thumbnails/a.png?v=3")).toBe("http://localhost:8080/media/thumbnails/a.png?v=3");
    expect(c.url(null)).toBeNull();
    expect(c.url("https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
    expect(resolveApiUrl("", "/play/1")).toBe("/play/1");
    expect(buildQuery({})).toBe("");
  });

  it("createPreviewToken POSTs to /api/games/{id}/preview-token with the session bearer", async () => {
    const body = { token: "prev", expiresAt: "2026-11-12T10:10:00Z" };
    const { client, fetchMock } = makeClient(jsonResponse(200, body), "sess");
    await expect(client.createPreviewToken("g 1")).resolves.toEqual(body);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://api.test/api/games/g%201/preview-token");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sess");
  });
});

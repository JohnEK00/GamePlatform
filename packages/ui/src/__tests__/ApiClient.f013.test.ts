import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";

function zipResponse(headers: Record<string, string>, status = 200) {
  return new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), { status, headers: { "Content-Type": "application/zip", ...headers } });
}

function client(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const f = vi.fn(fetchImpl);
  const c = new ApiClient({ baseUrl: "http://api.test", token: "tok", fetch: f as unknown as typeof fetch });
  return { c, f };
}

describe("ApiClient.downloadBundle (F013)", () => {
  it("sends auth and an encoded id, and parses the version and filename", async () => {
    const { c, f } = client(async () => zipResponse({ "X-Game-Version": "4", "Content-Disposition": 'attachment; filename="space-dodge-v4.zip"' }));
    const res = await c.downloadBundle("a/b c");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://api.test/api/games/a%2Fb%20c/bundle");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(res.version).toBe(4);
    expect(res.filename).toBe("space-dodge-v4.zip");
    expect(new Uint8Array(await res.blob.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 0x05, 0x06]));
  });

  it("falls back to getGame when X-Game-Version is missing or invalid, and to game-v{n}.zip", async () => {
    for (const header of [{}, { "X-Game-Version": "0" }, { "X-Game-Version": "abc" }]) {
      const { c } = client(async () => zipResponse(header));
      const getGame = vi.spyOn(c, "getGame").mockResolvedValue({ version: 7 } as never);
      const res = await c.downloadBundle("g1");
      expect(getGame).toHaveBeenCalledWith("g1");
      expect(res.version).toBe(7);
      expect(res.filename).toBe("game-v7.zip");
    }
  });

  it("turns an error JSON into ApiError, with retryAfter on 429", async () => {
    const { c } = client(
      async () =>
        new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow" } }), { status: 429, headers: { "Retry-After": "42" } }),
    );
    const err = await c.downloadBundle("g1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(42);

    const { c: c2 } = client(async () => new Response(JSON.stringify({ error: { code: "conflict", message: "The game was updated" } }), { status: 409 }));
    const e2 = await c2.downloadBundle("g1").catch((e) => e);
    expect(e2).toMatchObject({ status: 409, code: "conflict", message: "The game was updated" });

    const { c: c3 } = client(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "Game not found" } }), { status: 404 }));
    expect(await c3.downloadBundle("g1").catch((e) => e)).toMatchObject({ status: 404, code: "not_found" });
  });

  it("maps 405 and a 404 without an error body to 'unsupported'", async () => {
    for (const status of [405, 404]) {
      const { c } = client(async () => new Response("", { status }));
      const e = await c.downloadBundle("g1").catch((x) => x);
      expect(e).toMatchObject({ code: "unsupported", message: "This server doesn't support opening games in the Studio." });
    }
  });
});

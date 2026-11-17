import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";

function client(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const f = vi.fn(fetchImpl);
  const c = new ApiClient({ baseUrl: "http://api.test", token: "tok", fetch: f as unknown as typeof fetch });
  return { c, f };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ApiClient controls (F016)", () => {
  it("getControls: GET /api/games/{id}/controls with auth, and returns the response", async () => {
    const { c, f } = client(async () => json({ bindings: null, updatedAt: null }));
    const ctrl = new AbortController();
    expect(await c.getControls("a/b", ctrl.signal)).toEqual({ bindings: null, updatedAt: null });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://api.test/api/games/a%2Fb/controls");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.signal).toBe(ctrl.signal);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("putControls: PUT { bindings } and returns the normalised copy", async () => {
    const stored = { bindings: { keys: {}, gamepad: { jump: ["B"] } }, updatedAt: "2026-11-17T10:00:00Z" };
    const { c, f } = client(async () => json(stored));
    const bindings = { keys: { jump: ["KeyK"] }, gamepad: { jump: ["B" as const] } };
    expect(await c.putControls("g1", bindings)).toEqual(stored);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://api.test/api/games/g1/controls");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ bindings });
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.keepalive).toBeUndefined();
  });

  it("putControls with keepalive sends fetch keepalive", async () => {
    const { c, f } = client(async () => json({ bindings: { keys: {}, gamepad: {} }, updatedAt: "2026-11-17T10:00:00Z" }));
    await c.putControls("g1", { keys: {}, gamepad: {} }, { keepalive: true });
    expect(f.mock.calls[0][1].keepalive).toBe(true);
  });

  it("errors become ApiError (422, 429 with Retry-After)", async () => {
    const { c } = client(async () => json({ error: { code: "validation", message: 'bindings.gamepad.jump[0] "Home" can\'t be bound' } }, 422));
    const e = await c.putControls("g1", { keys: {}, gamepad: {} }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 422, code: "validation" });
    const { c: c2 } = client(async () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow" } }), { status: 429, headers: { "Retry-After": "12" } }));
    expect(await c2.putControls("g1", { keys: {}, gamepad: {} }).catch((x) => x)).toMatchObject({ status: 429, retryAfter: 12 });
  });
});

import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function makeClient(make: () => Response = () => jsonResponse(200, {})) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => make());
  const client = new ApiClient({ baseUrl: "http://api.test", token: "tok", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", body: init?.body, headers: init?.headers as Record<string, string> };
  };
  return { client, fetchMock, call };
}

describe("ApiClient F020 comment settings", () => {
  it("updateCommentSettings PUTs both fields as JSON and returns the stored values", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { mode: "repliesOnly", slowModeSecs: 300 }));
    const res = await client.updateCommentSettings("g 1", { mode: "repliesOnly", slowModeSecs: 300 });
    expect(res).toEqual({ mode: "repliesOnly", slowModeSecs: 300 });
    const c = call();
    expect(c.url).toBe("http://api.test/api/games/g%201/comment-settings");
    expect(c.method).toBe("PUT");
    expect(JSON.parse(String(c.body))).toEqual({ mode: "repliesOnly", slowModeSecs: 300 });
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(c.headers.Authorization).toBe("Bearer tok");
  });

  it("sends exactly mode and slowModeSecs (extra fields are not forwarded)", async () => {
    const { client, call } = makeClient(() => jsonResponse(200, { mode: "off", slowModeSecs: 0 }));
    await client.updateCommentSettings("g1", { mode: "off", slowModeSecs: 0, extra: 1 } as never);
    expect(JSON.parse(String(call().body))).toEqual({ mode: "off", slowModeSecs: 0 });
  });

  it("surfaces 403 / 422 / rate-limited 429 as ApiError", async () => {
    const responses = [
      jsonResponse(403, { error: { code: "forbidden", message: "Forbidden" } }),
      jsonResponse(422, { error: { code: "validation", message: "mode must be one of: on, repliesOnly, off" } }),
      jsonResponse(429, { error: { code: "rate_limited", message: "Too many" } }, { "Retry-After": "30" }),
    ];
    let i = 0;
    const { client } = makeClient(() => responses[i++]);
    const s = { mode: "on", slowModeSecs: 0 } as const;
    expect(await client.updateCommentSettings("g1", s).catch((e) => e)).toMatchObject({ status: 403, code: "forbidden" });
    expect(await client.updateCommentSettings("g1", s).catch((e) => e)).toMatchObject({
      status: 422,
      code: "validation",
      message: "mode must be one of: on, repliesOnly, off",
    });
    expect(await client.updateCommentSettings("g1", s).catch((e) => e)).toMatchObject({ status: 429, code: "rate_limited", retryAfter: 30 });
  });
});

describe("ApiClient F020 slow_mode errors", () => {
  it("keeps code slow_mode, the server message and retryAfter on a 429", async () => {
    const { client } = makeClient(() =>
      jsonResponse(429, { error: { code: "slow_mode", message: "Slow mode is on: you can post again in 42 seconds" } }, { "Retry-After": "42" }),
    );
    const err = (await client.postComment("g1", "hi").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: "slow_mode", retryAfter: 42, message: "Slow mode is on: you can post again in 42 seconds" });
  });

  it("builds the message from Retry-After when the body has none", () => {
    const err = ApiError.fromResponse(429, { error: { code: "slow_mode" } }, "", "7");
    expect(err).toMatchObject({ code: "slow_mode", retryAfter: 7, message: "Slow mode is on: you can post again in 7 seconds" });
  });

  it("a 429 without the code is still the generic rate limit", () => {
    expect(ApiError.fromResponse(429, null, "", "5")).toMatchObject({ code: "rate_limited", retryAfter: 5 });
    expect(ApiError.fromResponse(429, { error: { code: "rate_limited", message: "x" } }, "", "5")).toMatchObject({
      code: "rate_limited",
      message: "Slow down, try again in 5s.",
    });
  });
});

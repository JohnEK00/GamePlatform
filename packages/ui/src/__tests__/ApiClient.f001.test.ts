import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../api/client";

function makeClient(body: unknown) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  const client = new ApiClient({ baseUrl: "http://api.test", token: "tok", fetch: fetchMock as unknown as typeof fetch });
  const call = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i];
    return { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
  };
  return { client, call };
}

describe("ApiClient F001", () => {
  it("getLeaderboard builds the URL and query params", async () => {
    const lb = { period: "week", periodStart: null, periodEnd: null, config: { order: "desc", format: "number", label: "" }, entries: [], totalPlayers: 0, me: null };
    const { client, call } = makeClient(lb);
    expect(await client.getLeaderboard("g 1")).toEqual(lb);
    await client.getLeaderboard("g1", { period: "day", limit: 5 });
    await client.getLeaderboard("g1", { period: "all" });
    expect(call(0)).toMatchObject({ url: "http://api.test/api/games/g%201/leaderboard", method: "GET" });
    expect(call(1).url).toBe("http://api.test/api/games/g1/leaderboard?period=day&limit=5");
    expect(call(2).url).toBe("http://api.test/api/games/g1/leaderboard?period=all");
  });

  it("listScores accepts a period", async () => {
    const { client, call } = makeClient([]);
    await client.listScores("g1");
    await client.listScores("g1", 10);
    await client.listScores("g1", 10, "week");
    await client.listScores("g1", undefined, "day");
    expect(call(0).url).toBe("http://api.test/api/games/g1/scores");
    expect(call(1).url).toBe("http://api.test/api/games/g1/scores?limit=10");
    expect(call(2).url).toBe("http://api.test/api/games/g1/scores?limit=10&period=week");
    expect(call(3).url).toBe("http://api.test/api/games/g1/scores?period=day");
  });

  it("submitScore returns the ScoreSubmitResult", async () => {
    const result = {
      id: "s1",
      user: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null },
      score: 42,
      createdAt: "2026-01-01T00:00:00.000Z",
      rank: 3,
      personalBest: true,
      ranks: { day: 1, week: 2, all: 3 },
    };
    const { client, call } = makeClient(result);
    const r = await client.submitScore("g1", 42);
    expect(r.personalBest).toBe(true);
    expect(r.ranks).toEqual({ day: 1, week: 2, all: 3 });
    expect(call(0)).toMatchObject({ url: "http://api.test/api/games/g1/scores", method: "POST", body: { score: 42 } });
  });
});

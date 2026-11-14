import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import type { Leaderboard, ScoreSubmitResult, User } from "../api/types";
import { GamePlayer } from "../components/GamePlayer";
import { WebGameProviders } from "../WebGameApp";

const game = {
  id: "g1",
  title: "Space Dodge",
  width: 800,
  height: 600,
  playUrl: "/play/g1",
  version: 3,
  published: true,
  isOwner: false,
  leaderboard: { order: "asc" as const, format: "time" as const, label: "Best time" },
};
const me: User = { id: "u1", username: "bob", displayName: "Bob", avatarUrl: "/media/avatars/u1.png", bio: "", createdAt: "2026-01-01T00:00:00Z", role: "user" };

const lb: Leaderboard = {
  period: "week",
  periodStart: "2026-11-09T00:00:00.000Z",
  periodEnd: "2026-11-16T00:00:00.000Z",
  config: { order: "asc", format: "time", label: "Best time" },
  entries: [
    { id: "s1", user: { id: "u2", username: "alice", displayName: "", avatarUrl: "/media/avatars/u2.png" }, score: 83_456, createdAt: "", rank: 1 },
    { id: "s2", user: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: "/media/avatars/u1.png" }, score: 90_000, createdAt: "", rank: 2 },
  ],
  totalPlayers: 2,
  me: { id: "s2", user: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: "/media/avatars/u1.png" }, score: 90_000, createdAt: "", rank: 2 },
};

function post(source: MessageEventSource | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

async function flush(ms = 0) {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((r) => setTimeout(r, ms));
  });
}

async function setup({ loggedIn = true } = {}) {
  if (loggedIn) localStorage.setItem("webgame.token", "tok");
  const client = new ApiClient({ baseUrl: "http://api.test" });
  vi.spyOn(client, "me").mockResolvedValue(me);
  vi.spyOn(client, "recordPlay").mockResolvedValue({ plays: 1 });
  vi.spyOn(client, "listMyFavorites").mockResolvedValue({ items: [], total: 0, page: 1, perPage: 100 });
  vi.spyOn(client, "getSave").mockResolvedValue({ data: null, updatedAt: null });
  const getLb = vi.spyOn(client, "getLeaderboard").mockResolvedValue(lb);
  const submit = vi.spyOn(client, "submitScore");
  const onScore = vi.fn();
  const utils = render(
    <WebGameProviders config={{ apiBaseUrl: "http://api.test", routerMode: "browser" }} client={client}>
      <MemoryRouter>
        <GamePlayer game={game} onScoreSubmitted={onScore} />
      </MemoryRouter>
    </WebGameProviders>,
  );
  await flush();
  const iframe = utils.container.querySelector("iframe")!;
  const frameSpy = vi.spyOn(iframe.contentWindow!, "postMessage");
  return { ...utils, client, iframe, frameSpy, getLb, submit, onScore };
}

const sent = (spy: { mock: { calls: unknown[][] } }, type: string) =>
  spy.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((m) => m?.type === type);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GamePlayer leaderboard requests (F001)", () => {
  it("replies with a sanitised LeaderboardView", async () => {
    const { iframe, frameSpy, getLb } = await setup();
    post(iframe.contentWindow, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "week", limit: 5 });
    await flush();
    expect(getLb).toHaveBeenCalledWith("g1", { period: "week", limit: 25 });
    const [reply] = sent(frameSpy, "webgame:leaderboard");
    expect(reply).toEqual({
      type: "webgame:leaderboard",
      requestId: "lb-1",
      leaderboard: {
        period: "week",
        order: "asc",
        format: "time",
        label: "Best time",
        totalPlayers: 2,
        entries: [
          { rank: 1, name: "alice", score: 83_456, display: "1:23.456", isMe: false },
          { rank: 2, name: "Bob", score: 90_000, display: "1:30.000", isMe: true },
        ],
        me: { rank: 2, score: 90_000, display: "1:30.000" },
      },
    });
    const json = JSON.stringify(reply);
    expect(json).not.toMatch(/avatar|"u1"|"u2"|"s1"|tok/);
  });

  it("caches per period for 10s with one in-flight request, whatever the limit (N4)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { iframe, frameSpy, getLb } = await setup();
    const w = iframe.contentWindow;
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "day", limit: 5 });
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-2", period: "day", limit: 5.2 });
    await flush();
    expect(getLb).toHaveBeenCalledTimes(1);
    expect(sent(frameSpy, "webgame:leaderboard").map((m) => m.requestId)).toEqual(["lb-1", "lb-2"]);

    post(w, { type: "webgame:leaderboard-get", requestId: "lb-3", period: "day", limit: 5 });
    await flush();
    expect(getLb).toHaveBeenCalledTimes(1);

    // A different limit no longer creates a new cache key.
    for (let l = 1; l <= 25; l++) post(w, { type: "webgame:leaderboard-get", requestId: `lim-${l}`, period: "day", limit: l });
    await flush();
    expect(getLb).toHaveBeenCalledTimes(1);

    post(w, { type: "webgame:leaderboard-get", requestId: "lb-4", period: "week", limit: 6 });
    await flush();
    expect(getLb).toHaveBeenCalledTimes(2);
    expect(getLb).toHaveBeenLastCalledWith("g1", { period: "week", limit: 25 });

    await flush(10_001);
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-5", period: "day", limit: 5 });
    await flush();
    expect(getLb).toHaveBeenCalledTimes(3);
  });

  it("slices the cached 25-entry board to the requested limit (N4)", async () => {
    const { iframe, frameSpy, getLb } = await setup();
    const w = iframe.contentWindow;
    post(w, { type: "webgame:leaderboard-get", requestId: "a", period: "week", limit: 1 });
    await flush();
    post(w, { type: "webgame:leaderboard-get", requestId: "b", period: "week", limit: 25 });
    await flush();
    expect(getLb).toHaveBeenCalledTimes(1);
    const [a, b] = sent(frameSpy, "webgame:leaderboard") as { leaderboard: { entries: unknown[]; me: unknown; totalPlayers: number } }[];
    expect(a.leaderboard.entries).toHaveLength(1);
    expect(a.leaderboard.me).toEqual({ rank: 2, score: 90_000, display: "1:30.000" });
    expect(a.leaderboard.totalPlayers).toBe(2);
    expect(b.leaderboard.entries).toHaveLength(2);
  });

  it("throttles in-game API fetches per player instance and answers the excess locally (N4)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const { iframe, frameSpy, getLb, submit } = await setup();
    submit.mockResolvedValue({
      id: "s9",
      user: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null },
      score: 1,
      createdAt: "",
      rank: 1,
      personalBest: false,
    } as ScoreSubmitResult);
    const w = iframe.contentWindow;
    // Each score submit drops the cache, so every read would otherwise be a fresh API call.
    for (let i = 0; i < 14; i++) {
      post(w, { type: "webgame:leaderboard-get", requestId: `r-${i}`, period: "all", limit: 5 });
      await flush();
      post(w, { type: "webgame:score", score: i });
      await flush();
    }
    expect(getLb).toHaveBeenCalledTimes(10);
    const replies = sent(frameSpy, "webgame:leaderboard");
    expect(replies).toHaveLength(14);
    expect(replies.slice(10).every((m) => m.error === "rate_limited" && m.leaderboard === null)).toBe(true);

    await flush(10_001);
    post(w, { type: "webgame:leaderboard-get", requestId: "later", period: "all", limit: 5 });
    await flush();
    expect(getLb).toHaveBeenCalledTimes(11);
  });

  it("clamps the limit and ignores malformed requests", async () => {
    const { iframe, frameSpy, getLb } = await setup();
    const w = iframe.contentWindow;
    post(w, { type: "webgame:leaderboard-get", requestId: "", period: "week", limit: 5 });
    post(w, { type: "webgame:leaderboard-get", requestId: "x".repeat(65), period: "week", limit: 5 });
    post(w, { type: "webgame:leaderboard-get", requestId: 7, period: "week", limit: 5 });
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "month", limit: 5 });
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "week", limit: "5" });
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "week" });
    await flush();
    expect(getLb).not.toHaveBeenCalled();
    expect(sent(frameSpy, "webgame:leaderboard")).toEqual([]);

    post(w, { type: "webgame:leaderboard-get", requestId: "lb-2", period: "all", limit: 500 });
    post(w, { type: "webgame:leaderboard-get", requestId: "lb-3", period: "all", limit: -3 });
    await flush();
    expect(getLb).toHaveBeenCalledTimes(1);
    expect(getLb).toHaveBeenCalledWith("g1", { period: "all", limit: 25 });
    const replies = sent(frameSpy, "webgame:leaderboard") as { requestId: string; leaderboard: { entries: unknown[] } }[];
    expect(replies.map((r) => [r.requestId, r.leaderboard.entries.length])).toEqual([["lb-2", 2], ["lb-3", 1]]);
  });

  it("ignores messages from other sources", async () => {
    const { iframe, frameSpy, getLb } = await setup();
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    post(other.contentWindow, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "week", limit: 5 });
    post(window, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "week", limit: 5 });
    post(null, { type: "webgame:score", score: 5, requestId: "sc-1" });
    await flush();
    expect(getLb).not.toHaveBeenCalled();
    expect(frameSpy).not.toHaveBeenCalled();
    other.remove();
    expect(iframe).toBeTruthy();
  });

  it("replies error rate_limited / unavailable on failures", async () => {
    const { iframe, frameSpy, getLb } = await setup();
    getLb.mockRejectedValueOnce(new ApiError("rate_limited", "slow", 429)).mockRejectedValueOnce(new ApiError("internal", "x", 500));
    post(iframe.contentWindow, { type: "webgame:leaderboard-get", requestId: "lb-1", period: "week", limit: 5 });
    await flush();
    post(iframe.contentWindow, { type: "webgame:leaderboard-get", requestId: "lb-2", period: "week", limit: 5 });
    await flush();
    const replies = sent(frameSpy, "webgame:leaderboard");
    expect(replies[0]).toEqual({ type: "webgame:leaderboard", requestId: "lb-1", leaderboard: null, error: "rate_limited" });
    expect(replies[1]).toEqual({ type: "webgame:leaderboard", requestId: "lb-2", leaderboard: null, error: "unavailable" });
  });
});

describe("GamePlayer score results (F001)", () => {
  const result: ScoreSubmitResult = {
    id: "s9",
    user: { id: "u1", username: "bob", displayName: "Bob", avatarUrl: null },
    score: 83_456,
    createdAt: "",
    rank: 7,
    personalBest: true,
    ranks: { day: 2, week: 7, all: 41 },
  };

  it("anonymous score with requestId → error anonymous, and keeps the login toast", async () => {
    const { iframe, frameSpy, submit } = await setup({ loggedIn: false });
    post(iframe.contentWindow, { type: "webgame:score", score: 83_456, requestId: "sc-1" });
    expect(sent(frameSpy, "webgame:score-result")).toEqual([{ type: "webgame:score-result", requestId: "sc-1", result: null, error: "anonymous" }]);
    expect(submit).not.toHaveBeenCalled();
    expect(await screen.findByText("Log in to save your score to the leaderboard.")).toBeTruthy();
  });

  it("submits and replies with a ScoreResultView, toasting the personal best", async () => {
    const { iframe, frameSpy, submit, onScore } = await setup();
    submit.mockResolvedValue(result);
    post(iframe.contentWindow, { type: "webgame:score", score: 83_456, requestId: "sc-1" });
    await flush();
    expect(submit).toHaveBeenCalledWith("g1", 83_456);
    expect(sent(frameSpy, "webgame:score-result")).toEqual([
      {
        type: "webgame:score-result",
        requestId: "sc-1",
        result: { score: 83_456, display: "1:23.456", rank: 7, personalBest: true, ranks: { day: 2, week: 7, all: 41 } },
      },
    ]);
    expect(await screen.findByText("New personal best: 1:23.456")).toBeTruthy();
    expect(screen.getByText("#2 today · #7 this week · #41 all time")).toBeTruthy();
    expect(onScore).toHaveBeenCalledWith(result);
  });

  it("toasts Score saved when it is not a personal best; no reply without requestId", async () => {
    const { iframe, frameSpy, submit } = await setup();
    submit.mockResolvedValue({ ...result, personalBest: false });
    post(iframe.contentWindow, { type: "webgame:score", score: 83_456 });
    await flush();
    expect(await screen.findByText("Score saved: 1:23.456")).toBeTruthy();
    expect(sent(frameSpy, "webgame:score-result")).toEqual([]);
  });

  it("replies rate_limited / failed on submit errors", async () => {
    const { iframe, frameSpy, submit } = await setup();
    submit.mockRejectedValueOnce(new ApiError("rate_limited", "slow", 429)).mockRejectedValueOnce(new ApiError("validation", "bad", 422));
    post(iframe.contentWindow, { type: "webgame:score", score: 1, requestId: "sc-1" });
    await flush();
    post(iframe.contentWindow, { type: "webgame:score", score: 2, requestId: "sc-2" });
    await flush();
    expect(sent(frameSpy, "webgame:score-result")).toEqual([
      { type: "webgame:score-result", requestId: "sc-1", result: null, error: "rate_limited" },
      { type: "webgame:score-result", requestId: "sc-2", result: null, error: "failed" },
    ]);
  });
});

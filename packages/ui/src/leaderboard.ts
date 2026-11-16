// F001: leaderboard bridge between the parent page and untrusted game code (GAME_FORMAT.md § F001).
// The game only ever receives these sanitised views: no user ids, avatar URLs, tokens or raw API objects.
import type { Leaderboard, LeaderboardConfig, LeaderboardPeriod, ScoreSubmitResult } from "./api/types";
import { formatScore } from "./util";

export type LeaderboardViewEntry = { rank: number; name: string; score: number; display: string; isMe: boolean };

export type LeaderboardView = {
  period: LeaderboardPeriod;
  order: "desc" | "asc";
  format: "number" | "time";
  label: string;
  totalPlayers: number;
  entries: LeaderboardViewEntry[];
  me: { rank: number; score: number; display: string } | null;
  sample?: true;
};

export type ScoreResultView = {
  score: number;
  display: string;
  rank: number;
  personalBest: boolean;
  ranks: { day: number; week: number; all: number };
};

export const LEADERBOARD_PERIODS: readonly LeaderboardPeriod[] = ["day", "week", "all"];
export const DEFAULT_LEADERBOARD_CONFIG: LeaderboardConfig = { order: "desc", format: "number", label: "" };
/** In-game requests: `limit` is rounded and clamped to this range. */
export const GAME_LEADERBOARD_MAX_LIMIT = 25;

export function isLeaderboardPeriod(v: unknown): v is LeaderboardPeriod {
  return v === "day" || v === "week" || v === "all";
}

/** A valid `requestId` is a string of 1–64 chars. */
export function isRequestId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= 64;
}

/** Normalises a (possibly partial / missing) config from the API or a manifest. */
export function normalizeLeaderboardConfig(c: Partial<LeaderboardConfig> | null | undefined): LeaderboardConfig {
  return {
    order: c?.order === "asc" ? "asc" : "desc",
    format: c?.format === "time" ? "time" : "number",
    label: typeof c?.label === "string" ? c.label : "",
  };
}

/**
 * Validates a `webgame:leaderboard-get` message. Returns null for malformed requests (bad requestId,
 * unknown period, non-numeric limit); a numeric limit is rounded and clamped to 1–25.
 */
export function parseLeaderboardRequest(data: Record<string, unknown>): { requestId: string; period: LeaderboardPeriod; limit: number } | null {
  if (!isRequestId(data.requestId)) return null;
  if (!isLeaderboardPeriod(data.period)) return null;
  const l = data.limit;
  if (typeof l !== "number" || !Number.isFinite(l)) return null;
  const limit = Math.min(GAME_LEADERBOARD_MAX_LIMIT, Math.max(1, Math.round(l)));
  return { requestId: data.requestId, period: data.period, limit };
}

/** Returns `view` with at most `limit` entries (other fields unchanged). */
export function sliceLeaderboardView(view: LeaderboardView, limit: number): LeaderboardView {
  return view.entries.length <= limit ? view : { ...view, entries: view.entries.slice(0, Math.max(0, limit)) };
}

/** Builds the sanitised in-game view from an API `Leaderboard`. `viewerId` decides `isMe`. */
export function toLeaderboardView(lb: Leaderboard, viewerId: string | null | undefined, fallback?: Partial<LeaderboardConfig>): LeaderboardView {
  const cfg = normalizeLeaderboardConfig(lb.config ?? fallback);
  const entries = Array.isArray(lb.entries) ? lb.entries : [];
  return {
    period: isLeaderboardPeriod(lb.period) ? lb.period : "all",
    order: cfg.order,
    format: cfg.format,
    label: cfg.label,
    totalPlayers: typeof lb.totalPlayers === "number" ? lb.totalPlayers : entries.length,
    entries: entries.map((e) => ({
      rank: Number(e.rank) || 0,
      name: String(e.user?.displayName || e.user?.username || ""),
      score: Number(e.score),
      display: formatScore(Number(e.score), cfg.format),
      isMe: !!viewerId && e.user?.id === viewerId,
    })),
    me: lb.me ? { rank: Number(lb.me.rank) || 0, score: Number(lb.me.score), display: formatScore(Number(lb.me.score), cfg.format) } : null,
  };
}

/** Builds the in-game score result from `POST …/scores`. Tolerates v1 responses without `ranks`. */
export function toScoreResultView(r: ScoreSubmitResult, format: "number" | "time"): ScoreResultView {
  const ranks = r.ranks ?? { day: 0, week: 0, all: 0 };
  return {
    score: Number(r.score),
    display: formatScore(Number(r.score), format),
    rank: Number(r.rank) || 0,
    personalBest: !!r.personalBest,
    ranks: { day: Number(ranks.day) || 0, week: Number(ranks.week) || 0, all: Number(ranks.all) || 0 },
  };
}

/** Toast text for a saved score (spec F001 §2). */
export function scoreToastText(r: ScoreSubmitResult, format: "number" | "time"): { title: string; message: string | undefined } {
  const display = formatScore(Number(r.score), format);
  const title = r.personalBest ? `New personal best: ${display}` : `Score saved: ${display}`;
  const k = r.ranks;
  const message =
    k && k.day && k.week && k.all
      ? `#${k.day} today · #${k.week} this week · #${k.all} all time`
      : r.rank
        ? `You're #${r.rank} on the leaderboard.`
        : undefined;
  return { title, message };
}

/**
 * Deterministic sample board for the Studio preview: "Player 1"…"Player 5", best first per `order`,
 * scores matching `format`, `me: null`, `sample: true`.
 */
export function sampleLeaderboardView(period: LeaderboardPeriod, limit: number, config?: Partial<LeaderboardConfig>): LeaderboardView {
  const cfg = normalizeLeaderboardConfig(config);
  const n = Math.min(5, Math.max(1, Math.round(limit) || 5));
  const scores = Array.from({ length: 5 }, (_, i) =>
    cfg.format === "time"
      ? cfg.order === "asc"
        ? 45_250 + i * 7_125 // 0:45.250, 0:52.375, …
        : 180_000 - i * 15_500
      : cfg.order === "asc"
        ? 120 + i * 35
        : 5_000 - i * 750,
  );
  return {
    period,
    order: cfg.order,
    format: cfg.format,
    label: cfg.label,
    totalPlayers: 5,
    entries: scores.slice(0, n).map((score, i) => ({ rank: i + 1, name: `Player ${i + 1}`, score, display: formatScore(score, cfg.format), isMe: false })),
    me: null,
    sample: true,
  };
}

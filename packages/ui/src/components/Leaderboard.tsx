import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import type { LeaderboardConfig, LeaderboardPeriod, Score } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { formatScore, formatTimeUntil, useAsync } from "../util";
import { isLeaderboardPeriod, normalizeLeaderboardConfig } from "../leaderboard";
import { Avatar, LoadError, Skeleton } from "./common";
import { TabPanel, Tabs, type TabItem } from "./Tabs";

/** localStorage key remembering the last selected period tab. */
export const LEADERBOARD_PERIOD_KEY = "webgame.lb.period";

const TABS: TabItem<LeaderboardPeriod>[] = [
  { value: "day", label: "Today" },
  { value: "week", label: "This week" },
  { value: "all", label: "All time" },
];

const EMPTY_TEXT: Record<LeaderboardPeriod, string> = {
  day: "No scores today yet — be the first!",
  week: "No scores this week yet — be the first!",
  all: "No scores yet — be the first!",
};

function readPeriod(): LeaderboardPeriod {
  try {
    const v = localStorage.getItem(LEADERBOARD_PERIOD_KEY);
    if (isLeaderboardPeriod(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return "week";
}

function writePeriod(p: LeaderboardPeriod) {
  try {
    localStorage.setItem(LEADERBOARD_PERIOD_KEY, p);
  } catch {
    /* storage unavailable */
  }
}

export type LeaderboardProps = {
  gameId: string;
  /** F001: the game's leaderboard semantics (`Game.leaderboard`). Defaults when omitted. */
  config?: LeaderboardConfig;
  limit?: number;
  /** Change to reload (e.g. after a score was submitted). */
  refreshKey?: number;
};

/** Per-period leaderboard (Today · This week · All time) with the viewer's own row and a player count. */
export function Leaderboard({ gameId, config, limit = 10, refreshKey = 0 }: LeaderboardProps) {
  const api = useApi();
  const { user } = useAuth();
  const [period, setPeriod] = useState<LeaderboardPeriod>(readPeriod);
  const tabsId = `pf-lb-${useId().replace(/[^\w-]/g, "")}`;
  const { data, loading, error, reload } = useAsync(() => api.getLeaderboard(gameId, { period, limit }), [api, gameId, period, limit, refreshKey]);
  // Re-render once a minute so "resets in" stays fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const shown = data && data.period === period ? data : undefined;
  const cfg = normalizeLeaderboardConfig(shown?.config ?? config);
  const label = cfg.label.trim();
  const selectPeriod = (p: LeaderboardPeriod) => {
    setPeriod(p);
    writePeriod(p);
  };

  const entries = shown?.entries ?? [];
  const me = shown?.me ?? null;
  const meOutside = !!me && !entries.some((e) => e.user.id === me.user.id);
  const isMe = (s: Score) => (!!user && s.user.id === user.id) || (!!me && s.user.id === me.user.id);
  const resetsIn = shown && period !== "all" ? formatTimeUntil(shown.periodEnd) : null;

  const row = (s: Score, key: string) => (
    <li key={key} className={isMe(s) ? "is-me" : undefined}>
      <span className={`pf-leaderboard__rank pf-rank-${s.rank}`}>{s.rank}</span>
      <Link to={`/u/${encodeURIComponent(s.user.username)}`} className="pf-leaderboard__user">
        <Avatar user={s.user} size={22} />
        <span>{s.user.displayName || s.user.username}</span>
      </Link>
      <span className="pf-leaderboard__score">{formatScore(s.score, cfg.format)}</span>
    </li>
  );

  return (
    <section className="pf-panel pf-lb" aria-labelledby="pf-lb-title">
      <h2 id="pf-lb-title" className="pf-panel__title">
        <span aria-hidden="true">🏆</span> {label || "Leaderboard"}
      </h2>
      <Tabs id={tabsId} className="pf-lb__tabs" label="Leaderboard period" items={TABS} value={period} onChange={selectPeriod} />
      <TabPanel id={tabsId} value={period}>
      {loading && !shown ? (
        <ol className="pf-leaderboard" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i}>
              <Skeleton width="100%" height={28} />
            </li>
          ))}
        </ol>
      ) : error ? (
        <LoadError message="Couldn't load scores." onRetry={reload} />
      ) : !shown || entries.length === 0 ? (
        <p className="pf-muted pf-small">{EMPTY_TEXT[period]}</p>
      ) : (
        <>
          {label && (
            <div className="pf-lb__head pf-small pf-muted" aria-hidden="true">
              <span>Player</span>
              <span>{label}</span>
            </div>
          )}
          <ol className="pf-leaderboard">{entries.map((s) => row(s, s.id))}</ol>
          {meOutside && me && (
            <>
              <div className="pf-lb__divider" role="separator" aria-label="Your best" />
              <ol className="pf-leaderboard pf-lb__me">{row(me, `me-${me.id}`)}</ol>
            </>
          )}
        </>
      )}
      {shown && (
        <p className="pf-lb__footer pf-small pf-muted">
          {shown.totalPlayers.toLocaleString()} {shown.totalPlayers === 1 ? "player" : "players"}
          {resetsIn ? ` · resets in ${resetsIn}` : ""}
        </p>
      )}
      </TabPanel>
    </section>
  );
}

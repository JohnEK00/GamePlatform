import { Link } from "react-router-dom";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useAsync } from "../util";
import { Avatar, Skeleton } from "./common";

/** Top scores for a game. Change `refreshKey` to reload (e.g. after a score was submitted). */
export function Leaderboard({ gameId, limit = 10, refreshKey = 0 }: { gameId: string; limit?: number; refreshKey?: number }) {
  const api = useApi();
  const { user } = useAuth();
  const { data, loading, error } = useAsync(() => api.listScores(gameId, limit), [api, gameId, limit, refreshKey]);

  return (
    <section className="pf-panel" aria-labelledby="pf-lb-title">
      <h2 id="pf-lb-title" className="pf-panel__title">
        <span aria-hidden="true">🏆</span> Leaderboard
      </h2>
      {loading && !data ? (
        <ol className="pf-leaderboard">
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i}>
              <Skeleton width="100%" height={28} />
            </li>
          ))}
        </ol>
      ) : error ? (
        <p className="pf-muted pf-small">Couldn't load scores.</p>
      ) : !data || data.length === 0 ? (
        <p className="pf-muted pf-small">No scores yet — be the first!</p>
      ) : (
        <ol className="pf-leaderboard">
          {data.map((s) => (
            <li key={s.id} className={user?.id === s.user.id ? "is-me" : undefined}>
              <span className={`pf-leaderboard__rank pf-rank-${s.rank}`}>{s.rank}</span>
              <Link to={`/u/${encodeURIComponent(s.user.username)}`} className="pf-leaderboard__user">
                <Avatar user={s.user} size={22} />
                <span>{s.user.displayName || s.user.username}</span>
              </Link>
              <span className="pf-leaderboard__score">{s.score.toLocaleString()}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

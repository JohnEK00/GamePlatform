import { Link, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import { useApi } from "../context/config";
import { EmptyState, ErrorState, Skeleton, StarsDisplay, Thumbnail } from "../components/common";
import { PlaysChart } from "../components/PlaysChart";
import { formatCount, useAsync, useDocumentTitle } from "../util";
import { NotFoundPage } from "./NotFoundPage";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="pf-stat">
      <span className="pf-stat__value">{value}</span>
      <span className="pf-stat__label">{label}</span>
    </div>
  );
}

/** Owner-only analytics for one game: totals + 30-day plays (GET /api/games/{id}/stats). */
export function GameStatsPage() {
  const { id = "" } = useParams();
  const api = useApi();
  const game = useAsync(() => api.getGame(id), [api, id]);
  const isOwner = !!game.data?.isOwner;
  const stats = useAsync(() => (isOwner ? api.getGameStats(id) : Promise.resolve(null)), [api, id, isOwner]);
  useDocumentTitle(game.data ? `Stats · ${game.data.title}` : "Stats");

  if (game.error && isApiError(game.error) && game.error.status === 404) return <NotFoundPage what="game" />;
  if (game.error)
    return (
      <div className="pf-container pf-page">
        <ErrorState error={game.error} onRetry={game.reload} />
      </div>
    );
  const g = game.data;
  if (g && !g.isOwner)
    return (
      <div className="pf-container pf-page">
        <EmptyState
          icon="🔒"
          title="Only the owner can see these stats"
          action={
            <Link to={`/games/${g.id}`} className="pf-btn">
              Back to the game
            </Link>
          }
        />
      </div>
    );

  const s = stats.data;
  return (
    <div className="pf-container pf-page">
      <header className="pf-pagehead pf-pagehead--row pf-statshead">
        {g ? (
          <div className="pf-statshead__game">
            <Link to={`/games/${g.id}`} className="pf-statshead__thumb" tabIndex={-1} aria-hidden="true">
              <Thumbnail src={g.thumbnailUrl} seed={g.id} alt="" />
            </Link>
            <div>
              <p className="pf-eyebrow">Game stats</p>
              <h1>{g.title}</h1>
              <p className="pf-muted pf-small">
                {g.published ? "Published" : "Draft"} · v{g.version}
              </p>
            </div>
          </div>
        ) : (
          <Skeleton width={320} height={64} />
        )}
        {g && (
          <div className="pf-row">
            <Link to={`/games/${g.id}`} className="pf-btn pf-btn--ghost">
              View game
            </Link>
            <Link to={`/games/${g.id}/edit`} className="pf-btn">
              Edit
            </Link>
          </div>
        )}
      </header>

      {stats.error ? (
        <ErrorState error={stats.error} onRetry={stats.reload} />
      ) : !s ? (
        <>
          <div className="pf-stats pf-stats--auto">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={76} />
            ))}
          </div>
          <Skeleton height={240} />
        </>
      ) : (
        <>
          <div className="pf-stats pf-stats--auto">
            <Stat label="Plays" value={formatCount(s.plays)} />
            <Stat label="Unique players" value={formatCount(s.uniquePlayers)} />
            <Stat label="Favorites" value={formatCount(s.favorites)} />
            <Stat label="Comments" value={formatCount(s.comments)} />
            <div className="pf-stat">
              <span className="pf-stat__value">{g && g.ratingCount ? g.ratingAvg.toFixed(2) : "–"}</span>
              <span className="pf-stat__label">
                Rating {g && g.ratingCount ? <StarsDisplay value={g.ratingAvg} count={g.ratingCount} /> : null}
              </span>
            </div>
          </div>
          <section className="pf-panel pf-dash-chart" aria-label="Plays over the last 30 days">
            <PlaysChart daily={s.daily} />
          </section>
          <p className="pf-muted pf-small">
            Days are UTC. Unique players counts signed-in players with a score, save or achievement.
          </p>
        </>
      )}
    </div>
  );
}

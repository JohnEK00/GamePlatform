import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { GameSummary } from "../api/types";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { EmptyState, ErrorState, Pagination, Skeleton, StarsDisplay, Thumbnail } from "../components/common";
import { PlaysChart } from "../components/PlaysChart";
import { errorMessage, formatCount, formatDate, useAsync, useDocumentTitle } from "../util";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="pf-stat">
      <span className="pf-stat__value">{value}</span>
      <span className="pf-stat__label">{label}</span>
    </div>
  );
}

function Row({ game, onChange }: { game: GameSummary; onChange: (g: GameSummary) => void }) {
  const api = useApi();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      const g = await api.updateGame(game.id, { published: !game.published });
      onChange(g);
      toast.success(g.published ? "Published" : "Unpublished", g.title);
    } catch (e) {
      toast.error("Couldn't update game", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="pf-dashrow">
      <Link to={`/games/${game.id}`} className="pf-dashrow__thumb" tabIndex={-1} aria-hidden="true">
        <Thumbnail src={game.thumbnailUrl} seed={game.id} alt="" />
      </Link>
      <div className="pf-dashrow__info">
        <Link to={`/games/${game.id}`} className="pf-dashrow__title">
          {game.title}
        </Link>
        <span className="pf-muted pf-small">Updated {formatDate(game.updatedAt)}</span>
      </div>
      <div className="pf-dashrow__stats">
        <span title="Plays">▶ {formatCount(game.plays)}</span>
        <span title="Favorites">♥ {formatCount(game.favorites ?? 0)}</span>
        {game.ratingCount ? <StarsDisplay value={game.ratingAvg} count={game.ratingCount} /> : <span className="pf-muted">No ratings</span>}
      </div>
      <label className="pf-switch pf-switch--compact">
        <input type="checkbox" checked={game.published} disabled={busy} onChange={toggle} />
        <span className="pf-switch__track" aria-hidden="true" />
        <span className="pf-small">{game.published ? "Published" : "Draft"}</span>
      </label>
      <Link to={`/games/${game.id}/stats`} className="pf-btn pf-btn--sm pf-btn--ghost">
        Stats
      </Link>
      <Link to={`/games/${game.id}/edit`} className="pf-btn pf-btn--sm pf-btn--ghost">
        Edit
      </Link>
    </li>
  );
}

const PER_PAGE = 50;

export function DashboardPage() {
  const api = useApi();
  useDocumentTitle("My games");
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const { data, loading, error, reload, setData } = useAsync(
    () => api.listGames({ owner: "me", sort: "new", page, perPage: PER_PAGE }),
    [api, page],
  );
  // Exact totals across all your games + 30-day plays (GET /api/users/me/stats).
  const stats = useAsync(() => api.getMyStats(), [api]);
  const games = data?.items ?? [];
  const total = data?.total ?? games.length;
  const perPage = data?.perPage || PER_PAGE;
  const goToPage = (p: number) => {
    const next = new URLSearchParams(params);
    if (p === 1) next.delete("page");
    else next.set("page", String(p));
    setParams(next);
    window.scrollTo?.({ top: 0, behavior: "smooth" });
  };
  const t = stats.data?.totals;
  const dash = "–";

  return (
    <div className="pf-container pf-page">
      <header className="pf-pagehead pf-pagehead--row">
        <div>
          <h1>My games</h1>
          <p className="pf-muted">Manage your uploads, publish drafts and see how they're doing.</p>
        </div>
        <Link to="/upload" className="pf-btn pf-btn--primary">
          + Upload a game
        </Link>
      </header>

      <div className="pf-stats pf-stats--auto">
        {stats.loading && !stats.data ? (
          [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={76} />)
        ) : (
          <>
            <Stat label="Games" value={t ? String(t.games) : String(total)} />
            <Stat label="Published" value={t ? String(t.published) : dash} />
            <Stat label="Total plays" value={t ? formatCount(t.plays) : dash} />
            <Stat label="Favorites" value={t ? formatCount(t.favorites) : dash} />
            <Stat label="Comments" value={t ? formatCount(t.comments) : dash} />
            <Stat
              label={t && t.ratingCount ? `Avg rating (${formatCount(t.ratingCount)})` : "Avg rating"}
              value={t && t.ratingCount ? t.ratingAvg.toFixed(2) : dash}
            />
          </>
        )}
      </div>
      {stats.error ? (
        <p className="pf-muted pf-small">
          Couldn't load your stats: {errorMessage(stats.error)}{" "}
          <button type="button" className="pf-linkbtn" onClick={stats.reload}>
            Retry
          </button>
        </p>
      ) : stats.data ? (
        <section className="pf-panel pf-dash-chart" aria-label="Plays over the last 30 days">
          <PlaysChart daily={stats.data.daily} title="Plays per day · last 30 days (all your games)" />
        </section>
      ) : (
        <Skeleton height={240} />
      )}

      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : loading && !data ? (
        <ul className="pf-dashlist">
          {[0, 1, 2].map((i) => (
            <li key={i} className="pf-dashrow">
              <Skeleton height={56} width="100%" />
            </li>
          ))}
        </ul>
      ) : total === 0 ? (
        <EmptyState
          icon="📦"
          title="You haven't uploaded any games yet"
          action={
            <>
              <Link to="/upload" className="pf-btn pf-btn--primary">
                Upload a game
              </Link>{" "}
              <Link to="/docs" className="pf-btn pf-btn--ghost">
                Learn how
              </Link>
            </>
          }
        >
          Build something small with the Pixelforge engine and share it with the world.
        </EmptyState>
      ) : (
        <ul className="pf-dashlist">
          {games.map((g) => (
            <Row
              key={g.id}
              game={g}
              onChange={(ng) => {
                setData((d) => ({ ...d!, items: d!.items.map((x) => (x.id === ng.id ? { ...x, ...ng } : x)) }));
                stats.reload();
              }}
            />
          ))}
        </ul>
      )}

      {data && !error && (
        <Pagination page={page} total={data.total} perPage={perPage} onPage={goToPage} />
      )}
    </div>
  );
}

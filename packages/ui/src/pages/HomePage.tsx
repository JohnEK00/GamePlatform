import { Link, useSearchParams } from "react-router-dom";
import type { GameSort } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { EmptyState, ErrorState, Pagination, Skeleton, StarsDisplay, TagChip, Thumbnail } from "../components/common";
import { GameGrid } from "../components/GameCard";
import { formatCount, useAsync, useDocumentTitle } from "../util";

const SORTS: { key: GameSort; label: string }[] = [
  { key: "new", label: "New" },
  { key: "trending", label: "Trending" },
  { key: "popular", label: "Popular" },
  { key: "top", label: "Top rated" },
  { key: "favorites", label: "Most favorited" },
];
const PER_PAGE = 24;
const TRENDING_SHELF_SIZE = 8;

/** F003: "Trending this week" shelf. Hidden while nothing has weekly plays, and silently on errors. */
function TrendingShelf() {
  const api = useApi();
  const { data, loading, error } = useAsync(() => api.listGames({ sort: "trending", perPage: TRENDING_SHELF_SIZE }), [api]);
  // Older servers may omit playsWeek: treat it as 0 (=> no shelf).
  const items = (data?.items ?? []).filter((g) => (g.playsWeek ?? 0) > 0);
  if (error || (!loading && items.length === 0)) return null;
  return (
    <section className="pf-shelf" aria-labelledby="pf-trending-title">
      <div className="pf-shelf__head">
        <h2 id="pf-trending-title" className="pf-section-title">
          Trending this week
        </h2>
        <Link to="/?sort=trending" className="pf-shelf__more">
          See all →
        </Link>
      </div>
      <GameGrid games={items} loading={loading} skeletons={TRENDING_SHELF_SIZE} highlight="trending" />
    </section>
  );
}

function Featured() {
  const api = useApi();
  const { data, loading } = useAsync(() => api.listGames({ sort: "top", perPage: 4 }), [api]);
  if (!loading && (!data || data.items.length === 0)) return null;
  const [hero, ...rest] = data?.items ?? [];
  return (
    <section className="pf-featured" aria-labelledby="pf-featured-title">
      <h2 id="pf-featured-title" className="pf-section-title">
        Featured
      </h2>
      {loading || !hero ? (
        <div className="pf-featured__grid">
          <Skeleton className="pf-featured__hero" height={260} />
          <div className="pf-featured__side">
            <Skeleton height={80} />
            <Skeleton height={80} />
            <Skeleton height={80} />
          </div>
        </div>
      ) : (
        <div className="pf-featured__grid">
          <Link to={`/games/${hero.id}`} className="pf-featured__hero">
            <Thumbnail src={hero.thumbnailUrl} seed={hero.id} alt="" />
            <div className="pf-featured__info">
              <span className="pf-badge">#1 top rated</span>
              <h3>{hero.title}</h3>
              <p>{hero.description.slice(0, 140)}{hero.description.length > 140 ? "…" : ""}</p>
              <div className="pf-featured__meta">
                <StarsDisplay value={hero.ratingAvg} count={hero.ratingCount} />
                <span>▶ {formatCount(hero.plays)} plays</span>
              </div>
            </div>
          </Link>
          <div className="pf-featured__side">
            {rest.map((g) => (
              <Link key={g.id} to={`/games/${g.id}`} className="pf-featured__item">
                <Thumbnail src={g.thumbnailUrl} seed={g.id} alt="" />
                <div>
                  <strong>{g.title}</strong>
                  <span className="pf-muted pf-small">by {g.owner.displayName || g.owner.username}</span>
                  <StarsDisplay value={g.ratingAvg} count={g.ratingCount} />
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function HomePage() {
  const api = useApi();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const sortParam = params.get("sort");
  const sort: GameSort = SORTS.some((s) => s.key === sortParam) ? (sortParam as GameSort) : "new";
  const page = Math.max(1, Number(params.get("page")) || 1);
  useDocumentTitle(q ? `Search: ${q}` : tag ? `#${tag}` : "");

  const tags = useAsync(() => api.listTags(), [api]);
  const games = useAsync(() => api.listGames({ q, tag, sort, page, perPage: PER_PAGE }), [api, q, tag, sort, page]);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in patch)) next.delete("page");
    setParams(next);
  };

  const filtered = !!(q || tag);
  const showHero = !filtered && page === 1;

  return (
    <div className="pf-container pf-page">
      {showHero && (
        <section className="pf-hero">
          <div className="pf-hero__text">
            <p className="pf-eyebrow">Indie games, forged in the browser</p>
            <h1>
              Play something <span className="pf-gradient-text">new</span> today.
            </h1>
            <p className="pf-hero__lead">
              Pixelforge Arcade hosts tiny WebGL games made by people like you. Play instantly — no installs — rate your
              favourites, chase the leaderboards, and ship your own in minutes.
            </p>
            <div className="pf-hero__cta">
              <button
                type="button"
                className="pf-btn pf-btn--primary pf-btn--lg"
                onClick={() => document.getElementById("pf-browse")?.scrollIntoView?.({ behavior: "smooth" })}
              >
                Start playing
              </button>
              <Link to={user ? "/upload" : "/docs"} className="pf-btn pf-btn--ghost pf-btn--lg">
                {user ? "Upload a game" : "Make a game"}
              </Link>
            </div>
          </div>
          <div className="pf-hero__art" aria-hidden="true">
            <div className="pf-hero__screen">
              <span>PRESS START</span>
            </div>
          </div>
        </section>
      )}

      {showHero && <Featured />}

      {showHero && <TrendingShelf />}

      <section id="pf-browse" className="pf-browse" aria-labelledby="pf-browse-title">
        <div className="pf-browse__head">
          <h2 id="pf-browse-title" className="pf-section-title">
            {q ? (
              <>
                Results for “{q}”
              </>
            ) : tag ? (
              <>#{tag}</>
            ) : (
              "Browse games"
            )}
            {games.data && <span className="pf-muted pf-section-title__count">{games.data.total}</span>}
          </h2>
          <div className="pf-tabs" role="tablist" aria-label="Sort games">
            {SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={sort === s.key}
                className={`pf-tab${sort === s.key ? " is-active" : ""}`}
                onClick={() => update({ sort: s.key === "new" ? null : s.key })}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="pf-chips" aria-label="Filter by tag">
          {tags.loading && !tags.data
            ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} width={70} height={28} radius={14} />)
            : (
              <>
                <TagChip tag="all" active={!tag} onClick={() => update({ tag: null })} />
                {(tags.data ?? []).map((t) => (
                  <TagChip key={t.tag} tag={t.tag} active={t.tag === tag} onClick={() => update({ tag: t.tag === tag ? null : t.tag })} />
                ))}
              </>
            )}
        </div>

        {(q || tag) && (
          <p className="pf-filters">
            {q && (
              <button type="button" className="pf-chip pf-chip--removable" onClick={() => update({ q: null })}>
                “{q}” ×
              </button>
            )}
            {tag && (
              <button type="button" className="pf-chip pf-chip--removable" onClick={() => update({ tag: null })}>
                #{tag} ×
              </button>
            )}
          </p>
        )}

        {games.error ? (
          <ErrorState error={games.error} onRetry={games.reload} />
        ) : !games.loading && games.data && games.data.items.length === 0 ? (
          <EmptyState
            icon="🕹"
            title={filtered ? "No games match" : "No games yet"}
            action={
              filtered ? (
                <button type="button" className="pf-btn" onClick={() => setParams(new URLSearchParams())}>
                  Clear filters
                </button>
              ) : (
                <Link to="/upload" className="pf-btn pf-btn--primary">
                  Upload the first one
                </Link>
              )
            }
          >
            {filtered ? "Try another search or tag." : "The arcade is empty. Be the first to ship a game!"}
          </EmptyState>
        ) : (
          <GameGrid games={games.data?.items} loading={games.loading} highlight={sort === "trending" ? "trending" : undefined} />
        )}

        {games.data && (
          <Pagination
            page={page}
            total={games.data.total}
            perPage={games.data.perPage || PER_PAGE}
            onPage={(p) => {
              update({ page: p === 1 ? null : String(p) });
              document.getElementById("pf-browse")?.scrollIntoView?.({ behavior: "smooth" });
            }}
          />
        )}
      </section>
    </div>
  );
}

import { useCallback, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import type { GameSummary, Page } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { EmptyState, Skeleton, StarsDisplay, Thumbnail } from "../components/common";
import { CollectionsShelf, CreatorSpotlightSection, GameShelf, TagsSection } from "../components/HomeSections";
import { BROWSE_PATH, browsePath, HOME_SHELF_SIZE, legacyHomeRedirect } from "../home";
import { formatCount, useAsync, useDocumentTitle } from "../util";

const TRENDING_SHELF_SIZE = 8;
const ELLIPSIS = String.fromCodePoint(0x2026);
const PLAY = String.fromCodePoint(0x25b6);
const JOYSTICK = String.fromCodePoint(0x1f579);

/** F003: only items with weekly plays (older servers omit playsWeek: treat it as 0). */
const hasWeeklyPlays = (g: GameSummary) => (g.playsWeek ?? 0) > 0;

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
              <p>
                {hero.description.slice(0, 140)}
                {hero.description.length > 140 ? ELLIPSIS : ""}
              </p>
              <div className="pf-featured__meta">
                <StarsDisplay value={hero.ratingAvg} count={hero.ratingCount} />
                <span>
                  {PLAY} {formatCount(hero.plays)} plays
                </span>
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

function Hero() {
  const { user } = useAuth();
  return (
    <section className="pf-hero">
      <div className="pf-hero__text">
        <p className="pf-eyebrow">Indie games, forged in the browser</p>
        <h1>
          Play something <span className="pf-gradient-text">new</span> today.
        </h1>
        <p className="pf-hero__lead">
          Pixelforge Arcade hosts tiny WebGL games made by people like you. Play instantly {String.fromCodePoint(0x2014)} no
          installs {String.fromCodePoint(0x2014)} rate your favourites, chase the leaderboards, and ship your own in minutes.
        </p>
        <div className="pf-hero__cta">
          <Link className="pf-btn pf-btn--primary pf-btn--lg" to={BROWSE_PATH}>
            Start playing
          </Link>
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
  );
}

const NEW_QUERY = { sort: "new", perPage: HOME_SHELF_SIZE } as const;
const UPDATED_QUERY = { sort: "updated", perPage: HOME_SHELF_SIZE } as const;
const TRENDING_QUERY = { sort: "trending", perPage: TRENDING_SHELF_SIZE } as const;

/** F032 `/`: the sectioned discover page (spec section 0.1). Every request starts in parallel on mount. */
function Home() {
  useDocumentTitle("");
  const [empty, setEmpty] = useState(false);
  // New releases drives the empty-platform rule: with no games at all, only the hero and an invitation remain.
  const onNewLoaded = useCallback((p: Page<GameSummary>) => setEmpty(p.total === 0), []);

  return (
    <div className="pf-container pf-page pf-home">
      <Hero />
      {empty ? (
        <EmptyState
          icon={JOYSTICK}
          title="No games yet"
          action={
            <Link className="pf-btn pf-btn--primary" to="/upload">
              Upload the first one
            </Link>
          }
        >
          The arcade is empty. Be the first to ship a game!
        </EmptyState>
      ) : (
        <>
          <Featured />
          <GameShelf
            id="pf-trending-title"
            title="Trending this week"
            seeAll={browsePath({ sort: "trending" })}
            query={TRENDING_QUERY}
            size={TRENDING_SHELF_SIZE}
            highlight="trending"
            filter={hasWeeklyPlays}
          />
          <GameShelf id="pf-home-new-title" title="New releases" seeAll={BROWSE_PATH} query={NEW_QUERY} size={HOME_SHELF_SIZE} onLoaded={onNewLoaded} />
          <CreatorSpotlightSection />
          <GameShelf
            id="pf-home-updated-title"
            title="Recently updated"
            seeAll={browsePath({ sort: "updated" })}
            query={UPDATED_QUERY}
            size={HOME_SHELF_SIZE}
          />
          <CollectionsShelf />
          <TagsSection />
        </>
      )}
    </div>
  );
}

/**
 * `/`. Old links to the grid (`/?q=`, `?tag=`, `?sort=`, `?page=`) are sent to `/browse` with the same query,
 * replacing the history entry so Back never returns to the redirecting URL (spec section 0.8).
 */
export function HomePage() {
  const { search } = useLocation();
  const redirect = legacyHomeRedirect(search);
  if (redirect) return <Navigate replace to={redirect} />;
  return <Home />;
}

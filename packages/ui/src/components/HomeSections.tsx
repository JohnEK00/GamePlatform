// F032: the sections of the home page `/` (spec section 0.1-0.6). Each one fetches on mount, shows its heading
// and skeletons while loading, and hides silently on errors and when it has nothing to show.

import { useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import type { GameSummary, ListGamesQuery, Page } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { isValidCreator } from "../creators";
import { BROWSE_PATH, browsePath, HOME_COLLECTIONS_SIZE, HOME_TAGS_MAX, isValidSpotlight } from "../home";
import { useAsync } from "../util";
import { CollectionGrid } from "./CollectionCard";
import { Skeleton, TagChip } from "./common";
import { CreatorCard, CreatorCardSkeleton } from "./CreatorCard";
import { useFollows } from "./Follow";
import { GameGrid, type GameCardHighlight } from "./GameCard";

/** "See all ->" (ASCII-safe source: the arrow is built from its code point). */
const ARROW = String.fromCodePoint(0x2192);
export const SEE_ALL_LABEL = `See all ${ARROW}`;
export const SEE_ALL_CREATORS_LABEL = `See all creators ${ARROW}`;

export type GameShelfProps = {
  /** The h2's id; the section is labelled by it. */
  id: string;
  title: string;
  /** Target of the head's `See all ->` link; omitted = no link. */
  seeAll?: string;
  /** Passed to `listGames` as is. */
  query: ListGamesQuery;
  /** Skeleton count while loading (and the most cards shown). */
  size: number;
  highlight?: GameCardHighlight;
  /** Keeps only matching items (e.g. Trending: `playsWeek > 0`). */
  filter?: (g: GameSummary) => boolean;
  /** Called once per successful response (the home page reads New releases' `total` for the empty-platform rule). */
  onLoaded?: (page: Page<GameSummary>) => void;
};

/** A titled row of game cards from one `listGames` query (F003 `.pf-shelf`). Hidden on errors and when empty. */
export function GameShelf({ id, title, seeAll, query, size, highlight, filter, onLoaded }: GameShelfProps) {
  const api = useApi();
  const key = JSON.stringify(query);
  const { data, loading, error } = useAsync(() => api.listGames(query), [api, key]);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  useEffect(() => {
    if (data) onLoadedRef.current?.(data);
  }, [data]);
  const items = useMemo(() => {
    const all = Array.isArray(data?.items) ? data.items : [];
    return (filter ? all.filter(filter) : all).slice(0, size);
  }, [data, filter, size]);
  if (error || (!loading && items.length === 0)) return null;
  return (
    <section className="pf-shelf pf-home-shelf" aria-labelledby={id}>
      <div className="pf-shelf__head">
        <h2 id={id} className="pf-section-title">
          {title}
        </h2>
        {seeAll && (
          <Link to={seeAll} className="pf-shelf__more">
            {SEE_ALL_LABEL}
          </Link>
        )}
      </div>
      <GameGrid games={items} loading={loading} skeletons={size} highlight={highlight} />
    </section>
  );
}

/** Games shown beside the spotlight card. */
const SPOTLIGHT_GAMES = 3;

/**
 * F032 Creator spotlight: today's creator (the F035 card, h3 name) and up to 3 of their games. Seeds the F002
 * follow store from the creator like `CreatorsPage`. Hidden on errors, invalid responses and `creator: null`.
 */
export function CreatorSpotlightSection() {
  const api = useApi();
  const { token } = useAuth();
  const follows = useFollows();
  // `isFollowing` is per viewer: signing in or out reloads it.
  const { data, loading, error } = useAsync(() => api.getCreatorSpotlight(), [api, token]);
  const spotlight = !loading && isValidSpotlight(data) ? data : null;
  const creator = spotlight?.creator && isValidCreator(spotlight.creator) ? spotlight.creator : null;
  const games = useMemo(() => (spotlight ? spotlight.games.slice(0, SPOTLIGHT_GAMES) : []), [spotlight]);

  const seed = follows?.seed;
  const peek = follows?.peek;
  const seeded = useRef<unknown>(null);
  useEffect(() => {
    if (!seed || !peek || !creator) return;
    // Fresh server data always wins; otherwise only refill a store that has forgotten this user.
    const fresh = seeded.current !== creator;
    seeded.current = creator;
    if (fresh || peek(creator.user.username) === undefined) {
      seed(creator.user.username, { following: creator.isFollowing, followers: creator.followers });
    }
  }, [creator, seed, peek]);

  if (error || (!loading && !creator)) return null;
  return (
    <section className="pf-shelf pf-home-spotlight" aria-labelledby="pf-home-spotlight-title">
      <div className="pf-shelf__head">
        <h2 id="pf-home-spotlight-title" className="pf-section-title">
          Creator spotlight
        </h2>
        <Link to="/creators" className="pf-shelf__more">
          {SEE_ALL_CREATORS_LABEL}
        </Link>
      </div>
      <p className="pf-muted pf-small pf-home-spotlight__lead">A different creator every day.</p>
      <div className="pf-spotlight">
        {creator ? <CreatorCard creator={creator} headingLevel={3} /> : <CreatorCardSkeleton />}
        <GameGrid games={games} loading={!creator} skeletons={SPOTLIGHT_GAMES} />
      </div>
    </section>
  );
}

/** F032 Player collections: public collections with 3+ published games, newest update first. Hidden on errors / empty. */
export function CollectionsShelf() {
  const api = useApi();
  const { data, loading, error } = useAsync(() => api.listCollections({ perPage: HOME_COLLECTIONS_SIZE }), [api]);
  const items = Array.isArray(data?.items) ? data.items.slice(0, HOME_COLLECTIONS_SIZE) : [];
  if (error || (!loading && items.length === 0)) return null;
  return (
    <section className="pf-shelf pf-home-collections" aria-labelledby="pf-home-collections-title">
      <div className="pf-shelf__head">
        <h2 id="pf-home-collections-title" className="pf-section-title">
          Player collections
        </h2>
      </div>
      <CollectionGrid collections={items} loading={loading} skeletons={HOME_COLLECTIONS_SIZE} showOwner />
    </section>
  );
}

/**
 * F032 Browse by tag: the first 12 tags as links to `/browse?tag=`, then `Browse all games`. The chips hide on
 * errors, but the button always shows, so a visitor is never stuck.
 */
export function TagsSection() {
  const api = useApi();
  const { data, loading, error } = useAsync(() => api.listTags(), [api]);
  const tags = !error && Array.isArray(data) ? data.filter((t) => t && typeof t.tag === "string" && t.tag).slice(0, HOME_TAGS_MAX) : [];
  return (
    <section className="pf-shelf pf-home-tags" aria-labelledby="pf-home-tags-title">
      <div className="pf-shelf__head">
        <h2 id="pf-home-tags-title" className="pf-section-title">
          Browse by tag
        </h2>
      </div>
      {loading ? (
        <div className="pf-chips" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} width={70} height={28} radius={14} />
          ))}
        </div>
      ) : tags.length > 0 ? (
        <div className="pf-chips">
          {tags.map((t) => (
            <TagChip key={t.tag} tag={t.tag} to={browsePath({ tag: t.tag })} />
          ))}
        </div>
      ) : null}
      <p className="pf-home-tags__all">
        <Link className="pf-btn pf-btn--primary" to={BROWSE_PATH}>
          Browse all games
        </Link>
      </p>
    </section>
  );
}

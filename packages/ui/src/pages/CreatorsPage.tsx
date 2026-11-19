import { useEffect, useMemo, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Creator } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { CreatorCard, CreatorCardSkeleton } from "../components/CreatorCard";
import { EmptyState, ErrorState, Pagination } from "../components/common";
import { useFollows } from "../components/Follow";
import { CREATOR_SORTS, CREATOR_SORT_LABELS, CREATORS_PER_PAGE, creatorsPath, isValidCreator, parseCreatorSort } from "../creators";
import { useAsync, useDocumentTitle } from "../util";

/**
 * F035 `/creators?sort=&page=`: the Explore creators directory. Three sort tabs (Popular, Recently active,
 * New creators), 24 cards per page. Public. Seeds the follow store from each loaded card.
 */
export function CreatorsPage() {
  const api = useApi();
  const follows = useFollows();
  const { token } = useAuth();
  const [params, setParams] = useSearchParams();
  const sort = parseCreatorSort(params.get("sort"));
  const page = Math.max(1, Math.floor(Number(params.get("page"))) || 1);
  useDocumentTitle("Creators");

  const list = useAsync(
    () => api.listCreators({ sort: sort === "popular" ? undefined : sort, page, perPage: CREATORS_PER_PAGE }),
    // `isFollowing` is per viewer: signing in or out reloads the page.
    [api, sort, page, token],
  );
  const items = useMemo(() => (Array.isArray(list.data?.items) ? list.data.items.filter(isValidCreator) : []), [list.data]);

  // Server truth for the follow store, so every FollowButton / count for these users agrees. Fresh items are always
  // seeded; otherwise only users the store has forgotten (it is cleared when the signed-in user resolves or changes).
  const seed = follows?.seed;
  const peek = follows?.peek;
  const seededItems = useRef<Creator[] | null>(null);
  useEffect(() => {
    if (!seed || !peek) return;
    const fresh = seededItems.current !== items;
    seededItems.current = items;
    for (const c of items) {
      if (fresh || peek(c.user.username) === undefined) seed(c.user.username, { following: c.isFollowing, followers: c.followers });
    }
  }, [items, seed, peek]);

  const total = typeof list.data?.total === "number" ? list.data.total : 0;
  const ready = !list.error && !list.loading && !!list.data;

  return (
    <div className="pf-container pf-page pf-creators">
      <header className="pf-pagehead">
        <h1>Creators</h1>
        <p className="pf-muted">People who make games on Pixelforge Arcade.</p>
        <nav className="pf-tabs" aria-label="Sort creators">
          {CREATOR_SORTS.map((s) => (
            <Link key={s} to={creatorsPath(s)} className={`pf-tab${s === sort ? " is-active" : ""}`} aria-current={s === sort ? "page" : undefined}>
              {CREATOR_SORT_LABELS[s]}
            </Link>
          ))}
        </nav>
      </header>
      {list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : !ready ? (
        <ul className="pf-creator-grid" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i}>
              <CreatorCardSkeleton />
            </li>
          ))}
        </ul>
      ) : items.length === 0 && page === 1 && total === 0 ? (
        <EmptyState
          icon="🎨"
          title="No creators yet."
          action={
            <Link className="pf-btn pf-btn--primary" to="/docs">
              Make a game
            </Link>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState icon="🎨" title="No more creators." action={<Link to={creatorsPath(sort)}>Back to the first page</Link>} />
      ) : (
        <ul className="pf-creator-grid">
          {items.map((c) => (
            <li key={c.user.id || c.user.username}>
              <CreatorCard creator={c} />
            </li>
          ))}
        </ul>
      )}
      {ready && (
        <Pagination
          page={page}
          total={total}
          perPage={list.data?.perPage || CREATORS_PER_PAGE}
          onPage={(p) => {
            const next = new URLSearchParams(params);
            if (p === 1) next.delete("page");
            else next.set("page", String(p));
            setParams(next);
          }}
        />
      )}
    </div>
  );
}

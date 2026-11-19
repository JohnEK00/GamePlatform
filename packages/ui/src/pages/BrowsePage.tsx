import { Link, useSearchParams } from "react-router-dom";
import type { GameSort } from "../api/types";
import { useApi } from "../context/config";
import { EmptyState, ErrorState, Pagination, Skeleton, TagChip } from "../components/common";
import { GameGrid } from "../components/GameCard";
import { ToggleGroup, type TabItem } from "../components/Tabs";
import { useAsync, useDocumentTitle } from "../util";

/** The sort toggles, in order (F032 adds Recently updated last). */
export const BROWSE_SORTS: { key: GameSort; label: string }[] = [
  { key: "new", label: "New" },
  { key: "trending", label: "Trending" },
  { key: "popular", label: "Popular" },
  { key: "top", label: "Top rated" },
  { key: "favorites", label: "Most favorited" },
  { key: "updated", label: "Recently updated" },
];
const SORT_ITEMS: TabItem<GameSort>[] = BROWSE_SORTS.map((s) => ({ value: s.key, label: s.label }));
const PER_PAGE = 24;
const LQ = String.fromCodePoint(0x201c);
const RQ = String.fromCodePoint(0x201d);
const TIMES = String.fromCodePoint(0xd7);
const JOYSTICK = String.fromCodePoint(0x1f579);

/**
 * F032 `/browse?q=&tag=&sort=&page=`: the full sortable game grid (it used to live on `/`). `sort` is omitted for
 * New and `page` for 1; an unknown `sort` shows New.
 */
export function BrowsePage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const tag = params.get("tag") ?? "";
  const sortParam = params.get("sort");
  const sort: GameSort = BROWSE_SORTS.some((s) => s.key === sortParam) ? (sortParam as GameSort) : "new";
  const page = Math.max(1, Number(params.get("page")) || 1);
  useDocumentTitle(q ? `Search: ${q}` : tag ? `#${tag}` : "Browse games");

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
  const updatedEmpty = !filtered && sort === "updated";

  return (
    <div className="pf-container pf-page">
      <section id="pf-browse" className="pf-browse" aria-labelledby="pf-browse-title">
        <div className="pf-browse__head">
          <h1 id="pf-browse-title" className="pf-section-title">
            {q ? `Results for ${LQ}${q}${RQ}` : tag ? `#${tag}` : "Browse games"}
            {games.data && <span className="pf-muted pf-section-title__count">{games.data.total}</span>}
          </h1>
          {/* A sort order, not tabs: a toggle-button group (aria-pressed). */}
          <ToggleGroup label="Sort games" items={SORT_ITEMS} value={sort} onChange={(k) => update({ sort: k === "new" ? null : k })} />
        </div>

        <div className="pf-chips" aria-label="Filter by tag">
          {tags.loading && !tags.data ? (
            Array.from({ length: 6 }, (_, i) => <Skeleton key={i} width={70} height={28} radius={14} />)
          ) : (
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
                {`${LQ}${q}${RQ} ${TIMES}`}
              </button>
            )}
            {tag && (
              <button type="button" className="pf-chip pf-chip--removable" onClick={() => update({ tag: null })}>
                {`#${tag} ${TIMES}`}
              </button>
            )}
          </p>
        )}

        {games.error ? (
          <ErrorState error={games.error} onRetry={games.reload} />
        ) : !games.loading && games.data && games.data.items.length === 0 ? (
          updatedEmpty ? (
            <EmptyState
              icon={JOYSTICK}
              title="No updated games yet"
              action={
                <button type="button" className="pf-btn" onClick={() => update({ sort: null })}>
                  Show all games
                </button>
              }
            >
              Games show up here after their creators publish an update.
            </EmptyState>
          ) : (
            <EmptyState
              icon={JOYSTICK}
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
          )
        ) : (
          <GameGrid games={games.data?.items} loading={games.loading} highlight={sort === "trending" ? "trending" : undefined} />
        )}

        {games.data && !games.error && (
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

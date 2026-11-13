import { Link, useSearchParams } from "react-router-dom";
import { useApi } from "../context/config";
import { EmptyState, ErrorState, Pagination } from "../components/common";
import { GameGrid } from "../components/GameCard";
import { useAsync, useDocumentTitle } from "../util";

const PER_PAGE = 24;

/** The signed-in user's favorite games, newest favorite first. */
export function FavoritesPage() {
  const api = useApi();
  useDocumentTitle("Favorites");
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const { data, loading, error, reload } = useAsync(() => api.listMyFavorites({ page, perPage: PER_PAGE }), [api, page]);

  return (
    <div className="pf-container pf-page">
      <header className="pf-pagehead">
        <h1>Favorites</h1>
        <p className="pf-muted">Games you've hearted, most recent first.</p>
      </header>
      {error ? (
        <ErrorState error={error} onRetry={reload} />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          icon="♡"
          title="No favorites yet"
          action={
            <Link to="/" className="pf-btn pf-btn--primary">
              Browse games
            </Link>
          }
        >
          Tap the heart on any game to keep it here.
        </EmptyState>
      ) : (
        <GameGrid games={data?.items} loading={loading} />
      )}
      {data && !error && (
        <Pagination
          page={page}
          total={data.total}
          perPage={data.perPage || PER_PAGE}
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

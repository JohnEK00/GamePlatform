import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage, formatCount } from "../util";

export type FavoriteState = { favorited: boolean; favorites: number };

export type FavoritesApi = {
  /** Current state for a game: local (optimistic / confirmed) state wins over the given fallback. */
  get: (gameId: string, fallback: FavoriteState) => FavoriteState;
  /** Optimistically toggles; resolves with the confirmed state (or the reverted one on error). */
  toggle: (gameId: string, current: FavoriteState) => Promise<FavoriteState>;
  isPending: (gameId: string) => boolean;
};

const FavoritesContext = createContext<FavoritesApi | null>(null);

/**
 * Shares favorite state between cards and the game page. When logged in it loads the first 100 favorite ids so
 * cards (whose GameSummary has no `isFavorite`) can show a filled heart.
 */
export function FavoritesProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const { user } = useAuth();
  const toast = useToast();
  const [overrides, setOverrides] = useState<Record<string, FavoriteState>>({});
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = useRef(new Set<string>());
  const userId = user?.id ?? null;

  useEffect(() => {
    setOverrides({});
    setIds(new Set());
    if (!userId) return;
    let alive = true;
    api.listMyFavorites({ perPage: 100 }).then(
      (p) => {
        if (alive && Array.isArray(p?.items)) setIds(new Set(p.items.map((g) => g.id)));
      },
      () => {
        /* non-critical */
      },
    );
    return () => {
      alive = false;
    };
  }, [api, userId]);

  const get = useCallback(
    (gameId: string, fallback: FavoriteState): FavoriteState =>
      overrides[gameId] ?? { favorited: fallback.favorited || ids.has(gameId), favorites: fallback.favorites },
    [overrides, ids],
  );

  const setPendingFor = (gameId: string, on: boolean) => {
    if (on) pendingRef.current.add(gameId);
    else pendingRef.current.delete(gameId);
    setPending(new Set(pendingRef.current));
  };

  const toggle = useCallback(
    async (gameId: string, current: FavoriteState): Promise<FavoriteState> => {
      if (pendingRef.current.has(gameId)) return current;
      const next = { favorited: !current.favorited, favorites: Math.max(0, current.favorites + (current.favorited ? -1 : 1)) };
      setOverrides((o) => ({ ...o, [gameId]: next }));
      setPendingFor(gameId, true);
      try {
        const r = await api.setFavorite(gameId, next.favorited);
        const confirmed = { favorited: r.favorited, favorites: r.favorites };
        setOverrides((o) => ({ ...o, [gameId]: confirmed }));
        setIds((s) => {
          const n = new Set(s);
          if (confirmed.favorited) n.add(gameId);
          else n.delete(gameId);
          return n;
        });
        return confirmed;
      } catch (e) {
        setOverrides((o) => ({ ...o, [gameId]: current }));
        toast.error(next.favorited ? "Couldn't add to favorites" : "Couldn't remove from favorites", errorMessage(e));
        return current;
      } finally {
        setPendingFor(gameId, false);
      }
    },
    [api, toast],
  );

  const value = useMemo<FavoritesApi>(() => ({ get, toggle, isPending: (id) => pending.has(id) }), [get, toggle, pending]);
  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

/** Favorites store, or null outside a FavoritesProvider. */
export function useFavorites(): FavoritesApi | null {
  return useContext(FavoritesContext);
}

export type FavoriteButtonProps = {
  gameId: string;
  gameTitle: string;
  favorites: number;
  isFavorite?: boolean;
  /** "compact" = icon + count (cards); "full" = labelled button (game page). */
  variant?: "compact" | "full";
};

/** Heart toggle with optimistic updates. Logged-out users are prompted to log in. */
export function FavoriteButton({ gameId, gameTitle, favorites, isFavorite = false, variant = "compact" }: FavoriteButtonProps) {
  const store = useFavorites();
  const { user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const fallback = { favorited: isFavorite, favorites };
  const state = store ? store.get(gameId, fallback) : fallback;
  const busy = store?.isPending(gameId) ?? false;

  const onClick = () => {
    if (!user) {
      toast.show({
        kind: "info",
        title: "Log in to save favorites",
        action: { label: "Log in", onClick: () => navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`) },
      });
      return;
    }
    void store?.toggle(gameId, state);
  };

  const label = state.favorited ? `Remove ${gameTitle} from favorites` : `Add ${gameTitle} to favorites`;
  return (
    <button
      type="button"
      className={`pf-fav pf-fav--${variant}${state.favorited ? " is-on" : ""}`}
      aria-pressed={state.favorited}
      aria-label={label}
      title={state.favorited ? "Favorited" : "Favorite"}
      onClick={onClick}
      aria-busy={busy || undefined}
    >
      <svg viewBox="0 0 24 24" width={variant === "full" ? 18 : 15} height={variant === "full" ? 18 : 15} aria-hidden="true">
        <path
          d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.6 2.6.2.3.6.3.8 0 1-1.5 2.5-2.6 4.6-2.6 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"
          fill={state.favorited ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      {variant === "full" && <span>{state.favorited ? "Favorited" : "Favorite"}</span>}
      <span className="pf-fav__count">{formatCount(state.favorites)}</span>
    </button>
  );
}

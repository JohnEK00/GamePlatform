import { useId, useMemo } from "react";
import type { RelatedGame } from "../api/types";
import { useApi } from "../context/config";
import { useAsync } from "../util";
import { GameGrid } from "./GameCard";

export const RELATED_GAMES_LIMIT = 8;

export type RelatedGamesProps = {
  gameId: string;
  /** 1–24, default 8. */
  limit?: number;
};

/**
 * F003 "More like this" shelf. Hidden when the result is empty or the request fails; it refetches when `gameId`
 * changes and never shows the previous game's cards while the new ones load.
 */
export function RelatedGames({ gameId, limit = RELATED_GAMES_LIMIT }: RelatedGamesProps) {
  const api = useApi();
  const titleId = useId();
  const { data, loading, error } = useAsync(
    () => api.getRelatedGames(gameId, { limit }).then((items) => ({ gameId, items })),
    [api, gameId, limit],
  );
  // Only trust results tagged with the current game (guards against any stale state between renders).
  const items: RelatedGame[] | undefined = data && data.gameId === gameId ? data.items : undefined;
  const sharedTagsById = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const g of items ?? []) {
      if (g.reason === "tags" && Array.isArray(g.sharedTags) && g.sharedTags.length > 0) map[g.id] = g.sharedTags;
    }
    return map;
  }, [items]);

  const pending = loading || (!error && !items);
  if (!pending && (error || !items || items.length === 0)) return null;

  return (
    <section className="pf-related" aria-labelledby={titleId}>
      <h2 id={titleId} className="pf-section-title">
        More like this
      </h2>
      <GameGrid games={pending ? undefined : items} loading={pending} skeletons={4} highlight="related" sharedTagsById={sharedTagsById} />
    </section>
  );
}

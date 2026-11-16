import { useEffect, useId } from "react";
import type { CollectionSummary } from "../api/types";
import { useApi } from "../context/config";
import { useAsync } from "../util";
import { CollectionGrid } from "./CollectionCard";
import { noteCollectionsError } from "./collectionsSupport";

export const GAME_COLLECTIONS_LIMIT = 6;

export type GameCollectionsProps = {
  gameId: string;
  /** 1–24, default 6. */
  limit?: number;
};

/**
 * F008 "Featured in collections" shelf on the game page. Non-essential: hidden while loading, when nothing features
 * the game, and when the request fails (the error is logged).
 */
export function GameCollections({ gameId, limit = GAME_COLLECTIONS_LIMIT }: GameCollectionsProps) {
  const api = useApi();
  const titleId = useId();
  const { data, error } = useAsync(
    () => api.listGameCollections(gameId, limit).then((page) => ({ gameId, page })),
    [api, gameId, limit],
  );

  useEffect(() => {
    if (!error) return;
    if (!noteCollectionsError(api, error)) console.warn("Couldn't load the collections featuring this game", error);
  }, [api, error]);

  const page = data && data.gameId === gameId ? data.page : undefined;
  const items: CollectionSummary[] = Array.isArray(page?.items) ? page.items : [];
  const total = typeof page?.total === "number" ? page.total : items.length;
  if (error || !page || total <= 0 || items.length === 0) return null;

  return (
    <section className="pf-shelf pf-gamecollections" aria-labelledby={titleId}>
      <h2 id={titleId} className="pf-section-title">
        Featured in {total} {total === 1 ? "collection" : "collections"}
      </h2>
      <CollectionGrid collections={items} />
    </section>
  );
}

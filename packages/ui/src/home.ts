// F032: pure helpers for the sectioned home page, the /browse grid and F029 featured games
// (docs/API.md section F032). No React, no I/O.

import type { CreatorSpotlight, GameSort } from "./api/types";
import { isValidCreator } from "./creators";

/** Games per home shelf (New releases, Recently updated). */
export const HOME_SHELF_SIZE = 4;
/** Cards in the home Player collections shelf. */
export const HOME_COLLECTIONS_SIZE = 3;
/** Tag chips in the home Browse by tag section. */
export const HOME_TAGS_MAX = 12;
/** F029: the most games a profile can feature. */
export const FEATURED_GAMES_MAX = 4;

/** The full sortable game grid (it used to be `/`). */
export const BROWSE_PATH = "/browse";

export type BrowseParams = { q?: string; tag?: string; sort?: GameSort; page?: number };

/**
 * `/browse` plus, in this order: `q` (trimmed, when non-empty), `tag` (when non-empty), `sort` (unless `new` or
 * absent) and `page` (when > 1). E.g. `browsePath({ tag: "puzzle", page: 2 })` = `/browse?tag=puzzle&page=2`.
 */
export function browsePath(p: BrowseParams = {}): string {
  const params = new URLSearchParams();
  const q = typeof p.q === "string" ? p.q.trim() : "";
  if (q) params.set("q", q);
  if (p.tag) params.set("tag", p.tag);
  if (p.sort && p.sort !== "new") params.set("sort", p.sort);
  if (typeof p.page === "number" && Number.isFinite(p.page) && p.page > 1) params.set("page", String(Math.floor(p.page)));
  const qs = params.toString();
  return qs ? `${BROWSE_PATH}?${qs}` : BROWSE_PATH;
}

/** Query keys that send an old `/` URL to `/browse` (they belonged to the grid that moved). */
export const LEGACY_HOME_KEYS = ["q", "tag", "sort", "page"] as const;

/**
 * `"/browse" + search` when the query string `search` (with or without the leading `?`) has any
 * {@link LEGACY_HOME_KEYS} key, even with an empty value; otherwise null. The query is kept as is.
 */
export function legacyHomeRedirect(search: string): string | null {
  if (!search) return null;
  const params = new URLSearchParams(search);
  if (!LEGACY_HOME_KEYS.some((k) => params.has(k))) return null;
  return BROWSE_PATH + (search.startsWith("?") ? search : `?${search}`);
}

/** Shape check for `GET /api/creators/spotlight`; the home page hides the section when it fails. */
export function isValidSpotlight(x: unknown): x is CreatorSpotlight {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  return typeof s.day === "string" && (s.creator === null || isValidCreator(s.creator)) && Array.isArray(s.games);
}

/** A copy of `list` with the item at `index` moved one step (`-1` up, `1` down). Out-of-range moves return an unchanged copy. */
export function moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const next = list.slice();
  const to = index + delta;
  if (!Number.isInteger(index) || index < 0 || index >= next.length || to < 0 || to >= next.length) return next;
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

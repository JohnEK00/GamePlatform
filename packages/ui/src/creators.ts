// F035: pure helpers for the Explore creators page (docs/API.md section F035). No React, no I/O.

import type { Creator, CreatorSort } from "./api/types";
import { formatCount } from "./util";

/** The sorts, in tab order. */
export const CREATOR_SORTS: readonly CreatorSort[] = ["popular", "active", "new"];

/** Tab labels (spec section 0.2). */
export const CREATOR_SORT_LABELS: Record<CreatorSort, string> = {
  popular: "Popular",
  active: "Recently active",
  new: "New creators",
};

/** Page size of `/creators` (the server default). */
export const CREATORS_PER_PAGE = 24;

/** A `?sort=` value as a CreatorSort; anything unknown (or missing) is "popular". */
export function parseCreatorSort(v: string | null | undefined): CreatorSort {
  return typeof v === "string" && (CREATOR_SORTS as readonly string[]).includes(v) ? (v as CreatorSort) : "popular";
}

/** `/creators`, plus `?sort=` unless popular and `page=` only when > 1. E.g. `/creators?sort=new&page=2`. */
export function creatorsPath(sort: CreatorSort, page = 1): string {
  const params = new URLSearchParams();
  if (sort !== "popular") params.set("sort", sort);
  if (Number.isFinite(page) && page > 1) params.set("page", String(Math.floor(page)));
  const qs = params.toString();
  return qs ? `/creators?${qs}` : "/creators";
}

function counted(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** `{g} game(s) · {p} play(s) · {f} follower(s)`, with formatCount and the singular at exactly 1. */
export function creatorStatsText(games: number, plays: number, followers: number): string {
  return [counted(games, "game", "games"), counted(plays, "play", "plays"), counted(followers, "follower", "followers")].join(" · ");
}

/** Shape check for one `GET /api/creators` item; the page drops anything that fails it. */
export function isValidCreator(x: unknown): x is Creator {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  const user = c.user as Record<string, unknown> | null | undefined;
  return (
    !!user &&
    typeof user === "object" &&
    typeof user.username === "string" &&
    typeof c.games === "number" &&
    typeof c.plays === "number" &&
    typeof c.followers === "number" &&
    typeof c.isFollowing === "boolean"
  );
}

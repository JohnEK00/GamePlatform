// F008: pure helpers for collections (limits, validators mirroring docs/API.md § F008 "Text rules", reordering,
// share links). No React, no I/O.
import type { WebGameConfig } from "./context/config";

export const COLLECTION_TITLE_MAX = 60;
export const COLLECTION_DESCRIPTION_MAX = 500;
export const COLLECTION_DESCRIPTION_LINES_MAX = 8;
export const COLLECTION_NOTE_MAX = 140;
export const COLLECTIONS_PER_USER_MAX = 50;
export const COLLECTION_GAMES_MAX = 100;

// C0 controls, DEL and C1 controls.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Bidi embeddings/overrides (U+202A–U+202E) and isolates (U+2066–U+2069).
const BIDI = /[‪-‮⁦-⁩]/;

/** Length in Unicode scalar values (what the server counts). */
function scalarLength(s: string): number {
  return Array.from(s).length;
}

/** `\r\n` and `\r` become `\n`, then leading and trailing whitespace is trimmed (what the server stores). */
export function normalizeCollectionDescription(s: string): string {
  return s.replace(/\r\n?/g, "\n").trim();
}

/** null when valid; else the server's 422 message. */
export function validateCollectionTitle(raw: string): string | null {
  const s = raw.trim();
  const n = scalarLength(s);
  if (n < 1 || n > COLLECTION_TITLE_MAX) return `title must be 1–${COLLECTION_TITLE_MAX} characters`;
  if (CONTROL.test(s) || BIDI.test(s)) return "title must be a single line of plain text";
  return null;
}

/** null when valid; else the server's 422 message. */
export function validateCollectionDescription(raw: string): string | null {
  const s = normalizeCollectionDescription(raw);
  if (scalarLength(s) > COLLECTION_DESCRIPTION_MAX) return `description must be at most ${COLLECTION_DESCRIPTION_MAX} characters`;
  if (s.split("\n").length > COLLECTION_DESCRIPTION_LINES_MAX) return `description must be at most ${COLLECTION_DESCRIPTION_LINES_MAX} lines`;
  if (CONTROL.test(s.replace(/\n/g, "")) || BIDI.test(s)) return "description must be plain text";
  return null;
}

/** null when valid; else the server's 422 message. */
export function validateCollectionNote(raw: string): string | null {
  const s = raw.trim();
  if (scalarLength(s) > COLLECTION_NOTE_MAX) return `note must be at most ${COLLECTION_NOTE_MAX} characters`;
  if (CONTROL.test(s) || BIDI.test(s)) return "note must be a single line of plain text";
  return null;
}

/** Capitalised sentence for showing a validator / server message inline. */
export function collectionMessage(msg: string): string {
  if (!msg) return msg;
  const s = msg.charAt(0).toUpperCase() + msg.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * Returns a copy of `ids` with the element at `from` moved to index `to` (clamped to the list). Out-of-range `from`
 * returns an unchanged copy.
 */
export function moveItem<T>(ids: readonly T[], from: number, to: number): T[] {
  const out = ids.slice();
  if (!Number.isInteger(from) || from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, Math.trunc(to)));
  if (target === from) return out;
  const [x] = out.splice(from, 1);
  out.splice(target, 0, x);
  return out;
}

/** Same-origin in-app path of a collection. Trusts `path` only when it has the documented "/c/{id}" shape. */
export function collectionPath(c: { id: string; path?: string }): string {
  if (typeof c.path === "string" && /^\/c\/[A-Za-z0-9_-]+$/.test(c.path)) return c.path;
  return `/c/${encodeURIComponent(c.id)}`;
}

function currentOrigin(): string {
  return typeof window !== "undefined" && window.location ? window.location.origin : "";
}

/**
 * Absolute share link of a collection (spec § 2.7). Web (browser router): this page's origin (plus the router
 * basename). Desktop (hash router): the configured server (`apiBaseUrl`), which serves the web app; falls back to
 * the page origin when `apiBaseUrl` is empty. Never a `#/` URL.
 */
export function collectionShareUrl(config: Pick<WebGameConfig, "apiBaseUrl" | "routerMode" | "basename">, id: string): string {
  const path = `/c/${encodeURIComponent(id)}`;
  if (config.routerMode === "hash") {
    const base = (config.apiBaseUrl ?? "").trim().replace(/\/+$/, "");
    return `${base || currentOrigin()}${path}`;
  }
  const basename = (config.basename ?? "").replace(/\/+$/, "");
  const prefix = basename && basename.startsWith("/") ? basename : "";
  return `${currentOrigin()}${prefix}${path}`;
}

/** "1 game" / "{n} games". */
export function gamesLabel(n: number): string {
  return `${n} ${n === 1 ? "game" : "games"}`;
}

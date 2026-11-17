import type {
  Comment,
  CommentListPage,
  CommentMode,
  CommentSettings,
  CommentSettingsView,
  CommentSort,
  CommentThread,
  Page,
  SlowModeSecs,
} from "./types";

/** What any server (v1 or F006) is guaranteed to send for a comment. */
export type RawComment = Pick<Comment, "id" | "gameId" | "author" | "body" | "createdAt"> & Partial<Comment>;
export type RawCommentThread = RawComment & { replyCount?: number; replies?: RawComment[] };

/**
 * F006: fills the fields older servers omit (`null` / `0` / `false`). `canDeleteFallback` is used only when the
 * server did not send `canDelete` (pre-F006 servers: the author or the game owner may delete).
 */
export function normalizeComment(c: RawComment, canDeleteFallback?: (c: RawComment) => boolean): Comment {
  const hearts = typeof c.hearts === "number" && Number.isFinite(c.hearts) && c.hearts > 0 ? Math.floor(c.hearts) : 0;
  return {
    ...c,
    parentId: c.parentId ?? null,
    replyTo: c.replyTo ?? null,
    isCreator: c.isCreator === true,
    hearts,
    myHeart: c.myHeart === true,
    creatorHeart: c.creatorHeart === true,
    canDelete: typeof c.canDelete === "boolean" ? c.canDelete : (canDeleteFallback?.(c) ?? false),
    // F017 (missing on older servers → false).
    pinned: c.pinned === true,
    locked: c.locked === true,
    canModerate: c.canModerate === true,
    // F018 (missing on older servers → undefined: muting not supported).
    threadMuted: typeof c.threadMuted === "boolean" ? c.threadMuted : undefined,
  };
}

/** F006: a thread with defaults for older servers (`replies ?? []`, `replyCount ?? 0`, never below the preview length). */
export function normalizeThread(t: RawCommentThread, canDeleteFallback?: (c: RawComment) => boolean): CommentThread {
  const replies = Array.isArray(t.replies) ? t.replies.map((r) => normalizeComment(r, canDeleteFallback)) : [];
  const count = typeof t.replyCount === "number" && Number.isFinite(t.replyCount) ? t.replyCount : 0;
  return { ...normalizeComment(t, canDeleteFallback), replyCount: Math.max(count, replies.length), replies };
}

/** What any server (v1, F006, F017 or F020) is guaranteed to send for a comment list page. */
export type RawCommentListPage = Page<RawCommentThread> & { totalAll?: number; pinned?: RawCommentThread | null; settings?: unknown };

/**
 * F006/F017/F020: a comment list page with defaults for older servers (`totalAll ?? total`, `pinned ?? null`,
 * `settings` per `normalizeCommentSettingsView`).
 */
export function normalizeCommentListPage(p: RawCommentListPage, canDeleteFallback?: (c: RawComment) => boolean): CommentListPage {
  return {
    ...p,
    items: (p.items ?? []).map((t) => normalizeThread(t, canDeleteFallback)),
    totalAll: typeof p.totalAll === "number" ? p.totalAll : p.total,
    pinned: p.pinned && typeof p.pinned === "object" ? normalizeThread(p.pinned, canDeleteFallback) : null,
    settings: normalizeCommentSettingsView(p.settings),
  };
}

// ---------- F020: comment settings ----------

/** F020: the three modes, in the settings form's order. */
export const COMMENT_MODES: readonly CommentMode[] = ["on", "repliesOnly", "off"];

/** F020: the allowed slow-mode intervals (seconds), in the settings form's order. */
export const SLOW_MODE_SECS: readonly SlowModeSecs[] = [0, 30, 60, 300, 900, 3600];

const isCommentMode = (v: unknown): v is CommentMode => typeof v === "string" && (COMMENT_MODES as readonly string[]).includes(v);
const isSlowModeSecs = (v: unknown): v is SlowModeSecs => typeof v === "number" && (SLOW_MODE_SECS as readonly number[]).includes(v);

/** F020: `{ mode, slowModeSecs }` with an unknown mode read as `"on"` and an unknown interval as `0`. */
export function normalizeCommentSettings(raw: unknown): CommentSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    mode: isCommentMode(r.mode) ? r.mode : "on",
    slowModeSecs: isSlowModeSecs(r.slowModeSecs) ? r.slowModeSecs : 0,
  };
}

/**
 * F020: the list page's `settings`. Missing (older servers) → `{ mode: "on", slowModeSecs: 0, canManage: false,
 * waitSecs: 0 }`; unknown mode → `"on"`; unknown interval → `0`; `waitSecs` non-finite or negative → `0`, else
 * rounded up to whole seconds.
 */
export function normalizeCommentSettingsView(raw: unknown): CommentSettingsView {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const w = r.waitSecs;
  return {
    ...normalizeCommentSettings(r),
    canManage: r.canManage === true,
    waitSecs: typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.ceil(w) : 0,
  };
}

/** F020: the server knows comment settings (its list page has a `settings` key). Older servers show no badges or ⚙. */
export function isF020CommentPage(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && "settings" in raw;
}

const INTERVAL_LONG: Record<number, string> = { 30: "30 seconds", 60: "minute", 300: "5 minutes", 900: "15 minutes", 3600: "hour" };
const INTERVAL_SHORT: Record<number, string> = { 30: "30 s", 60: "1 min", 300: "5 min", 900: "15 min", 3600: "1 h" };

/** F020 § 2.5: the interval in "you can post once every {interval}" ("30 seconds", "minute", …, "hour"); "" for 0. */
export function slowModeInterval(secs: number): string {
  return INTERVAL_LONG[secs] ?? "";
}

/** F020 § 2.3: the badge text after "Slow mode · " ("30 s", "1 min", "5 min", "15 min", "1 h"); "" for 0. */
export function slowModeShort(secs: number): string {
  return INTERVAL_SHORT[secs] ?? "";
}

/** F020 § 2.5: `m:ss` (whole minutes unpadded, two-digit seconds): 5 → "0:05", 298 → "4:58", 3600 → "60:00". */
export function formatWait(secs: number): string {
  const s = Number.isFinite(secs) && secs > 0 ? Math.ceil(secs) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * F017: the server knows pin, lock and sort (its list page has a `pinned` key, even when null). Older servers keep the
 * F006 UI (no sort toggle, no pin/lock tools).
 */
export function isF017CommentPage(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && "pinned" in raw;
}

/** F017: the per-device comment sort (`localStorage["webgame.comments.sort"]`). */
export const COMMENT_SORT_STORAGE_KEY = "webgame.comments.sort";

/** F017: the stored sort; anything but `"top"` (or a storage error) reads as `"new"`. */
export function readCommentSort(): CommentSort {
  try {
    return globalThis.localStorage?.getItem(COMMENT_SORT_STORAGE_KEY) === "top" ? "top" : "new";
  } catch {
    return "new";
  }
}

/** F017: remembers the sort on this device (storage errors are ignored). */
export function writeCommentSort(sort: CommentSort): void {
  try {
    globalThis.localStorage?.setItem(COMMENT_SORT_STORAGE_KEY, sort);
  } catch {
    /* ignore */
  }
}

/** F006: the permalink of a comment or reply (a query, so it works under the desktop HashRouter). */
export function commentPermalink(gameId: string, commentId: string): string {
  return `/games/${encodeURIComponent(gameId)}?comment=${encodeURIComponent(commentId)}`;
}

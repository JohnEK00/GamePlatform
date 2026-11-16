import type { Comment, CommentListPage, CommentSort, CommentThread, Page } from "./types";

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

/** What any server (v1, F006 or F017) is guaranteed to send for a comment list page. */
export type RawCommentListPage = Page<RawCommentThread> & { totalAll?: number; pinned?: RawCommentThread | null };

/**
 * F006/F017: a comment list page with defaults for older servers (`totalAll ?? total`, `pinned ?? null`).
 */
export function normalizeCommentListPage(p: RawCommentListPage, canDeleteFallback?: (c: RawComment) => boolean): CommentListPage {
  return {
    ...p,
    items: (p.items ?? []).map((t) => normalizeThread(t, canDeleteFallback)),
    totalAll: typeof p.totalAll === "number" ? p.totalAll : p.total,
    pinned: p.pinned && typeof p.pinned === "object" ? normalizeThread(p.pinned, canDeleteFallback) : null,
  };
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

import type { Comment, CommentListPage, CommentThread, Page } from "./types";

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
  };
}

/** F006: a thread with defaults for older servers (`replies ?? []`, `replyCount ?? 0`, never below the preview length). */
export function normalizeThread(t: RawCommentThread, canDeleteFallback?: (c: RawComment) => boolean): CommentThread {
  const replies = Array.isArray(t.replies) ? t.replies.map((r) => normalizeComment(r, canDeleteFallback)) : [];
  const count = typeof t.replyCount === "number" && Number.isFinite(t.replyCount) ? t.replyCount : 0;
  return { ...normalizeComment(t, canDeleteFallback), replyCount: Math.max(count, replies.length), replies };
}

/** F006: a comment list page with defaults for older servers (`totalAll ?? total`). */
export function normalizeCommentListPage(
  p: Page<RawCommentThread> & { totalAll?: number },
  canDeleteFallback?: (c: RawComment) => boolean,
): CommentListPage {
  return {
    ...p,
    items: (p.items ?? []).map((t) => normalizeThread(t, canDeleteFallback)),
    totalAll: typeof p.totalAll === "number" ? p.totalAll : p.total,
  };
}

/** F006: the permalink of a comment or reply (a query, so it works under the desktop HashRouter). */
export function commentPermalink(gameId: string, commentId: string): string {
  return `/games/${encodeURIComponent(gameId)}?comment=${encodeURIComponent(commentId)}`;
}

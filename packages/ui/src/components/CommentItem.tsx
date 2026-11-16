import { Link } from "react-router-dom";
import { commentPermalink } from "../api/comments";
import type { Comment } from "../api/types";
import { formatDate, timeAgo } from "../util";
import { Avatar } from "./common";
import { HeartButton, type HeartState } from "./HeartButton";
import { ReportButton } from "./Report";
import { MuteThreadButton } from "./MuteThreadButton";
import { useNotifications } from "../context/notifications";

export type CommentItemProps = {
  comment: Comment;
  /** The game page the permalink points at (defaults to `comment.gameId`). */
  gameId?: string;
  /** The viewer's user id (null when anonymous). */
  viewerId: string | null;
  /** Replies get a smaller avatar and the "Replying to" line. */
  isReply?: boolean;
  /** `pf-comment--highlight` (permalink target). */
  highlighted?: boolean;
  /** Hide Reply and hearts (pre-F006 servers). */
  legacy?: boolean;
  /** The thread this comment belongs to (its own id when top-level); Reply buttons control `reply-form-{threadId}`. */
  threadId: string;
  /** True while the thread's reply form is open from this comment's Reply button. */
  replyExpanded?: boolean;
  onReply?: (comment: Comment) => void;
  onDelete?: (comment: Comment) => void;
  deleting?: boolean;
  onHeartChange?: (comment: Comment, next: HeartState) => void;
  /** F017: Pin / Unpin (top-level comments with `canModerate` only). */
  onPin?: (comment: Comment) => void;
  /** F017: Lock / Unlock (top-level comments with `canModerate` only). */
  onLock?: (comment: Comment) => void;
  /** F017: a pin request is in flight (the button ignores clicks but keeps focus). */
  pinBusy?: boolean;
  /** F017: a lock request is in flight. */
  lockBusy?: boolean;
  /** F017: the thread is locked and the viewer can't moderate it: no Reply button. */
  repliesLocked?: boolean;
};

export function displayName(u: { displayName?: string; username: string }): string {
  return u.displayName || u.username;
}

/** One comment or reply (F006 spec § 2.1, § 2.6): an <article> labelled by its author, with its action row. */
export function CommentItem({
  comment: c,
  gameId,
  viewerId,
  isReply = false,
  highlighted = false,
  legacy = false,
  threadId,
  replyExpanded = false,
  onReply,
  onDelete,
  deleting = false,
  onHeartChange,
  onPin,
  onLock,
  pinBusy = false,
  lockBusy = false,
  repliesLocked = false,
}: CommentItemProps) {
  const name = displayName(c.author);
  const profile = `/u/${encodeURIComponent(c.author.username)}`;
  const authorId = `comment-${c.id}-author`;
  const isAuthor = !!viewerId && viewerId === c.author.id;
  const tools = !isReply && !legacy && c.canModerate;
  // F018 § 2.2: top-level only, signed in, server sends `threadMuted`, notifications supported.
  const notificationsSupported = useNotifications().supported;
  const canMute = !!viewerId && !isReply && !legacy && typeof c.threadMuted === "boolean" && notificationsSupported;
  const className = `pf-comment${isReply ? " pf-comment--reply" : ""}${highlighted ? " pf-comment--highlight" : ""}`;
  return (
    <article id={`comment-${c.id}`} className={className} aria-labelledby={authorId} tabIndex={-1}>
      <Link to={profile} className="pf-comment__avatar" tabIndex={-1} aria-hidden="true">
        <Avatar user={c.author} size={isReply ? 28 : 32} />
      </Link>
      <div className="pf-comment__main">
        <div className="pf-comment__head">
          <Link to={profile} className="pf-comment__author" id={authorId}>
            {name}
          </Link>
          {c.isCreator && <span className="pf-badge pf-badge--creator">Creator</span>}
          {!isReply && c.pinned && (
            <span className="pf-badge pf-badge--pinned">
              <span aria-hidden="true">📌</span> Pinned
            </span>
          )}
          {!isReply && c.locked && (
            <span className="pf-badge pf-badge--locked">
              <span aria-hidden="true">🔒</span> Locked
            </span>
          )}
          <Link to={commentPermalink(gameId ?? c.gameId, c.id)} className="pf-comment__time pf-muted pf-small" title={`${formatDate(c.createdAt)} · link to this comment`}>
            <time dateTime={c.createdAt}>{timeAgo(c.createdAt)}</time>
          </Link>
          {isReply && c.replyTo && (
            <span className="pf-comment__replyto pf-muted pf-small">
              Replying to <Link to={`/u/${encodeURIComponent(c.replyTo.username)}`}>@{c.replyTo.username}</Link>
            </span>
          )}
        </div>
        <p className="pf-comment__body">{c.body}</p>
        <div className="pf-comment__actions">
          {viewerId && !legacy && onReply && !repliesLocked && (
            <button
              type="button"
              id={`reply-btn-${c.id}`}
              className="pf-linkbtn pf-comment__reply"
              aria-expanded={replyExpanded}
              aria-controls={`reply-form-${threadId}`}
              aria-label={`Reply to ${name}`}
              onClick={() => onReply(c)}
            >
              Reply
            </button>
          )}
          {!legacy && (
            <HeartButton comment={c} interactive={!!viewerId && !isAuthor} onChange={onHeartChange ? (next) => onHeartChange(c, next) : undefined} />
          )}
          {canMute && <MuteThreadButton commentId={c.id} muted={c.threadMuted === true} authorName={name} />}
          {c.canDelete && onDelete && (
            <button
              type="button"
              id={`delete-btn-${c.id}`}
              className="pf-linkbtn pf-linkbtn--danger"
              onClick={() => onDelete(c)}
              disabled={deleting}
              aria-haspopup={!isReply && "replyCount" in c && (c as { replyCount: number }).replyCount > 0 ? "dialog" : undefined}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          )}
          {tools && onPin && (
            <button
              type="button"
              id={`pin-btn-${c.id}`}
              className="pf-linkbtn pf-comment__tool"
              aria-label={`${c.pinned ? "Unpin" : "Pin"} comment by ${name}`}
              aria-busy={pinBusy || undefined}
              onClick={() => {
                if (!pinBusy) onPin(c);
              }}
            >
              {c.pinned ? "Unpin" : "Pin"}
            </button>
          )}
          {tools && onLock && (
            <button
              type="button"
              id={`lock-btn-${c.id}`}
              className="pf-linkbtn pf-comment__tool"
              aria-label={`${c.locked ? "Unlock" : "Lock"} replies to comment by ${name}`}
              aria-busy={lockBusy || undefined}
              onClick={() => {
                if (!lockBusy) onLock(c);
              }}
            >
              {c.locked ? "Unlock" : "Lock"}
            </button>
          )}
          {viewerId && !isAuthor && (
            <ReportButton targetType="comment" targetId={c.id} targetLabel={`comment by ${name}`} className="pf-linkbtn pf-comment__report">
              Report
            </ReportButton>
          )}
        </div>
      </div>
    </article>
  );
}

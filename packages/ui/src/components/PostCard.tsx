import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Post } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { hasPostSocial, linkifyPost, postPath, repliesLinkLabel, repliesLinkText } from "../posts";
import { errorMessage, formatDate, timeAgo } from "../util";
import { Avatar, ConfirmDialog, Skeleton } from "./common";
import { HeartButton, type HeartState } from "./HeartButton";
import { PostAttachmentCard } from "./PostAttachmentCard";
import { ReportButton } from "./Report";

/** F030 § 0.4: a post body as plain text, with safe URLs as external links (never HTML). */
export function PostBody({ body }: { body: string }) {
  const segments = useMemo(() => linkifyPost(body), [body]);
  return (
    <p className="pf-post__body">
      {segments.map((s, i) =>
        s.type === "link" ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer nofollow ugc">
            {s.text}
            <span className="pf-sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  );
}

export type PostCardProps = {
  post: Post;
  /** Called after a successful delete (the toast has shown). The caller removes the card and moves focus. */
  onDeleted?: (post: Post) => void;
  /** Feed item id: adds `data-kind="postCreated" data-feed-id` (the feed's focus rule finds items by it). */
  feedId?: string;
  /**
   * F031: the card sits above its own reply thread (the permalink page), so the replies link is hidden. Default false.
   */
  inThread?: boolean;
};

/**
 * F030 § 0.13: one post (head, body, attachment, Delete or Report). F031 § 0.11: with the server's F031 fields the
 * actions row always shows the heart and (outside the thread) a replies link before Delete / Report.
 */
export function PostCard({ post, onDeleted, feedId, inThread = false }: PostCardProps) {
  const api = useApi();
  const toast = useToast();
  const { user } = useAuth();
  const whoId = useId();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const author = post.author;
  const name = author.displayName || author.username;
  const authorPath = `/u/${encodeURIComponent(author.username)}`;
  const isAuthor = !!user && (user.id === author.id || user.username.toLowerCase() === author.username.toLowerCase());
  const canDelete = post.canDelete === true;
  const showReport = !canDelete && !isAuthor;
  const social = hasPostSocial(post);
  const hearts = social ? Math.max(0, post.hearts ?? 0) : 0;
  const replyCount = social ? Math.max(0, post.replyCount ?? 0) : 0;
  const showReplies = social && !inThread && !(post.locked === true && replyCount === 0);
  const onToggle = (on: boolean): Promise<HeartState> =>
    api.setPostHeart(post.id, on).then((r) => ({ hearts: r.hearts, myHeart: r.hearted, creatorHeart: false }));

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.deletePost(post.id);
      setBusy(false);
      setConfirm(false);
      toast.success("Post deleted");
      onDeleted?.(post);
    } catch (err) {
      setBusy(false);
      setConfirm(false);
      toast.error("Couldn't delete the post", errorMessage(err));
    }
  };

  const feedAttrs = feedId !== undefined ? { "data-kind": "postCreated", "data-feed-id": feedId } : {};

  return (
    <article className="pf-post" tabIndex={-1} aria-labelledby={whoId} {...feedAttrs}>
      <div className="pf-post__head">
        <Link to={authorPath} className="pf-post__avatar" tabIndex={-1} aria-hidden="true">
          <Avatar user={author} size={40} />
        </Link>
        <div id={whoId} className="pf-post__who">
          <Link to={authorPath} className="pf-post__author">
            <strong>{name}</strong>
          </Link>
          <span className="pf-muted">@{author.username}</span>
          <span aria-hidden="true"> · </span>
          <Link to={postPath(post.id)} className="pf-post__time pf-muted">
            <time dateTime={post.createdAt} title={formatDate(post.createdAt)}>
              {timeAgo(post.createdAt)}
            </time>
          </Link>
        </div>
      </div>
      <PostBody body={post.body} />
      {post.attachment ? <PostAttachmentCard attachment={post.attachment} /> : null}
      {(social || canDelete || showReport) && (
        <div className={`pf-post__actions${social ? " pf-post__actions--social" : ""}`}>
          {social && (
            <HeartButton
              comment={{ id: post.id, author, hearts, myHeart: post.myHeart === true, creatorHeart: false }}
              interactive={!!user && !isAuthor}
              subject="post"
              onToggle={onToggle}
            />
          )}
          {showReplies && (
            <Link className="pf-linkbtn pf-post__replies" to={postPath(post.id)} aria-label={repliesLinkLabel(replyCount, name)}>
              <span aria-hidden="true">💬</span> {repliesLinkText(replyCount)}
            </Link>
          )}
          {canDelete ? (
            <button
              type="button"
              className="pf-btn pf-btn--ghost pf-btn--sm pf-btn--danger-text"
              aria-haspopup="dialog"
              aria-label={`Delete post by ${name}`}
              onClick={() => setConfirm(true)}
            >
              Delete
            </button>
          ) : showReport ? (
            <ReportButton targetType="post" targetId={post.id} className="pf-btn pf-btn--ghost pf-btn--sm" ariaLabel={`Report post by ${name}`}>
              ⚑ Report
            </ReportButton>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="Delete this post?"
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => !busy && setConfirm(false)}
      >
        It's removed from the profile and from followers' feeds. This can't be undone.
      </ConfirmDialog>
    </article>
  );
}

/** F030: placeholder card while posts load. */
export function PostCardSkeleton() {
  return (
    <div className="pf-post pf-post--skeleton" aria-hidden="true">
      <div className="pf-post__head">
        <Skeleton width={40} height={40} radius={20} />
        <Skeleton width={160} height={14} />
      </div>
      <div className="pf-post__skeleton-lines">
        <Skeleton width="90%" height={16} />
        <Skeleton width="60%" height={16} />
      </div>
    </div>
  );
}

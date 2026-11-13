import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Comment } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage, timeAgo, formatDate } from "../util";
import { Alert, Avatar, Skeleton, Spinner } from "./common";
import { ReportButton } from "./Report";

const PER_PAGE = 20;

/** Comment thread with posting and deletion (author or game owner may delete). */
export function Comments({ gameId, isGameOwner = false }: { gameId: string; isGameOwner?: boolean }) {
  const api = useApi();
  const { user } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const [items, setItems] = useState<Comment[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    api.listComments(gameId, { page, perPage: PER_PAGE }).then(
      (p) => {
        if (!alive) return;
        setItems((prev) => (page === 1 ? p.items : [...prev, ...p.items.filter((c) => !prev.some((x) => x.id === c.id))]));
        setTotal(p.total);
        setLoading(false);
      },
      (e) => {
        if (!alive) return;
        setLoadError(e);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, gameId, page]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    if (text.length > 2000) {
      setPostError("Comments can be at most 2000 characters.");
      return;
    }
    setPosting(true);
    setPostError(null);
    try {
      const c = await api.postComment(gameId, text);
      setItems((xs) => [c, ...xs]);
      setTotal((t) => t + 1);
      setBody("");
    } catch (err) {
      setPostError(errorMessage(err));
    } finally {
      setPosting(false);
    }
  };

  const remove = async (c: Comment) => {
    setDeleting(c.id);
    try {
      await api.deleteComment(c.id);
      setItems((xs) => xs.filter((x) => x.id !== c.id));
      setTotal((t) => Math.max(0, t - 1));
      toast.success("Comment deleted");
    } catch (err) {
      toast.error("Couldn't delete comment", errorMessage(err));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section className="pf-panel" aria-labelledby="pf-comments-title">
      <h2 id="pf-comments-title" className="pf-panel__title">
        Comments <span className="pf-muted">{total > 0 ? total : ""}</span>
      </h2>

      {user ? (
        <form className="pf-comment-form" onSubmit={submit}>
          <Avatar user={user} size={32} />
          <div className="pf-comment-form__main">
            <label htmlFor="pf-comment-body" className="pf-sr-only">
              Write a comment
            </label>
            <textarea
              id="pf-comment-body"
              className="pf-input"
              rows={3}
              maxLength={2000}
              placeholder="Share your thoughts, tips or high-score brags…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            {postError && <Alert>{postError}</Alert>}
            <div className="pf-comment-form__actions">
              <span className="pf-muted pf-small">{body.length}/2000</span>
              <button type="submit" className="pf-btn pf-btn--primary" disabled={posting || !body.trim()}>
                {posting ? <Spinner size={14} /> : null} Post comment
              </button>
            </div>
          </div>
        </form>
      ) : (
        <p className="pf-muted pf-small">
          <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}>Log in</Link> to join the conversation.
        </p>
      )}

      {loadError && items.length === 0 ? (
        <p className="pf-muted pf-small">Couldn't load comments: {errorMessage(loadError)}</p>
      ) : loading && items.length === 0 ? (
        <ul className="pf-comments">
          {[0, 1, 2].map((i) => (
            <li key={i} className="pf-comment">
              <Skeleton width={32} height={32} radius={16} />
              <div style={{ flex: 1, display: "grid", gap: 6 }}>
                <Skeleton width="30%" height={12} />
                <Skeleton width="90%" height={14} />
              </div>
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        <p className="pf-muted pf-small">No comments yet.</p>
      ) : (
        <ul className="pf-comments">
          {items.map((c) => (
            <li key={c.id} className="pf-comment">
              <Link to={`/u/${encodeURIComponent(c.author.username)}`} aria-label={c.author.displayName || c.author.username}>
                <Avatar user={c.author} size={32} />
              </Link>
              <div className="pf-comment__main">
                <div className="pf-comment__head">
                  <Link to={`/u/${encodeURIComponent(c.author.username)}`} className="pf-comment__author">
                    {c.author.displayName || c.author.username}
                  </Link>
                  <time dateTime={c.createdAt} title={formatDate(c.createdAt)} className="pf-muted pf-small">
                    {timeAgo(c.createdAt)}
                  </time>
                  {user && (user.id === c.author.id || isGameOwner) && (
                    <button type="button" className="pf-linkbtn pf-linkbtn--danger" onClick={() => remove(c)} disabled={deleting === c.id}>
                      {deleting === c.id ? "Deleting…" : "Delete"}
                    </button>
                  )}
                  {user && user.id !== c.author.id && (
                    <ReportButton targetType="comment" targetId={c.id} className="pf-linkbtn pf-comment__report">
                      Report
                    </ReportButton>
                  )}
                </div>
                <p className="pf-comment__body">{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items.length < total && (
        <div className="pf-center">
          <button type="button" className="pf-btn pf-btn--ghost" onClick={() => setPage((p) => p + 1)} disabled={loading}>
            {loading ? <Spinner size={14} /> : null} Load more comments
          </button>
        </div>
      )}
    </section>
  );
}

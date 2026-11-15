import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { isApiError } from "../api/client";
import { normalizeComment, normalizeCommentListPage, normalizeThread } from "../api/comments";
import type { Comment, CommentThread, UserRef } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage } from "../util";
import { Alert, ConfirmDialog, Skeleton, Spinner } from "./common";
import { CommentForm } from "./CommentForm";
import { CommentItem, displayName } from "./CommentItem";
import type { HeartState } from "./HeartButton";

const PER_PAGE = 20;
/** "Show more replies" page size (spec § 2.1). */
export const REPLIES_PER_PAGE = 50;
/** Page size when loading a whole thread (before posting a reply, permalink search). Threads are capped at 200. */
const FULL_REPLIES_PER_PAGE = 100;
const FULL_REPLIES_MAX_PAGES = 2;

type ThreadView = CommentThread & {
  /** The permalink's thread, shown above page 1 because it isn't on it. */
  pinned?: boolean;
  /** A later page also contained the pinned thread (it counts as loaded, but isn't shown twice). */
  seenInPages?: boolean;
  loadingReplies?: boolean;
};

type ReplyFormState = {
  threadId: string;
  /** The comment whose Reply button opened the form (focus returns there). */
  openerId: string;
  /** Sent as `parentId`: the reply it was opened from, or the thread. */
  parentId: string;
  /** "Replying to @x" chip (opened from someone else's reply). */
  replyingTo: UserRef | null;
};

type FocusRequest = { id: string; scroll?: boolean };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function mergeReplies(existing: Comment[], more: Comment[]): Comment[] {
  const seen = new Set(existing.map((r) => r.id));
  const out = existing.slice();
  for (const r of more) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

function postErrorMessage(e: unknown): string {
  if (isApiError(e) && (e.status === 429 || e.code === "rate_limited")) {
    return e.retryAfter
      ? `You're commenting too fast, try again in ${e.retryAfter}s.`
      : "You're commenting too fast, try again in a moment.";
  }
  return errorMessage(e);
}

export type CommentsProps = {
  gameId: string;
  /** Pre-F006 servers don't send `canDelete`; the game owner may then delete any comment. */
  isGameOwner?: boolean;
  /** F006 permalink (`?comment={id}`): show that comment's thread, scroll to it and focus it. */
  focusCommentId?: string | null;
};

/**
 * Comment threads with replies, hearts, permalinks, posting and deletion (F006). The list is viewer-specific
 * (`myHeart`, `canDelete`), so it starts over when the game or the session changes.
 */
export function Comments(props: CommentsProps) {
  const { token } = useAuth();
  return <CommentsList key={`${props.gameId}|${token ?? ""}`} {...props} />;
}

function CommentsList({ gameId, isGameOwner = false, focusCommentId = null }: CommentsProps) {
  const api = useApi();
  const { user } = useAuth();
  const toast = useToast();
  const location = useLocation();
  const viewerId = user?.id ?? null;

  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [total, setTotal] = useState(0);
  const [totalAll, setTotalAll] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [firstPageDone, setFirstPageDone] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  /** The server didn't send F006 fields: no replies or hearts. */
  const [legacy, setLegacy] = useState(false);

  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const [replyForm, setReplyForm] = useState<ReplyFormState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyPosting, setReplyPosting] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmThread, setConfirmThread] = useState<ThreadView | null>(null);

  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [pendingLinked, setPendingLinked] = useState<{ thread: CommentThread; targetId: string } | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [live, setLive] = useState<{ n: number; text: string }>({ n: 0, text: "" });

  // Latest values for async continuations (read when they settle, never captured at call time).
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const replyFormRef = useRef(replyForm);
  replyFormRef.current = replyForm;

  const repliesInFlight = useRef(new Set<string>());
  const pendingFocus = useRef<FocusRequest | null>(null);
  const [, setFocusTick] = useState(0);
  const requestFocus = useCallback((req: FocusRequest) => {
    pendingFocus.current = req;
    setFocusTick((t) => t + 1);
  }, []);

  const announce = useCallback((text: string) => setLive((l) => ({ n: l.n + 1, text })), []);

  // Move focus after the DOM has the target (runs after every commit; reads the latest request).
  useEffect(() => {
    const req = pendingFocus.current;
    if (!req) return;
    const el = document.getElementById(req.id);
    if (!el) return;
    pendingFocus.current = null;
    el.focus({ preventScroll: !!req.scroll });
    if (req.scroll && typeof el.scrollIntoView === "function") {
      const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }
  });

  // ---------- Top-level pages ----------
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    api.listComments(gameId, { page, perPage: PER_PAGE }).then(
      (raw) => {
        if (!alive) return;
        const p = normalizeCommentListPage(raw);
        setLegacy(typeof (raw as { totalAll?: unknown }).totalAll !== "number");
        setThreads((prev) => {
          if (page === 1) {
            // A pinned permalink thread that turns out to be on page 1 stays in place (keeping its loaded replies).
            const pinned = prev.find((t) => t.pinned);
            const items: ThreadView[] = p.items.map((t) =>
              pinned && t.id === pinned.id ? { ...t, replies: mergeReplies(t.replies, pinned.replies) } : t,
            );
            return pinned && !items.some((t) => t.id === pinned.id) ? [pinned, ...items] : items;
          }
          const ids = new Set(prev.map((t) => t.id));
          const next = prev.map((t) => (t.pinned && p.items.some((x) => x.id === t.id) ? { ...t, seenInPages: true } : t));
          return [...next, ...p.items.filter((t) => !ids.has(t.id))];
        });
        setTotal(p.total);
        setTotalAll(p.totalAll);
        setLoading(false);
        if (page === 1) setFirstPageDone(true);
      },
      (e) => {
        if (!alive) return;
        setLoadError(e);
        setLoading(false);
        if (page === 1) setFirstPageDone(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, gameId, page]);

  /** Loads a whole thread (≤ 200 replies) and returns its replies and count, or null on failure. */
  const fetchAllReplies = useCallback(
    async (threadId: string, until?: (replies: Comment[]) => boolean) => {
      let replies: Comment[] = [];
      let count = 0;
      for (let pg = 1; pg <= FULL_REPLIES_MAX_PAGES; pg++) {
        const res = await api.listReplies(threadId, { page: pg, perPage: FULL_REPLIES_PER_PAGE });
        replies = mergeReplies(replies, (res.items ?? []).map((r) => normalizeComment(r)));
        count = typeof res.total === "number" ? res.total : replies.length;
        if (until?.(replies)) break;
        if ((res.items ?? []).length < FULL_REPLIES_PER_PAGE || replies.length >= count) break;
      }
      return { replies, count: Math.max(count, replies.length) };
    },
    [api],
  );

  const updateThread = useCallback((id: string, fn: (t: ThreadView) => ThreadView) => {
    setThreads((xs) => xs.map((t) => (t.id === id ? fn(t) : t)));
  }, []);

  // ---------- Permalink (?comment=) ----------
  useEffect(() => {
    setNotice((n) => (n && n.kind === "info" ? null : n));
    setPendingLinked(null);
    if (!focusCommentId) return;
    let alive = true;
    (async () => {
      try {
        const ctx = await api.getComment(focusCommentId);
        if (!alive) return;
        if (!ctx || !ctx.thread || !ctx.comment || ctx.comment.gameId !== gameId) throw new Error("not on this game");
        const thread = normalizeThread(ctx.thread);
        const targetId = ctx.comment.id;
        if (targetId !== thread.id && !thread.replies.some((r) => r.id === targetId)) {
          // A hidden reply: load the thread until it's found (at most 2 pages of 100).
          try {
            const all = await fetchAllReplies(thread.id, (rs) => rs.some((r) => r.id === targetId));
            thread.replies = mergeReplies(thread.replies, all.replies);
            thread.replyCount = Math.max(thread.replyCount, all.count, thread.replies.length);
          } catch {
            /* show the thread anyway; the target falls back to the thread itself */
          }
          if (!alive) return;
        }
        const found = targetId === thread.id || thread.replies.some((r) => r.id === targetId);
        setPendingLinked({ thread, targetId: found ? targetId : thread.id });
      } catch (err) {
        if (!alive) return;
        const gone = !isApiError(err) || err.status === 404 || err.status === 403 || err.status === 422;
        setNotice({
          kind: "info",
          text: gone ? "That comment is no longer available." : `Couldn't load the linked comment: ${errorMessage(err)}`,
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, gameId, focusCommentId, fetchAllReplies]);

  // Place the linked thread once page 1 is in, so it never jumps after being focused.
  useEffect(() => {
    if (!pendingLinked || !firstPageDone) return;
    const { thread, targetId } = pendingLinked;
    setPendingLinked(null);
    setThreads((prev) => {
      if (prev.some((t) => t.id === thread.id)) {
        return prev.map((t) =>
          t.id === thread.id
            ? { ...t, replies: mergeReplies(t.replies, thread.replies), replyCount: Math.max(t.replyCount, thread.replyCount) }
            : t,
        );
      }
      return [{ ...thread, pinned: true }, ...prev.filter((t) => !t.pinned)];
    });
    setHighlightId(targetId);
    requestFocus({ id: `comment-${targetId}`, scroll: true });
  }, [pendingLinked, firstPageDone, requestFocus]);

  // ---------- Top-level post ----------
  const postTop = async (text: string) => {
    setPosting(true);
    setPostError(null);
    try {
      const c = await api.postComment(gameId, text);
      const t: ThreadView = { ...normalizeComment(c), replyCount: 0, replies: [] };
      setThreads((xs) => [t, ...xs.filter((x) => x.id !== t.id)]);
      setTotal((n) => n + 1);
      setTotalAll((n) => n + 1);
      setBody("");
      announce("Comment posted");
    } catch (err) {
      setPostError(postErrorMessage(err));
    } finally {
      setPosting(false);
    }
  };

  // ---------- Replies ----------
  const openReply = (thread: ThreadView, from: Comment) => {
    const cur = replyFormRef.current;
    if (cur && cur.openerId === from.id) {
      closeReply();
      return;
    }
    const fromReply = from.id !== thread.id;
    setReplyError(null);
    setReplyForm({
      threadId: thread.id,
      openerId: from.id,
      parentId: from.id,
      replyingTo: fromReply && from.author.id !== viewerId ? from.author : null,
    });
  };

  const closeReply = () => {
    const cur = replyFormRef.current;
    setReplyForm(null);
    setReplyError(null);
    if (cur) requestFocus({ id: `reply-btn-${cur.openerId}` });
  };

  const removeThreadLocally = (id: string) => {
    const t = threadsRef.current.find((x) => x.id === id);
    if (!t) return;
    setThreads((xs) => xs.filter((x) => x.id !== id));
    setTotal((n) => Math.max(0, n - 1));
    setTotalAll((n) => Math.max(0, n - 1 - t.replyCount));
    if (replyFormRef.current?.threadId === id) setReplyForm(null);
  };

  const postReply = async (text: string) => {
    const form = replyFormRef.current;
    if (!form) return;
    setReplyPosting(true);
    setReplyError(null);
    try {
      const created = normalizeComment(await api.postComment(gameId, text, form.parentId));
      const thread = threadsRef.current.find((t) => t.id === form.threadId);
      // Load hidden replies first so the new one is never shown out of order.
      let all: { replies: Comment[]; count: number } | null = null;
      if (thread && thread.replies.length < thread.replyCount) {
        try {
          all = await fetchAllReplies(form.threadId);
        } catch {
          all = null;
        }
      }
      updateThread(form.threadId, (t) => {
        const base = all ? mergeReplies(t.replies, all.replies) : t.replies;
        const withNew = base.some((r) => r.id === created.id)
          ? base.map((r) => (r.id === created.id ? created : r))
          : [...base, created];
        // The new reply always goes last (it's the newest).
        const replies = [...withNew.filter((r) => r.id !== created.id), created];
        return { ...t, replies, replyCount: Math.max(t.replyCount + 1, all?.count ?? 0, replies.length) };
      });
      setTotalAll((n) => n + 1);
      setDrafts((d) => {
        const { [form.threadId]: _gone, ...rest } = d;
        return rest;
      });
      setReplyForm(null);
      announce("Reply posted");
      requestFocus({ id: `comment-${created.id}` });
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        removeThreadLocally(form.threadId);
        setReplyForm(null);
        setNotice({ kind: "error", text: "This comment was deleted" });
        requestFocus({ id: "pf-comments-title" });
      } else {
        setReplyError(postErrorMessage(err));
      }
    } finally {
      setReplyPosting(false);
    }
  };

  const showMoreReplies = async (thread: ThreadView) => {
    if (repliesInFlight.current.has(thread.id)) return;
    repliesInFlight.current.add(thread.id);
    updateThread(thread.id, (t) => ({ ...t, loadingReplies: true }));
    try {
      const cur = threadsRef.current.find((t) => t.id === thread.id) ?? thread;
      const pg = Math.floor(cur.replies.length / REPLIES_PER_PAGE) + 1;
      const res = await api.listReplies(thread.id, { page: pg, perPage: REPLIES_PER_PAGE });
      const items = (res.items ?? []).map((r) => normalizeComment(r));
      const latest = threadsRef.current.find((t) => t.id === thread.id);
      if (!latest) return;
      const known = new Set(latest.replies.map((r) => r.id));
      const fresh = items.filter((r) => !known.has(r.id));
      updateThread(thread.id, (t) => {
        const replies = mergeReplies(t.replies, items);
        const count = typeof res.total === "number" ? res.total : t.replyCount;
        return { ...t, replies, replyCount: Math.max(count, replies.length), loadingReplies: false };
      });
      if (fresh.length > 0) {
        announce(`${plural(fresh.length, "more reply", "more replies")} loaded`);
        requestFocus({ id: `comment-${fresh[0].id}` });
      }
    } catch (err) {
      if (isApiError(err) && err.status === 404) {
        removeThreadLocally(thread.id);
        setNotice({ kind: "error", text: "This comment was deleted" });
        requestFocus({ id: "pf-comments-title" });
      } else {
        toast.error("Couldn't load replies", errorMessage(err));
      }
    } finally {
      repliesInFlight.current.delete(thread.id);
      updateThread(thread.id, (t) => (t.loadingReplies ? { ...t, loadingReplies: false } : t));
    }
  };

  // ---------- Hearts ----------
  const onHeartChange = (c: Comment, next: HeartState) => {
    const patch = (x: Comment): Comment => (x.id === c.id ? { ...x, ...next } : x);
    setThreads((xs) =>
      xs.map((t) => {
        if (t.id === c.id) return { ...t, ...next };
        if (c.parentId === t.id || t.replies.some((r) => r.id === c.id)) return { ...t, replies: t.replies.map(patch) };
        return t;
      }),
    );
  };

  // ---------- Delete ----------
  const deleteNow = async (c: Comment, thread: ThreadView) => {
    const isReply = c.id !== thread.id;
    setDeleting(c.id);
    try {
      await api.deleteComment(c.id);
      const list = threadsRef.current;
      if (isReply) {
        const t = list.find((x) => x.id === thread.id);
        const replies = t?.replies ?? [];
        const i = replies.findIndex((r) => r.id === c.id);
        const next = replies[i + 1] ?? replies[i - 1];
        updateThread(thread.id, (x) => ({
          ...x,
          replies: x.replies.filter((r) => r.id !== c.id),
          replyCount: Math.max(0, x.replyCount - 1),
        }));
        setTotalAll((n) => Math.max(0, n - 1));
        const form = replyFormRef.current;
        if (form && form.openerId === c.id) setReplyForm({ ...form, openerId: thread.id, parentId: thread.id, replyingTo: null });
        requestFocus({ id: next ? `comment-${next.id}` : `comment-${thread.id}` });
      } else {
        const i = list.findIndex((x) => x.id === thread.id);
        const next = i >= 0 ? list[i + 1] : undefined;
        removeThreadLocally(thread.id);
        requestFocus({ id: next ? `comment-${next.id}` : "pf-comments-title" });
      }
      setConfirmThread(null);
      toast.success("Comment deleted");
      announce("Comment deleted");
    } catch (err) {
      setConfirmThread(null);
      // Focus goes back to the Delete button (the dialog does that itself when it was open).
      requestFocus({ id: `delete-btn-${c.id}` });
      toast.error("Couldn't delete comment", errorMessage(err));
    } finally {
      setDeleting(null);
    }
  };

  const onDelete = (c: Comment, thread: ThreadView) => {
    if (c.id === thread.id && thread.replyCount > 0) setConfirmThread(thread);
    else void deleteNow(c, thread);
  };

  // ---------- Render ----------
  const loadedCount = threads.filter((t) => !t.pinned || t.seenInPages).length;
  const hasMore = loadedCount < total;
  const nextLabel = (t: ThreadView) => {
    const n = Math.max(0, t.replyCount - t.replies.length);
    return `Show ${plural(n, "more reply", "more replies")}`;
  };

  const renderReplyForm = (t: ThreadView) => {
    if (!replyForm || replyForm.threadId !== t.id || !user) return null;
    return (
      <CommentForm
        key={`${t.id}:${replyForm.openerId}`}
        className="pf-comment-form--reply"
        inputId={`reply-body-${t.id}`}
        formId={`reply-form-${t.id}`}
        formLabel={`Reply to ${displayName(t.author)}`}
        label={replyForm.replyingTo ? `Write a reply to @${replyForm.replyingTo.username}` : `Write a reply to ${displayName(t.author)}`}
        placeholder="Write a reply…"
        submitLabel="Post reply"
        value={drafts[t.id] ?? ""}
        onChange={(v) => setDrafts((d) => ({ ...d, [t.id]: v }))}
        onSubmit={postReply}
        busy={replyPosting}
        error={replyError}
        onCancel={closeReply}
        replyingTo={replyForm.replyingTo}
        onClearReplyingTo={() => setReplyForm((f) => (f ? { ...f, parentId: f.threadId, replyingTo: null } : f))}
        autoFocus
      />
    );
  };

  const itemProps = (t: ThreadView, c: Comment) => ({
    // Pre-F006 servers don't send canDelete: the author or the game owner may delete (the v1 rule).
    comment: legacy ? { ...c, canDelete: !!viewerId && (viewerId === c.author.id || isGameOwner) } : c,
    gameId,
    viewerId,
    threadId: t.id,
    legacy,
    highlighted: highlightId === c.id,
    replyExpanded: !!replyForm && replyForm.threadId === t.id && replyForm.openerId === c.id,
    onReply: (x: Comment) => openReply(t, x),
    onDelete: (x: Comment) => onDelete(x, t),
    deleting: deleting === c.id,
    onHeartChange,
  });

  return (
    <section className="pf-panel" aria-labelledby="pf-comments-title">
      <h2 id="pf-comments-title" className="pf-panel__title" tabIndex={-1}>
        Comments <span className="pf-muted">{totalAll > 0 ? totalAll : ""}</span>
      </h2>
      <p className="pf-sr-only" role="status" aria-live="polite" aria-atomic="true">
        <span key={live.n}>{live.text}</span>
      </p>

      {user ? (
        <CommentForm
          inputId="pf-comment-body"
          label="Write a comment"
          placeholder="Share your thoughts, tips or high-score brags…"
          submitLabel="Post comment"
          value={body}
          onChange={setBody}
          onSubmit={postTop}
          busy={posting}
          error={postError}
          user={user}
        />
      ) : (
        <p className="pf-muted pf-small">
          <Link to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}>Log in</Link> to join the conversation.
        </p>
      )}

      {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}

      {loadError && threads.length === 0 ? (
        <p className="pf-muted pf-small">Couldn't load comments: {errorMessage(loadError)}</p>
      ) : loading && threads.length === 0 ? (
        <ul className="pf-comments" aria-label="Loading comments">
          {[0, 1, 2].map((i) => (
            <li key={i} className="pf-thread pf-thread--skeleton">
              <Skeleton width={32} height={32} radius={16} />
              <div style={{ flex: 1, display: "grid", gap: 6 }}>
                <Skeleton width="30%" height={12} />
                <Skeleton width="90%" height={14} />
              </div>
            </li>
          ))}
        </ul>
      ) : threads.length === 0 ? (
        <p className="pf-muted pf-small">No comments yet.</p>
      ) : (
        <ul className="pf-comments" aria-label="Comments">
          {threads.map((t) => {
            const hidden = t.replyCount - t.replies.length;
            return (
              <li key={t.id} className={`pf-thread${t.pinned ? " pf-thread--pinned" : ""}`}>
                {t.pinned && <p className="pf-thread__pinned pf-small">Linked comment</p>}
                <CommentItem {...itemProps(t, t)} />
                {t.replies.length > 0 && (
                  <ul className="pf-replies" aria-label={`Replies to ${displayName(t.author)}`}>
                    {t.replies.map((r) => (
                      <li key={r.id}>
                        <CommentItem {...itemProps(t, r)} isReply />
                      </li>
                    ))}
                  </ul>
                )}
                {hidden > 0 && !legacy && (
                  <div className="pf-replies__more">
                    <button type="button" className="pf-linkbtn" onClick={() => void showMoreReplies(t)} aria-busy={t.loadingReplies || undefined}>
                      {t.loadingReplies ? <Spinner size={12} /> : null} {nextLabel(t)}
                    </button>
                  </div>
                )}
                {renderReplyForm(t)}
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <div className="pf-center">
          <button type="button" className="pf-btn pf-btn--ghost" onClick={() => setPage((p) => p + 1)} disabled={loading}>
            {loading ? <Spinner size={14} /> : null} Load more comments
          </button>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmThread}
        title={confirmThread ? `Delete this comment and its ${plural(confirmThread.replyCount, "reply", "replies")}?` : ""}
        confirmLabel="Delete"
        danger
        busy={!!confirmThread && deleting === confirmThread.id}
        onConfirm={() => {
          const t = confirmThread ? threadsRef.current.find((x) => x.id === confirmThread.id) : undefined;
          if (t) void deleteNow(t, t);
          else setConfirmThread(null);
        }}
        onCancel={() => setConfirmThread(null)}
      >
        Replies by other people are removed too. This cannot be undone.
      </ConfirmDialog>
    </section>
  );
}

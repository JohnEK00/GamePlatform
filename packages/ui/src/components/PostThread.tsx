import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type Ref } from "react";
import { Link, useLocation } from "react-router-dom";
import type { CreatePostReplyRequest, Post, PostReply } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { isValidPostReply, normalizePostBody, POST_BODY_MAX, POST_REPLY_CAP, postLength, REPLY_LINES_MESSAGE, validatePostBody } from "../posts";
import { errorMessage, formatDate, timeAgo } from "../util";
import { Alert, Avatar, ConfirmDialog, LoadError, Spinner } from "./common";
import { PostBody } from "./PostCard";
import { ReportButton } from "./Report";

/** The server's 422 message for a reply on a locked post (API § F031). */
const REPLIES_OFF_MESSAGE = "Replies are turned off for this post";
/** The thread heading (also the last-resort focus target). */
const HEADING_ID = "pf-post-replies-title";
/** The reply form (the Reply buttons control it). */
export const POST_REPLY_FORM_ID = "pf-post-reply-form";

type Viewer = { id: string; username: string } | null;

function nameOf(u: { displayName?: string; username: string }): string {
  return u.displayName || u.username;
}

function isSameUser(viewer: Viewer, u: { id?: string; username: string } | null | undefined): boolean {
  if (!viewer || !u) return false;
  return (!!u.id && viewer.id === u.id) || viewer.username.toLowerCase() === u.username.toLowerCase();
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as { current: T | null }).current = value;
}

// ---------- PostReplyItem ----------

export type PostReplyItemProps = {
  reply: PostReply;
  /** `pf-post-reply--highlight` (the `?reply=` deep-link target). */
  highlighted?: boolean;
  /** The form slot shows a form: render the Reply button. */
  canReply?: boolean;
  /** Reply was pressed on this reply. */
  onReply?: (reply: PostReply) => void;
  /** Called after a successful delete (the toast has shown). The thread removes the reply and moves focus. */
  onDeleted?: (reply: PostReply) => void;
};

/** F031 § 0.13: one reply in a post's thread (author, "Author" badge, time link, "Replying to", body, actions). */
export function PostReplyItem({ reply, highlighted = false, canReply = false, onReply, onDeleted }: PostReplyItemProps) {
  const api = useApi();
  const toast = useToast();
  const { user } = useAuth();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const name = nameOf(reply.author);
  const profile = `/u/${encodeURIComponent(reply.author.username)}`;
  const authorId = `reply-${reply.id}-author`;
  const isAuthor = isSameUser(user, reply.author);

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.deletePostReply(reply.id);
      setBusy(false);
      setConfirm(false);
      toast.success("Reply deleted");
      onDeleted?.(reply);
    } catch (err) {
      setBusy(false);
      setConfirm(false);
      toast.error("Couldn't delete the reply", errorMessage(err));
    }
  };

  return (
    <article
      id={`reply-${reply.id}`}
      className={`pf-post-reply${highlighted ? " pf-post-reply--highlight" : ""}`}
      tabIndex={-1}
      aria-labelledby={authorId}
    >
      <Link to={profile} className="pf-post-reply__avatar" tabIndex={-1} aria-hidden="true">
        <Avatar user={reply.author} size={28} />
      </Link>
      <div className="pf-post-reply__main">
        <div className="pf-post-reply__head">
          <Link id={authorId} to={profile} className="pf-post-reply__author">
            {name}
          </Link>
          {reply.byPostAuthor && <span className="pf-badge pf-badge--creator">Author</span>}
          <Link to={reply.path} className="pf-post-reply__time pf-muted pf-small" title={`${formatDate(reply.createdAt)} · link to this reply`}>
            <time dateTime={reply.createdAt}>{timeAgo(reply.createdAt)}</time>
          </Link>
          {reply.replyTo && (
            <span className="pf-post-reply__replyto pf-muted pf-small">
              Replying to <Link to={`/u/${encodeURIComponent(reply.replyTo.username)}`}>@{reply.replyTo.username}</Link>
            </span>
          )}
        </div>
        <PostBody body={reply.body} />
        <div className="pf-post-reply__actions">
          {canReply && onReply && (
            <button
              type="button"
              className="pf-linkbtn"
              aria-label={`Reply to ${name}`}
              aria-controls={POST_REPLY_FORM_ID}
              onClick={() => onReply(reply)}
            >
              Reply
            </button>
          )}
          {reply.canDelete && (
            <button type="button" className="pf-linkbtn pf-linkbtn--danger" aria-haspopup="dialog" onClick={() => setConfirm(true)}>
              Delete
            </button>
          )}
          {!isAuthor && (
            <ReportButton targetType="postReply" targetId={reply.id} className="pf-linkbtn">
              Report
            </ReportButton>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        title="Delete this reply?"
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => !busy && setConfirm(false)}
      >
        This can't be undone.
      </ConfirmDialog>
    </article>
  );
}

// ---------- PostReplyForm ----------

export type PostReplyFormProps = {
  postId: string;
  /** The reply being answered ("Replying to @…"); null = answering the post. */
  replyTo?: PostReply | null;
  /** The ✕ on "Replying to" was pressed (the form focuses its textarea itself). */
  onClearReplyTo?: () => void;
  /** Shown above the textarea and describes it (e.g. the locked notice for the author). */
  notice?: string | null;
  /** Called with the created reply, after the text was cleared and before the toast. */
  onPosted?: (reply: PostReply) => void;
  /** Called with a server error (after it is shown in the form's Alert). */
  onError?: (err: unknown) => void;
  /** The textarea (focus target of the thread). */
  textareaRef?: Ref<HTMLTextAreaElement>;
};

/** F031 § 0.14: the reply form below a post's thread. */
export function PostReplyForm({ postId, replyTo = null, onClearReplyTo, notice = null, onPosted, onError, textareaRef }: PostReplyFormProps) {
  const api = useApi();
  const toast = useToast();
  const uid = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const n = postLength(text);
  const over = n > POST_BODY_MAX;
  const countId = `${uid}-count`;
  const noticeId = `${uid}-notice`;
  const textId = `${uid}-text`;

  const focusInput = () => inputRef.current?.focus();

  const submit = async () => {
    if (busy || n === 0 || over) return;
    const problem = validatePostBody(text, REPLY_LINES_MESSAGE);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const req: CreatePostReplyRequest = { body: normalizePostBody(text), replyToId: replyTo ? replyTo.id : null };
    try {
      const reply = await api.createPostReply(postId, req);
      setBusy(false);
      setText("");
      onPosted?.(reply);
      toast.success("Reply posted");
      focusInput();
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err));
      onError?.(err);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const describedBy = notice ? `${noticeId} ${countId}` : countId;

  return (
    <form id={POST_REPLY_FORM_ID} className="pf-panel pf-post-reply-form" aria-label="Reply to the post" onSubmit={onSubmit} noValidate>
      {replyTo && (
        <p className="pf-post-reply-form__replyto pf-small">
          Replying to <strong>@{replyTo.author.username}</strong>
          <button
            type="button"
            className="pf-linkbtn pf-post-reply-form__clear"
            aria-label={`Stop replying to @${replyTo.author.username}`}
            onClick={() => {
              onClearReplyTo?.();
              focusInput();
            }}
          >
            ✕
          </button>
        </p>
      )}
      {notice && (
        <p className="pf-post-reply-form__notice pf-muted pf-small" id={noticeId}>
          {notice}
        </p>
      )}
      <label className="pf-sr-only" htmlFor={textId}>
        Reply text
      </label>
      <textarea
        id={textId}
        ref={(el) => {
          inputRef.current = el;
          assignRef(textareaRef, el);
        }}
        className="pf-input pf-post-reply-form__input"
        rows={2}
        value={text}
        placeholder="Write a reply…"
        aria-describedby={describedBy}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={onKeyDown}
      />
      {error && <Alert>{error}</Alert>}
      <div className="pf-post-reply-form__foot">
        <span className={`pf-post-composer__count${over ? " is-over" : ""}`} id={countId}>
          {over ? `${n} / ${POST_BODY_MAX} · ${n - POST_BODY_MAX} too many` : `${n} / ${POST_BODY_MAX}`}
        </span>
        <button type="submit" className="pf-btn pf-btn--primary pf-btn--sm" disabled={n === 0 || over || busy}>
          {busy ? <Spinner size={14} /> : null} Reply
        </button>
      </div>
    </form>
  );
}

// ---------- PostThread ----------

export type PostThreadProps = {
  post: Post;
  /** The thread changed the post (lock state from the server, `replyCount` ± 1, `locked` after a lock 422). */
  onPostChange: (post: Post) => void;
  /** `?reply=` of the page: highlight, scroll to and focus that reply once it is loaded. */
  replyId?: string | null;
};

type FocusRequest = { kind: "reply"; id: string } | { kind: "textarea"; scrollForm?: boolean } | { kind: "heading" };

/**
 * F031 § 0.12: the reply thread below a post on its permalink page. Loads the whole thread in one request (the
 * 200-reply cap equals the page maximum), with the lock toggle for the author and admins and the reply form.
 */
export function PostThread({ post, onPostChange, replyId = null }: PostThreadProps) {
  const api = useApi();
  const toast = useToast();
  const { user } = useAuth();
  const location = useLocation();

  const [replies, setReplies] = useState<PostReply[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loadKey, setLoadKey] = useState(0);
  // Bumped on every successful load: the deep-link focus runs once per (load, replyId).
  const [loadSeq, setLoadSeq] = useState(0);
  const [replyTarget, setReplyTarget] = useState<PostReply | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const [, setFocusTick] = useState(0);

  const postRef = useRef(post);
  postRef.current = post;
  const repliesRef = useRef(replies);
  repliesRef.current = replies;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const formWrapRef = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef<FocusRequest | null>(null);
  const lockInFlight = useRef(false);

  const locked = post.locked === true;
  const canModerate = post.canDelete === true;
  const replyCount = Math.max(0, post.replyCount ?? 0);
  const showForm = !!user && (!locked || canModerate);
  const loginHref = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;

  // ---------- Load ----------
  useEffect(() => {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    let alive = true;
    setLoading(true);
    setLoadError(null);
    api.listPostReplies(post.id, { page: 1, perPage: POST_REPLY_CAP }, ctrl?.signal).then(
      (page) => {
        if (!alive) return;
        const items = page && Array.isArray(page.items) ? page.items.filter(isValidPostReply) : [];
        setReplies(items);
        setLoading(false);
        setLoadSeq((s) => s + 1);
      },
      (err) => {
        if (!alive) return;
        setLoadError(err);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
      ctrl?.abort();
    };
  }, [api, post.id, loadKey]);

  const reload = useCallback(() => {
    setLoading(true);
    setLoadKey((k) => k + 1);
  }, []);

  // ---------- Deep link (`?reply=`) ----------
  // When `?reply` changes while mounted and the id isn't loaded, reload once for that id.
  const prevReplyId = useRef(replyId);
  const reloadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (prevReplyId.current === replyId) return;
    prevReplyId.current = replyId;
    if (!replyId) return;
    const list = repliesRef.current;
    if (!list || list.some((r) => r.id === replyId)) return;
    if (reloadedFor.current === replyId) return;
    reloadedFor.current = replyId;
    reload();
  }, [replyId, reload]);

  // Highlight target: scroll it into view and focus it, once per (load, replyId).
  const handledFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!replyId || !replies || loading) return;
    const key = `${loadSeq}|${replyId}`;
    if (handledFocus.current === key) return;
    if (!replies.some((r) => r.id === replyId)) return;
    handledFocus.current = key;
    const el = document.getElementById(`reply-${replyId}`);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [replyId, replies, loading, loadSeq]);

  // ---------- Focus after changes (runs after every commit; reads the latest request) ----------
  useLayoutEffect(() => {
    const req = pendingFocus.current;
    if (!req) return;
    let el: HTMLElement | null = null;
    if (req.kind === "reply") el = document.getElementById(`reply-${req.id}`);
    else if (req.kind === "textarea") el = textareaRef.current;
    else el = document.getElementById(HEADING_ID);
    if (!el) return;
    pendingFocus.current = null;
    if (req.kind === "textarea" && req.scrollForm) {
      const form = formWrapRef.current?.querySelector("form") ?? null;
      if (form && typeof form.scrollIntoView === "function") form.scrollIntoView({ block: "nearest" });
    }
    el.focus();
  });

  // ---------- Actions ----------
  const toggleLock = async () => {
    if (lockInFlight.current) return;
    lockInFlight.current = true;
    setLockBusy(true);
    const turnOff = !postRef.current.locked;
    try {
      const next = turnOff ? await api.lockPost(post.id) : await api.unlockPost(post.id);
      toast.success(turnOff ? "Replies turned off" : "Replies turned on");
      onPostChange(next && typeof next === "object" && typeof next.id === "string" ? next : { ...postRef.current, locked: turnOff });
    } catch (err) {
      toast.error("Couldn't change replies", errorMessage(err));
    } finally {
      lockInFlight.current = false;
      setLockBusy(false);
    }
  };

  const onReply = (r: PostReply) => {
    // Replying to your own reply records nothing (the server would store replyTo: null).
    setReplyTarget(isSameUser(user, r.author) ? null : r);
    pendingFocus.current = { kind: "textarea", scrollForm: true };
    // Force a commit even when the target didn't change, so the focus effect runs.
    setFocusTick((t) => t + 1);
  };

  const onPosted = (reply: PostReply) => {
    setReplies((list) => [...(list ?? []), reply]);
    setReplyTarget(null);
    const p = postRef.current;
    onPostChange({ ...p, replyCount: Math.max(0, p.replyCount ?? 0) + 1 });
  };

  const onFormError = (err: unknown) => {
    if (errorMessage(err) === REPLIES_OFF_MESSAGE) onPostChange({ ...postRef.current, locked: true });
  };

  const onDeleted = (reply: PostReply) => {
    const list = repliesRef.current ?? [];
    const index = list.findIndex((r) => r.id === reply.id);
    const next = list.filter((r) => r.id !== reply.id);
    setReplies(next);
    if (replyTarget?.id === reply.id) setReplyTarget(null);
    const p = postRef.current;
    onPostChange({ ...p, replyCount: Math.max(0, (p.replyCount ?? 0) - 1) });
    // § 0.13: the reply now at the deleted one's index, else the previous one, else the textarea, else the heading.
    const target = index >= 0 ? (next[index] ?? next[index - 1]) : undefined;
    if (target) pendingFocus.current = { kind: "reply", id: target.id };
    else if (textareaRef.current) pendingFocus.current = { kind: "textarea" };
    else pendingFocus.current = { kind: "heading" };
  };

  // ---------- Render ----------
  const found = !!replyId && !!replies && replies.some((r) => r.id === replyId);
  const gone = !!replyId && !!replies && !loading && !loadError && !found;

  let body;
  if (loadError && !replies) {
    body = <LoadError message="Couldn't load replies." onRetry={reload} />;
  } else if (!replies) {
    body = <Spinner size={18} label="Loading replies" />;
  } else {
    body = (
      <>
        {loadError ? <LoadError message="Couldn't load replies." onRetry={reload} /> : null}
        {gone && (
          <p className="pf-muted pf-small pf-post-thread__gone" role="status">
            That reply is no longer available.
          </p>
        )}
        {replies.length === 0 ? (
          <p className="pf-muted pf-post-thread__empty">No replies yet.</p>
        ) : (
          <ol className="pf-post-thread__list">
            {replies.map((r) => (
              <li key={r.id}>
                <PostReplyItem reply={r} highlighted={r.id === replyId} canReply={showForm} onReply={onReply} onDeleted={onDeleted} />
              </li>
            ))}
          </ol>
        )}
      </>
    );
  }

  return (
    <section className="pf-post-thread" aria-labelledby={HEADING_ID}>
      <div className="pf-post-thread__head">
        <h2 id={HEADING_ID} className="pf-section-title" tabIndex={-1}>
          {replyCount > 0 ? `Replies (${replyCount})` : "Replies"}
        </h2>
        {canModerate && (
          <button
            type="button"
            className="pf-btn pf-btn--ghost pf-btn--sm"
            aria-busy={lockBusy || undefined}
            onClick={() => void toggleLock()}
          >
            {locked ? (
              "Turn on replies"
            ) : (
              <>
                <span aria-hidden="true">🔒</span> Turn off replies
              </>
            )}
          </button>
        )}
      </div>
      {body}
      {locked && (
        <p className="pf-post-thread__locked pf-small">
          <span aria-hidden="true">🔒</span> Replies are turned off for this post.
        </p>
      )}
      <div ref={formWrapRef}>
        {!user && !locked && (
          <p className="pf-post-thread__login pf-small">
            <Link to={loginHref}>Log in</Link> to reply.
          </p>
        )}
        {showForm && (
          <PostReplyForm
            postId={post.id}
            replyTo={replyTarget}
            onClearReplyTo={() => setReplyTarget(null)}
            notice={locked ? "Replies are turned off. You can still reply." : null}
            onPosted={onPosted}
            onError={onFormError}
            textareaRef={textareaRef}
          />
        )}
      </div>
    </section>
  );
}

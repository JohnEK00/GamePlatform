import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { isApiError } from "../api/client";
import {
  isF017CommentPage,
  normalizeComment,
  normalizeCommentListPage,
  normalizeThread,
  readCommentSort,
  writeCommentSort,
} from "../api/comments";
import type { Comment, CommentSort, CommentThread, ThreadState, UserRef } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage } from "../util";
import { Alert, ConfirmDialog, Skeleton, Spinner } from "./common";
import { CommentForm } from "./CommentForm";
import { CommentItem, displayName } from "./CommentItem";
import { CommentSortToggle } from "./CommentSortToggle";
import type { HeartState } from "./HeartButton";

const PER_PAGE = 20;
/** "Show more replies" page size (spec § 2.1). */
export const REPLIES_PER_PAGE = 50;
/** Page size when loading a whole thread (before posting a reply, permalink search). Threads are capped at 200. */
const FULL_REPLIES_PER_PAGE = 100;
const FULL_REPLIES_MAX_PAGES = 2;

type ThreadView = CommentThread & {
  /** The permalink's thread, shown above page 1 because it isn't on it ("Linked comment"). */
  linked?: boolean;
  /** A later page also contained the linked thread (it counts as loaded, but isn't shown twice). */
  seenInPages?: boolean;
  loadingReplies?: boolean;
};

/** F017 § 2.5: the hint above a moderator's reply form in a locked thread. */
const LOCKED_MODERATOR_HINT = "This thread is locked. Only you and moderators can reply.";

/**
 * The three slots of the list (F017 § 2.2): the server's pinned thread, the permalink's linked thread, and the
 * paged list. `threads` is always kept in this order (`compose`), so "the next thread" is the visual next one.
 */
type Slots = { pinned: ThreadView | null; linked: ThreadView | null; list: ThreadView[] };

const inPinnedSlot = (t: ThreadView) => t.pinned && !t.linked;

function partition(threads: ThreadView[]): Slots {
  const pinned = threads.find(inPinnedSlot) ?? null;
  const linked = threads.find((t) => t.linked && t !== pinned) ?? null;
  return { pinned, linked, list: threads.filter((t) => t !== pinned && t !== linked) };
}

function compose(pinned: ThreadView | null, linked: ThreadView | null, list: ThreadView[]): ThreadView[] {
  const out: ThreadView[] = [];
  if (pinned) out.push(pinned);
  if (linked) out.push(linked);
  return out.concat(list);
}

const timeOf = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/** < 0 when `a` comes before `b` under `sort` (Newest: createdAt desc; Top: hearts desc, then createdAt desc). */
function compareThreads(sort: CommentSort, a: Comment, b: Comment): number {
  if (sort === "top" && a.hearts !== b.hearts) return b.hearts - a.hearts;
  return timeOf(b.createdAt) - timeOf(a.createdAt);
}

/**
 * F017 § 2.4: where a thread that left the pinned slot goes. Inserted at its sorted position when that is before or
 * among the loaded list threads; otherwise appended when no pages remain, or left out (a later page brings it).
 */
function placeBack(list: ThreadView[], back: ThreadView, sort: CommentSort, pagesRemain: boolean): { list: ThreadView[]; leftOut: boolean } {
  const i = list.findIndex((t) => compareThreads(sort, back, t) < 0);
  if (i >= 0) return { list: [...list.slice(0, i), back, ...list.slice(i)], leftOut: false };
  if (pagesRemain) return { list, leftOut: true };
  return { list: [...list, back], leftOut: false };
}

const loadedCountOf = (s: Slots) => s.list.length + (s.linked?.seenInPages ? 1 : 0);

type Moved = { threads: ThreadView[]; totalDelta: number; leftOut: boolean; replacedId: string | null };

/** F017: `id` moves into the pinned slot; the thread it replaces goes back (§ 2.4). Pure (also used inside updaters). */
function applyPin(prev: ThreadView[], id: string, st: ThreadState, sort: CommentSort, total: number): Moved {
  const s = partition(prev);
  const target = prev.find((t) => t.id === id);
  if (!target) return { threads: prev, totalDelta: 0, leftOut: false, replacedId: null };
  const unflag = (t: ThreadView) => (st.unpinnedId && t.id === st.unpinnedId && t.pinned ? { ...t, pinned: false } : t);
  const wasPinned = s.pinned?.id === id;
  let totalDelta = wasPinned ? 0 : -1;
  const linked = s.linked && s.linked.id !== id ? unflag(s.linked) : null;
  let list = s.list.filter((t) => t.id !== id).map(unflag);
  let leftOut = false;
  let replacedId: string | null = null;
  if (s.pinned && !wasPinned) {
    totalDelta += 1;
    replacedId = s.pinned.id;
    const loaded = list.length + (linked?.seenInPages ? 1 : 0);
    // Pages remain when something other than the returning thread is still unloaded.
    const placed = placeBack(list, { ...s.pinned, pinned: false }, sort, loaded < total + totalDelta - 1);
    list = placed.list;
    leftOut = placed.leftOut;
  }
  const locked = typeof st.locked === "boolean" ? st.locked : target.locked;
  const pinned: ThreadView = { ...target, pinned: true, locked, linked: false, seenInPages: false };
  return { threads: compose(pinned, linked, list), totalDelta, leftOut, replacedId };
}

/** F017: the pinned thread `id` goes back into the list (§ 2.4). Pure. */
function applyUnpin(prev: ThreadView[], id: string, sort: CommentSort, total: number): Moved {
  const s = partition(prev);
  if (s.pinned?.id !== id) {
    // Not in the slot (e.g. a stale linked copy): only the flag changes.
    return { threads: prev.map((t) => (t.id === id ? { ...t, pinned: false } : t)), totalDelta: 0, leftOut: false, replacedId: null };
  }
  const placed = placeBack(s.list, { ...s.pinned, pinned: false }, sort, loadedCountOf(s) < total);
  return { threads: compose(null, s.linked, placed.list), totalDelta: 1, leftOut: placed.leftOut, replacedId: null };
}

function isLockedError(e: unknown): boolean {
  return isApiError(e) && e.status === 422 && /locked/i.test(e.message);
}

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
  /** F017: the server sends `pinned` (sort toggle, pin and lock tools). Older servers keep the F006 UI. */
  const [f017, setF017] = useState(false);
  const [sort, setSort] = useState<CommentSort>(readCommentSort);

  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const [replyForm, setReplyForm] = useState<ReplyFormState | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyPosting, setReplyPosting] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmThread, setConfirmThread] = useState<ThreadView | null>(null);
  /** F017: "Replace the pinned comment?" for this thread. */
  const [confirmPin, setConfirmPin] = useState<{ threadId: string; replacedName: string } | null>(null);
  /** F017: pin/lock requests in flight (`pin:{id}` / `lock:{id}`), for `aria-busy`. */
  const [toolBusy, setToolBusy] = useState<Record<string, true>>({});

  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [pendingLinked, setPendingLinked] = useState<{ thread: CommentThread; targetId: string } | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [live, setLive] = useState<{ n: number; text: string }>({ n: 0, text: "" });

  // Latest values for async continuations (read when they settle, never captured at call time).
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const replyFormRef = useRef(replyForm);
  replyFormRef.current = replyForm;
  const totalRef = useRef(total);
  totalRef.current = total;
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const toolsInFlight = useRef(new Set<string>());
  /** F017: the thread whose reply was just refused as locked (its form stays open with the error). */
  const lockErrorThread = useRef<string | null>(null);

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
    api.listComments(gameId, { page, perPage: PER_PAGE, sort }).then(
      (raw) => {
        if (!alive) return;
        const p = normalizeCommentListPage(raw);
        setLegacy(typeof (raw as { totalAll?: unknown }).totalAll !== "number");
        if (page === 1) setF017(isF017CommentPage(raw));
        setThreads((prev) => {
          if (page === 1) {
            // The page-1 `pinned` fills the pinned slot (later pages repeat it and are ignored for it).
            const linked = prev.find((t) => t.linked);
            const withLoaded = (t: ThreadView): ThreadView => {
              const old = prev.find((x) => x.id === t.id);
              return old ? { ...t, replies: mergeReplies(t.replies, old.replies), replyCount: Math.max(t.replyCount, old.replyCount) } : t;
            };
            const pin: ThreadView | null = p.pinned ? { ...withLoaded(p.pinned), pinned: true, linked: false, seenInPages: false } : null;
            // A linked permalink thread that turns out to be on page 1 stays in place (keeping its loaded replies).
            const items: ThreadView[] = p.items
              .filter((t) => t.id !== pin?.id)
              .map((t) => (linked && t.id === linked.id ? withLoaded({ ...t, pinned: false }) : { ...t, pinned: false }));
            const keepLinked =
              linked && linked.id !== pin?.id && !items.some((t) => t.id === linked.id) ? { ...linked, seenInPages: false } : null;
            return compose(pin, keepLinked, items);
          }
          const ids = new Set(prev.map((t) => t.id));
          const next = prev.map((t) => (t.linked && p.items.some((x) => x.id === t.id) ? { ...t, seenInPages: true } : t));
          return [...next, ...p.items.filter((t) => !ids.has(t.id)).map((t) => ({ ...t, pinned: false }))];
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
  }, [api, gameId, page, sort]);

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
      const s = partition(prev);
      return compose(s.pinned, { ...thread, linked: true }, s.list);
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
      // Prepended to the list in both sorts (F017 § 2.1); it takes its sorted place on the next load.
      setThreads((xs) => {
        const s = partition(xs.filter((x) => x.id !== t.id));
        return compose(s.pinned, s.linked, [t, ...s.list]);
      });
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
    if (!cur) return;
    // A locked thread (F017) has no Reply buttons for this viewer: its note explains why.
    const t = threadsRef.current.find((x) => x.id === cur.threadId);
    requestFocus({ id: t && t.locked && !t.canModerate ? `thread-note-${t.id}` : `reply-btn-${cur.openerId}` });
  };

  const removeThreadLocally = (id: string) => {
    const t = threadsRef.current.find((x) => x.id === id);
    if (!t) return;
    setThreads((xs) => xs.filter((x) => x.id !== id));
    // The pinned thread isn't counted in `total` (F017).
    if (!inPinnedSlot(t)) setTotal((n) => Math.max(0, n - 1));
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
      } else if (isLockedError(err)) {
        // F017 § 2.5: locked while the form was open. The error stays inline; the note explains the missing buttons.
        lockErrorThread.current = form.threadId;
        setReplyError(errorMessage(err));
        updateThread(form.threadId, (t) => ({ ...t, locked: true }));
        requestFocus({ id: `thread-note-${form.threadId}` });
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

  // F017 § 2.5: a thread that is (now) locked for this viewer closes its open reply form (the draft is kept), except
  // right after a 422 "locked" reply, where the form stays to show the error inline.
  useEffect(() => {
    if (!replyForm) return;
    const t = threads.find((x) => x.id === replyForm.threadId);
    if (t && t.locked && !t.canModerate && lockErrorThread.current !== t.id) setReplyForm(null);
  }, [threads, replyForm]);

  // ---------- Sort (F017 § 2.1) ----------
  const changeSort = (next: CommentSort) => {
    if (next === sortRef.current) return;
    sortRef.current = next;
    setSort(next);
    writeCommentSort(next);
    const form = replyFormRef.current;
    if (form && partition(threadsRef.current).list.some((t) => t.id === form.threadId)) setReplyForm(null);
    // The list starts over; the pinned and linked threads stay above it.
    setThreads((xs) => {
      const s = partition(xs);
      return compose(s.pinned, s.linked ? { ...s.linked, seenInPages: false } : null, []);
    });
    setPage(1);
    setLoading(true);
    setLoadError(null);
    announce(next === "top" ? "Comments sorted by top" : "Comments sorted by newest");
  };

  // ---------- Pin / lock (F017 § 2.3) ----------
  const setBusy = (key: string, on: boolean) => {
    if (on) toolsInFlight.current.add(key);
    else toolsInFlight.current.delete(key);
    setToolBusy((b) => {
      if (on) return { ...b, [key]: true };
      const { [key]: _gone, ...rest } = b;
      return rest;
    });
  };

  const toolError = (err: unknown, title: string, id: string, focusId: string) => {
    if (isApiError(err) && err.status === 404) {
      removeThreadLocally(id);
      toast.error("This comment was deleted");
      requestFocus({ id: "pf-comments-title" });
      return;
    }
    if (isApiError(err) && (err.status === 429 || err.code === "rate_limited")) {
      toast.error(title, err.retryAfter ? `Slow down, try again in ${err.retryAfter}s` : "Slow down, try again in a moment");
    } else {
      toast.error(title, errorMessage(err));
    }
    requestFocus({ id: focusId });
  };

  const pinNow = async (id: string) => {
    const key = `pin:${id}`;
    if (toolsInFlight.current.has(key)) return;
    setBusy(key, true);
    try {
      const st = await api.pinComment(id);
      // Read the latest list, total and sort when the request settles (never the ones from click time).
      const plan = applyPin(threadsRef.current, id, st, sortRef.current, totalRef.current);
      setThreads((xs) => applyPin(xs, id, st, sortRef.current, totalRef.current).threads);
      if (plan.totalDelta) setTotal((n) => Math.max(0, n + plan.totalDelta));
      if (plan.leftOut && plan.replacedId && replyFormRef.current?.threadId === plan.replacedId) setReplyForm(null);
      setConfirmPin(null);
      announce("Comment pinned");
      requestFocus({ id: `pin-btn-${id}` });
    } catch (err) {
      setConfirmPin(null);
      toolError(err, "Couldn't pin comment", id, `pin-btn-${id}`);
    } finally {
      setBusy(key, false);
    }
  };

  const unpinNow = async (id: string) => {
    const key = `pin:${id}`;
    if (toolsInFlight.current.has(key)) return;
    setBusy(key, true);
    try {
      await api.unpinComment(id);
      const plan = applyUnpin(threadsRef.current, id, sortRef.current, totalRef.current);
      setThreads((xs) => applyUnpin(xs, id, sortRef.current, totalRef.current).threads);
      if (plan.totalDelta) setTotal((n) => n + plan.totalDelta);
      if (plan.leftOut && replyFormRef.current?.threadId === id) setReplyForm(null);
      announce("Comment unpinned");
      // Left out (it arrives with a later page): the heading is the nearest stable target.
      requestFocus({ id: plan.leftOut ? "pf-comments-title" : `pin-btn-${id}` });
    } catch (err) {
      toolError(err, "Couldn't unpin comment", id, `pin-btn-${id}`);
    } finally {
      setBusy(key, false);
    }
  };

  const onPin = (c: Comment) => {
    if (toolsInFlight.current.has(`pin:${c.id}`)) return;
    if (c.pinned) {
      void unpinNow(c.id);
      return;
    }
    const current = partition(threadsRef.current).pinned;
    if (current && current.id !== c.id) setConfirmPin({ threadId: c.id, replacedName: displayName(current.author) });
    else void pinNow(c.id);
  };

  const onLock = async (c: Comment) => {
    const key = `lock:${c.id}`;
    if (toolsInFlight.current.has(key)) return;
    const wasLocked = c.locked;
    setBusy(key, true);
    try {
      const st = wasLocked ? await api.unlockComment(c.id) : await api.lockComment(c.id);
      const locked = st && typeof st.locked === "boolean" ? st.locked : !wasLocked;
      updateThread(c.id, (t) => ({ ...t, locked }));
      announce(locked ? "Thread locked" : "Thread unlocked");
      requestFocus({ id: `lock-btn-${c.id}` });
    } catch (err) {
      toolError(err, wasLocked ? "Couldn't unlock thread" : "Couldn't lock thread", c.id, `lock-btn-${c.id}`);
    } finally {
      setBusy(key, false);
    }
  };

  // ---------- Render ----------
  const slots = partition(threads);
  const loadedCount = loadedCountOf(slots);
  const reloading = loading && page === 1;
  const hasMore = loadedCount < total && !reloading;
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
        notice={t.locked && t.canModerate ? LOCKED_MODERATOR_HINT : null}
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
    // F017: tools only on servers that know them (the item also requires a top-level comment with canModerate).
    onPin: f017 ? onPin : undefined,
    onLock: f017 ? (x: Comment) => void onLock(x) : undefined,
    pinBusy: !!toolBusy[`pin:${c.id}`],
    lockBusy: !!toolBusy[`lock:${c.id}`],
    repliesLocked: t.locked && !t.canModerate,
  });

  const renderThread = (t: ThreadView, label?: string) => {
    const hidden = t.replyCount - t.replies.length;
    return (
      <li key={t.id} className={`pf-thread${t.linked ? " pf-thread--linked" : ""}`}>
        {label && <p className="pf-thread__linked pf-small">{label}</p>}
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
        {t.locked && (
          <p className="pf-thread-note pf-muted pf-small" id={`thread-note-${t.id}`} tabIndex={-1}>
            Replies are turned off for this thread.
          </p>
        )}
        {renderReplyForm(t)}
      </li>
    );
  };

  const skeletons = [0, 1, 2].map((i) => (
    <li key={`skeleton-${i}`} className="pf-thread pf-thread--skeleton" aria-hidden="true">
      <Skeleton width={32} height={32} radius={16} />
      <div style={{ flex: 1, display: "grid", gap: 6 }}>
        <Skeleton width="30%" height={12} />
        <Skeleton width="90%" height={14} />
      </div>
    </li>
  ));
  const nothing = !slots.pinned && !slots.linked && slots.list.length === 0;
  const showSkeleton = reloading && slots.list.length === 0;

  return (
    <section className="pf-panel" aria-labelledby="pf-comments-title">
      <div className="pf-comments__head">
        <h2 id="pf-comments-title" className="pf-panel__title" tabIndex={-1}>
          Comments <span className="pf-muted">{totalAll > 0 ? totalAll : ""}</span>
        </h2>
        {f017 && !legacy && <CommentSortToggle value={sort} onChange={changeSort} />}
      </div>
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

      {slots.pinned && (
        <ul className="pf-comments pf-comments--pinned" aria-label="Pinned comment">
          {renderThread(slots.pinned)}
        </ul>
      )}

      {loadError && !loading && !slots.linked && slots.list.length === 0 ? (
        <p className="pf-muted pf-small">Couldn't load comments: {errorMessage(loadError)}</p>
      ) : !firstPageDone && nothing ? (
        <ul className="pf-comments" aria-label="Loading comments" aria-busy="true">
          {skeletons}
        </ul>
      ) : nothing && !loading ? (
        <p className="pf-muted pf-small">No comments yet.</p>
      ) : slots.linked || slots.list.length > 0 || showSkeleton ? (
        <ul className="pf-comments" aria-label="Comments" aria-busy={reloading || undefined}>
          {slots.linked && renderThread(slots.linked, "Linked comment")}
          {slots.list.map((t) => renderThread(t))}
          {showSkeleton && skeletons}
        </ul>
      ) : null}
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

      <ConfirmDialog
        open={!!confirmPin}
        title="Replace the pinned comment?"
        confirmLabel="Pin this one"
        busy={!!confirmPin && !!toolBusy[`pin:${confirmPin.threadId}`]}
        onConfirm={() => {
          if (confirmPin) void pinNow(confirmPin.threadId);
        }}
        onCancel={() => setConfirmPin(null)}
      >
        Only one comment can be pinned. The comment by {confirmPin?.replacedName ?? ""} will be unpinned.
      </ConfirmDialog>
    </section>
  );
}

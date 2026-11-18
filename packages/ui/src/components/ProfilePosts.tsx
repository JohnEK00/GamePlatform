import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Link } from "react-router-dom";
import { isApiError } from "../api/client";
import type { Post } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { isValidPost, POSTS_PER_PAGE } from "../posts";
import { profilePath } from "../profile";
import { errorMessage } from "../util";
import { EmptyState, LoadError, Spinner } from "./common";
import { PostCard, PostCardSkeleton } from "./PostCard";
import { pagesForOffset } from "./ScreenshotGallery";

/** What `ProfilePosts` exposes through its `ref`. */
export type ProfilePostsHandle = {
  /** Shows a just-created post at the top (no refetch). */
  prepend: (post: Post) => void;
};

export type ProfilePostsProps = {
  username: string;
  isMe: boolean;
  /**
   * The Overview shelf: at most `preview` posts (one request with `perPage = preview`), its own "Posts" heading, no
   * "Load more", and "See all {total} posts →" when there are more. Without it: the Posts section list (the section
   * renders the heading and the composer), 20 per page with "Load more".
   */
  preview?: number;
  /** Called after a post was deleted here (the profile shell passes its `reload`, so the counts update). */
  onChanged?: () => void;
  /** Where focus goes when a delete leaves no card (the section's composer textarea, else its heading). */
  focusFallback?: () => HTMLElement | null | undefined;
  ref?: Ref<ProfilePostsHandle>;
};

type State = {
  items: Post[];
  total: number;
  loading: boolean;
  error: unknown;
  /** The first page has loaded at least once (other profiles stay hidden until then). */
  loaded: boolean;
  /** A local delete emptied a list that had items (keeps the shelf heading as the focus target). */
  emptiedLocally: boolean;
};

const INITIAL: State = { items: [], total: 0, loading: true, error: null, loaded: false, emptiedLocally: false };

/**
 * F030 profile posts, newest first: the Posts section list or the Overview shelf. Your own profile always shows it
 * (skeletons, empty state, error with Retry); other profiles show the shelf only once there is something to show.
 * A 404 (older server) hides it everywhere. Offset paging (`pagesForOffset`), so a local delete never skips a post.
 */
export function ProfilePosts({ username, isMe, preview, onChanged, focusFallback, ref }: ProfilePostsProps) {
  const previewSize = typeof preview === "number" && preview > 0 ? Math.floor(preview) : 0;
  const perPage = previewSize || POSTS_PER_PAGE;
  const api = useApi();
  const { user, loading: authLoading } = useAuth();
  const titleId = useId();
  const [st, setSt] = useState<State>(INITIAL);
  const gen = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Index of the card that was just deleted; the focus effect below consumes it. */
  const pendingFocus = useRef<number | null>(null);
  const viewer = user?.id ?? null;

  /** `offset` 0 reloads from page 1; otherwise loads the rows from `offset` on. */
  const load = useCallback(
    (offset: number, total = 0) => {
      const g = offset === 0 ? ++gen.current : gen.current;
      setSt((s) => (offset === 0 ? { ...INITIAL } : { ...s, loading: true, error: null }));
      const pages = offset === 0 ? [1] : pagesForOffset(offset, total, perPage);
      Promise.all(pages.map((page) => api.listUserPosts(username, { page, perPage }))).then(
        (rs) => {
          if (g !== gen.current) return;
          setSt((s) => {
            const merged = offset === 0 ? [] : [...s.items];
            const seen = new Set(merged.map((x) => x.id));
            for (const r of rs)
              for (const x of Array.isArray(r?.items) ? r.items : [])
                if (isValidPost(x) && !seen.has(x.id)) {
                  seen.add(x.id);
                  merged.push(x);
                }
            const t = Number(rs[rs.length - 1]?.total);
            const total = Number.isFinite(t) ? Math.max(t, merged.length) : merged.length;
            return { items: merged, total, loading: false, error: null, loaded: true, emptiedLocally: offset === 0 ? false : s.emptiedLocally };
          });
        },
        (e: unknown) => {
          if (g !== gen.current) return;
          setSt((s) => ({ ...s, loading: false, error: e }));
        },
      );
    },
    [api, username, perPage],
  );

  // (Re)load from page 1 on user or viewer change (canDelete depends on the session); wait for the session first.
  useEffect(() => {
    if (authLoading) return;
    load(0);
  }, [load, viewer, authLoading]);

  useImperativeHandle(
    ref,
    () => ({
      prepend: (post: Post) => {
        if (!isValidPost(post)) return;
        setSt((s) => {
          if (s.items.some((x) => x.id === post.id)) return s;
          return { ...s, items: [post, ...s.items], total: s.total + 1, emptiedLocally: false };
        });
      },
    }),
    [],
  );

  const onDeleted = (post: Post) => {
    setSt((cur) => {
      const index = cur.items.findIndex((x) => x.id === post.id);
      if (index < 0) return cur;
      pendingFocus.current = index;
      const items = cur.items.filter((x) => x.id !== post.id);
      return { ...cur, items, total: Math.max(items.length, cur.total - 1), emptiedLocally: cur.emptiedLocally || items.length === 0 };
    });
    onChanged?.();
  };

  // § 0.14: after a delete, the card now at that index, else the previous one, else the fallback, else the heading.
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    const cards = listRef.current?.querySelectorAll<HTMLElement>("article.pf-post");
    if (cards && cards.length) {
      cards[Math.min(index, cards.length - 1)].focus();
      return;
    }
    const target = focusFallback?.() ?? headingRef.current;
    target?.focus();
  }, [st.items, focusFallback]);

  const { items, total, loading, error, loaded, emptiedLocally } = st;
  // An older server (no endpoint) or a user deleted mid-request: hidden everywhere.
  if (error && isApiError(error) && error.status === 404) return null;
  const firstLoading = !loaded && !error;

  // Other profiles: the shelf is omitted while loading, when empty and on an error (a local delete keeps the heading);
  // the section list stays hidden until loaded.
  if (!isMe && items.length === 0 && !emptiedLocally && (previewSize || firstLoading || !error)) return null;

  const hasMore = !previewSize && items.length < total;
  const seeAll = !!previewSize && total > previewSize;
  const loadMore = () => load(items.length, total);

  const list =
    error && items.length === 0 ? (
      <LoadError message="Couldn't load posts." onRetry={() => load(0)} />
    ) : firstLoading ? (
      <div className="pf-posts" aria-busy="true">
        {Array.from({ length: Math.min(3, perPage) }, (_, i) => (
          <PostCardSkeleton key={i} />
        ))}
      </div>
    ) : items.length === 0 ? (
      isMe ? (
        previewSize ? (
          <EmptyState
            icon="✎"
            title="No posts yet"
            action={
              <Link className="pf-btn pf-btn--primary" to={profilePath(username, "posts")}>
                Write a post
              </Link>
            }
          >
            Share an update with your followers.
          </EmptyState>
        ) : (
          <EmptyState icon="✎" title="No posts yet">
            Posts appear here and in your followers' feeds.
          </EmptyState>
        )
      ) : null
    ) : (
      <>
        <div className="pf-posts" ref={listRef}>
          {items.map((p) => (
            <PostCard key={p.id} post={p} onDeleted={onDeleted} />
          ))}
        </div>
        {error && <LoadError message={`Couldn't load more: ${errorMessage(error)}`} onRetry={loadMore} />}
        {hasMore && !error && (
          <div className="pf-posts__more">
            <button type="button" className="pf-btn pf-btn--sm" onClick={() => !loading && loadMore()} aria-disabled={loading}>
              {loading ? <Spinner size={12} /> : null} Load more
            </button>
          </div>
        )}
      </>
    );

  if (!previewSize) return <div className="pf-profile-posts">{list}</div>;

  return (
    <section className="pf-shelf pf-profile-posts" aria-labelledby={titleId}>
      <div className="pf-shelf__head">
        <h2 id={titleId} className="pf-section-title" ref={headingRef} tabIndex={-1}>
          Posts
        </h2>
        {seeAll && (
          <Link className="pf-shelf__more" to={profilePath(username, "posts")}>
            See all {total} posts →
          </Link>
        )}
      </div>
      {list}
    </section>
  );
}

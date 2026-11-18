import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { isApiError } from "../api/client";
import type { UserScreenshot } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { errorMessage, gameScreenshotsPath } from "../util";
import { EmptyState, LoadError, Skeleton, Spinner } from "./common";
import { pagesForOffset } from "./ScreenshotGallery";
import { ScreenshotLightbox } from "./ScreenshotLightbox";

/** F015 § 2.3: profile screenshots page size. */
export const PROFILE_SCREENSHOTS_PER_PAGE = 12;

export type ProfileScreenshotsProps = {
  username: string;
  isMe: boolean;
  /**
   * F028: a shelf of at most `preview` shots (one request with `perPage = preview`), no "Load more", and a
   * "See all {total} screenshots →" link to the profile's Screenshots section when there are more.
   */
  preview?: number;
};

type State = {
  items: UserScreenshot[];
  total: number;
  loading: boolean;
  error: unknown;
  /** The first page has loaded at least once (other profiles stay hidden until then). */
  loaded: boolean;
  /** A local delete emptied a list that had items (keeps the heading as the focus target). */
  emptiedLocally: boolean;
};

const INITIAL: State = { items: [], total: 0, loading: true, error: null, loaded: false, emptiedLocally: false };

const isValid = (s: unknown): s is UserScreenshot =>
  !!s && typeof s === "object" && typeof (s as UserScreenshot).id === "string" && typeof (s as UserScreenshot).thumbUrl === "string";

const titleOf = (s: UserScreenshot) => (s.game && typeof s.game.title === "string" ? s.game.title : "");
const gameIdOf = (s: UserScreenshot) => (s.game && typeof s.game.id === "string" ? s.game.id : s.gameId);

/**
 * F015 Screenshots section of a profile: the user's screenshots across games, newest first, each labelled with its
 * game; "Load more" and a lightbox. Your own profile always shows it (empty state, error with Retry); other profiles
 * show it only once there is something to show. A 404 (older server) hides it everywhere.
 */
export function ProfileScreenshots({ username, isMe, preview }: ProfileScreenshotsProps) {
  const previewSize = typeof preview === "number" && preview > 0 ? Math.floor(preview) : 0;
  const perPage = previewSize || PROFILE_SCREENSHOTS_PER_PAGE;
  const api = useApi();
  const { user, loading: authLoading } = useAuth();
  const titleId = useId();
  const [st, setSt] = useState<State>(INITIAL);
  const [open, setOpen] = useState<number | null>(null);
  const gen = useRef(0);
  const gridRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastOpen = useRef(0);
  if (open !== null) lastOpen.current = open;
  const viewer = user?.id ?? null;

  /** `offset` 0 reloads from page 1; otherwise loads the rows from `offset` on (see `pagesForOffset`). */
  const load = useCallback(
    (offset: number, total = 0) => {
      const g = offset === 0 ? ++gen.current : gen.current;
      setSt((s) => (offset === 0 ? { ...INITIAL } : { ...s, loading: true, error: null }));
      const pages = offset === 0 ? [1] : pagesForOffset(offset, total, perPage);
      Promise.all(pages.map((page) => api.listUserScreenshots(username, { page, perPage }))).then(
        (rs) => {
          if (g !== gen.current) return;
          setSt((s) => {
            const merged = offset === 0 ? [] : [...s.items];
            const seen = new Set(merged.map((x) => x.id));
            for (const r of rs)
              for (const x of Array.isArray(r?.items) ? r.items : [])
                if (isValid(x) && !seen.has(x.id)) {
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
    setOpen(null);
    load(0);
  }, [load, viewer, authLoading]);

  const onDeleted = (s: UserScreenshot) => {
    setSt((cur) => {
      const items = cur.items.filter((x) => x.id !== s.id);
      return { ...cur, items, total: Math.max(items.length, cur.total - 1), emptiedLocally: cur.emptiedLocally || (items.length === 0 && cur.items.length > 0) };
    });
    setOpen(null);
  };

  // After a delete: the thumbnail now at that grid position, else the previous one, else the section heading.
  const returnFocus = () => {
    const buttons = gridRef.current?.querySelectorAll<HTMLElement>(".pf-shots__item");
    if (buttons && buttons.length) return buttons[Math.min(lastOpen.current, buttons.length - 1)];
    return headingRef.current;
  };

  const { items, total, loading, error, loaded, emptiedLocally } = st;
  // An older server (no endpoint) or a user deleted mid-request: hidden on every profile.
  if (error && isApiError(error) && error.status === 404) return null;
  // Other profiles: nothing while loading, when empty, or on an error (a local delete keeps the heading).
  if (!isMe && items.length === 0 && !emptiedLocally) return null;

  const hasMore = !previewSize && items.length < total;
  const seeAll = !!previewSize && total > items.length;
  const loadMore = () => load(items.length, total);
  const firstLoading = !loaded && !error;

  return (
    <section className="pf-shelf pf-profile-shots" aria-labelledby={titleId}>
      <div className="pf-shelf__head">
        <h2 id={titleId} className="pf-section-title" ref={headingRef} tabIndex={-1}>
          Screenshots{total > 0 ? <span className="pf-tab__count">{total}</span> : null}
        </h2>
        {seeAll && (
          <Link className="pf-shelf__more" to={`/u/${encodeURIComponent(username)}/screenshots`}>
            See all {total} screenshots →
          </Link>
        )}
      </div>
      {error && items.length === 0 ? (
        <LoadError message="Couldn't load your screenshots." onRetry={() => load(0)} />
      ) : firstLoading ? (
        <div className="pf-shots__grid" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="pf-shots__skeleton" height="auto" />
          ))}
        </div>
      ) : items.length === 0 ? (
        isMe ? (
          <EmptyState icon="📷" title="No screenshots yet">
            Press 📷 while playing a game and post the shot to its page. Your screenshots appear here.
          </EmptyState>
        ) : null
      ) : (
        <>
          <ul className="pf-shots__grid" ref={gridRef}>
            {items.map((s, i) => {
              const title = titleOf(s);
              const caption = typeof s.caption === "string" ? s.caption.trim() : "";
              return (
                <li key={s.id} className="pf-profile-shots__cell">
                  <button
                    type="button"
                    className="pf-shots__item"
                    onClick={() => setOpen(i)}
                    aria-haspopup="dialog"
                    aria-label={caption ? `Screenshot of ${title}: ${caption}` : `Screenshot of ${title}`}
                  >
                    <img src={api.url(s.thumbUrl)} alt="" loading="lazy" />
                  </button>
                  <Link to={gameScreenshotsPath(gameIdOf(s))} className="pf-profile-shots__game pf-small" title={title}>
                    {title}
                  </Link>
                </li>
              );
            })}
          </ul>
          {error && <LoadError message={`Couldn't load more: ${errorMessage(error)}`} onRetry={loadMore} />}
          {hasMore && !error && (
            <div className="pf-shots__more">
              <button type="button" className="pf-btn pf-btn--sm" onClick={() => !loading && loadMore()} aria-disabled={loading}>
                {loading ? <Spinner size={12} /> : null} Load more
              </button>
            </div>
          )}
        </>
      )}
      {open !== null && items[open] && (
        <ScreenshotLightbox
          items={items}
          index={open}
          gameTitle={titleOf}
          showGameLink
          onIndex={(i) => setOpen(Math.max(0, Math.min(items.length - 1, i)))}
          onClose={() => setOpen(null)}
          onDeleted={onDeleted}
          returnFocus={returnFocus}
        />
      )}
    </section>
  );
}

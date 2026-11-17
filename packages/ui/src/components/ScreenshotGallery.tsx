import { useCallback, useEffect, useRef, useState } from "react";
import type { Game, Screenshot } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { errorMessage } from "../util";
import { LoadError, Skeleton, Spinner } from "./common";
import { SCREENSHOTS_CHANGED_EVENT, SCREENSHOTS_SECTION_ID } from "./ScreenshotDialog";
import { ScreenshotLightbox } from "./ScreenshotLightbox";

/** Gallery page size (F005 § 2.3). */
export const SCREENSHOT_GALLERY_PER_PAGE = 12;

export type ScreenshotGalleryProps = {
  game: Pick<Game, "id" | "title" | "isOwner">;
  /** After "Set as thumbnail" succeeded. */
  onGameUpdated?: (g: Game) => void;
};

type State = { items: Screenshot[]; total: number; loading: boolean; error: unknown };

/**
 * Pages to request for the rows starting at `offset` with OFFSET paging (review 3, L2). After a local delete the
 * server list has shifted up, so `offset` (= items shown) is no longer a page boundary; fetching only the next page
 * would skip the rows that moved up into the current one. So: the page containing `offset`, plus the one after it
 * when `offset` is mid-page (and that page can exist). Rows already shown are de-duplicated by id.
 */
export function pagesForOffset(offset: number, total: number, perPage = SCREENSHOT_GALLERY_PER_PAGE): number[] {
  const first = Math.floor(offset / perPage) + 1;
  if (offset % perPage === 0 || first * perPage >= total) return [first];
  return [first, first + 1];
}

/** Community screenshots on the game page: grid, "Load more", and a lightbox (F005 § 2.3). */
export function ScreenshotGallery({ game, onGameUpdated }: ScreenshotGalleryProps) {
  const api = useApi();
  const { user, loading: authLoading } = useAuth();
  const [st, setSt] = useState<State>({ items: [], total: 0, loading: true, error: null });
  const [open, setOpen] = useState<number | null>(null);
  const gen = useRef(0);
  const gridRef = useRef<HTMLUListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Grid position of the open item, kept for the focus fallback after a delete.
  const lastOpen = useRef(0);
  if (open !== null) lastOpen.current = open;
  const gameId = game.id;
  const viewer = user?.id ?? null;

  /** `offset` 0 reloads from the top; otherwise loads the rows from `offset` on (see {@link pagesForOffset}). */
  const load = useCallback(
    (offset: number, total = 0) => {
      const g = offset === 0 ? ++gen.current : gen.current;
      setSt((s) => ({ ...s, loading: true, error: null }));
      const pages = offset === 0 ? [1] : pagesForOffset(offset, total);
      Promise.all(pages.map((page) => api.listScreenshots(gameId, { page, perPage: SCREENSHOT_GALLERY_PER_PAGE }))).then(
        (rs) => {
          if (g !== gen.current) return;
          setSt((s) => {
            const merged = offset === 0 ? [] : [...s.items];
            const seen = new Set(merged.map((x) => x.id));
            for (const r of rs)
              for (const x of r.items)
                if (!seen.has(x.id)) {
                  seen.add(x.id);
                  merged.push(x);
                }
            return { items: merged, total: rs[rs.length - 1].total, loading: false, error: null };
          });
        },
        (e: unknown) => {
          if (g !== gen.current) return;
          setSt((s) => ({ ...s, loading: false, error: e }));
        },
      );
    },
    [api, gameId],
  );

  // (Re)load from page 1 on game or viewer change (canDelete depends on the session); wait for the session first.
  useEffect(() => {
    if (authLoading) return;
    setOpen(null);
    load(0);
  }, [load, viewer, authLoading]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ gameId?: string }>).detail;
      if (!d || d.gameId === gameId) load(0);
    };
    window.addEventListener(SCREENSHOTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SCREENSHOTS_CHANGED_EVENT, onChanged);
  }, [gameId, load]);

  const onDeleted = (s: Screenshot) => {
    setSt((cur) => ({ ...cur, items: cur.items.filter((x) => x.id !== s.id), total: Math.max(0, cur.total - 1) }));
    setOpen(null);
  };

  // After a delete, focus the item that took its place, else the previous one, else the section heading.
  const returnFocus = () => {
    const buttons = gridRef.current?.querySelectorAll<HTMLElement>(".pf-shots__item");
    if (buttons && buttons.length) return buttons[Math.min(lastOpen.current, buttons.length - 1)];
    return headingRef.current;
  };

  const { items, total, loading, error } = st;
  const hasMore = items.length < total;
  const loadMore = () => load(items.length, total);
  return (
    <section className="pf-panel pf-shots" id={SCREENSHOTS_SECTION_ID} aria-labelledby={`${SCREENSHOTS_SECTION_ID}-title`}>
      <h2 className="pf-panel__title" id={`${SCREENSHOTS_SECTION_ID}-title`} ref={headingRef} tabIndex={-1}>
        Screenshots{total > 0 ? <span className="pf-tab__count">{total}</span> : null}
      </h2>
      {error && items.length === 0 ? (
        <LoadError message={`Couldn't load screenshots: ${errorMessage(error)}`} onRetry={() => load(0)} />
      ) : loading && items.length === 0 ? (
        <div className="pf-shots__grid" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="pf-shots__skeleton" height="auto" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="pf-muted pf-shots__empty">No screenshots yet. Press 📷 while playing to capture one.</p>
      ) : (
        <>
          <ul className="pf-shots__grid" ref={gridRef}>
            {items.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="pf-shots__item"
                  onClick={() => setOpen(i)}
                  aria-haspopup="dialog"
                  aria-label={s.caption ? `Screenshot: ${s.caption}` : `Screenshot by ${s.author.displayName || s.author.username}`}
                >
                  <img src={api.url(s.thumbUrl)} alt="" loading="lazy" />
                </button>
              </li>
            ))}
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
          gameTitle={() => game.title}
          thumbnailGame={game.isOwner ? { id: game.id, title: game.title, onGameUpdated } : undefined}
          onIndex={(i) => setOpen(Math.max(0, Math.min(items.length - 1, i)))}
          onClose={() => setOpen(null)}
          onDeleted={onDeleted}
          returnFocus={returnFocus}
        />
      )}
    </section>
  );
}

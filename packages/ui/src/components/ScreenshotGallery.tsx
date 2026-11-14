import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Game, Screenshot } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage, formatDate, timeAgo } from "../util";
import { ConfirmDialog, LoadError, Skeleton, Spinner, UserLink } from "./common";
import { ReportButton } from "./Report";
import { SCREENSHOTS_CHANGED_EVENT, SCREENSHOTS_SECTION_ID, setThumbnailFromUrl } from "./ScreenshotDialog";
import { useModal } from "./useModal";

/** Gallery page size (F005 § 2.3). */
export const SCREENSHOT_GALLERY_PER_PAGE = 12;

export type ScreenshotGalleryProps = {
  game: Pick<Game, "id" | "title" | "isOwner">;
  /** After "Set as thumbnail" succeeded. */
  onGameUpdated?: (g: Game) => void;
};

type State = { items: Screenshot[]; total: number; page: number; loading: boolean; error: unknown };

function Lightbox({
  items,
  index,
  game,
  onIndex,
  onClose,
  onDeleted,
  onGameUpdated,
}: {
  items: Screenshot[];
  index: number;
  game: ScreenshotGalleryProps["game"];
  onIndex: (i: number) => void;
  onClose: () => void;
  onDeleted: (s: Screenshot) => void;
  onGameUpdated?: (g: Game) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const { user } = useAuth();
  const uid = useId();
  const [confirm, setConfirm] = useState<null | "delete" | "thumb">(null);
  const [busy, setBusy] = useState(false);
  const ref = useModal<HTMLDivElement>(true, onClose, { canClose: !busy });
  const s = items[index];
  if (!s) return null;
  const who = s.author.displayName || s.author.username;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (confirm) return;
    if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      onIndex(index - 1);
    } else if (e.key === "ArrowRight" && index < items.length - 1) {
      e.preventDefault();
      onIndex(index + 1);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.deleteScreenshot(s.id);
      toast.success("Screenshot deleted");
      setConfirm(null);
      onDeleted(s);
    } catch (e) {
      toast.error("Couldn't delete the screenshot", errorMessage(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const doThumb = async () => {
    setBusy(true);
    try {
      const g = await setThumbnailFromUrl(api, game.id, s.imageUrl);
      toast.success("Thumbnail updated", game.title);
      onGameUpdated?.(g);
    } catch (e) {
      toast.error("Couldn't set the thumbnail", errorMessage(e));
    } finally {
      setConfirm(null);
      setBusy(false);
    }
  };

  const fullUrl = api.url(s.imageUrl);
  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="pf-modal pf-modal--wide pf-lightbox" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} ref={ref} onKeyDown={onKeyDown}>
        <h2 id={`${uid}-title`} className="pf-sr-only">
          Screenshot {index + 1} of {items.length}
        </h2>
        <figure className="pf-lightbox__figure">
          <img src={fullUrl} alt={s.caption || `Screenshot of ${game.title} by ${who}`} width={s.width} height={s.height} />
          {s.caption && <figcaption className="pf-lightbox__caption">{s.caption}</figcaption>}
        </figure>
        <div className="pf-lightbox__meta pf-small">
          <UserLink user={s.author} size={20} />
          <time className="pf-muted" dateTime={s.createdAt} title={formatDate(s.createdAt)}>
            {timeAgo(s.createdAt)}
          </time>
          <span className="pf-muted">v{s.gameVersion}</span>
        </div>
        <div className="pf-shot-dialog__actions">
          <button type="button" className="pf-btn pf-btn--sm pf-btn--ghost" onClick={() => onIndex(index - 1)} disabled={index === 0} aria-label="Previous screenshot">
            ←
          </button>
          <button
            type="button"
            className="pf-btn pf-btn--sm pf-btn--ghost"
            onClick={() => onIndex(index + 1)}
            disabled={index >= items.length - 1}
            aria-label="Next screenshot"
          >
            →
          </button>
          <span className="pf-shot-dialog__spacer" />
          <a className="pf-btn pf-btn--sm" href={fullUrl} target="_blank" rel="noopener">
            Open image
          </a>
          {game.isOwner && (
            <button type="button" className="pf-btn pf-btn--sm" onClick={() => setConfirm("thumb")} disabled={busy}>
              🖼 Set as thumbnail
            </button>
          )}
          {user && user.id !== s.author.id && (
            <ReportButton targetType="screenshot" targetId={s.id} targetLabel={s.caption || `by ${who}`} className="pf-btn pf-btn--sm pf-btn--ghost">
              ⚑ Report
            </ReportButton>
          )}
          {s.canDelete && (
            <button type="button" className="pf-btn pf-btn--sm pf-btn--danger" onClick={() => setConfirm("delete")} disabled={busy}>
              Delete
            </button>
          )}
          <button type="button" className="pf-btn pf-btn--sm pf-btn--ghost" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm === "delete"}
        title="Delete this screenshot?"
        confirmLabel="Delete"
        danger
        busy={busy}
        onConfirm={() => void doDelete()}
        onCancel={() => !busy && setConfirm(null)}
      >
        It is removed from the game page permanently.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "thumb"}
        title={`Replace the thumbnail of ${game.title}?`}
        confirmLabel="Replace thumbnail"
        busy={busy}
        onConfirm={() => void doThumb()}
        onCancel={() => !busy && setConfirm(null)}
      >
        Your game card will show this screenshot.
      </ConfirmDialog>
    </div>
  );
}

/** Community screenshots on the game page: grid, "Load more", and a lightbox (F005 § 2.3). */
export function ScreenshotGallery({ game, onGameUpdated }: ScreenshotGalleryProps) {
  const api = useApi();
  const { user, loading: authLoading } = useAuth();
  const [st, setSt] = useState<State>({ items: [], total: 0, page: 0, loading: true, error: null });
  const [open, setOpen] = useState<number | null>(null);
  const gen = useRef(0);
  const gameId = game.id;
  const viewer = user?.id ?? null;

  const load = useCallback(
    (page: number) => {
      const g = page === 1 ? ++gen.current : gen.current;
      setSt((s) => ({ ...s, loading: true, error: null }));
      api.listScreenshots(gameId, { page, perPage: SCREENSHOT_GALLERY_PER_PAGE }).then(
        (r) => {
          if (g !== gen.current) return;
          setSt((s) => {
            const base = page === 1 ? [] : s.items;
            const seen = new Set(base.map((x) => x.id));
            return { items: [...base, ...r.items.filter((x) => !seen.has(x.id))], total: r.total, page, loading: false, error: null };
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
    load(1);
  }, [load, viewer, authLoading]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      const d = (e as CustomEvent<{ gameId?: string }>).detail;
      if (!d || d.gameId === gameId) load(1);
    };
    window.addEventListener(SCREENSHOTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SCREENSHOTS_CHANGED_EVENT, onChanged);
  }, [gameId, load]);

  const onDeleted = (s: Screenshot) => {
    setSt((cur) => ({ ...cur, items: cur.items.filter((x) => x.id !== s.id), total: Math.max(0, cur.total - 1) }));
    setOpen(null);
  };

  const { items, total, loading, error } = st;
  const hasMore = items.length < total;
  return (
    <section className="pf-panel pf-shots" id={SCREENSHOTS_SECTION_ID} aria-labelledby={`${SCREENSHOTS_SECTION_ID}-title`}>
      <h2 className="pf-panel__title" id={`${SCREENSHOTS_SECTION_ID}-title`}>
        Screenshots{total > 0 ? <span className="pf-tab__count">{total}</span> : null}
      </h2>
      {error && items.length === 0 ? (
        <LoadError message={`Couldn't load screenshots: ${errorMessage(error)}`} onRetry={() => load(1)} />
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
          <ul className="pf-shots__grid">
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
          {error && <LoadError message={`Couldn't load more: ${errorMessage(error)}`} onRetry={() => load(st.page + 1)} />}
          {hasMore && !error && (
            <div className="pf-shots__more">
              <button type="button" className="pf-btn pf-btn--sm" onClick={() => load(st.page + 1)} disabled={loading}>
                {loading ? <Spinner size={12} /> : null} Load more
              </button>
            </div>
          )}
        </>
      )}
      {open !== null && items[open] && (
        <Lightbox
          items={items}
          index={open}
          game={game}
          onIndex={(i) => setOpen(Math.max(0, Math.min(items.length - 1, i)))}
          onClose={() => setOpen(null)}
          onDeleted={onDeleted}
          onGameUpdated={onGameUpdated}
        />
      )}
    </section>
  );
}

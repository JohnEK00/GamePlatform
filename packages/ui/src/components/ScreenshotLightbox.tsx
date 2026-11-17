import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import type { Game, Screenshot } from "../api/types";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage, formatDate, gameScreenshotsPath, timeAgo } from "../util";
import { ConfirmDialog, UserLink } from "./common";
import { ReportButton } from "./Report";
import { setThumbnailFromUrl } from "./ScreenshotDialog";
import { useModal } from "./useModal";

export type ScreenshotLightboxProps<T extends Screenshot = Screenshot> = {
  items: T[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onDeleted: (s: T) => void;
  /** Focus target after a delete (it wins over the opener, F015 § 0.12) or when the opener is gone (see `useModal`). */
  returnFocus: () => HTMLElement | null;
  /** Title of the screenshot's game (alt text, view link). */
  gameTitle: (s: T) => string;
  /** Game page only, owner only: shows "🖼 Set as thumbnail" for this game. */
  thumbnailGame?: { id: string; title: string; onGameUpdated?: (g: Game) => void };
  /** Feed and profile: shows a "View on game page" link to `/games/{s.gameId}?section=screenshots`. */
  showGameLink?: boolean;
};

/** The F005 screenshot lightbox (F015: shared by the game page gallery, the feed and the profile). */
export function ScreenshotLightbox<T extends Screenshot = Screenshot>({
  items,
  index,
  onIndex,
  onClose,
  onDeleted,
  returnFocus,
  gameTitle,
  thumbnailGame,
  showGameLink = false,
}: ScreenshotLightboxProps<T>) {
  const api = useApi();
  const toast = useToast();
  const { user } = useAuth();
  const uid = useId();
  const [confirm, setConfirm] = useState<null | "delete" | "thumb">(null);
  const [busy, setBusy] = useState(false);
  // F015 § 0.12: after a delete, focus goes to `returnFocus` (the thumbnail now at the deleted shot's position, …)
  // even when the thumbnail that opened the lightbox still exists (the user may have arrowed to another shot).
  const deleted = useRef(false);
  const ref = useModal<HTMLDivElement>(true, onClose, { canClose: !busy, returnFocus, preferReturnFocus: () => deleted.current });
  const s = items[index];
  if (!s) return null;
  const who = s.author.displayName || s.author.username;
  const title = gameTitle(s);

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
      deleted.current = true;
      onDeleted(s);
    } catch (e) {
      toast.error("Couldn't delete the screenshot", errorMessage(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const doThumb = async () => {
    if (!thumbnailGame) return;
    setBusy(true);
    try {
      const g = await setThumbnailFromUrl(api, thumbnailGame.id, s.imageUrl);
      toast.success("Thumbnail updated", thumbnailGame.title);
      thumbnailGame.onGameUpdated?.(g);
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
          <img src={fullUrl} alt={s.caption || `Screenshot of ${title} by ${who}`} width={s.width} height={s.height} />
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
          {/* aria-disabled (not disabled) at the ends, so focus and the arrow keys keep working (review 3, L1b). */}
          <button
            type="button"
            className="pf-btn pf-btn--sm pf-btn--ghost"
            onClick={() => index > 0 && onIndex(index - 1)}
            aria-disabled={index === 0}
            aria-label="Previous screenshot"
          >
            ←
          </button>
          <button
            type="button"
            className="pf-btn pf-btn--sm pf-btn--ghost"
            onClick={() => index < items.length - 1 && onIndex(index + 1)}
            aria-disabled={index >= items.length - 1}
            aria-label="Next screenshot"
          >
            →
          </button>
          <span className="pf-shot-dialog__spacer" />
          {showGameLink && (
            <Link className="pf-btn pf-btn--sm" to={gameScreenshotsPath(s.gameId)}>
              View on game page
            </Link>
          )}
          <a className="pf-btn pf-btn--sm" href={fullUrl} target="_blank" rel="noopener">
            Open image
          </a>
          {thumbnailGame && (
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
        It is removed from the game page and everywhere else permanently.
      </ConfirmDialog>
      {thumbnailGame && (
        <ConfirmDialog
          open={confirm === "thumb"}
          title={`Replace the thumbnail of ${thumbnailGame.title}?`}
          confirmLabel="Replace thumbnail"
          busy={busy}
          onConfirm={() => void doThumb()}
          onCancel={() => !busy && setConfirm(null)}
        >
          Your game card will show this screenshot.
        </ConfirmDialog>
      )}
    </div>
  );
}

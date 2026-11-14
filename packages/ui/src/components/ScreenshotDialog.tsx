import { useId, useState } from "react";
import { isApiError, type ApiClient } from "../api/client";
import type { Game, Screenshot } from "../api/types";
import { useApi, usePlatform } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import {
  codePointLength,
  fitImageForUpload,
  launderImage,
  sanitizeScreenshotCaption,
  SCREENSHOT_CAPTION_MAX,
  screenshotFileName,
} from "../screenshot";
import { downloadBlob } from "../studio/project";
import { errorMessage } from "../util";
import { ConfirmDialog, Spinner } from "./common";
import { useModal } from "./useModal";
import type { ScreenshotItem } from "./useScreenshotCapture";

/** Window event fired after a screenshot was posted or deleted (`detail: { gameId }`); the gallery reloads on it. */
export const SCREENSHOTS_CHANGED_EVENT = "webgame:screenshots-changed";
/** DOM id of the game page's Screenshots section (the "View" toast action scrolls to it). */
export const SCREENSHOTS_SECTION_ID = "screenshots";

export function notifyScreenshotsChanged(gameId: string): void {
  window.dispatchEvent(new CustomEvent(SCREENSHOTS_CHANGED_EVENT, { detail: { gameId } }));
}

export function scrollToScreenshots(): void {
  const el = document.getElementById(SCREENSHOTS_SECTION_ID);
  if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** User-facing text for a failed screenshot post / thumbnail update (F005 § 2.2). */
export function screenshotErrorMessage(e: unknown): string {
  if (isApiError(e)) {
    if (e.status === 429 || e.code === "rate_limited")
      return `You're posting too many screenshots, try again in ${e.retryAfter ? `${e.retryAfter}s` : "a moment"}`;
    if (e.status === 503) return "The server is busy, try again in a few seconds";
    if (e.status === 404) return "This game is no longer available";
    if (e.status === 422 && /\b20\b/.test(e.message)) return "You've posted 20 screenshots for this game; delete one first";
  }
  return errorMessage(e);
}

/** Fits an already laundered PNG under 2 MB and makes it the game's thumbnail. */
export async function setThumbnailFromLaundered(api: ApiClient, gameId: string, png: Blob): Promise<Game> {
  const fitted = await fitImageForUpload(png);
  return api.replaceThumbnail(gameId, fitted);
}

/** Gallery path: fetch the stored image, launder it again (never trust bytes), fit, upload. */
export async function setThumbnailFromUrl(api: ApiClient, gameId: string, imageUrl: string): Promise<Game> {
  const res = await fetch(api.url(imageUrl));
  if (!res.ok) throw new Error("Couldn't load the image.");
  const { blob } = await launderImage(await res.blob());
  return setThumbnailFromLaundered(api, gameId, blob);
}

export type ScreenshotDialogGame = {
  /** Absent in the Studio. */
  id?: string;
  title: string;
  published?: boolean;
  isOwner?: boolean;
};

export type ScreenshotDialogProps = {
  item: ScreenshotItem;
  /** 1-based position in the tray (for the heading). */
  index: number;
  mode: "player" | "studio";
  game: ScreenshotDialogGame;
  onRemove: () => void;
  onClose: () => void;
  /** After "Set as thumbnail" succeeded. */
  onGameUpdated?: (g: Game) => void;
  onPosted?: (s: Screenshot) => void;
};

function canCopyImages(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.clipboard?.write === "function" && typeof ClipboardItem !== "undefined";
}

/** A tray item's actions: caption, Download, Copy, Post to game page, Set as thumbnail, Remove (F005 § 2.2). */
export function ScreenshotDialog({ item, index, mode, game, onRemove, onClose, onGameUpdated, onPosted }: ScreenshotDialogProps) {
  const api = useApi();
  const platform = usePlatform();
  const toast = useToast();
  const { user } = useAuth();
  const uid = useId();
  const [caption, setCaption] = useState(() => sanitizeScreenshotCaption(item.caption));
  const [busy, setBusy] = useState<null | "post" | "thumb" | "download">(null);
  const [confirmThumb, setConfirmThumb] = useState(false);
  const ref = useModal<HTMLDivElement>(true, onClose, { canClose: busy === null && !confirmThumb });

  const isStudio = mode === "studio";
  const owner = !!game.isOwner;
  const showPost = !isStudio && !!game.id && (game.published !== false || owner);
  const showThumb = !isStudio && !!game.id && owner;
  const alt = caption.trim() || `Screenshot of ${game.title}`;

  const download = async () => {
    const name = screenshotFileName(game.title, new Date(item.capturedAt));
    if (platform.saveFile) {
      setBusy("download");
      try {
        if (await platform.saveFile(name, item.blob)) toast.success("Saved", name);
      } catch (e) {
        toast.error("Couldn't save the screenshot", typeof e === "string" ? e : errorMessage(e));
      } finally {
        setBusy(null);
      }
      return;
    }
    downloadBlob(item.blob, name);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": item.blob })]);
      toast.success("Copied");
    } catch (e) {
      toast.error("Couldn't copy the screenshot", errorMessage(e));
    }
  };

  const post = async () => {
    if (!game.id) return;
    const gameId = game.id;
    setBusy("post");
    try {
      const blob = await fitImageForUpload(item.blob);
      const s = await api.postScreenshot(gameId, blob, sanitizeScreenshotCaption(caption));
      toast.show({ kind: "success", title: "Posted", action: { label: "View", onClick: scrollToScreenshots } });
      notifyScreenshotsChanged(gameId);
      onPosted?.(s);
    } catch (e) {
      toast.error("Couldn't post the screenshot", screenshotErrorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const setThumb = async () => {
    if (!game.id) return;
    setBusy("thumb");
    try {
      const g = await setThumbnailFromLaundered(api, game.id, item.blob);
      setConfirmThumb(false);
      toast.success("Thumbnail updated", game.title);
      onGameUpdated?.(g);
    } catch (e) {
      setConfirmThumb(false);
      toast.error("Couldn't set the thumbnail", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const len = codePointLength(caption);

  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && busy === null && onClose()}>
      <div className="pf-modal pf-modal--wide pf-shot-dialog" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} ref={ref}>
        <h2 id={`${uid}-title`}>
          Screenshot {index}
          {item.source === "game" && <span className="pf-badge pf-shot-badge">from game</span>}
        </h2>
        <figure className="pf-shot-dialog__figure">
          <img src={item.url} alt={alt} width={item.width} height={item.height} />
          <figcaption className="pf-muted pf-small">
            {item.width}×{item.height}
          </figcaption>
        </figure>
        {!isStudio && (
          <div className="pf-field">
            <label className="pf-label" htmlFor={`${uid}-caption`}>
              Caption <span className="pf-muted pf-small">(optional)</span>
            </label>
            <input
              id={`${uid}-caption`}
              className="pf-input"
              type="text"
              value={caption}
              onChange={(e) => setCaption(Array.from(e.target.value.replace(/[\r\n]/g, " ")).slice(0, SCREENSHOT_CAPTION_MAX).join(""))}
              disabled={busy !== null}
              autoComplete="off"
            />
            <span className="pf-field__hint" aria-live="polite">
              {len}/{SCREENSHOT_CAPTION_MAX}
            </span>
          </div>
        )}
        {showPost && (
          <p className="pf-muted pf-small pf-shot-dialog__hint">
            {!user ? "Sign in to post" : game.published === false ? "Visible after you publish" : "Visible to everyone on the game page"}
          </p>
        )}
        <div className="pf-shot-dialog__actions">
          <button type="button" className="pf-btn pf-btn--sm" onClick={() => void download()} disabled={busy !== null}>
            {busy === "download" ? <Spinner size={12} /> : "⬇"} Download
          </button>
          {canCopyImages() && (
            <button type="button" className="pf-btn pf-btn--sm" onClick={() => void copy()} disabled={busy !== null}>
              ⧉ Copy
            </button>
          )}
          {showPost && (
            <button
              type="button"
              className="pf-btn pf-btn--sm pf-btn--primary"
              onClick={() => void post()}
              disabled={!user || busy !== null}
              title={!user ? "Sign in to post" : undefined}
            >
              {busy === "post" ? <Spinner size={12} /> : null} Post to game page
            </button>
          )}
          {showThumb && (
            <button type="button" className="pf-btn pf-btn--sm" onClick={() => setConfirmThumb(true)} disabled={busy !== null}>
              🖼 Set as thumbnail
            </button>
          )}
          <span className="pf-shot-dialog__spacer" />
          <button
            type="button"
            className="pf-btn pf-btn--sm pf-btn--ghost"
            onClick={() => {
              onRemove();
              onClose();
            }}
            disabled={busy !== null}
          >
            Remove
          </button>
          <button type="button" className="pf-btn pf-btn--sm pf-btn--ghost" onClick={onClose} disabled={busy !== null}>
            Close
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmThumb}
        title={`Replace the thumbnail of ${game.title}?`}
        confirmLabel="Replace thumbnail"
        busy={busy === "thumb"}
        onConfirm={() => void setThumb()}
        onCancel={() => busy === null && setConfirmThumb(false)}
      >
        Your game card will show this frame.
      </ConfirmDialog>
    </div>
  );
}

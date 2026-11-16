import { useRef, useState, type RefObject } from "react";
import type { Game, Screenshot } from "../api/types";
import { ScreenshotDialog, type ScreenshotDialogGame } from "./ScreenshotDialog";
import type { ScreenshotItem } from "./useScreenshotCapture";

export type ScreenshotTrayProps = {
  items: ScreenshotItem[];
  mode: "player" | "studio";
  game: ScreenshotDialogGame;
  onRemove: (id: number) => void;
  onClear: () => void;
  onGameUpdated?: (g: Game) => void;
  onPosted?: (s: Screenshot) => void;
  /** Where focus goes when the last item is removed and the tray disappears (normally the 📷 button). */
  emptyFocusRef?: RefObject<HTMLElement | null>;
};

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Horizontal strip of in-memory captures under a player (F005 § 2.2). Renders nothing when empty. */
export function ScreenshotTray({ items, mode, game, onRemove, onClear, onGameUpdated, onPosted, emptyFocusRef }: ScreenshotTrayProps) {
  const [openId, setOpenId] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // List position of the open item, kept for the focus fallback after "Remove".
  const lastIndex = useRef(0);
  if (items.length === 0) return null;
  const openIndex = openId === null ? -1 : items.findIndex((x) => x.id === openId);
  const open = openIndex >= 0 ? items[openIndex] : null;
  if (openIndex >= 0) lastIndex.current = openIndex;
  // After "Remove" (or "Clear all"), focus the item that took its place, else the previous one, else the 📷 button.
  const returnFocus = () => {
    const buttons = listRef.current?.querySelectorAll<HTMLElement>(".pf-shot-tray__item");
    if (buttons && buttons.length) return buttons[Math.min(lastIndex.current, buttons.length - 1)];
    return emptyFocusRef?.current ?? null;
  };
  // Number items oldest = 1 so a thumbnail keeps its number as newer ones arrive.
  const numberOf = (i: number) => items.length - i;

  return (
    <div className="pf-shot-tray" role="region" aria-label="Screenshots">
      <ul className="pf-shot-tray__list" ref={listRef}>
        {items.map((it, i) => (
          <li key={it.id}>
            <button
              type="button"
              className="pf-shot-tray__item"
              onClick={() => setOpenId(it.id)}
              aria-haspopup="dialog"
              aria-label={`Screenshot ${numberOf(i)}, captured ${timeLabel(it.capturedAt)}${it.source === "game" ? ", from game" : ""}`}
            >
              <img src={it.url} alt="" style={{ aspectRatio: `${it.width} / ${it.height}` }} />
              {it.source === "game" && (
                <span className="pf-shot-tray__tag" aria-hidden="true">
                  from game
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="pf-shot-tray__meta">
        <button
          type="button"
          className="pf-linkbtn"
          onClick={() => {
            onClear();
            // The tray (and this button) disappears; keep focus on a stable control.
            emptyFocusRef?.current?.focus();
          }}
        >
          Clear all
        </button>
        <span className="pf-muted pf-small">Kept only until you leave this page.</span>
      </div>
      {open && (
        <ScreenshotDialog
          key={open.id}
          item={open}
          index={numberOf(openIndex)}
          mode={mode}
          game={game}
          onRemove={() => onRemove(open.id)}
          onClose={() => setOpenId(null)}
          onGameUpdated={onGameUpdated}
          onPosted={onPosted}
          returnFocus={returnFocus}
        />
      )}
    </div>
  );
}

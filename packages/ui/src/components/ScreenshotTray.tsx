import { useState } from "react";
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
};

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Horizontal strip of in-memory captures under a player (F005 § 2.2). Renders nothing when empty. */
export function ScreenshotTray({ items, mode, game, onRemove, onClear, onGameUpdated, onPosted }: ScreenshotTrayProps) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (items.length === 0) return null;
  const openIndex = openId === null ? -1 : items.findIndex((x) => x.id === openId);
  const open = openIndex >= 0 ? items[openIndex] : null;
  // Number items oldest = 1 so a thumbnail keeps its number as newer ones arrive.
  const numberOf = (i: number) => items.length - i;

  return (
    <div className="pf-shot-tray" role="region" aria-label="Screenshots">
      <ul className="pf-shot-tray__list">
        {items.map((it, i) => (
          <li key={it.id}>
            <button
              type="button"
              className="pf-shot-tray__item"
              onClick={() => setOpenId(it.id)}
              aria-haspopup="dialog"
              aria-label={`Screenshot ${numberOf(i)}, captured ${timeLabel(it.capturedAt)}`}
            >
              <img src={it.url} alt="" style={{ aspectRatio: `${it.width} / ${it.height}` }} />
              {it.source === "game" && <span className="pf-shot-tray__tag">from game</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="pf-shot-tray__meta">
        <button type="button" className="pf-linkbtn" onClick={onClear}>
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
        />
      )}
    </div>
  );
}

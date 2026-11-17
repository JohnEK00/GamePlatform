import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import type { CollectionItem } from "../api/types";
import { COLLECTION_NOTE_MAX, collectionMessage, validateCollectionNote } from "../collections";
import { errorMessage, formatCount } from "../util";
import { Spinner, Thumbnail } from "./common";

/** The label used for an item in control labels and announcements. */
export function collectionItemTitle(item: CollectionItem): string {
  return item.game ? item.game.title : "Unavailable game";
}

export type MoveDirection = "up" | "down";

export type CollectionItemRowProps = {
  item: CollectionItem;
  /** 0-based position in the collection. */
  index: number;
  /** Items in the list. */
  count: number;
  /** Show the owner controls (move, note, remove). */
  isOwner: boolean;
  onMove?: (index: number, dir: MoveDirection) => void;
  /** Saves the note; rejects with the error to show. */
  onSaveNote?: (gameId: string, note: string) => Promise<void>;
  onRemove?: (index: number) => void;
};

/**
 * One row of a collection page (spec § 2.5). Owner controls are real buttons; Move up / Move down are hidden (not
 * disabled) at the boundaries. Buttons carry `data-action` so the page can restore focus after the list changes.
 */
export function CollectionItemRow({ item, index, count, isOwner, onMove, onSaveNote, onRemove }: CollectionItemRowProps) {
  const uid = useId();
  const g = item.game;
  const title = collectionItemTitle(item);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const editBtn = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Where focus goes after the next commit: the note input (opening) or the Edit note button (closing).
  const focusNext = useRef<"input" | "edit" | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    const el = f === "input" ? inputRef.current : editBtn.current;
    if (el) {
      focusNext.current = null;
      el.focus();
      if (f === "input") inputRef.current?.select();
    }
  });

  const startEdit = () => {
    setDraft(item.note);
    setNoteError(null);
    focusNext.current = "input";
    setEditing(true);
  };
  const cancel = () => {
    if (saving) return;
    focusNext.current = "edit";
    setEditing(false);
    setNoteError(null);
  };
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (saving || !onSaveNote) return;
    const err = validateCollectionNote(draft);
    if (err) {
      setNoteError(collectionMessage(err));
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    setNoteError(null);
    try {
      await onSaveNote(item.gameId, draft.trim());
      if (!alive.current) return;
      focusNext.current = "edit";
      setEditing(false);
    } catch (e2) {
      if (alive.current) {
        setNoteError(collectionMessage(errorMessage(e2)));
        inputRef.current?.focus();
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  const noteLen = Array.from(draft.trim()).length;
  const gamePath = `/games/${encodeURIComponent(item.gameId)}`;
  return (
    <li className={`pf-collection-item${g ? "" : " pf-collection-item--gone"}`} data-game-id={item.gameId}>
      <span className="pf-collection-item__pos" aria-hidden="true">
        {index + 1}
      </span>
      {g ? (
        <Link to={gamePath} className="pf-collection-item__thumb" tabIndex={-1} aria-hidden="true">
          <Thumbnail src={g.thumbnailUrl} seed={g.id} alt="" />
        </Link>
      ) : (
        <span className="pf-collection-item__thumb pf-collection-item__thumb--gone" aria-hidden="true">
          ?
        </span>
      )}
      <div className="pf-collection-item__main">
        {g ? (
          <>
            <h3 className="pf-collection-item__title">
              <Link to={gamePath}>{g.title}</Link>
            </h3>
            <p className="pf-collection-item__meta pf-muted pf-small">
              <span>
                by{" "}
                <Link to={`/u/${encodeURIComponent(g.owner.username)}`} className="pf-collection-item__owner">
                  {g.owner.displayName || g.owner.username}
                </Link>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {formatCount(g.plays)} {g.plays === 1 ? "play" : "plays"}
              </span>
              <span aria-hidden="true">·</span>
              <span>{g.ratingCount > 0 ? `★ ${g.ratingAvg.toFixed(1)} (${g.ratingCount})` : "Not rated"}</span>
            </p>
          </>
        ) : (
          <>
            <h3 className="pf-collection-item__title">Unavailable game</h3>
            <p className="pf-muted pf-small">This game was unpublished or removed by its creator.</p>
          </>
        )}
        {editing ? (
          <form className="pf-collection-note-edit" onSubmit={save} noValidate>
            <label className="pf-sr-only" htmlFor={`${uid}-note`}>
              Note for {title}
            </label>
            <input
              ref={inputRef}
              id={`${uid}-note`}
              className="pf-input pf-input--sm"
              value={draft}
              maxLength={COLLECTION_NOTE_MAX}
              placeholder="Add a short note"
              onChange={(e) => {
                setDraft(e.target.value);
                if (noteError) setNoteError(null);
              }}
              onKeyDown={onKeyDown}
              aria-invalid={noteError ? true : undefined}
              aria-describedby={`${uid}-count${noteError ? ` ${uid}-err` : ""}`}
              disabled={saving}
            />
            <span id={`${uid}-count`} className="pf-field__hint">
              {noteLen}/{COLLECTION_NOTE_MAX}
            </span>
            <button type="submit" className="pf-btn pf-btn--primary pf-btn--sm" disabled={saving}>
              {saving ? <Spinner size={12} /> : null} Save
            </button>
            <button type="button" className="pf-btn pf-btn--ghost pf-btn--sm" onClick={cancel} disabled={saving}>
              Cancel
            </button>
            {noteError && (
              <span id={`${uid}-err`} className="pf-field__error" role="alert">
                {noteError}
              </span>
            )}
          </form>
        ) : (
          item.note && <p className="pf-collection-note">{item.note}</p>
        )}
        {isOwner && (
          <div className="pf-collection-item__controls">
            {g && index > 0 && (
              <button type="button" className="pf-linkbtn" data-action="up" aria-label={`Move up: ${title}`} onClick={() => onMove?.(index, "up")}>
                Move up
              </button>
            )}
            {g && index < count - 1 && (
              <button
                type="button"
                className="pf-linkbtn"
                data-action="down"
                aria-label={`Move down: ${title}`}
                onClick={() => onMove?.(index, "down")}
              >
                Move down
              </button>
            )}
            {g && !editing && (
              <button ref={editBtn} type="button" className="pf-linkbtn" data-action="note" aria-label={`Edit note for ${title}`} onClick={startEdit}>
                Edit note
              </button>
            )}
            <button
              type="button"
              className="pf-linkbtn pf-linkbtn--danger"
              data-action="remove"
              aria-label={`Remove ${title} from collection`}
              onClick={() => onRemove?.(index)}
            >
              Remove
            </button>
          </div>
        )}
      </div>
      {g && (
        <Link to={gamePath} className="pf-btn pf-btn--primary pf-btn--sm pf-collection-item__play" aria-label={`Play ${g.title}`}>
          ▶ Play
        </Link>
      )}
    </li>
  );
}

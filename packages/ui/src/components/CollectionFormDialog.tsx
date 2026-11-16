import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { isApiError } from "../api/client";
import type { Collection, CollectionVisibility, UpdateCollectionRequest } from "../api/types";
import {
  COLLECTION_DESCRIPTION_LINES_MAX,
  COLLECTION_DESCRIPTION_MAX,
  COLLECTION_TITLE_MAX,
  collectionMessage,
  normalizeCollectionDescription,
  validateCollectionDescription,
  validateCollectionTitle,
} from "../collections";
import { useApi } from "../context/config";
import { errorMessage } from "../util";
import { Alert, Spinner } from "./common";
import { useModal } from "./useModal";

export const VISIBILITY_OPTIONS: { value: CollectionVisibility; label: string; hint: string }[] = [
  { value: "public", label: "Public", hint: "Shown on your profile and on game pages" },
  { value: "private", label: "Private", hint: "Only you can see it" },
];

export type CollectionFormDialogProps = {
  open: boolean;
  /** Edit this collection; omitted = create. */
  collection?: Collection | null;
  /** Create only: the first item. */
  gameId?: string;
  onClose: () => void;
  /** The created / updated collection (the dialog does not close itself). */
  onSaved: (c: Collection) => void;
};

const codePoints = (s: string) => Array.from(s).length;

/** Create or edit a collection's title, description and visibility. */
export function CollectionFormDialog({ open, collection, gameId, onClose, onSaved }: CollectionFormDialogProps) {
  const api = useApi();
  const uid = useId();
  const editing = !!collection;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<CollectionVisibility>("public");
  const [busy, setBusy] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [descError, setDescError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const ref = useModal<HTMLFormElement>(open, onClose, { canClose: !busy });

  useEffect(() => {
    if (!open) return;
    setTitle(collection?.title ?? "");
    setDescription(collection?.description ?? "");
    setVisibility(collection?.visibility ?? "public");
    setTitleError(null);
    setDescError(null);
    setError(null);
    setBusy(false);
    // Only when (re)opened: later prop updates must not wipe what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const tErr = validateCollectionTitle(title);
    const dErr = validateCollectionDescription(description);
    setTitleError(tErr ? collectionMessage(tErr) : null);
    setDescError(dErr ? collectionMessage(dErr) : null);
    setError(null);
    if (tErr || dErr) {
      (tErr ? titleRef.current : descRef.current)?.focus();
      return;
    }
    const t = title.trim();
    const d = normalizeCollectionDescription(description);
    setBusy(true);
    try {
      let saved: Collection;
      if (collection) {
        const patch: UpdateCollectionRequest = {};
        if (t !== collection.title) patch.title = t;
        if (d !== collection.description) patch.description = d;
        if (visibility !== collection.visibility) patch.visibility = visibility;
        saved = Object.keys(patch).length > 0 ? await api.updateCollection(collection.id, patch) : collection;
      } else {
        saved = await api.createCollection({ title: t, description: d || undefined, visibility, ...(gameId ? { gameId } : {}) });
      }
      setBusy(false);
      onSaved(saved);
    } catch (err) {
      setBusy(false);
      const msg = errorMessage(err);
      if (isApiError(err) && err.status === 422 && /^title/i.test(msg)) setTitleError(collectionMessage(msg));
      else if (isApiError(err) && err.status === 422 && /^description/i.test(msg)) setDescError(collectionMessage(msg));
      else setError(collectionMessage(msg));
    }
  };

  const titleLen = codePoints(title.trim());
  const descLen = codePoints(normalizeCollectionDescription(description));
  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="pf-modal pf-modal--wide pf-collection-form"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-heading`}
        ref={ref}
        onSubmit={submit}
        noValidate
      >
        <h2 id={`${uid}-heading`}>{editing ? "Edit collection" : "New collection"}</h2>
        <div className="pf-stack">
          <div className="pf-field">
            <label className="pf-label" htmlFor={`${uid}-title-input`}>
              Title <span className="pf-req">*</span>
            </label>
            <input
              ref={titleRef}
              data-autofocus
              id={`${uid}-title-input`}
              className="pf-input"
              value={title}
              maxLength={COLLECTION_TITLE_MAX * 2}
              required
              aria-invalid={titleError ? true : undefined}
              aria-describedby={`${uid}-title-count${titleError ? ` ${uid}-title-err` : ""}`}
              onChange={(e) => {
                setTitle(e.target.value);
                if (titleError) setTitleError(null);
              }}
              disabled={busy}
            />
            <span id={`${uid}-title-count`} className="pf-field__hint">
              {titleLen}/{COLLECTION_TITLE_MAX}
            </span>
            {titleError && (
              <span id={`${uid}-title-err`} className="pf-field__error">
                {titleError}
              </span>
            )}
          </div>
          <div className="pf-field">
            <label className="pf-label" htmlFor={`${uid}-desc`}>
              Description <span className="pf-muted pf-small">(optional)</span>
            </label>
            <textarea
              ref={descRef}
              id={`${uid}-desc`}
              className="pf-input"
              rows={4}
              value={description}
              maxLength={COLLECTION_DESCRIPTION_MAX * 2}
              aria-invalid={descError ? true : undefined}
              aria-describedby={`${uid}-desc-hint${descError ? ` ${uid}-desc-err` : ""}`}
              onChange={(e) => {
                setDescription(e.target.value);
                if (descError) setDescError(null);
              }}
              disabled={busy}
            />
            <span id={`${uid}-desc-hint`} className="pf-field__hint">
              Up to {COLLECTION_DESCRIPTION_LINES_MAX} lines · {descLen}/{COLLECTION_DESCRIPTION_MAX}
            </span>
            {descError && (
              <span id={`${uid}-desc-err`} className="pf-field__error">
                {descError}
              </span>
            )}
          </div>
          <fieldset className="pf-report__reasons pf-collection-form__visibility">
            <legend className="pf-label">Visibility</legend>
            {VISIBILITY_OPTIONS.map((o) => (
              <label key={o.value} className={`pf-report__reason${visibility === o.value ? " is-active" : ""}`}>
                <input
                  type="radio"
                  name={`${uid}-visibility`}
                  value={o.value}
                  checked={visibility === o.value}
                  onChange={() => setVisibility(o.value)}
                  disabled={busy}
                />
                <span>
                  <strong>{o.label}</strong>
                  <span className="pf-muted pf-small">{o.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && <Alert>{error}</Alert>}
        </div>
        <div className="pf-modal__actions">
          <button type="button" className="pf-btn pf-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="pf-btn pf-btn--primary" disabled={busy}>
            {busy ? <Spinner size={14} /> : null} {editing ? "Save changes" : "Create collection"}
          </button>
        </div>
      </form>
    </div>
  );
}

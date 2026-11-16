import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { Collection, CollectionVisibility, MyCollection } from "../api/types";
import { COLLECTION_GAMES_MAX, COLLECTION_TITLE_MAX, COLLECTIONS_PER_USER_MAX, collectionMessage, validateCollectionTitle } from "../collections";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { errorMessage } from "../util";
import { isCollectionsUnsupportedError, useCollectionsSupported } from "./collectionsSupport";
import { ErrorState, Skeleton, Spinner } from "./common";
import { VISIBILITY_OPTIONS } from "./CollectionFormDialog";
import { useModal } from "./useModal";

export type AddToCollectionDialogProps = {
  gameId: string;
  gameTitle: string;
  onClose: () => void;
};

function toMine(c: Collection, gameId: string): MyCollection {
  const { items, isOwner: _o, canDelete: _d, ...summary } = c;
  const list = Array.isArray(items) ? items : [];
  return { ...summary, containsGame: list.length === 0 || list.some((i) => i.gameId === gameId), itemCount: Math.max(1, list.length) };
}

/**
 * "Add to collection" (spec § 2.4): one native checkbox per collection of the viewer, toggled immediately with
 * PUT / DELETE, plus an inline "New collection…" form. Mount it while open; focus returns to the opener on close.
 */
export function AddToCollectionDialog({ gameId, gameTitle, onClose }: AddToCollectionDialogProps) {
  const api = useApi();
  const uid = useId();
  const [items, setItems] = useState<MyCollection[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const busyRef = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState({ n: 0, text: "" });
  const [formOpen, setFormOpen] = useState<boolean | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newVis, setNewVis] = useState<CollectionVisibility>("public");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const checkboxes = useRef(new Map<string, HTMLInputElement>());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<"title" | { id: string } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const ref = useModal<HTMLDivElement>(true, onClose, { canClose: !creating, initialFocus: "[data-dialog-heading]" });

  const announce = useCallback((text: string) => setLive((l) => ({ n: l.n + 1, text })), []);

  useEffect(() => {
    let on = true;
    setLoadError(null);
    setItems(null);
    api.listMyCollections(gameId).then(
      (xs) => {
        if (!on) return;
        const list = Array.isArray(xs) ? xs : [];
        setItems(list);
        // Empty: the inline form opens; move focus there if it is still on the heading.
        if (list.length === 0 && document.activeElement === headingRef.current) {
          pendingFocus.current = "title";
          setFocusTick((t) => t + 1);
        }
      },
      (e) => {
        if (on) setLoadError(e);
      },
    );
    return () => {
      on = false;
    };
  }, [api, gameId, tick]);

  // Focus requests run after the DOM has the target.
  useEffect(() => {
    const req = pendingFocus.current;
    if (!req) return;
    const el = req === "title" ? titleRef.current : (checkboxes.current.get(req.id) ?? null);
    if (el) {
      pendingFocus.current = null;
      el.focus();
    }
  });

  const setBusyFor = (id: string, on: boolean) => {
    if (on) busyRef.current.add(id);
    else busyRef.current.delete(id);
    setBusy(new Set(busyRef.current));
  };

  const patch = (id: string, f: (c: MyCollection) => MyCollection) => setItems((xs) => (xs ? xs.map((c) => (c.id === id ? f(c) : c)) : xs));

  const toggle = async (c: MyCollection) => {
    if (busyRef.current.has(c.id)) return;
    const want = !c.containsGame;
    if (want && c.itemCount >= COLLECTION_GAMES_MAX) return;
    setBusyFor(c.id, true);
    setError(null);
    patch(c.id, (x) => ({ ...x, containsGame: want }));
    try {
      if (want) {
        const r = await api.putCollectionGame(c.id, gameId);
        patch(c.id, (x) => ({
          ...x,
          containsGame: true,
          itemCount: r?.added === false ? x.itemCount : x.itemCount + 1,
          gameCount: typeof r?.gameCount === "number" ? r.gameCount : x.gameCount,
          updatedAt: r?.updatedAt ?? x.updatedAt,
        }));
        announce(`Added to ${c.title}`);
      } else {
        const r = await api.deleteCollectionGame(c.id, gameId);
        patch(c.id, (x) => ({
          ...x,
          containsGame: false,
          itemCount: r?.removed === false ? x.itemCount : Math.max(0, x.itemCount - 1),
          gameCount: typeof r?.gameCount === "number" ? r.gameCount : x.gameCount,
          updatedAt: r?.updatedAt ?? x.updatedAt,
        }));
        announce(`Removed from ${c.title}`);
      }
    } catch (e) {
      patch(c.id, (x) => ({ ...x, containsGame: !want }));
      if (alive.current) setError(collectionMessage(errorMessage(e)));
    } finally {
      setBusyFor(c.id, false);
    }
  };

  const openForm = () => {
    setFormOpen(true);
    setCreateError(null);
    pendingFocus.current = "title";
    setFocusTick((t) => t + 1);
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (creating) return;
    const err = validateCollectionTitle(newTitle);
    if (err) {
      setCreateError(collectionMessage(err));
      titleRef.current?.focus();
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const c = await api.createCollection({ title: newTitle.trim(), visibility: newVis, gameId });
      if (!alive.current) return;
      const mine = toMine(c, gameId);
      setItems((xs) => [mine, ...(xs ?? []).filter((x) => x.id !== mine.id)]);
      setFormOpen(false);
      setNewTitle("");
      setNewVis("public");
      pendingFocus.current = { id: mine.id };
      setFocusTick((t) => t + 1);
      announce(`Added to ${mine.title}`);
    } catch (err2) {
      if (alive.current) setCreateError(collectionMessage(errorMessage(err2)));
    } finally {
      if (alive.current) setCreating(false);
    }
  };

  void focusTick;
  const unsupported = !!loadError && isCollectionsUnsupportedError(loadError);
  const atCap = !!items && items.length >= COLLECTIONS_PER_USER_MAX;
  const showForm = !!items && !atCap && (formOpen ?? items.length === 0);
  const formId = `${uid}-new`;

  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !creating && onClose()}>
      <div className="pf-modal pf-modal--wide pf-addcoll" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} ref={ref}>
        <h2 id={`${uid}-title`} ref={headingRef} tabIndex={-1} data-dialog-heading>
          Add to collection
        </h2>
        <p className="pf-muted pf-small pf-addcoll__game">{gameTitle}</p>
        <p className="pf-sr-only" role="status" aria-live="polite" aria-atomic="true">
          <span key={live.n}>{live.text}</span>
        </p>
        <div className="pf-addcoll__body">
          {loadError ? (
            unsupported ? (
              <p className="pf-muted">Collections aren't available on this server yet.</p>
            ) : (
              <ErrorState error={loadError} onRetry={() => setTick((t) => t + 1)} />
            )
          ) : !items ? (
            <ul className="pf-addcoll__list" aria-busy="true" aria-label="Loading your collections">
              {[0, 1, 2].map((i) => (
                <li key={i} className="pf-addcoll__item">
                  <Skeleton width="60%" height={18} />
                </li>
              ))}
            </ul>
          ) : (
            <>
              {items.length > 0 && (
                <ul className="pf-addcoll__list" aria-label="Your collections">
                  {items.map((c) => {
                    const isBusy = busy.has(c.id);
                    const full = !c.containsGame && c.itemCount >= COLLECTION_GAMES_MAX;
                    const cbId = `${uid}-cb-${c.id}`;
                    const hintId = `${uid}-full-${c.id}`;
                    return (
                      <li key={c.id} className={`pf-addcoll__item${full ? " is-full" : ""}`}>
                        <input
                          ref={(el) => {
                            if (el) checkboxes.current.set(c.id, el);
                            else checkboxes.current.delete(c.id);
                          }}
                          id={cbId}
                          type="checkbox"
                          checked={c.containsGame}
                          disabled={full}
                          aria-busy={isBusy || undefined}
                          aria-describedby={full ? hintId : undefined}
                          onChange={() => void toggle(c)}
                        />
                        <label htmlFor={cbId} className="pf-addcoll__label">
                          <span className="pf-addcoll__name">{c.title}</span>
                          {c.visibility === "private" && <span className="pf-muted pf-small"> (private)</span>}
                          <span className="pf-muted pf-small pf-addcoll__count">
                            {" "}
                            {c.itemCount}/{COLLECTION_GAMES_MAX}
                          </span>
                        </label>
                        {isBusy && <Spinner size={12} label="Saving" />}
                        {full && (
                          <span id={hintId} className="pf-muted pf-small pf-addcoll__hint">
                            Full ({COLLECTION_GAMES_MAX} games)
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {error && (
                <div className="pf-alert pf-alert--error" role="alert">
                  {error}
                </div>
              )}
              {atCap ? (
                <p className="pf-muted pf-small">You have {COLLECTIONS_PER_USER_MAX} collections, the maximum.</p>
              ) : (
                <div className="pf-addcoll__new">
                  {!showForm && (
                    <button type="button" className="pf-linkbtn pf-addcoll__newbtn" aria-expanded={false} aria-controls={formId} onClick={openForm}>
                      New collection…
                    </button>
                  )}
                  {showForm && (
                    <form id={formId} className="pf-addcoll__form" onSubmit={create} noValidate aria-label="New collection">
                      <div className="pf-field">
                        <label className="pf-label" htmlFor={`${uid}-newtitle`}>
                          New collection title
                        </label>
                        <input
                          ref={titleRef}
                          id={`${uid}-newtitle`}
                          className="pf-input"
                          value={newTitle}
                          maxLength={COLLECTION_TITLE_MAX * 2}
                          aria-invalid={createError ? true : undefined}
                          aria-describedby={createError ? `${uid}-newerr` : undefined}
                          onChange={(e) => {
                            setNewTitle(e.target.value);
                            if (createError) setCreateError(null);
                          }}
                          disabled={creating}
                        />
                      </div>
                      <fieldset className="pf-addcoll__vis">
                        <legend className="pf-label">Visibility</legend>
                        {VISIBILITY_OPTIONS.map((o) => (
                          <label key={o.value} className="pf-addcoll__radio">
                            <input
                              type="radio"
                              name={`${uid}-vis`}
                              value={o.value}
                              checked={newVis === o.value}
                              onChange={() => setNewVis(o.value)}
                              disabled={creating}
                            />{" "}
                            {o.label}
                          </label>
                        ))}
                      </fieldset>
                      {createError && (
                        <span id={`${uid}-newerr`} className="pf-field__error" role="alert">
                          {createError}
                        </span>
                      )}
                      <div className="pf-row">
                        <button type="submit" className="pf-btn pf-btn--primary pf-btn--sm" disabled={creating}>
                          {creating ? <Spinner size={12} /> : null} Create and add
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="pf-modal__actions">
          <button type="button" className="pf-btn pf-btn--primary" onClick={onClose} disabled={creating}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export type AddToCollectionButtonProps = {
  gameId: string;
  gameTitle: string;
  className?: string;
};

/** "+ Collection" on the game page: opens the dialog; anonymous viewers get a log-in link. Hidden on servers without F008. */
export function AddToCollectionButton({ gameId, gameTitle, className = "pf-btn pf-btn--ghost pf-btn--sm" }: AddToCollectionButtonProps) {
  const { user } = useAuth();
  const supported = useCollectionsSupported();
  const [open, setOpen] = useState(false);
  if (!supported) return null;
  if (!user)
    return (
      <Link to={`/login?next=${encodeURIComponent(`/games/${gameId}`)}`} className={className}>
        + Collection
      </Link>
    );
  return (
    <>
      <button type="button" className={className} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        + Collection
      </button>
      {open && <AddToCollectionDialog gameId={gameId} gameTitle={gameTitle} onClose={() => setOpen(false)} />}
    </>
  );
}

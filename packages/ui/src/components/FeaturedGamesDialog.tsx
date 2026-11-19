// F029 (folded into F032): the picker for a profile's featured games (spec section 0.15).
// Disabled states use aria-disabled, never `disabled`, so keyboard focus is never lost.

import { useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { GameSummary } from "../api/types";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { FEATURED_GAMES_MAX, moveItem } from "../home";
import { errorMessage, useAsync } from "../util";
import { Alert, LoadError, Spinner, Thumbnail } from "./common";
import { useModal } from "./useModal";

const UP = String.fromCodePoint(0x2191);
const DOWN = String.fromCodePoint(0x2193);
const ELLIPSIS = String.fromCodePoint(0x2026);
/** Candidates fetched per list (the API maximum). */
const CANDIDATES_PER_LIST = 100;

export type FeaturedGamesDialogProps = {
  open: boolean;
  /** The current featured list (the dialog's starting selection). */
  initial: GameSummary[];
  onClose: () => void;
  /** The saved list from the server (the dialog closes itself after calling it). */
  onSaved: (featured: GameSummary[]) => void;
  /** Where focus goes on close when the opener is gone (e.g. `Feature games` replaced by `Edit featured`). */
  returnFocus?: () => HTMLElement | null | undefined;
};

const ownerName = (g: GameSummary) => g.owner.displayName || g.owner.username;
const isPublished = (g: GameSummary) => !!g && typeof g.id === "string" && g.published !== false;

/** Picker dialog for F029 featured games: up to 4, ordered, from your published games and your favorites. */
export function FeaturedGamesDialog(props: FeaturedGamesDialogProps) {
  if (!props.open) return null;
  return <FeaturedGamesDialogBody {...props} />;
}

type PendingFocus = { kind: "move"; id: string; dir: "up" | "down" } | { kind: "heading" };

function FeaturedGamesDialogBody({ initial, onClose, onSaved, returnFocus }: FeaturedGamesDialogProps) {
  const api = useApi();
  const toast = useToast();
  const [selected, setSelected] = useState<GameSummary[]>(() => (Array.isArray(initial) ? initial.slice(0, FEATURED_GAMES_MAX) : []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);
  const savingRef = useRef(false);
  const close = () => {
    if (!savingRef.current) onClose();
  };
  const ref = useModal<HTMLDivElement>(true, close, { initialFocus: "#featured-dialog-title", canClose: !saving, returnFocus });

  const candidates = useAsync(async () => {
    const [own, favs] = await Promise.all([
      api.listGames({ owner: "me", sort: "new", perPage: CANDIDATES_PER_LIST }),
      api.listMyFavorites({ perPage: CANDIDATES_PER_LIST }),
    ]);
    const mine = (Array.isArray(own?.items) ? own.items : []).filter(isPublished);
    const mineIds = new Set(mine.map((g) => g.id));
    const favorites = (Array.isArray(favs?.items) ? favs.items : []).filter((g) => isPublished(g) && !mineIds.has(g.id));
    return { mine, favorites };
  }, [api]);

  useLayoutEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    const root = ref.current;
    if (!root) return;
    const target =
      p.kind === "heading"
        ? root.querySelector<HTMLElement>("#featured-selected-title")
        : Array.from(root.querySelectorAll<HTMLElement>("[data-featured-move]")).find((b) => b.dataset.featuredMove === `${p.id}:${p.dir}`);
    target?.focus();
  });

  const full = selected.length >= FEATURED_GAMES_MAX;
  const selectedIds = useMemo(() => new Set(selected.map((g) => g.id)), [selected]);

  const move = (index: number, delta: -1 | 1) => {
    if (savingRef.current) return;
    const to = index + delta;
    if (to < 0 || to >= selected.length) return;
    pendingFocus.current = { kind: "move", id: selected[index].id, dir: delta < 0 ? "up" : "down" };
    setSelected((s) => moveItem(s, index, delta));
  };
  const remove = (id: string) => {
    if (savingRef.current) return;
    pendingFocus.current = { kind: "heading" };
    setSelected((s) => s.filter((g) => g.id !== id));
  };
  const add = (g: GameSummary) => {
    if (savingRef.current || selectedIds.has(g.id) || full) return;
    setSelected((s) => (s.length >= FEATURED_GAMES_MAX || s.some((x) => x.id === g.id) ? s : [...s, g]));
  };
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const res = await api.setFeaturedGames(selected.map((g) => g.id));
      savingRef.current = false;
      toast.success("Featured games saved.");
      onSaved(Array.isArray(res?.featured) ? res.featured : selected);
      onClose();
    } catch (err) {
      savingRef.current = false;
      setSaving(false);
      setError(errorMessage(err));
    }
  };

  /** aria-disabled buttons: ignore the press (the handler is a no-op) but keep focus where it is. */
  const guard = (disabled: boolean, fn: () => void) => (e: MouseEvent) => {
    if (disabled) {
      e.preventDefault();
      return;
    }
    fn();
  };

  const candidateRow = (g: GameSummary, showOwner: boolean) => {
    const added = selectedIds.has(g.id);
    const off = added || full || saving;
    return (
      <li key={g.id} className="pf-featured-row">
        <span className="pf-featured-row__thumb" aria-hidden="true">
          <Thumbnail src={g.thumbnailUrl} seed={g.id} alt="" />
        </span>
        <span className="pf-featured-row__title">
          <span className="pf-featured-row__name">{g.title}</span>
          {showOwner && <span className="pf-muted pf-small"> by {ownerName(g)}</span>}
        </span>
        <span className="pf-featured-row__actions">
          <button
            type="button"
            className="pf-btn pf-btn--sm"
            aria-label={`Add ${g.title}`}
            aria-disabled={off ? "true" : undefined}
            onClick={guard(off, () => add(g))}
          >
            {added ? "Added" : "Add"}
          </button>
        </span>
      </li>
    );
  };

  const lists = candidates.data;
  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="pf-modal pf-featured-dialog" role="dialog" aria-modal="true" aria-labelledby="featured-dialog-title" ref={ref}>
        <h2 id="featured-dialog-title" tabIndex={-1}>
          Featured games
        </h2>
        <p className="pf-muted">Pick up to 4 games. They show first on your profile, in this order.</p>

        <h3 id="featured-selected-title" className="pf-featured-dialog__subtitle" tabIndex={-1}>
          Selected ({selected.length}/{FEATURED_GAMES_MAX})
        </h3>
        {selected.length === 0 ? (
          <p className="pf-muted">No games selected. Your profile won't show a Featured row.</p>
        ) : (
          <ol className="pf-featured-selected" aria-labelledby="featured-selected-title">
            {selected.map((g, i) => {
              const first = i === 0;
              const last = i === selected.length - 1;
              return (
                <li key={g.id} className="pf-featured-row">
                  <span className="pf-featured-row__thumb" aria-hidden="true">
                    <Thumbnail src={g.thumbnailUrl} seed={g.id} alt="" />
                  </span>
                  <span className="pf-featured-row__title">
                    <span className="pf-featured-row__name">{g.title}</span>
                    <span className="pf-muted pf-small"> by {ownerName(g)}</span>
                  </span>
                  <span className="pf-featured-row__actions">
                    <button
                      type="button"
                      className="pf-btn pf-btn--ghost pf-btn--sm"
                      aria-label={`Move ${g.title} up`}
                      aria-disabled={first || saving ? "true" : undefined}
                      data-featured-move={`${g.id}:up`}
                      onClick={guard(first || saving, () => move(i, -1))}
                    >
                      {UP}
                    </button>
                    <button
                      type="button"
                      className="pf-btn pf-btn--ghost pf-btn--sm"
                      aria-label={`Move ${g.title} down`}
                      aria-disabled={last || saving ? "true" : undefined}
                      data-featured-move={`${g.id}:down`}
                      onClick={guard(last || saving, () => move(i, 1))}
                    >
                      {DOWN}
                    </button>
                    <button
                      type="button"
                      className="pf-btn pf-btn--ghost pf-btn--sm"
                      aria-label={`Remove ${g.title}`}
                      aria-disabled={saving ? "true" : undefined}
                      onClick={guard(saving, () => remove(g.id))}
                    >
                      Remove
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}

        <div className="pf-featured-candidates">
          {full && <p className="pf-muted pf-small">You can feature up to 4 games. Remove one to add another.</p>}
          {candidates.error ? (
            <LoadError message="Couldn't load your games." onRetry={candidates.reload} />
          ) : candidates.loading || !lists ? (
            <div className="pf-center pf-pad">
              <Spinner label="Loading your games" />
            </div>
          ) : (
            <>
              <h3 className="pf-featured-dialog__subtitle">Your games</h3>
              {lists.mine.length === 0 ? (
                <p className="pf-muted pf-small">You haven't published any games yet.</p>
              ) : (
                <ul className="pf-featured-list">{lists.mine.map((g) => candidateRow(g, false))}</ul>
              )}
              <h3 className="pf-featured-dialog__subtitle">Your favorites</h3>
              {lists.favorites.length === 0 ? (
                <p className="pf-muted pf-small">Games you favorite show up here.</p>
              ) : (
                <ul className="pf-featured-list">{lists.favorites.map((g) => candidateRow(g, true))}</ul>
              )}
            </>
          )}
        </div>

        {error && <Alert>{error}</Alert>}

        <div className="pf-modal__actions">
          <button type="button" className="pf-btn pf-btn--ghost" aria-disabled={saving ? "true" : undefined} onClick={guard(saving, close)}>
            Cancel
          </button>
          <button
            type="button"
            className="pf-btn pf-btn--primary"
            aria-disabled={saving ? "true" : undefined}
            aria-busy={saving || undefined}
            onClick={guard(saving, () => void save())}
          >
            {saving ? `Saving${ELLIPSIS}` : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

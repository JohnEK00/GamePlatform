import { useCallback, useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../api/client";
import type { Game, GameVersion } from "../api/types";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { errorMessage, formatDate, timeAgo } from "../util";
import { ReleaseNotesField } from "./ReleaseNotesField";
import { Spinner } from "./common";

/** Versions per history page (the server default). */
const HISTORY_PAGE_SIZE = 20;

export type VersionHistoryProps = {
  game: Game;
  /** Called with the updated game when the owner edits the current version's notes. */
  onUpdated?(g: Game): void;
};

function fullTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Notes as plain text (never HTML), or the muted empty line. */
function Notes({ notes }: { notes: string }) {
  return notes ? <p className="pf-versions__notes">{notes}</p> : <p className="pf-muted pf-small pf-versions__empty">No release notes for this version.</p>;
}

/** Inline notes editor for one history row (owner only). */
function NotesEditor({
  initial,
  saving,
  error,
  onSave,
  onCancel,
}: {
  initial: string;
  saving: boolean;
  error: string | null;
  onSave: (notes: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <div className="pf-versions__editor">
      <ReleaseNotesField value={draft} onChange={setDraft} label="Release notes" hideLabel error={error} disabled={saving} autoFocus />
      <div className="pf-versions__editactions">
        <button type="button" className="pf-btn pf-btn--ghost pf-btn--sm" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="pf-btn pf-btn--primary pf-btn--sm" onClick={() => onSave(draft)} disabled={saving}>
          {saving ? <Spinner size={12} /> : null} Save
        </button>
      </div>
    </div>
  );
}

/**
 * F004: the game page's "What's new" panel: the latest version's notes, a lazily loaded version history
 * ("Show older" paging) and, for the owner, inline notes editing. Notes are always rendered as plain text.
 * Renders nothing for older servers (no `latestVersion`) and for a v1 game without notes.
 */
export function VersionHistory({ game, onUpdated }: VersionHistoryProps) {
  const api = useApi();
  const toast = useToast();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<GameVersion[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // Drops responses for a previous game/version (the history is reset on every bundle replace).
  const generation = useRef(0);

  const latest = game.latestVersion;

  const load = useCallback(
    async (nextPage: number) => {
      const gen = generation.current;
      setLoadingHistory(true);
      setHistoryError(null);
      try {
        const res = await api.listGameVersions(game.id, { page: nextPage, perPage: HISTORY_PAGE_SIZE });
        if (gen !== generation.current) return;
        const got = Array.isArray(res?.items) ? res.items : [];
        setItems((prev) => {
          const base = nextPage === 1 || !prev ? [] : prev;
          const seen = new Set(base.map((v) => v.version));
          return [...base, ...got.filter((v) => !seen.has(v.version))];
        });
        setTotal(typeof res?.total === "number" ? res.total : got.length);
        setPage(nextPage);
      } catch (e) {
        if (gen === generation.current) setHistoryError(e);
      } finally {
        if (gen === generation.current) setLoadingHistory(false);
      }
    },
    [api, game.id],
  );

  // A new version (or another game) invalidates the loaded history; reload it if the list is open.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    generation.current += 1;
    setItems(null);
    setTotal(0);
    setPage(0);
    setEditing(null);
    setEditError(null);
    setLoadingHistory(false);
    if (openRef.current) void load(1);
  }, [game.id, game.version, load]);

  if (!latest) return null;
  if (game.version === 1 && latest.version === 1 && !latest.notes) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && items === null && !loadingHistory) void load(1);
  };

  const save = async (version: number, notes: string) => {
    setSaving(true);
    setEditError(null);
    try {
      const updated = await api.updateVersionNotes(game.id, version, notes);
      setItems((prev) => prev?.map((v) => (v.version === version ? { ...v, ...updated } : v)) ?? prev);
      setEditing(null);
      if (version === game.version || updated.current) {
        onUpdated?.({ ...game, latestVersion: { ...latest, ...updated, current: true } });
      }
      toast.success(`Notes for v${version} saved`);
    } catch (e) {
      if (isApiError(e) && e.status === 429) {
        toast.error(e.retryAfter ? `Slow down — try again in ${e.retryAfter}s` : "Slow down — try again in a moment");
      } else {
        setEditError(errorMessage(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const loadedAll = items !== null && items.length >= total;
  const oldest = items && items.length > 0 ? items[items.length - 1] : null;
  const headingId = `${uid}-heading`;
  const listId = `${uid}-history`;

  return (
    <section className="pf-panel pf-versions" id="versions" aria-labelledby={headingId}>
      <div className="pf-versions__head">
        <h2 className="pf-panel__title" id={headingId}>
          What's new
        </h2>
        <span className="pf-muted pf-small pf-versions__summary">
          v{latest.version} ·{" "}
          {game.lastUpdatedAt ? (
            <time dateTime={game.lastUpdatedAt} title={fullTimestamp(game.lastUpdatedAt)}>
              Updated {timeAgo(game.lastUpdatedAt)}
            </time>
          ) : (
            <time dateTime={latest.createdAt} title={fullTimestamp(latest.createdAt)}>
              Released {formatDate(latest.createdAt)}
            </time>
          )}
        </span>
      </div>
      <Notes notes={latest.notes} />

      <button type="button" className="pf-linkbtn pf-versions__toggle" aria-expanded={open} aria-controls={listId} onClick={toggle}>
        {open ? "▾" : "▸"} Version history
      </button>

      {open && (
        <div id={listId} className="pf-versions__history">
          {items && items.length > 0 && (
            <ol className="pf-versions__list">
              {items.map((v) => (
                <li key={v.version} className="pf-versions__row" data-current={v.current || undefined}>
                  <div className="pf-versions__rowhead">
                    <strong className="pf-versions__num">v{v.version}</strong>
                    <time className="pf-muted pf-small" dateTime={v.createdAt} title={fullTimestamp(v.createdAt)}>
                      {formatDate(v.createdAt)}
                    </time>
                    {v.current && <span className="pf-versions__current">Current</span>}
                    {game.isOwner && editing !== v.version && (
                      <button
                        type="button"
                        className="pf-btn pf-btn--ghost pf-btn--sm pf-versions__edit"
                        aria-label={`Edit notes for v${v.version}`}
                        disabled={saving}
                        onClick={() => {
                          setEditError(null);
                          setEditing(v.version);
                        }}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {game.isOwner && editing === v.version ? (
                    <NotesEditor
                      initial={v.notes}
                      saving={saving}
                      error={editError}
                      onSave={(n) => void save(v.version, n)}
                      onCancel={() => {
                        setEditing(null);
                        setEditError(null);
                      }}
                    />
                  ) : (
                    <Notes notes={v.notes} />
                  )}
                </li>
              ))}
            </ol>
          )}
          {items && items.length === 0 && !loadingHistory && !historyError && <p className="pf-muted pf-small">No versions yet.</p>}
          {loadingHistory && (
            <p className="pf-muted pf-small pf-versions__loading" role="status">
              <Spinner size={12} /> Loading versions…
            </p>
          )}
          {historyError != null && !loadingHistory && (
            <div className="pf-alert pf-alert--error" role="alert">
              Couldn't load the version history: {errorMessage(historyError)}{" "}
              <button type="button" className="pf-linkbtn" onClick={() => void load(items ? page + 1 : 1)}>
                Retry
              </button>
            </div>
          )}
          {items && !loadedAll && !loadingHistory && !historyError && (
            <button type="button" className="pf-btn pf-btn--sm pf-versions__more" onClick={() => void load(page + 1)}>
              Show older
            </button>
          )}
          {loadedAll && oldest && oldest.version > 1 && (
            <p className="pf-muted pf-small pf-versions__earlier">Earlier versions were published before release notes existed.</p>
          )}
        </div>
      )}
    </section>
  );
}

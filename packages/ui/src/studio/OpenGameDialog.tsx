import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { GameSummary } from "../api/types";
import { useApi } from "../context/config";
import { Alert, Spinner, Thumbnail } from "../components/common";
import { useModal } from "../components/useModal";
import { errorMessage, timeAgo } from "../util";

export type OpenGameDialogProps = {
  onClose: () => void;
  /** Called with the chosen game; the dialog has not closed itself. */
  onPick: (game: GameSummary) => void;
};

/** F013: Studio → Open → "My game…": lists your games (drafts included) to open one in the Studio. */
export function OpenGameDialog({ onClose, onPick }: OpenGameDialogProps) {
  const api = useApi();
  const uid = useId();
  const ref = useModal<HTMLDivElement>(true, onClose);
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setError(null);
    setGames(null);
    try {
      const page = await api.listGames({ owner: "me", sort: "new", perPage: 100 });
      setGames(page.items);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (games ?? []).filter((g) => !needle || g.title.toLowerCase().includes(needle));
  }, [games, q]);

  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pf-modal pf-modal--wide pf-opengame" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} ref={ref}>
        <h2 id={`${uid}-title`}>Open one of your games</h2>
        <label className="pf-sr-only" htmlFor={`${uid}-search`}>
          Search your games
        </label>
        <input
          id={`${uid}-search`}
          className="pf-input"
          type="search"
          data-autofocus
          placeholder="Search your games…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {error ? (
          <Alert>
            {error}{" "}
            <button type="button" className="pf-btn pf-btn--sm" onClick={() => void load()}>
              Retry
            </button>
          </Alert>
        ) : games === null ? (
          <div className="pf-opengame__loading">
            <Spinner label="Loading your games" />
          </div>
        ) : games.length === 0 ? (
          <p className="pf-muted">You haven't published any games yet.</p>
        ) : shown.length === 0 ? (
          <p className="pf-muted">No games match “{q.trim()}”.</p>
        ) : (
          <ul className="pf-opengame__list" aria-label="Your games">
            {shown.map((g) => (
              <li key={g.id}>
                <button type="button" className="pf-opengame__item" onClick={() => onPick(g)}>
                  <span className="pf-opengame__thumb">
                    <Thumbnail src={g.thumbnailUrl} seed={g.id} alt="" />
                  </span>
                  <span className="pf-opengame__title">{g.title}</span>
                  {!g.published && <span className="pf-badge pf-badge--draft">Draft</span>}
                  <span className="pf-muted pf-small">{timeAgo(g.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="pf-modal__actions">
          <button type="button" className="pf-btn pf-btn--ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

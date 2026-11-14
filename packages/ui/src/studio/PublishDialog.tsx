import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isApiError } from "../api/client";
import type { Game, GameSummary } from "../api/types";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { Alert, ProgressBar, Spinner } from "../components/common";
import { useModal } from "../components/useModal";
import { GameFields, type GameFieldValues } from "../components/GameFields";
import { ReleaseNotesField } from "../components/ReleaseNotesField";
import { errorMessage, isNotesError, parseTags, timeAgo, validateTags } from "../util";
import { asManifest, buildBundleZipAsync, checkBundleSize, slugify, validateProject, type StudioLink, type StudioProject } from "./project";

export type PublishMode = "new" | "update";

export type PublishDialogProps = {
  project: StudioProject;
  /** The project's link, already filtered for the current apiBase (null when none or ignored). */
  link: StudioLink | null;
  /** The current `apiBaseUrl`, stored in new links. */
  apiBase: string;
  onClose: () => void;
  /** A publish of either kind succeeded: the new link (the Studio also clears `dirty`). */
  onPublished: (link: StudioLink, mode: PublishMode) => void;
  /** An update to the linked game returned 403/404. */
  onUnlink: () => void;
  /** The linked game's title as just fetched from the server. */
  onLinkTitle?: (title: string) => void;
};

function projectProblems(project: StudioProject): string | null {
  const problems = validateProject(project);
  return problems.length ? `Fix these problems first: ${problems.slice(0, 3).join(" ")}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ""}` : null;
}

async function buildBundle(project: StudioProject, title: string): Promise<File | string> {
  const zip = await buildBundleZipAsync(project);
  const sizeErr = checkBundleSize(zip);
  if (sizeErr) return sizeErr;
  return new File([zip], `${slugify(title)}.zip`, { type: "application/zip" });
}

/** The single game whose title equals game.json `name` (trimmed, case-insensitive), else null. */
function matchByName(games: GameSummary[], name: unknown): string | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const n = name.trim().toLowerCase();
  const hits = games.filter((g) => g.title.trim().toLowerCase() === n);
  return hits.length === 1 ? hits[0].id : null;
}

/** F013: Studio "Publish": a new game, or an update (full bundle replace) of one of your games. */
export function PublishDialog({ project, link, apiBase, onClose, onPublished, onUnlink, onLinkTitle }: PublishDialogProps) {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const uid = useId();
  const m = asManifest(project.manifest);
  const [mode, setMode] = useState<PublishMode>(link ? "update" : "new");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [notesError, setNotesError] = useState<string | null>(null);
  const busy = progress !== null;
  const ref = useModal<HTMLFormElement>(true, onClose, { initialFocus: link ? `[name="pf-publish-mode"]:checked` : "#pf-game-title", canClose: !busy });

  // ---- new game ----
  const [values, setValues] = useState<GameFieldValues>({ title: typeof m.name === "string" ? m.name.slice(0, 80) : "", description: "", tags: "", published: true });
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof GameFieldValues, string>>>({});
  const [showNotes, setShowNotes] = useState(false);

  // ---- update ----
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [gamesError, setGamesError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [target, setTarget] = useState<Game | null>(null);
  const [targetLoading, setTargetLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const fetchSeq = useRef(0);
  const linkRef = useRef(link);
  linkRef.current = link;
  const onLinkTitleRef = useRef(onLinkTitle);
  onLinkTitleRef.current = onLinkTitle;

  const loadGames = useCallback(
    async (preselect: boolean) => {
      setGamesError(null);
      try {
        const page = await api.listGames({ owner: "me", sort: "new", perPage: 100 });
        setGames(page.items);
        if (page.items.length === 0) {
          setMode("new");
          return;
        }
        if (preselect) {
          const l = linkRef.current;
          const id = l && page.items.some((g) => g.id === l.gameId) ? l.gameId : matchByName(page.items, m.name);
          if (id) setSelectedId(id);
        }
      } catch (e) {
        setGames([]);
        setGamesError(errorMessage(e));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  useEffect(() => {
    void loadGames(true);
  }, [loadGames]);

  const fetchTarget = useCallback(
    async (id: string): Promise<Game | null> => {
      const seq = ++fetchSeq.current;
      setTarget(null);
      if (!id) return null;
      setTargetLoading(true);
      try {
        const g = await api.getGame(id);
        if (seq !== fetchSeq.current) return null;
        setTarget(g);
        const l = linkRef.current;
        if (l && l.gameId === g.id && l.title !== g.title) onLinkTitleRef.current?.(g.title);
        return g;
      } catch (e) {
        if (seq === fetchSeq.current) setError(errorMessage(e));
        return null;
      } finally {
        if (seq === fetchSeq.current) setTargetLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void fetchTarget(selectedId);
  }, [selectedId, fetchTarget]);

  const choose = (id: string) => {
    setConfirmed(false);
    setConflict(null);
    setError(null);
    setSelectedId(id);
  };

  const linkedHere = !!link && !!target && link.gameId === target.id;
  const stale = linkedHere && link!.version !== target!.version;
  const needsConfirm = !!target && (!linkedHere || stale || conflict !== null);

  const submitNew = async () => {
    const tags = parseTags(values.tags);
    const errs: typeof fieldErrors = {};
    if (!values.title.trim()) errs.title = "Title is required.";
    const tagErr = validateTags(tags);
    if (tagErr) errs.tags = tagErr;
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    // R11: catch everything the backend would reject before uploading anything.
    const problem = projectProblems(project);
    if (problem) return setError(problem);
    setError(null);
    setNotesError(null);
    setProgress(0);
    try {
      const bundle = await buildBundle(project, values.title);
      if (typeof bundle === "string") {
        setProgress(null);
        setError(bundle);
        return;
      }
      const game = await api.createGame(
        { title: values.title.trim(), description: values.description, tags, published: values.published, bundle, notes: showNotes ? notes : undefined },
        (p) => setProgress(p.fraction),
      );
      onPublished({ gameId: game.id, title: game.title, version: game.version || 1, apiBase }, "new");
      toast.success("Published!", `${game.title} is ${game.published ? "live" : "saved as a draft"}.`);
      navigate(`/games/${game.id}`);
    } catch (err) {
      setProgress(null);
      if (isNotesError(err)) setNotesError(errorMessage(err));
      else setError(isApiError(err) && err.code === "validation" ? `The bundle was rejected: ${err.message}` : errorMessage(err));
    }
  };

  const submitUpdate = async () => {
    if (!target) return;
    if (needsConfirm && !confirmed) return setError("Tick the confirmation to replace this game's files.");
    const problem = projectProblems(project);
    if (problem) return setError(problem);
    setError(null);
    setNotesError(null);
    setProgress(0);
    const game = target;
    try {
      const bundle = await buildBundle(project, game.title);
      if (typeof bundle === "string") {
        setProgress(null);
        setError(bundle);
        return;
      }
      const g = await api.replaceBundle(game.id, bundle, (p) => setProgress(p.fraction), { notes, expectedVersion: game.version });
      setProgress(null);
      onPublished({ gameId: g.id || game.id, title: g.title, version: g.version, apiBase }, "update");
      toast.success(g.published ? `Version ${g.version} of ${g.title} is live` : `Version ${g.version} of ${g.title} saved (draft)`);
      onClose();
    } catch (err) {
      setProgress(null);
      if (isApiError(err) && err.status === 409) {
        const fresh = await fetchTarget(game.id);
        setConfirmed(false);
        setConflict(`“${fresh?.title ?? game.title}” changed while you were publishing${fresh ? ` (now v${fresh.version})` : ""}. Check and try again.`);
      } else if (isNotesError(err)) {
        setNotesError(errorMessage(err));
      } else if (isApiError(err) && err.status === 422) {
        setError(`The bundle was rejected: ${err.message}`);
      } else if (isApiError(err) && err.status === 429) {
        setError(err.retryAfter ? `Upload limit reached. Try again in ${err.retryAfter}s.` : "Upload limit reached. Try again later.");
      } else if (isApiError(err) && (err.status === 403 || err.status === 404)) {
        setError("You can't update this game. It may have been deleted.");
        if (linkRef.current?.gameId === game.id) onUnlink();
        fetchSeq.current++;
        setTarget(null);
        setSelectedId("");
        void loadGames(false);
      } else {
        setError(errorMessage(err));
      }
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    void (mode === "new" ? submitNew() : submitUpdate());
  };

  const noGames = games !== null && games.length === 0 && !gamesError;
  const updateBlocked = !target || targetLoading || (needsConfirm && !confirmed);

  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="pf-modal pf-modal--wide pf-form pf-publish" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} ref={ref} onSubmit={submit} noValidate>
        <h2 id={`${uid}-title`}>Publish</h2>
        <div className="pf-publish__modes" role="radiogroup" aria-label="Publish as">
          <label className={`pf-publish__mode${mode === "new" ? " is-active" : ""}`}>
            <input type="radio" name="pf-publish-mode" value="new" checked={mode === "new"} disabled={busy} onChange={() => setMode("new")} /> New game
          </label>
          <label className={`pf-publish__mode${mode === "update" ? " is-active" : ""}`}>
            <input
              type="radio"
              name="pf-publish-mode"
              value="update"
              checked={mode === "update"}
              disabled={busy || noGames}
              onChange={() => setMode("update")}
            />{" "}
            Update an existing game
          </label>
        </div>
        {noGames && <p className="pf-muted pf-small">You have no games to update yet.</p>}

        {mode === "new" ? (
          <>
            <GameFields values={values} onChange={setValues} disabled={busy} errors={fieldErrors} />
            {showNotes ? (
              <ReleaseNotesField value={notes} onChange={setNotes} disabled={busy} error={notesError} autoFocus />
            ) : (
              <button type="button" className="pf-linkbtn pf-publish__addnotes" onClick={() => setShowNotes(true)} disabled={busy}>
                + Add release notes
              </button>
            )}
          </>
        ) : (
          <>
            <div className="pf-field">
              <label className="pf-label" htmlFor="pf-publish-game">
                Game
              </label>
              {games === null ? (
                <span className="pf-publish__loading">
                  <Spinner size={16} label="Loading your games" />
                </span>
              ) : (
                <select id="pf-publish-game" className="pf-input" value={selectedId} disabled={busy} onChange={(e) => choose(e.target.value)}>
                  <option value="">Choose a game…</option>
                  {games.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                      {g.published ? "" : " (draft)"}
                    </option>
                  ))}
                </select>
              )}
              {gamesError && <span className="pf-field__error">{gamesError}</span>}
            </div>
            {targetLoading && <Spinner size={16} label="Loading the game" />}
            {target && (
              <>
                <p className="pf-muted pf-small" data-testid="publish-current">
                  Currently v{target.version} · {target.published ? "Published" : "Draft"}
                  {target.latestVersion ? ` · updated ${timeAgo(target.latestVersion.createdAt)}` : ""}
                </p>
                {conflict && <Alert>{conflict}</Alert>}
                {stale && !conflict && (
                  <div className="pf-alert pf-alert--warning" role="alert">
                    “{target.title}” was updated to v{target.version} outside this project (you last opened or published v{link!.version}). Publishing replaces
                    those changes.
                  </div>
                )}
                {needsConfirm && (
                  <label className="pf-publish__confirm">
                    <input type="checkbox" checked={confirmed} disabled={busy} required onChange={(e) => setConfirmed(e.target.checked)} />
                    <span>
                      Replace all files of “{target.title}” (v{target.version}) with this project
                    </span>
                  </label>
                )}
                <ReleaseNotesField value={notes} onChange={setNotes} disabled={busy} error={notesError} />
                <p className="pf-muted pf-small">
                  Title, description, tags and visibility don't change. Edit them on the <Link to={`/games/${target.id}/edit`}>game's page</Link>.
                  {!target.published && " This game is a draft. Players won't see the update until you publish it."}
                </p>
              </>
            )}
          </>
        )}

        {progress !== null && <ProgressBar value={progress} label="Uploading" />}
        {error && <Alert>{error}</Alert>}
        <div className="pf-modal__actions">
          <button type="button" className="pf-btn pf-btn--ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {mode === "new" ? (
            <button type="submit" className="pf-btn pf-btn--primary" disabled={busy}>
              {busy ? <Spinner size={14} /> : null} Publish
            </button>
          ) : (
            <button type="submit" className="pf-btn pf-btn--primary" disabled={busy || updateBlocked}>
              {busy ? <Spinner size={14} /> : null} Publish update
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

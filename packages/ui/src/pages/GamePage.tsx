import { useEffect, useId, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import type { Game } from "../api/types";
import { useApi, usePlatform } from "../context/config";
import { useToast } from "../context/toast";
import { Comments } from "../components/Comments";
import { ConfirmDialog, ErrorState, ProgressBar, Skeleton, Spinner, TagChip, UserLink } from "../components/common";
import { clearGameSave, discardPendingCloudSave, GamePlayer, hasGameSave } from "../components/GamePlayer";
import { GameAchievements } from "../components/Achievements";
import { FavoriteButton } from "../components/Favorite";
import { FollowButton, useFollows } from "../components/Follow";
import { RelatedGames } from "../components/RelatedGames";
import { ReleaseNotesField } from "../components/ReleaseNotesField";
import { useModal } from "../components/useModal";
import { VersionHistory } from "../components/VersionHistory";
import { ReportButton } from "../components/Report";
import { useAuth } from "../context/auth";
import { Leaderboard } from "../components/Leaderboard";
import { StarRating } from "../components/StarRating";
import { errorMessage, formatCount, formatDate, looksLikeZip, useAsync, useDocumentTitle, VERSIONS_SECTION, isNotesError, REPLACE_CONFLICT_MESSAGE } from "../util";
import { NotFoundPage } from "./NotFoundPage";

/** F004: the modal shown after a bundle is picked: file name, "What's new" notes, Upload / Cancel. */
function ReplaceBundleDialog({
  file,
  notes,
  onNotes,
  busy,
  progress,
  error,
  notesError,
  conflict,
  reloading,
  onUpload,
  onReload,
  onCancel,
}: {
  file: File;
  notes: string;
  onNotes: (v: string) => void;
  busy: boolean;
  progress: number | null;
  error: string | null;
  notesError: string | null;
  conflict: boolean;
  reloading: boolean;
  onUpload: () => void;
  onReload: () => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const ref = useModal<HTMLDivElement>(true, onCancel, { canClose: !busy, initialFocus: "textarea" });
  return (
    <div className="pf-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="pf-modal" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} ref={ref}>
        <h2 id={`${uid}-title`}>Upload a new version</h2>
        <div className="pf-modal__body pf-stack">
          <p className="pf-small pf-muted">
            Bundle: <strong className="pf-replace__file">{file.name}</strong>
          </p>
          <ReleaseNotesField value={notes} onChange={onNotes} disabled={busy} error={notesError} />
          {progress !== null && <ProgressBar value={progress} label="Uploading bundle" />}
          {conflict && (
            <div className="pf-alert pf-alert--error pf-replace__conflict" role="alert">
              <span>{REPLACE_CONFLICT_MESSAGE}</span>{" "}
              <button type="button" className="pf-btn pf-btn--sm" onClick={onReload} disabled={reloading}>
                {reloading ? <Spinner size={12} /> : null} Reload
              </button>
            </div>
          )}
          {error && !conflict && (
            <div className="pf-alert pf-alert--error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="pf-modal__actions">
          <button type="button" className="pf-btn pf-btn--ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="pf-btn pf-btn--primary" onClick={onUpload} disabled={busy || reloading}>
            {busy ? <Spinner size={14} /> : null} Upload
          </button>
        </div>
      </div>
    </div>
  );
}

function OwnerActions({ game, onUpdated, onReload }: { game: Game; onUpdated: (g: Game) => void; onReload?: () => Promise<void> }) {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const platform = usePlatform();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // F004: the picked bundle waiting in the notes modal.
  const [pending, setPending] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [notesError, setNotesError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);

  const doDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteGame(game.id);
      toast.success("Game deleted", game.title);
      navigate("/dashboard");
    } catch (e) {
      toast.error("Couldn't delete game", errorMessage(e));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const picked = async (file: File | null | undefined) => {
    if (!file) return;
    setUploadError(null);
    if (!(await looksLikeZip(file))) {
      setUploadError(`"${file.name}" doesn't look like a .zip file.`);
      return;
    }
    setNotesError(null);
    setConflict(false);
    setPending(file);
  };

  const closeDialog = () => {
    if (progress !== null) return;
    setPending(null);
    setUploadError(null);
    setNotesError(null);
    setConflict(false);
  };

  const upload = async () => {
    const file = pending;
    if (!file) return;
    setUploadError(null);
    setNotesError(null);
    setConflict(false);
    setProgress(0);
    try {
      const g = await api.replaceBundle(game.id, file, (p) => setProgress(p.fraction), { notes, expectedVersion: game.version });
      setProgress(null);
      setPending(null);
      setNotes("");
      onUpdated(g);
      toast.success(`Version ${g.version} is live`);
    } catch (e) {
      setProgress(null);
      if (isApiError(e) && e.status === 409) setConflict(true);
      else if (isNotesError(e)) setNotesError(errorMessage(e));
      else setUploadError(errorMessage(e));
    }
  };

  const reload = async () => {
    if (!onReload) return;
    setReloading(true);
    try {
      await onReload();
      setConflict(false);
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setReloading(false);
    }
  };

  const pick = async () => {
    if (platform.pickFile) {
      void picked(await platform.pickFile(".zip,application/zip"));
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.onchange = () => void picked(input.files?.[0]);
    input.click();
  };

  return (
    <section className="pf-panel pf-owner" aria-label="Owner actions">
      <div className="pf-owner__row">
        <span className="pf-badge pf-badge--owner">You own this game</span>
        {!game.published && <span className="pf-badge pf-badge--draft">Unpublished</span>}
        <span className="pf-muted pf-small">v{game.version}</span>
      </div>
      <div className="pf-owner__row">
        <Link to={`/games/${game.id}/edit`} className="pf-btn pf-btn--sm">
          ✎ Edit details
        </Link>
        <Link to={`/games/${game.id}/stats`} className="pf-btn pf-btn--sm">
          📈 Stats
        </Link>
        <button type="button" className="pf-btn pf-btn--sm" onClick={pick} disabled={progress !== null || pending !== null}>
          ⬆ Replace bundle
        </button>
        <button type="button" className="pf-btn pf-btn--sm pf-btn--danger" onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
      </div>
      {pending && (
        <ReplaceBundleDialog
          file={pending}
          notes={notes}
          onNotes={setNotes}
          busy={progress !== null}
          progress={progress}
          error={uploadError}
          notesError={notesError}
          conflict={conflict}
          reloading={reloading}
          onUpload={() => void upload()}
          onReload={() => void reload()}
          onCancel={closeDialog}
        />
      )}
      {!pending && uploadError && (
        <div className="pf-alert pf-alert--error" role="alert">
          {uploadError}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${game.title}”?`}
        confirmLabel="Delete forever"
        danger
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      >
        This removes the game, its files, ratings, comments and scores. This cannot be undone.
      </ConfirmDialog>
    </section>
  );
}

/** "Clear save data" for the game's locally persisted storage (webgame.save.{id}). */
function ClearSaveData({ gameId, onCleared }: { gameId: string; onCleared: () => void }) {
  const toast = useToast();
  const api = useApi();
  const { user } = useAuth();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const clear = async () => {
    const had = hasGameSave(gameId);
    setBusy(true);
    // Drop any pending debounced cloud write first so it can't resurrect the data.
    await discardPendingCloudSave(gameId);
    clearGameSave(gameId);
    let cloudError: unknown = null;
    if (user) {
      try {
        await api.deleteSave(gameId);
      } catch (e) {
        if (!(isApiError(e) && e.status === 404)) cloudError = e;
      }
    }
    setBusy(false);
    setConfirm(false);
    onCleared();
    if (cloudError) toast.error("Local save cleared, but the cloud save couldn't be deleted", errorMessage(cloudError));
    else toast.success(had || user ? "Save data cleared" : "No save data to clear");
  };
  return (
    <div className="pf-gamepage__savebar">
      <button type="button" className="pf-linkbtn pf-linkbtn--danger" onClick={() => setConfirm(true)}>
        Clear save data
      </button>
      <ConfirmDialog
        open={confirm}
        title="Clear save data?"
        confirmLabel="Clear and restart"
        danger
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void clear()}
      >
        {user
          ? "This deletes your progress for this game — in this browser and your cloud save — and restarts the game."
          : "This deletes this game's progress stored in this browser and restarts the game."}
      </ConfirmDialog>
    </div>
  );
}

/**
 * Compact Follow button for the game's owner. `Game` carries no follow state, so when logged in the owner's profile
 * is read lazily (unless the FollowProvider cache already knows the user); anonymous viewers get a login prompt.
 */
function OwnerFollow({ game }: { game: Game }) {
  const api = useApi();
  const { user } = useAuth();
  const follows = useFollows();
  const owner = game.owner;
  const known = follows?.peek(owner.username);
  const [loaded, setLoaded] = useState<{ username: string; following: boolean; followers: number } | null>(null);
  const isSelf = !!user && user.username.toLowerCase() === owner.username.toLowerCase();
  const seed = follows?.seed;
  const need = !!user && !isSelf && !game.isOwner && !known && loaded?.username !== owner.username;

  useEffect(() => {
    if (!need) return;
    let alive = true;
    api.getUser(owner.username, { perPage: 1 }).then(
      (p) => {
        if (!alive || typeof p?.isFollowing !== "boolean") return;
        setLoaded({ username: owner.username, following: p.isFollowing, followers: p.followers });
        seed?.(owner.username, { following: p.isFollowing, followers: p.followers });
      },
      () => {
        /* non-critical: the button stays hidden */
      },
    );
    return () => {
      alive = false;
    };
  }, [api, need, owner.username, seed]);

  if (game.isOwner || isSelf) return null;
  if (user && !known && loaded?.username !== owner.username) return null;
  const fallback = known ?? (loaded ? { following: loaded.following, followers: loaded.followers } : { following: false });
  return (
    <FollowButton
      username={owner.username}
      displayName={owner.displayName}
      isFollowing={fallback.following}
      followers={fallback.followers}
      variant="compact"
    />
  );
}

export function GamePage() {
  const { id = "" } = useParams();
  const api = useApi();
  const { data: game, loading, error, reload, setData } = useAsync(() => api.getGame(id), [api, id]);
  const [lbKey, setLbKey] = useState(0);
  const [playerKey, setPlayerKey] = useState(0);
  const [achKey, setAchKey] = useState(0);
  useDocumentTitle(game?.title);
  const location = useLocation();
  const wantsVersions = new URLSearchParams(location.search).get("section") === VERSIONS_SECTION;
  const gameLoaded = !!game && game.id === id;

  // F004: `?section=versions` (feed links; works under HashRouter, unlike a #hash) scrolls to "What's new".
  useEffect(() => {
    if (!wantsVersions || !gameLoaded) return;
    const el = document.getElementById("versions");
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [wantsVersions, gameLoaded, id]);

  /** Refetch without the loading skeleton, so open forms (picked file, typed notes) survive. */
  const refetch = async () => {
    const g = await api.getGame(id);
    setData(g);
  };

  if (error && isApiError(error) && error.status === 404) return <NotFoundPage what="game" />;
  if (error)
    return (
      <div className="pf-container pf-page">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );

  if (loading || !game)
    return (
      <div className="pf-container pf-page pf-gamepage">
        <div className="pf-gamepage__main">
          <Skeleton className="pf-player-skeleton" height="auto" />
          <Skeleton width="50%" height={32} />
          <Skeleton width="30%" height={18} />
          <Skeleton width="100%" height={80} />
        </div>
        <aside className="pf-gamepage__side">
          <Skeleton height={140} />
          <Skeleton height={260} />
        </aside>
      </div>
    );

  return (
    <div className="pf-container pf-page pf-gamepage">
      <div className="pf-gamepage__main">
        <GamePlayer
          key={`${game.id}:${playerKey}`}
          game={game}
          onPlayRecorded={(plays) => setData((g) => ({ ...(g ?? game), plays }))}
          onScoreSubmitted={() => setLbKey((k) => k + 1)}
          onAchievementUnlocked={(r) => r.new && setAchKey((k) => k + 1)}
        />
        <ClearSaveData gameId={game.id} onCleared={() => setPlayerKey((k) => k + 1)} />
        <div className="pf-gamepage__header">
          <div>
            <h1 className="pf-gamepage__title">{game.title}</h1>
            <div className="pf-gamepage__byline">
              <UserLink user={game.owner} />
              <OwnerFollow game={game} />
              <span className="pf-muted">·</span>
              <span className="pf-muted">{formatCount(game.plays)} plays</span>
              <span className="pf-muted">·</span>
              <span className="pf-muted">Updated {formatDate(game.updatedAt)}</span>
            </div>
          </div>
          <div className="pf-gamepage__actions">
            <FavoriteButton gameId={game.id} gameTitle={game.title} favorites={game.favorites ?? 0} isFavorite={!!game.isFavorite} variant="full" />
            {!game.isOwner && (
              <ReportButton targetType="game" targetId={game.id} targetLabel={game.title} className="pf-btn pf-btn--ghost pf-btn--sm">
                ⚑ Report
              </ReportButton>
            )}
          </div>
        </div>
        {game.tags.length > 0 && (
          <div className="pf-chips">
            {game.tags.map((t) => (
              <TagChip key={t} tag={t} to={`/?tag=${encodeURIComponent(t)}`} />
            ))}
          </div>
        )}
        {game.description ? (
          <div className="pf-description">{game.description}</div>
        ) : (
          <p className="pf-muted">No description provided.</p>
        )}
        <VersionHistory game={game} onUpdated={(g) => setData(g)} />
        {(!game.achievements || game.achievements.length > 0) && <GameAchievements gameId={game.id} refreshKey={achKey} />}
        <Comments gameId={game.id} isGameOwner={game.isOwner} />
      </div>
      <aside className="pf-gamepage__side">
        {game.isOwner && <OwnerActions game={game} onUpdated={(g) => setData(g)} onReload={refetch} />}
        <section className="pf-panel" aria-label="Rating">
          <h2 className="pf-panel__title">Rating</h2>
          <StarRating
            gameId={game.id}
            ratingAvg={game.ratingAvg}
            ratingCount={game.ratingCount}
            myRating={game.myRating}
            onChange={(r) => setData((g) => ({ ...(g ?? game), ...r }))}
          />
        </section>
        <Leaderboard gameId={game.id} config={game.leaderboard} refreshKey={lbKey} />
        <section className="pf-panel pf-small pf-muted" aria-label="Game info">
          <dl className="pf-dl">
            <dt>Resolution</dt>
            <dd>
              {game.width}×{game.height}
            </dd>
            <dt>Version</dt>
            <dd>{game.version}</dd>
            <dt>Released</dt>
            <dd>{formatDate(game.createdAt)}</dd>
            {game.lastUpdatedAt && (
              <>
                <dt>Updated</dt>
                <dd>{formatDate(game.lastUpdatedAt)}</dd>
              </>
            )}
          </dl>
        </section>
      </aside>
      <RelatedGames gameId={game.id} />
    </div>
  );
}

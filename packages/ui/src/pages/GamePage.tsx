import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import type { Game } from "../api/types";
import { useApi, usePlatform } from "../context/config";
import { useToast } from "../context/toast";
import { Comments } from "../components/Comments";
import { ConfirmDialog, ErrorState, ProgressBar, Skeleton, TagChip, UserLink } from "../components/common";
import { clearGameSave, discardPendingCloudSave, GamePlayer, hasGameSave } from "../components/GamePlayer";
import { GameAchievements } from "../components/Achievements";
import { FavoriteButton } from "../components/Favorite";
import { ReportButton } from "../components/Report";
import { useAuth } from "../context/auth";
import { Leaderboard } from "../components/Leaderboard";
import { StarRating } from "../components/StarRating";
import { errorMessage, formatCount, formatDate, looksLikeZip, useAsync, useDocumentTitle } from "../util";
import { NotFoundPage } from "./NotFoundPage";

function OwnerActions({ game, onUpdated }: { game: Game; onUpdated: (g: Game) => void }) {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const platform = usePlatform();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

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

  const replace = async (file: File | null | undefined) => {
    if (!file) return;
    setUploadError(null);
    if (!(await looksLikeZip(file))) {
      setUploadError(`"${file.name}" doesn't look like a .zip file.`);
      return;
    }
    setProgress(0);
    try {
      const g = await api.replaceBundle(game.id, file, (p) => setProgress(p.fraction));
      onUpdated(g);
      toast.success("New version uploaded", `Version ${g.version} is live.`);
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  };

  const pick = async () => {
    if (platform.pickFile) {
      void replace(await platform.pickFile(".zip,application/zip"));
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.onchange = () => void replace(input.files?.[0]);
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
        <button type="button" className="pf-btn pf-btn--sm" onClick={pick} disabled={progress !== null}>
          ⬆ Replace bundle
        </button>
        <button type="button" className="pf-btn pf-btn--sm pf-btn--danger" onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
      </div>
      {progress !== null && <ProgressBar value={progress} label="Uploading bundle" />}
      {uploadError && (
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

export function GamePage() {
  const { id = "" } = useParams();
  const api = useApi();
  const { data: game, loading, error, reload, setData } = useAsync(() => api.getGame(id), [api, id]);
  const [lbKey, setLbKey] = useState(0);
  const [playerKey, setPlayerKey] = useState(0);
  const [achKey, setAchKey] = useState(0);
  useDocumentTitle(game?.title);

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
        {(!game.achievements || game.achievements.length > 0) && <GameAchievements gameId={game.id} refreshKey={achKey} />}
        <Comments gameId={game.id} isGameOwner={game.isOwner} />
      </div>
      <aside className="pf-gamepage__side">
        {game.isOwner && <OwnerActions game={game} onUpdated={(g) => setData(g)} />}
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
          </dl>
        </section>
      </aside>
    </div>
  );
}

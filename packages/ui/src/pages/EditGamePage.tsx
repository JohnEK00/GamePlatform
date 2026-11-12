import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isApiError } from "../api/client";
import type { Game } from "../api/types";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { Alert, ConfirmDialog, EmptyState, ErrorState, ProgressBar, Skeleton, Spinner, Thumbnail } from "../components/common";
import { FileDrop } from "../components/FileDrop";
import { GameFields, type GameFieldValues } from "../components/GameFields";
import { errorMessage, looksLikeZip, parseTags, useAsync, useDocumentTitle, validateTags } from "../util";
import { NotFoundPage } from "./NotFoundPage";
import { BUNDLE_ACCEPT, IMAGE_ACCEPT } from "./UploadPage";

function toValues(g: Game): GameFieldValues {
  return { title: g.title, description: g.description, tags: g.tags.join(", "), published: g.published };
}

export function EditGamePage() {
  const { id = "" } = useParams();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: game, loading, error, reload, setData } = useAsync(() => api.getGame(id), [api, id]);
  useDocumentTitle(game ? `Edit ${game.title}` : "Edit game");

  const [values, setValues] = useState<GameFieldValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof GameFieldValues, string>>>({});
  const [thumb, setThumb] = useState<File | null>(null);
  const [bundle, setBundle] = useState<File | null>(null);
  const [progress, setProgress] = useState<{ what: string; v: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (game && !values) setValues(toValues(game));
  }, [game, values]);

  if (error && isApiError(error) && error.status === 404) return <NotFoundPage what="game" />;
  if (error)
    return (
      <div className="pf-container pf-page">
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  if (loading || !game || !values)
    return (
      <div className="pf-container pf-page pf-narrow">
        <Skeleton width="40%" height={32} />
        <Skeleton height={360} />
      </div>
    );
  if (!game.isOwner)
    return (
      <div className="pf-container pf-page">
        <EmptyState icon="🔒" title="Not your game" action={<Link className="pf-btn" to={`/games/${game.id}`}>Back to game</Link>}>
          Only the owner can edit this game.
        </EmptyState>
      </div>
    );

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const tags = parseTags(values.tags);
    const errs: typeof fieldErrors = {};
    if (!values.title.trim()) errs.title = "Title is required.";
    const tagErr = validateTags(tags);
    if (tagErr) errs.tags = tagErr;
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    setSaveError(null);
    try {
      const g = await api.updateGame(game.id, { title: values.title.trim(), description: values.description, tags, published: values.published });
      setData(g);
      setValues(toValues(g));
      toast.success("Changes saved");
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const uploadThumb = async () => {
    if (!thumb) return;
    setFileError(null);
    setProgress({ what: "Uploading thumbnail", v: 0 });
    try {
      const g = await api.replaceThumbnail(game.id, thumb, (p) => setProgress({ what: "Uploading thumbnail", v: p.fraction }));
      setData(g);
      setThumb(null);
      toast.success("Thumbnail updated");
    } catch (err) {
      setFileError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  const uploadBundle = async () => {
    if (!bundle) return;
    setFileError(null);
    if (!(await looksLikeZip(bundle))) return setFileError(`"${bundle.name}" doesn't look like a valid .zip file.`);
    setProgress({ what: "Uploading bundle", v: 0 });
    try {
      const g = await api.replaceBundle(game.id, bundle, (p) => setProgress({ what: "Uploading bundle", v: p.fraction }));
      setData(g);
      setBundle(null);
      toast.success("New version uploaded", `Version ${g.version} is live.`);
    } catch (err) {
      setFileError(isApiError(err) && err.code === "validation" ? `Bundle rejected: ${err.message}` : errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteGame(game.id);
      toast.success("Game deleted");
      navigate("/dashboard");
    } catch (err) {
      toast.error("Couldn't delete game", errorMessage(err));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const busy = saving || progress !== null;
  return (
    <div className="pf-container pf-page pf-narrow">
      <header className="pf-pagehead">
        <p className="pf-eyebrow">
          <Link to={`/games/${game.id}`}>← {game.title}</Link>
        </p>
        <h1>Edit game</h1>
      </header>

      <form className="pf-form pf-panel" onSubmit={save} noValidate>
        <h2 className="pf-panel__title">Details</h2>
        <GameFields values={values} onChange={setValues} disabled={saving} errors={fieldErrors} />
        {saveError && <Alert>{saveError}</Alert>}
        <div className="pf-form__actions">
          <Link to={`/games/${game.id}`} className="pf-btn pf-btn--ghost">
            View game
          </Link>
          <button type="submit" className="pf-btn pf-btn--primary" disabled={busy}>
            {saving ? <Spinner size={14} /> : null} Save changes
          </button>
        </div>
      </form>

      <section className="pf-form pf-panel">
        <h2 className="pf-panel__title">Files</h2>
        <div className="pf-form__row2">
          <div className="pf-stack">
            <span className="pf-label">Current thumbnail</span>
            <div className="pf-edit-thumb">
              <Thumbnail src={game.thumbnailUrl} seed={game.id} alt="Current thumbnail" />
            </div>
            <FileDrop label="New thumbnail" hint="PNG, JPG or WebP · ≤ 2 MB" accept={IMAGE_ACCEPT} file={thumb} onFile={setThumb} preview disabled={busy} icon="🖼" />
            <button type="button" className="pf-btn" disabled={!thumb || busy} onClick={uploadThumb}>
              Upload thumbnail
            </button>
          </div>
          <div className="pf-stack">
            <span className="pf-label">Current bundle</span>
            <p className="pf-muted pf-small">
              Version {game.version} · entry <code>{game.entry}</code> · {game.width}×{game.height}
            </p>
            <FileDrop label="New bundle (.zip)" hint="Uploading bumps the version" accept={BUNDLE_ACCEPT} file={bundle} onFile={setBundle} disabled={busy} icon="📦" />
            <button type="button" className="pf-btn" disabled={!bundle || busy} onClick={uploadBundle}>
              Upload new version
            </button>
          </div>
        </div>
        {progress && <ProgressBar value={progress.v} label={progress.what} />}
        {fileError && <Alert>{fileError}</Alert>}
      </section>

      <section className="pf-panel pf-danger-zone">
        <h2 className="pf-panel__title">Danger zone</h2>
        <p className="pf-muted pf-small">Deleting removes the game, its files, ratings, comments and scores.</p>
        <button type="button" className="pf-btn pf-btn--danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
          Delete this game
        </button>
      </section>
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete “${game.title}”?`}
        confirmLabel="Delete forever"
        danger
        busy={deleting}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      >
        This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}

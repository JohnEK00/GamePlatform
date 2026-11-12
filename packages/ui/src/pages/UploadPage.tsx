import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { isApiError } from "../api/client";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { Alert, ProgressBar, Spinner } from "../components/common";
import { FileDrop } from "../components/FileDrop";
import { GameFields, type GameFieldValues } from "../components/GameFields";
import { errorMessage, looksLikeZip, parseTags, useDocumentTitle, validateTags } from "../util";

export const BUNDLE_ACCEPT = ".zip,application/zip,application/x-zip-compressed";
export const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp";
const MAX_BUNDLE = 50 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;

export function UploadPage() {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  useDocumentTitle("Upload a game");
  const [values, setValues] = useState<GameFieldValues>({ title: "", description: "", tags: "", published: true });
  const [bundle, setBundle] = useState<File | null>(null);
  const [thumb, setThumb] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof GameFieldValues, string>>>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const tags = parseTags(values.tags);
    const errs: typeof fieldErrors = {};
    if (!values.title.trim()) errs.title = "Title is required.";
    const tagErr = validateTags(tags);
    if (tagErr) errs.tags = tagErr;
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    if (!bundle) return setError("Choose a game bundle (.zip).");
    if (bundle.size > MAX_BUNDLE) return setError("The bundle is larger than 50 MB.");
    if (!(await looksLikeZip(bundle))) return setError(`"${bundle.name}" doesn't look like a valid .zip file.`);
    if (thumb && thumb.size > MAX_IMAGE) return setError("The thumbnail is larger than 2 MB.");

    setProgress(0);
    try {
      const game = await api.createGame(
        { title: values.title.trim(), description: values.description, tags, published: values.published, bundle, thumbnail: thumb },
        (p) => setProgress(p.fraction),
      );
      toast.success("Game uploaded!", `${game.title} is ${game.published ? "live" : "saved as a draft"}.`);
      navigate(`/games/${game.id}`);
    } catch (err) {
      setProgress(null);
      setError(isApiError(err) && err.code === "validation" ? `Your bundle was rejected: ${err.message}` : errorMessage(err));
    }
  };

  const busy = progress !== null;
  return (
    <div className="pf-container pf-page pf-narrow">
      <header className="pf-pagehead">
        <h1>Upload a game</h1>
        <p className="pf-muted">
          Package your game as a .zip with a <code>game.json</code> at the root. New here? Read{" "}
          <Link to="/docs">Make a game</Link>.
        </p>
      </header>
      <form className="pf-form pf-panel" onSubmit={submit} noValidate>
        <GameFields values={values} onChange={setValues} disabled={busy} errors={fieldErrors} />
        <div className="pf-form__row2">
          <FileDrop
            label="Game bundle (.zip) *"
            hint="game.json + entry .js + assets · up to 50 MB"
            accept={BUNDLE_ACCEPT}
            file={bundle}
            onFile={setBundle}
            disabled={busy}
            icon="📦"
          />
          <FileDrop
            label="Thumbnail (optional)"
            hint="PNG, JPG or WebP · up to 2 MB · 16:9 looks best"
            accept={IMAGE_ACCEPT}
            file={thumb}
            onFile={setThumb}
            preview
            disabled={busy}
            icon="🖼"
          />
        </div>
        {error && <Alert>{error}</Alert>}
        {busy && <ProgressBar value={progress ?? 0} label={progress! >= 1 ? "Processing" : "Uploading"} />}
        <div className="pf-form__actions">
          <Link to="/dashboard" className="pf-btn pf-btn--ghost">
            Cancel
          </Link>
          <button type="submit" className="pf-btn pf-btn--primary" disabled={busy}>
            {busy ? <Spinner size={14} /> : null} {busy ? "Uploading…" : "Upload game"}
          </button>
        </div>
      </form>
    </div>
  );
}

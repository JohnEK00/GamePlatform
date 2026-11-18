import { useRef, useState } from "react";
import { useApi } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { errorMessage } from "../util";
import { Alert, ProgressBar, Spinner } from "./common";
import { FileDrop } from "./FileDrop";
import { IMAGE_ACCEPT } from "../pages/UploadPage";

/** F028: client-side banner size limit (the server rejects bigger files with 413). */
export const BANNER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * F028 Settings "Banner" panel: preview (3:1), file picker, upload with progress, and Remove. Hidden when the server
 * doesn't know banners (`user.bannerUrl` is undefined).
 */
export function BannerSettings() {
  const api = useApi();
  const { user, setUser } = useAuth();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<HTMLButtonElement>(null);

  if (!user || user.bannerUrl === undefined) return null;

  const uploading = progress !== null;
  const busy = uploading || removing;
  const canUpload = !!file && !busy;

  const upload = async () => {
    if (!file || busy) return;
    if (file.size > BANNER_MAX_BYTES) {
      setError("Banners can be at most 2 MB.");
      return;
    }
    setError(null);
    setProgress(0);
    try {
      setUser(await api.uploadBanner(file, (p) => setProgress(p.fraction)));
      setFile(null);
      toast.success("Banner updated");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setError(null);
    setRemoving(true);
    try {
      setUser(await api.deleteBanner());
      toast.success("Banner removed");
      uploadRef.current?.focus();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <section className="pf-form pf-panel pf-banner-settings">
      <h2 className="pf-panel__title">Banner</h2>
      <div className="pf-banner-preview">
        {user.bannerUrl ? (
          <img src={api.url(user.bannerUrl)} alt="Your current banner" />
        ) : (
          <span className="pf-banner-preview__empty pf-muted">No banner yet</span>
        )}
      </div>
      <FileDrop
        label="New banner"
        hint="PNG, JPG or WebP · ≤ 2 MB · at least 600×200 · cropped to 3:1"
        accept={IMAGE_ACCEPT}
        file={file}
        onFile={(f) => {
          setFile(f);
          setError(null);
        }}
        preview
        disabled={busy}
        icon="🖼"
      />
      {uploading && <ProgressBar value={progress ?? 0} label="Uploading banner" />}
      {error && <Alert>{error}</Alert>}
      <div className="pf-form__actions pf-banner-settings__actions">
        {/* aria-disabled (not disabled) so focus can land here after Remove banner. */}
        <button
          ref={uploadRef}
          type="button"
          className="pf-btn"
          aria-disabled={!canUpload}
          onClick={() => canUpload && void upload()}
        >
          {uploading ? <Spinner size={14} /> : null} Upload banner
        </button>
        {user.bannerUrl && (
          <button type="button" className="pf-btn pf-btn--ghost" onClick={() => void remove()} disabled={busy}>
            {removing ? <Spinner size={14} /> : null} Remove banner
          </button>
        )}
      </div>
    </section>
  );
}

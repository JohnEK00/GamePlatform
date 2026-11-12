import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useApi, usePlatform } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { Alert, Avatar, ProgressBar, Spinner } from "../components/common";
import { FileDrop } from "../components/FileDrop";
import { errorMessage, useDocumentTitle } from "../util";
import { IMAGE_ACCEPT } from "./UploadPage";

export function SettingsPage() {
  const api = useApi();
  const { user, setUser, logout } = useAuth();
  const toast = useToast();
  const platform = usePlatform();
  useDocumentTitle("Settings");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [bio, setBio] = useState(user?.bio ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(user?.displayName ?? "");
    setBio(user?.bio ?? "");
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!user) return null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      setUser(await api.updateMe({ displayName: displayName.trim(), bio }));
      toast.success("Profile saved");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const uploadAvatar = async () => {
    if (!avatar) return;
    if (avatar.size > 2 * 1024 * 1024) return setAvatarError("Avatars can be at most 2 MB.");
    setAvatarError(null);
    setProgress(0);
    try {
      setUser(await api.uploadAvatar(avatar, (p) => setProgress(p.fraction)));
      setAvatar(null);
      toast.success("Avatar updated");
    } catch (err) {
      setAvatarError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="pf-container pf-page pf-narrow">
      <header className="pf-pagehead">
        <h1>Settings</h1>
        <p className="pf-muted">
          Signed in as <Link to={`/u/${encodeURIComponent(user.username)}`}>@{user.username}</Link>
        </p>
      </header>

      <form className="pf-form pf-panel" onSubmit={save}>
        <h2 className="pf-panel__title">Profile</h2>
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-displayname">
            Display name
          </label>
          <input id="pf-displayname" className="pf-input" maxLength={50} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={user.username} />
        </div>
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-bio">
            Bio
          </label>
          <textarea id="pf-bio" className="pf-input" rows={4} maxLength={1000} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Tell players about yourself" />
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="pf-form__actions">
          <button type="submit" className="pf-btn pf-btn--primary" disabled={saving}>
            {saving ? <Spinner size={14} /> : null} Save profile
          </button>
        </div>
      </form>

      <section className="pf-form pf-panel">
        <h2 className="pf-panel__title">Avatar</h2>
        <div className="pf-avatar-row">
          <Avatar user={user} size={72} />
          <div className="pf-stack" style={{ flex: 1 }}>
            <FileDrop label="New avatar" hint="PNG, JPG or WebP · ≤ 2 MB" accept={IMAGE_ACCEPT} file={avatar} onFile={setAvatar} preview disabled={progress !== null} icon="🙂" />
            {progress !== null && <ProgressBar value={progress} label="Uploading avatar" />}
            {avatarError && <Alert>{avatarError}</Alert>}
            <div>
              <button type="button" className="pf-btn" disabled={!avatar || progress !== null} onClick={uploadAvatar}>
                Upload avatar
              </button>
            </div>
          </div>
        </div>
      </section>

      {platform.extraSettings && <section className="pf-panel pf-extra-settings">{platform.extraSettings}</section>}

      <section className="pf-panel">
        <h2 className="pf-panel__title">Session</h2>
        <button type="button" className="pf-btn pf-btn--ghost" onClick={logout}>
          Log out
        </button>
      </section>
    </div>
  );
}

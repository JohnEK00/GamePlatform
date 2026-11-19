import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { ProfileLink, UpdateMeRequest } from "../api/types";
import { BannerSettings } from "../components/BannerSettings";
import {
  linkLabelErrors,
  linkRowErrors,
  linksForSave,
  ProfileLinksEditor,
  type ProfileLinkRow,
  type ProfileLinksEditorHandle,
} from "../components/ProfileLinksEditor";
import { useApi, usePlatform } from "../context/config";
import { useAuth } from "../context/auth";
import { useToast } from "../context/toast";
import { Alert, Avatar, ProgressBar, Spinner } from "../components/common";
import { FileDrop } from "../components/FileDrop";
import { NotificationSettingsSection } from "../components/NotificationSettings";
import { validateBio, validateDisplayName } from "../profile";
import { errorMessage, useDocumentTitle } from "../util";
import { IMAGE_ACCEPT } from "./UploadPage";

function linkRowsOf(links: ProfileLink[] | undefined): ProfileLinkRow[] {
  return Array.isArray(links) ? links.map((l) => ({ label: l?.label ?? "", url: l?.url ?? "" })) : [];
}

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
  const [links, setLinks] = useState<ProfileLinkRow[]>(() => linkRowsOf(user?.links));
  const [linkErrorsShown, setLinkErrorsShown] = useState(false);
  const linksEditor = useRef<ProfileLinksEditorHandle>(null);
  const [fieldErrorsShown, setFieldErrorsShown] = useState(false);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const bioRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDisplayName(user?.displayName ?? "");
    setBio(user?.bio ?? "");
    setFieldErrorsShown(false);
    setLinks(linkRowsOf(user?.links));
    setLinkErrorsShown(false);
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const [linkFocus, setLinkFocus] = useState<{ index: number; field: "label" | "url"; n: number } | null>(null);
  useEffect(() => {
    if (!linkFocus) return;
    if (linkFocus.field === "label") linksEditor.current?.focusLabel(linkFocus.index);
    else linksEditor.current?.focusUrl(linkFocus.index);
  }, [linkFocus]);

  if (!user) return null;

  // F028: older servers omit `links`: no editor, and `links` is never sent.
  const linksSupported = Array.isArray(user.links);
  const linkErrors = linksSupported && linkErrorsShown ? linkRowErrors(links) : undefined;
  const linkLabelErrs = linksSupported && linkErrorsShown ? linkLabelErrors(links) : undefined;

  // Review 11 L1: the shared forbidden set, checked on the raw text (before trim) once a save was attempted.
  const nameError = fieldErrorsShown ? validateDisplayName(displayName) : null;
  const bioError = fieldErrorsShown ? validateBio(bio) : null;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const nameErr = validateDisplayName(displayName);
    const bioErr = validateBio(bio);
    if (nameErr || bioErr) {
      setFieldErrorsShown(true);
      setError(null);
      (nameErr ? displayNameRef : bioRef).current?.focus();
      return;
    }
    setFieldErrorsShown(false);
    const body: UpdateMeRequest = { displayName: displayName.trim(), bio };
    if (linksSupported) {
      const urlErrs = linkRowErrors(links);
      const labelErrs = linkLabelErrors(links);
      // The first invalid input in DOM order (a row's label comes before its URL).
      const row = links.findIndex((_, i) => labelErrs[i] !== null || urlErrs[i] !== null);
      if (row !== -1) {
        setLinkErrorsShown(true);
        setError(null);
        // Focus after the errors render (aria-invalid / aria-describedby in place).
        const field = labelErrs[row] !== null ? "label" : "url";
        setLinkFocus((f) => ({ index: row, field, n: (f?.n ?? 0) + 1 }));
        return;
      }
      body.links = linksForSave(links);
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await api.updateMe(body);
      setUser(saved);
      if (linksSupported) {
        setLinks(linkRowsOf(saved.links ?? body.links ?? []));
        setLinkErrorsShown(false);
      }
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
          <input
            id="pf-displayname"
            ref={displayNameRef}
            className="pf-input"
            maxLength={50}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={user.username}
            aria-invalid={nameError ? "true" : undefined}
            aria-describedby={nameError ? "pf-displayname-error" : undefined}
          />
          {nameError && (
            <p className="pf-field__error" id="pf-displayname-error">
              {nameError}
            </p>
          )}
        </div>
        <div className="pf-field">
          <label className="pf-label" htmlFor="pf-bio">
            Bio
          </label>
          <textarea
            id="pf-bio"
            ref={bioRef}
            className="pf-input"
            rows={4}
            maxLength={1000}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="Tell players about yourself"
            aria-invalid={bioError ? "true" : undefined}
            aria-describedby={bioError ? "pf-bio-error" : undefined}
          />
          {bioError && (
            <p className="pf-field__error" id="pf-bio-error">
              {bioError}
            </p>
          )}
        </div>
        {linksSupported && <ProfileLinksEditor ref={linksEditor} value={links} onChange={setLinks} errors={linkErrors} labelErrors={linkLabelErrs} />}
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

      <BannerSettings />

      <NotificationSettingsSection />

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

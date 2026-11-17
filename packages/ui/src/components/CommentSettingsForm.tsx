import { useEffect, useRef, useState, type FormEvent } from "react";
import { isApiError, rateLimitMessage } from "../api/client";
import { COMMENT_MODES, SLOW_MODE_SECS, normalizeCommentSettings } from "../api/comments";
import type { CommentMode, CommentSettings, SlowModeSecs } from "../api/types";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { errorMessage } from "../util";
import { Alert, Spinner } from "./common";

/** F020 § 2.1: radio labels, in order. */
export const COMMENT_MODE_LABELS: Record<CommentMode, string> = {
  on: "Everyone can comment",
  repliesOnly: "Replies only: no new threads",
  off: "Off: no new comments or replies",
};

/** F020 § 2.1: slow-mode option labels, in order. */
export const SLOW_MODE_LABELS: Record<SlowModeSecs, string> = {
  0: "Off",
  30: "30 seconds",
  60: "1 minute",
  300: "5 minutes",
  900: "15 minutes",
  3600: "1 hour",
};

export type CommentSettingsFormProps = {
  gameId: string;
  /** The stored settings (the form starts from them and compares against them for "changed"). */
  value: CommentSettings;
  /** The stored values the server returned. */
  onSaved: (next: CommentSettings) => void;
  /** Dialog only: a Cancel button (and the save button reads "Save"). */
  onCancel?: () => void;
  /** id of the heading that names the form (and the dialog). */
  headingId?: string;
  /** Called when a save starts and ends (the dialog blocks Escape while saving). */
  onBusyChange?: (busy: boolean) => void;
};

/**
 * F020: "Who can comment" (radio group) and "Slow mode" (select), shared by the edit page's Comments panel and the
 * game page's ⚙ Settings dialog.
 */
export function CommentSettingsForm({ gameId, value, onSaved, onCancel, headingId, onBusyChange }: CommentSettingsFormProps) {
  const api = useApi();
  const toast = useToast();
  const [mode, setMode] = useState<CommentMode>(value.mode);
  const [secs, setSecs] = useState<SlowModeSecs>(value.slowModeSecs);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const busyCb = useRef(onBusyChange);
  busyCb.current = onBusyChange;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A new stored value (after a save, or a reload) becomes the starting point.
  useEffect(() => {
    setMode(value.mode);
    setSecs(value.slowModeSecs);
  }, [value.mode, value.slowModeSecs]);

  const changed = mode !== value.mode || secs !== value.slowModeSecs;

  const setBusy = (b: boolean) => {
    setSaving(b);
    busyCb.current?.(b);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || !changed) return;
    setBusy(true);
    setError(null);
    try {
      const saved = normalizeCommentSettings(await api.updateCommentSettings(gameId, { mode, slowModeSecs: secs }));
      if (!alive.current) return;
      setBusy(false);
      toast.success("Comment settings saved");
      onSaved(saved);
    } catch (err) {
      if (!alive.current) return;
      setBusy(false);
      setError(isApiError(err) && (err.status === 429 || err.code === "rate_limited") ? rateLimitMessage(err.retryAfter) : errorMessage(err));
    }
  };

  return (
    <form className="pf-comment-settings" onSubmit={submit} aria-labelledby={headingId} aria-busy={saving || undefined} noValidate>
      <fieldset className="pf-comment-settings__modes" aria-describedby="pf-comment-mode-hint">
        <legend className="pf-label">Who can comment</legend>
        {COMMENT_MODES.map((m) => (
          <label key={m} className={`pf-report__reason${mode === m ? " is-active" : ""}`}>
            <input
              type="radio"
              name="pf-comment-mode"
              value={m}
              checked={mode === m}
              onChange={() => setMode(m)}
              disabled={saving}
            />
            <span>{COMMENT_MODE_LABELS[m]}</span>
          </label>
        ))}
        <p id="pf-comment-mode-hint" className="pf-field__hint">
          Existing comments stay visible. You and moderators can always post.
        </p>
      </fieldset>
      <div className="pf-field">
        <label className="pf-label" htmlFor="pf-slow-mode">
          Slow mode
        </label>
        <select
          id="pf-slow-mode"
          className="pf-input pf-comment-settings__select"
          value={String(secs)}
          onChange={(e) => setSecs(Number(e.target.value) as SlowModeSecs)}
          aria-describedby="pf-slow-mode-hint"
          disabled={saving}
        >
          {SLOW_MODE_SECS.map((s) => (
            <option key={s} value={String(s)}>
              {SLOW_MODE_LABELS[s]}
            </option>
          ))}
        </select>
        <span id="pf-slow-mode-hint" className="pf-field__hint">
          Each player can post one comment or reply on this game per interval.
        </span>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className={onCancel ? "pf-modal__actions" : "pf-form__actions"}>
        {onCancel && (
          <button type="button" className="pf-btn pf-btn--ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
        <button type="submit" className="pf-btn pf-btn--primary" disabled={!changed || saving}>
          {saving ? <Spinner size={14} /> : null} {onCancel ? "Save" : "Save comment settings"}
        </button>
      </div>
    </form>
  );
}

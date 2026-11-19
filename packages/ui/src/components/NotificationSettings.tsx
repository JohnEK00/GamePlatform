import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { isApiError } from "../api/client";
import type { NotificationSettings as Settings } from "../api/types";
import { useApi } from "../context/config";
import { useToast } from "../context/toast";
import { errorMessage } from "../util";
import { LoadError, Spinner } from "./common";
import { MutedList } from "./MutedList";

type Key = keyof Settings;

/**
 * The switches, in display order (F007 spec § 2.4; F018 adds `pins`, F021 `collections`, F024 adds `screenshots`,
 * F031 `postReplies` and `postHearts` right after `pins`).
 * A switch is shown only when the server's settings have its field (older servers omit `pins` / `collections` /
 * `screenshots`).
 */
export const NOTIFICATION_SETTING_FIELDS: readonly { key: Key; label: string; hint: string }[] = [
  { key: "comments", label: "Comments on my games", hint: "Someone comments on a game you made." },
  { key: "replies", label: "Replies to my comments and to me", hint: "Someone answers in your thread or replies to you." },
  { key: "hearts", label: "Hearts on my comments", hint: "Someone hearts a comment you wrote." },
  { key: "pins", label: "Pins on your comments", hint: "A creator pins a comment you wrote." },
  { key: "postReplies", label: "Replies to my posts", hint: "Someone replies to a post you wrote, or answers your reply on a post." },
  { key: "postHearts", label: "Hearts on my posts", hint: "Someone hearts a post you wrote." },
  { key: "follows", label: "New followers", hint: "Someone starts following you." },
  { key: "newGames", label: "New games from creators I follow", hint: "A creator you follow publishes a new game." },
  { key: "collections", label: "My games added to collections", hint: "Someone adds a game you made to a public collection." },
  { key: "screenshots", label: "Screenshots of my games", hint: "Someone posts a screenshot of a game you made." },
];

/**
 * Settings → Notifications (`id="notifications"`): per-kind switches saved on change with a partial PUT.
 * Renders nothing against a server without F007 (404). `/settings#notifications` scrolls it into view.
 */
export function NotificationSettingsSection() {
  const api = useApi();
  const toast = useToast();
  const location = useLocation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);
  // Last value the user chose per field, so a stale failure doesn't revert a newer choice.
  const wanted = useRef<Partial<Settings>>({});

  useEffect(() => {
    let alive = true;
    setError(null);
    api.getNotificationSettings().then(
      (s) => alive && setSettings(s),
      (e) => {
        if (!alive) return;
        if (isApiError(e) && e.status === 404) setUnsupported(true);
        else setError(e);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, reloadKey]);

  useEffect(() => {
    if (location.hash !== "#notifications") return;
    sectionRef.current?.scrollIntoView?.({ block: "start" });
    // on mount only (and when the hash is set later)
  }, [location.hash]);

  if (unsupported) return null;

  const change = async (key: Key, value: boolean) => {
    if (!settings) return;
    const before = settings[key];
    wanted.current[key] = value;
    setSettings((s) => (s ? { ...s, [key]: value } : s));
    try {
      const next = await api.updateNotificationSettings({ [key]: value } as Partial<Settings>);
      if (wanted.current[key] !== value) return;
      if (next && typeof next[key] === "boolean") setSettings((s) => (s ? { ...s, [key]: next[key] } : s));
      toast.success("Notification settings saved");
    } catch (e) {
      if (wanted.current[key] !== value) return;
      wanted.current[key] = before;
      setSettings((s) => (s ? { ...s, [key]: before } : s));
      toast.error("Couldn't save notification settings", errorMessage(e));
    }
  };

  return (
    <section id="notifications" ref={sectionRef} className="pf-panel pf-notif-settings" aria-labelledby="pf-notif-settings-title">
      <fieldset className="pf-notif-settings__fieldset">
        <legend id="pf-notif-settings-title" className="pf-panel__title">
          Notifications
        </legend>
        {error ? (
          <LoadError message="Couldn't load notification settings." onRetry={() => setReloadKey((k) => k + 1)} />
        ) : !settings ? (
          <Spinner size={18} label="Loading notification settings" />
        ) : (
          <div className="pf-stack pf-notif-settings__list">
            {NOTIFICATION_SETTING_FIELDS.filter((f) => typeof settings[f.key] === "boolean").map((f) => (
              <label key={f.key} className="pf-switch">
                <input
                  type="checkbox"
                  checked={settings[f.key] === true}
                  onChange={(e) => void change(f.key, e.target.checked)}
                  aria-labelledby={`pf-notif-set-${f.key}-label`}
                  aria-describedby={`pf-notif-set-${f.key}-hint`}
                />
                <span className="pf-switch__track" aria-hidden="true" />
                <span className="pf-notif-settings__text">
                  <strong id={`pf-notif-set-${f.key}-label`}>{f.label}</strong>
                  <span id={`pf-notif-set-${f.key}-hint`} className="pf-field__hint">
                    {f.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <p className="pf-muted pf-small pf-notif-settings__note">
        Turning a type off stops new notifications of that type. Existing ones stay until they expire.
      </p>
      {/* F018: only servers with mutes send `pins`; the list hides itself on a 404 as well. */}
      {settings && typeof settings.pins === "boolean" && <MutedList />}
    </section>
  );
}

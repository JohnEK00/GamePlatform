import { useEffect, useId, useRef, useState } from "react";
import {
  isTauri,
  osNotificationsStatus,
  readOsNotificationsEnabled,
  requestOsNotifications,
  writeOsNotificationsEnabled,
  type OsNotificationsStatus,
} from "./platform";

const BLOCKED = "Notifications are blocked in your system settings.";

/**
 * F007 § 2.8: "Show desktop notifications" (per device, off by default), rendered in `platform.extraSettings`.
 * Renders nothing in a plain browser or when the app was built without the `os-notifications` Cargo feature.
 * The UI's NotificationsProvider resets its OS watermark when it sees the setting turn on, so old
 * notifications don't burst out.
 */
export function OsNotificationSetting() {
  const id = useId();
  const [status, setStatus] = useState<OsNotificationsStatus | null>(null);
  const [enabled, setEnabled] = useState(readOsNotificationsEnabled);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (isTauri()) {
      osNotificationsStatus().then((s) => {
        if (mounted.current) setStatus(s);
      });
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!isTauri() || status === null || status === "unsupported") return null;

  async function change(on: boolean) {
    setMessage(null);
    if (!on) {
      writeOsNotificationsEnabled(false);
      setEnabled(false);
      return;
    }
    setBusy(true);
    const result = await requestOsNotifications();
    if (!mounted.current) return;
    setBusy(false);
    setStatus(result);
    if (result === "granted") {
      writeOsNotificationsEnabled(true);
      setEnabled(true);
    } else {
      writeOsNotificationsEnabled(false);
      setEnabled(false);
      if (result === "denied") setMessage(BLOCKED);
    }
  }

  return (
    <div className="pf-stack pfd-os-notifications">
      <label className="pf-switch">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => void change(e.target.checked)}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
        />
        <span className="pf-switch__track" aria-hidden="true" />
        <span className="pfd-os-notifications__text">
          <strong id={`${id}-label`}>Show desktop notifications</strong>
          <span id={`${id}-hint`} className="pf-field__hint">
            When the app isn't focused, new notifications also appear in your system's notification area. Comment text is
            never shown.
          </span>
        </span>
      </label>
      <div role="status">{message && <div className="pf-alert pf-alert--error">{message}</div>}</div>
    </div>
  );
}

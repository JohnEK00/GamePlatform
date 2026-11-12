import { useEffect, useState } from "react";
import { ServerForm } from "./ServerForm";
import { checkHealth } from "./server";
import { useServer } from "./ServerContext";

type Health = "checking" | "online" | "offline";

const RETRY_MS = 10_000;

/** Friendly banner shown above the app while the configured server is unreachable. */
export function OfflineBanner() {
  const { server, isDefault } = useServer();
  const [health, setHealth] = useState<Health>("checking");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    checkHealth(server).then((r) => {
      if (cancelled) return;
      setHealth(r.ok ? "online" : "offline");
      setError(r.ok ? "" : r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [server, tick]);

  // Keep polling while offline so the banner disappears by itself once the backend comes up.
  useEffect(() => {
    if (health !== "offline") return;
    const t = setInterval(() => setTick((n) => n + 1), RETRY_MS);
    return () => clearInterval(t);
  }, [health]);

  if (health !== "offline" || dismissed) return null;

  return (
    <div className="pfd-banner" role="alert">
      <div className="pfd-banner__row">
        <span className="pfd-banner__icon" aria-hidden="true">
          ⚠
        </span>
        <div className="pfd-banner__text">
          <strong>{isDefault ? "Welcome to Pixelforge Arcade! " : ""}Can’t reach the game server.</strong>{" "}
          <span>
            Tried <code>{server}</code>: {error}.{" "}
            {isDefault
              ? "Start the backend locally (npm run dev:backend) or connect to another server."
              : "Check that the server is running, or pick another one."}
          </span>
        </div>
        <div className="pfd-banner__actions">
          <button type="button" className="pf-btn pf-btn--sm" onClick={() => setTick((n) => n + 1)}>
            Retry
          </button>
          <button type="button" className="pf-btn pf-btn--sm pf-btn--primary" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
            {editing ? "Close" : "Change server"}
          </button>
          <button type="button" className="pf-btn pf-btn--sm pf-btn--ghost" onClick={() => setDismissed(true)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      </div>
      {editing && (
        <div className="pfd-banner__form">
          <ServerForm compact />
        </div>
      )}
    </div>
  );
}

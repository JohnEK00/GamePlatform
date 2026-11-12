import { useId, useState, type FormEvent } from "react";
import { checkHealth, DEFAULT_SERVER, normalizeServerUrl, type HealthResult } from "./server";
import { useServer } from "./ServerContext";

type Status = { kind: "idle" } | { kind: "testing" } | { kind: "result"; url: string; result: HealthResult };

/** Server URL input with "Test connection" and "Save" (save re-mounts the app). */
export function ServerForm({ compact = false }: { compact?: boolean }) {
  const { server, isDefault, setServer } = useServer();
  const id = useId();
  const [value, setValue] = useState(server);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const normalized = normalizeServerUrl(value);
  const invalid = value.trim() !== "" && normalized === null;

  async function test() {
    if (!normalized) return;
    setStatus({ kind: "testing" });
    setStatus({ kind: "result", url: normalized, result: await checkHealth(normalized) });
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (!normalized) return;
    setServer(normalized);
  }

  return (
    <form className="pf-stack pfd-server-form" onSubmit={save} noValidate>
      <div className="pf-field">
        <label className="pf-label" htmlFor={id}>
          API server URL
        </label>
        <input
          id={id}
          className="pf-input"
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder={DEFAULT_SERVER}
          value={value}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setStatus({ kind: "idle" });
          }}
        />
        {!compact && (
          <p className="pf-small pf-muted">
            The Pixelforge Arcade backend this app talks to. Current: <code>{server}</code>
            {isDefault ? " (default)" : ""}. Logins are stored per server, so you may need to sign in again after switching.
          </p>
        )}
      </div>
      {invalid && <div className="pf-alert pf-alert--error">Enter an http:// or https:// address, e.g. {DEFAULT_SERVER}</div>}
      {status.kind === "result" &&
        (status.result.ok ? (
          <div className="pf-alert pf-alert--success" role="status">
            Connected to {status.url}
            {status.result.version ? ` (server v${status.result.version})` : ""}.
          </div>
        ) : (
          <div className="pf-alert pf-alert--error" role="status">
            {status.url}: {status.result.error}.
          </div>
        ))}
      <div className="pf-form__actions">
        {!isDefault && !compact && (
          <button type="button" className="pf-btn pf-btn--ghost" onClick={() => setServer(null)}>
            Reset to default
          </button>
        )}
        <button type="button" className="pf-btn" disabled={!normalized || status.kind === "testing"} onClick={test}>
          {status.kind === "testing" ? "Testing…" : "Test connection"}
        </button>
        <button type="submit" className="pf-btn pf-btn--primary" disabled={!normalized || (normalized === server && !isDefault)}>
          Save
        </button>
      </div>
    </form>
  );
}

/** Rendered on /settings via `platform.extraSettings` (the UI already wraps it in a .pf-panel). */
export function ServerSettings() {
  return (
    <>
      <h2 className="pf-panel__title">Server</h2>
      <ServerForm />
    </>
  );
}

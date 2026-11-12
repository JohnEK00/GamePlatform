/** Persisted API-server setting + connectivity check. */

export const SERVER_STORAGE_KEY = "webgame.desktop.server";
export const DEFAULT_SERVER: string = normalizeServerUrl(import.meta.env.VITE_API_BASE_URL ?? "") ?? "http://localhost:8080";

/** Trim, default the scheme to http://, drop trailing slashes. Returns null if not a valid http(s) URL. */
export function normalizeServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.search || u.hash) return null;
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** The saved server URL, or null when the user never chose one (first run). */
export function readSavedServer(): string | null {
  try {
    const v = localStorage.getItem(SERVER_STORAGE_KEY);
    return v ? normalizeServerUrl(v) : null;
  } catch {
    return null;
  }
}

export function saveServer(url: string | null): void {
  try {
    if (url) localStorage.setItem(SERVER_STORAGE_KEY, url);
    else localStorage.removeItem(SERVER_STORAGE_KEY);
  } catch {
    /* storage unavailable — setting lasts for this session only */
  }
}

export type HealthResult = { ok: true; version?: string } | { ok: false; error: string };

/** GET {server}/api/health with a timeout. */
export async function checkHealth(server: string, timeoutMs = 5000): Promise<HealthResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${server}/api/health`, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return { ok: false, error: `Server answered HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { status?: string; version?: string } | null;
    if (body?.status !== "ok") return { ok: false, error: "Not a Pixelforge Arcade server (unexpected /api/health response)" };
    return { ok: true, version: body.version };
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, error: `No answer within ${Math.round(timeoutMs / 1000)}s` };
    return { ok: false, error: "Could not connect (server down, wrong address, or CORS not allowing this app)" };
  } finally {
    clearTimeout(timer);
  }
}

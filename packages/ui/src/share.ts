// F028: absolute share links that work in any browser (pure; no React, no I/O beyond window.location).
import type { WebGameConfig } from "./context/config";

/** How long a Copy link button shows "Link copied" (F008, moved here in F028). */
export const LINK_COPIED_MS = 2000;

export type ShareConfig = Pick<WebGameConfig, "apiBaseUrl" | "routerMode" | "basename">;

function currentOrigin(): string {
  return typeof window !== "undefined" && window.location ? window.location.origin : "";
}

/**
 * Absolute share link for an in-app `path` (starting with "/"). Web (browser router): this page's origin plus the
 * router basename. Desktop (hash router): the configured server (`apiBaseUrl`, trailing slashes trimmed), which serves
 * the web app; falls back to the page origin when `apiBaseUrl` is empty. Never a `#/` URL.
 */
export function appShareUrl(config: ShareConfig, path: string): string {
  if (config.routerMode === "hash") {
    const base = (config.apiBaseUrl ?? "").trim().replace(/\/+$/, "");
    return `${base || currentOrigin()}${path}`;
  }
  const basename = (config.basename ?? "").replace(/\/+$/, "");
  const prefix = basename && basename.startsWith("/") ? basename : "";
  return `${currentOrigin()}${prefix}${path}`;
}

/** F028: share link of a profile, `{origin}/u/{username}` (desktop: `{serverBase}/u/{username}`). */
export function profileShareUrl(config: ShareConfig, username: string): string {
  return appShareUrl(config, `/u/${encodeURIComponent(username)}`);
}

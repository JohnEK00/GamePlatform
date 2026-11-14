/**
 * Webview side of the native menu (src-tauri/src/menu.rs) and the F11 shortcut.
 * Rust handles window actions itself; navigation items arrive as the `app-menu` event with the item id.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { STUDIO_OPEN_FOLDER_EVENT } from "@webgame/ui";
import { isTauri } from "./platform";

export const MENU_EVENT = "app-menu";

const ROUTES: Record<string, string> = {
  upload: "/upload",
  settings: "/settings",
  feed: "/feed",
  docs: "/docs",
  "open-folder": "/studio",
};

/** Hash-router navigation (the app uses routerMode "hash"; setting the hash fires popstate). */
export function navigate(route: string): void {
  if (window.location.hash !== `#${route}`) window.location.hash = route;
}

/**
 * File → "Open local game folder…": runs the Studio's own Open folder flow (`platform.openLocalProject`, error
 * toasts), via the @webgame/ui contract (docs/ARCHITECTURE.md "v2 features"). On the Studio already, dispatch
 * `STUDIO_OPEN_FOLDER_EVENT`; otherwise set the pending flag, which the Studio consumes on mount, and navigate.
 */
export function openFolderInStudio(): void {
  const route = window.location.hash.slice(1).split("?")[0];
  if (route === "/studio") {
    window.dispatchEvent(new CustomEvent(STUDIO_OPEN_FOLDER_EVENT));
  } else {
    window.__webgameStudioOpenPending = true;
    navigate("/studio");
  }
}

/** Installs the menu-event listener and the F11 key handler. Returns a cleanup function. */
export function installNativeIntegrations(): () => void {
  if (!isTauri()) return () => {};

  let disposed = false;
  let unlisten: (() => void) | null = null;
  listen<string>(MENU_EVENT, ({ payload }) => {
    if (payload === "open-folder") openFolderInStudio();
    else if (ROUTES[payload]) navigate(ROUTES[payload]);
  })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    })
    .catch((e) => console.warn("menu events unavailable", e));

  // The menu's F11 accelerator may not fire while the webview has focus; Rust de-duplicates double toggles.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "F11" && !e.repeat) {
      e.preventDefault();
      invoke("toggle_fullscreen").catch(() => {});
    }
  };
  window.addEventListener("keydown", onKey, true);

  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener("keydown", onKey, true);
  };
}

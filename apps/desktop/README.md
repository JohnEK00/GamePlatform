# @webgame/desktop — Pixelforge Arcade (Tauri v2)

Desktop shell that mounts `<WebGameApp>` from `@webgame/ui` (hash router) inside a Tauri v2 webview and adds:

- **Native file picker** (`platform.pickFile`): the Rust command `pick_file(filters)` opens the native dialog
  (tauri-plugin-dialog Rust API, filters derived from the field's `accept` string), reads the chosen file (regular file,
  max 60 MB) and returns `{ ticket, name, size }`; `read_picked(ticket)` then returns the bytes as a raw `ArrayBuffer`
  and consumes the ticket (single use, at most 4 pending). The webview never passes a filesystem path, so it can only
  read files the user picked. In a plain browser (`npm run dev`) it falls back to `<input type=file>`.
- **Server setting** (`platform.extraSettings` → "Server" panel on `/settings`): URL input, *Test connection*
  (`GET /api/health`), *Save* (persisted in `localStorage["webgame.desktop.server"]`, default `http://localhost:8080`,
  or `VITE_API_BASE_URL` at build time). Saving re-mounts the app (`key={server}`).
- **Offline / first-run banner** above the app when the server is unreachable (retries every 10 s, inline
  "Change server" form).
- **Window state** persisted by `tauri-plugin-window-state`.

## Prerequisites (Windows)

- Node 24 + the repo's `node_modules` (installed from the repo root).
- Rust stable (1.80+) with the **MSVC** toolchain, and *Visual Studio Build Tools* with
  "Desktop development with C++" (MSVC + Windows SDK).
- **Microsoft Edge WebView2 Runtime** (preinstalled on Windows 10/11; bundles use the download bootstrapper).
- macOS/Linux: see the Tauri prerequisites (Xcode CLT / webkit2gtk-4.1 etc.).

## Develop

```sh
npm run build -w @webgame/ui          # the desktop app consumes packages/ui/dist (dev and build)
npm run dev:backend                   # API on http://localhost:8080 (separate terminal)
npm run dev:desktop                   # = npm run tauri -w @webgame/desktop -- dev  (starts Vite on :1420)
```

`npm run dev -w @webgame/desktop` alone serves the frontend at http://localhost:1420 in a normal browser.
The backend's default `CORS_ORIGINS` already includes `http://localhost:1420`, `http://tauri.localhost` and
`tauri://localhost`; for a remote server add those origins to its `CORS_ORIGINS`.

## Build

```sh
npm run build -w @webgame/desktop               # typecheck + Vite build → apps/desktop/dist
cd apps/desktop/src-tauri && cargo build        # debug binary (target/debug/pixelforge-arcade.exe)
npm run tauri -w @webgame/desktop -- build      # release bundles (MSI/NSIS) in src-tauri/target/release/bundle
```

## Layout

```
apps/desktop/
├─ index.html, vite.config.ts     Vite (port 1420, strictPort, envPrefix VITE_/TAURI_)
├─ src/                           main.tsx, App.tsx, platform.ts (pickFile), server.ts (setting + health),
│                                 ServerForm.tsx (settings panel), OfflineBanner.tsx, desktop.css
├─ app-icon.png, scripts/gen-icon.mjs   icon source (regenerate all icons: npm run icons -w @webgame/desktop)
└─ src-tauri/                     Rust crate: lib.rs (plugins + pick_file/read_picked), tauri.conf.json, capabilities/, icons/
```

## Security notes

- CSP (`tauri.conf.json`): scripts only from the app itself; `connect-src`/`frame-src`/`img-src` allow any
  `http:`/`https:` origin because the API server is user-configurable. Games still run in the
  `sandbox="allow-scripts allow-pointer-lock"` iframe served by the backend.
- The capability (`capabilities/default.json`) only applies to the local `main` window content, so remote pages
  and game iframes cannot invoke `pick_file`/`read_picked`. It grants no dialog permissions (least privilege): the
  dialog is opened from Rust, so the frontend has no `dialog:allow-open` and there is no arbitrary-path read command.

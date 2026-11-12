# WebGameApp — Architecture

A platform where users sign up, upload games built with our custom WebGL engine, and play/rate/comment on games in the browser or the desktop app.

## Layout (npm workspaces + one Cargo crate)

```
WebGameApp/
├─ packages/
│  ├─ engine/     @webgame/engine  — TypeScript WebGL2 game engine ("Pixelforge"). Builds dist/engine.js (ESM, no deps)
│  └─ ui/         @webgame/ui      — PURE GUI: React component library + all pages + typed API client. No bootstrapping.
├─ apps/
│  ├─ web/        @webgame/web     — Vite web app: mounts <WebGameApp> from @webgame/ui (BrowserRouter)
│  └─ desktop/    @webgame/desktop — Tauri v2 app: mounts <WebGameApp> (HashRouter) + desktop extras
├─ backend/       Rust (axum + sqlx/SQLite) REST API, file storage, game hosting, player page
├─ examples/      Example games written against the engine (packed to .zip by scripts/pack-examples.mjs)
├─ docs/          ARCHITECTURE.md, API.md, GAME_FORMAT.md  ← the contracts. Change them only via the project manager.
└─ .claude/agents Agent team definitions
```

## Ownership (one agent per area — never edit another area's files)

| Area | Owner agent | Paths |
|---|---|---|
| Engine + examples | `engine-dev` | `packages/engine/**`, `examples/**`, `scripts/pack-examples.mjs` |
| Backend | `backend-dev` | `backend/**` |
| GUI + web app | `frontend-dev` | `packages/ui/**`, `apps/web/**` |
| Desktop | `desktop-dev` | `apps/desktop/**` |
| Contracts, root config | `project-manager` | `docs/**`, root `package.json`, `.gitignore`, `README.md` |
| Review / integration tests | `qa-reviewer` | read-only + reports |

## Runtime picture

```
 Browser / Tauri webview
 ┌──────────────────────────────────────────────┐
 │ @webgame/ui  (React)                         │
 │   GamePlayer ──<iframe sandbox="allow-scripts│
 │                 allow-pointer-lock">─────────┼──► GET {api}/play/{id}  (backend-generated HTML)
 │        ▲  postMessage(webgame:*)             │        loads {api}/runtime/engine.js
 │        └─────────────────────────────────────┤        loads {api}/games/{id}/files/<entry>
 │   ApiClient ── fetch + Bearer JWT ───────────┼──► {api}/api/*
 └──────────────────────────────────────────────┘
```

- **Security model for user code**: uploaded games are untrusted JS. They ONLY run inside an iframe with `sandbox="allow-scripts allow-pointer-lock"` (NO `allow-same-origin`), so they get an opaque origin and cannot read the user's token or call the API as the user. The backend therefore serves `/play/*`, `/runtime/*`, `/games/*/files/*` with `Access-Control-Allow-Origin: *`.
- Platform features a game may use (submit score, report ready, request fullscreen) go through `window.parent.postMessage` (see GAME_FORMAT.md). The parent (`GamePlayer`) validates `event.source === iframe.contentWindow` and performs the API call with the user's token.
- **Dev ports**: backend `http://localhost:8080`, web dev server `http://localhost:5173` (proxies `/api`, `/play`, `/runtime`, `/games`, `/media` to 8080), Tauri dev server `http://localhost:1420`.
- **Production (web)**: backend serves `apps/web/dist` as the SPA (fallback to index.html) when `WEB_DIST` is set — a single process.

## Tech choices
- Engine: TypeScript, raw WebGL2 (no libs), Vite library build. TS 7 / Vite 8 are installed.
- UI: React 19, react-router-dom 7, plain CSS (CSS variables, dark theme default), no UI framework.
- Backend: Rust stable 1.96, axum, tokio, sqlx (sqlite, runtime-checked queries — NOT the compile-time `query!` macros), argon2, jsonwebtoken, zip, tower-http.
- Desktop: Tauri v2, reuses `@webgame/ui`.

## Dependency rule
JS dependencies are already installed from the repo root. Agents must NOT run `npm install` for new packages without the project manager's approval (parallel installs corrupt the shared `node_modules`). Rust crates are free to add in `backend/Cargo.toml` / `apps/desktop/src-tauri/Cargo.toml`.

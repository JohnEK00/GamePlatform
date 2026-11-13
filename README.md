# Pixelforge Arcade (WebGameApp)

A full-stack platform for making, uploading and playing browser games. It has five parts:
- **Pixelforge**, a custom WebGL2 engine
- **Rust backend** (axum + SQLite)
- **@webgame/ui**, a pure React GUI package
- **Web app** built on that GUI
- **Tauri desktop app** built on the same GUI

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/API.md](docs/API.md) and [docs/GAME_FORMAT.md](docs/GAME_FORMAT.md).

## Prerequisites
Node 20+ (tested on 24), Rust stable (tested on 1.96), and on Windows the WebView2 runtime plus MSVC build tools for Tauri.

## Quick start (dev)
```sh
npm install                    # once, from the repo root
npm run build:engine           # backend serves packages/engine/dist/engine.js at /runtime/engine.js
npm run build:ui               # web/desktop apps consume the built GUI package
npm run examples               # packs examples/* into examples/dist/*.zip
npm run dev:backend            # http://localhost:8080
npm run dev:web                # http://localhost:5173 (proxies the API)
npm run dev:desktop            # Tauri window (needs the backend running)
```
To seed a demo account and the example games, see [backend/README.md](backend/README.md).

## Features
- **Play & share**: upload games as `.zip` bundles, browse/search/sort by tags, ratings, comments, leaderboards and favorites.
- **Achievements**: games declare them in `game.json` and call `engine.platform.unlockAchievement(id)`. They show on game pages and profiles.
- **Cloud saves**: `engine.storage` follows your account across devices, with a localStorage fallback.
- **Game Studio** (`/studio`): write a game in the browser, starting from a template, with a live sandboxed preview, then publish it or export a `.zip`. On desktop you can also open a local game folder.
- **Creator analytics**: dashboard totals and a 30-day plays chart for your games overall and per game.
- **Moderation**: report games and comments, plus an admin queue at `/admin` (admins are set with `ADMIN_USERNAMES`).
- **Security**: untrusted game code runs only in sandboxed iframes, owner previews use short-lived preview tokens, and rate limits protect auth, uploads and comments.
- **Engine**: WebGL2 sprite batching, input, audio, scenes, tilemaps, physics, particles, tweens, and an F3 debug overlay. There are three example games: Space Dodge, Pixel Peaks and Brick Breaker.
- **Desktop**: native menu, F11 fullscreen, native open and save dialogs, and a configurable server.

## Docker
```sh
JWT_SECRET=change-me PUBLIC_ORIGIN=http://localhost:8080 docker compose up --build
```
CI (`.github/workflows/ci.yml`) builds and tests the engine, UI, backend and desktop crate on every push.

## Production (single process)
```sh
npm run build
cd backend && cargo build --release
WEB_DIST=../apps/web/dist ENGINE_DIST=../packages/engine/dist JWT_SECRET=change-me ./target/release/webgame-server
```

## Agent team
This repo is managed by a team of Claude Code agents in [.claude/agents/](.claude/agents/):

| Agent | Role |
|---|---|
| `project-manager` | Orchestrator: owns docs/contracts, delegates, integrates and verifies |
| `engine-dev` | `packages/engine`, `examples/` |
| `backend-dev` | `backend/` |
| `frontend-dev` | `packages/ui`, `apps/web` |
| `desktop-dev` | `apps/desktop` |
| `qa-reviewer` | Read-only review + end-to-end smoke tests |

Run `claude --agent project-manager` and give it a feature request. It splits the request by area, dispatches the specialists in parallel and verifies the result.

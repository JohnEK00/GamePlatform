# Pixelforge Arcade (WebGameApp)

A full-stack platform for making, uploading and playing browser games. It has five parts:
- **Pixelforge**, a custom WebGL2 engine
- **Rust backend** (axum + SQLite)
- **@webgame/ui**, a pure React GUI package
- **Web app** built on that GUI
- **Tauri desktop app** built on the same GUI

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/API.md](docs/API.md) and [docs/GAME_FORMAT.md](docs/GAME_FORMAT.md).

## Prerequisites
Node 22.12+ (tested on 24; vitest and jsdom need 22.12+), Rust stable (tested on 1.96), and on Windows the WebView2 runtime plus MSVC build tools for Tauri.

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

**Testing on other devices (LAN):** the dev server listens on localhost only. To let phones or other machines on your network reach it, start it with `WEBGAME_LAN=1 npm run dev:web` and open `http://<your-LAN-IP>:5173`. Everyone on that network can then use the dev app and its API, so only do this on a network you trust and always set `JWT_SECRET` for the backend. Without `JWT_SECRET`, the backend uses a random secret per run, so logins don't survive a restart. Vite's file serving is limited to the app sources either way; the database and `.env` files are never served. Browsers block gamepads on plain-`http` LAN addresses, and the engine then simply runs without gamepad input.

## Features
- **Play & share**: upload games as `.zip` bundles, browse/search/sort by tags (including Trending), ratings, favorites, "More like this", and release notes with an "Updated" badge.
- **Leaderboards**: daily, weekly and all-time boards, lower-is-better and time scores, and boards games can show in-game.
- **Social**: follow creators, an activity feed, threaded comment replies with hearts, creator pin/lock tools, per-game comment modes (on, replies only, off) with optional slow mode, and in-app notifications (with optional desktop OS notifications, mutes per game or thread, and one polling tab per browser).
- **Collections**: curated, ordered game lists with notes, public (shareable `/c/{id}` links, shown on profiles and game pages) or private.
- **Screenshots**: capture with 📷 or a game's own key, share to a per-game gallery or set as the thumbnail, and see them in the feed (Screenshots tab) and on profiles; every image is re-encoded before use.
- **Controls**: games declare named actions; players remap keys and gamepad buttons per game from a controls panel, and signed-in players' bindings follow their account across devices. Games can show prompts for the device in use.
- **Achievements**: games declare them in `game.json` and call `engine.platform.unlockAchievement(id)`. They show on game pages and profiles.
- **Cloud saves**: `engine.storage` follows your account across devices, with a localStorage fallback.
- **Game Studio** (`/studio`): write a game in the browser, starting from a template, with a live sandboxed preview, then publish it or export a `.zip`. On desktop you can also open a local game folder.
- **Creator analytics**: dashboard totals and a 30-day plays chart for your games overall and per game.
- **Moderation**: report games, comments, screenshots and collections, plus an admin queue at `/admin` (admins are set with `ADMIN_USERNAMES`; register those accounts before listing them).
- **Security**: untrusted game code runs only in sandboxed iframes, owner previews use short-lived preview tokens, and rate limits protect auth, uploads and comments.
- **Engine**: WebGL2 sprite batching, input with remappable actions, audio, scenes, tilemaps, physics, particles, tweens, bitmap and pixel fonts, 9-slice panels, menu widgets (buttons, sliders, toggles, text fields and lists), frame capture, and an F3 debug overlay. There are six example games: Space Dodge, Pixel Peaks, Brick Breaker, Ember Garden, Overclock and Kiln Clash.
- **Studio extras**: open your own published games, publish updates with release notes, and start from templates including Time trial and Menu & HUD.
- **Desktop**: native menu (Feed, Controls, Notifications, Collections, Take Screenshot), F11 fullscreen, native open and save dialogs, local game folders in the Studio, opt-in OS notifications, and a configurable server.

See [docs/ROADMAP.md](docs/ROADMAP.md) for shipped and upcoming features and [docs/reviews/](docs/reviews/) for the review history.

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

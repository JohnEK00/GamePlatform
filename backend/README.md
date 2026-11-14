# webgame-server

Rust backend for WebGameApp: the REST API (`docs/API.md`), game bundle upload/validation, static game hosting and the `/play/{id}` player page (`docs/GAME_FORMAT.md`).

Stack: axum 0.8, tokio, sqlx 0.8 (SQLite, runtime queries), argon2, jsonwebtoken (HS256; session tokens 7 days, preview tokens 10 minutes), zip, tower-http.

## Run

```sh
cd backend
cargo run                      # http://localhost:8080
curl http://localhost:8080/api/health
```

Migrations in `migrations/` are embedded and applied at startup. The data dir and the SQLite file are created on first run.

`/runtime/engine.js` is served from `ENGINE_DIST`. Build the engine first with `npm run build:engine` from the repo root. Until you do, that route returns 503 with a message telling you how to fix it.

## Environment

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `DATABASE_URL` | `sqlite://data/webgame.db?mode=rwc` | |
| `DATA_DIR` | `data` | `games/{id}/v{version}/…`, `thumbnails/`, `avatars/` |
| `JWT_SECRET` | dev default (logs a warning) | **set in production** |
| `ENGINE_DIST` | `../packages/engine/dist` | must contain `engine.js` |
| `WEB_DIST` | unset | if set, serves the SPA: any GET not matched by a backend route falls back to `index.html`, including `/games/{id}` and `/games/{id}/edit` (only `/games/{id}/files/*` is backend-owned under `/games`) |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:1420,http://tauri.localhost,tauri://localhost` | applies to `/api/*` only; hosting routes use `*` |
| `PUBLIC_ORIGIN` | unset (logs a warning) | e.g. `https://arcade.example.com`; **recommended in production**. When set, `/play` uses it as `{ORIGIN}` (import URLs and CSP) and ignores `Host`/`X-Forwarded-Proto`. Must be `http(s)://host[:port]` with no path, query, fragment or user info; one trailing slash is stripped. An invalid value stops the server at startup with an error |
| `ADMIN_USERNAMES` | unset | comma list, case-insensitive. Applied at startup (listed users become `admin`, everyone else `user`) and on register. **A listed username that is not registered yet becomes admin for whoever registers it first**: register the admin accounts before listing them, and list only existing accounts |
| `RATE_LIMIT` | on | `off` / `0` / `false` disables the in-memory token buckets (tests run with it off) |
| `TRUST_PROXY` | off | number of trusted reverse-proxy hops in front of the server (`true` = 1, `off`/`0` = none; other values stop startup with an error). With `n` hops the client IP for rate limiting is the `n`-th `X-Forwarded-For` entry counted from the right (entries further left are client-controlled and ignored); if the header has fewer than `n` entries the connection address is used. `X-Real-IP` is used only when there is no `X-Forwarded-For`. Leave off unless every request passes through a proxy that appends to `X-Forwarded-For`, otherwise clients can spoof it |
| `RUST_LOG` | `info,webgame_server=debug,tower_http=info` | |

## Docker

The repo-root `Dockerfile` builds the engine, UI and web app (node 24), the backend (release), and a slim non-root runtime image that serves everything from one process on port 8080 (`WEB_DIST=/app/web`, `ENGINE_DIST=/app/engine`, data and SQLite in the `/data` volume).

```sh
# from the repo root
JWT_SECRET=$(openssl rand -hex 32) PUBLIC_ORIGIN=http://localhost:8080 docker compose up --build
# or without compose
docker build -t webgame-app .
docker run -p 8080:8080 -e JWT_SECRET=... -e PUBLIC_ORIGIN=https://arcade.example.com -v webgame-data:/data webgame-app
```

`docker-compose.yml` requires `JWT_SECRET` and passes through `PUBLIC_ORIGIN`, `ADMIN_USERNAMES`, `TRUST_PROXY` and `RATE_LIMIT`. CI (`.github/workflows/ci.yml`) runs the node build + engine/ui tests, backend fmt/clippy/test, a Docker image build (no push), and a Windows desktop `cargo build`.

## Seed demo data

```sh
cargo run -- seed path/to/game1.zip path/to/game2.zip
cargo run -- seed --dir ../examples/dist          # every *.zip in a folder
```

This creates the user `demo` / `demo12345` (if it doesn't already exist) and uploads each bundle as a published game tagged `demo`. Invalid bundles are skipped and a warning is printed.

## Test & lint

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

`tests/api.rs` covers v1, `tests/v2.rs` the v2 additions (favorites, achievements, saves, stats, reports/admin, rate limits, `/play/studio`).

The integration tests in `tests/` drive `webgame_server::app(state)` with `tower::ServiceExt::oneshot`. Each test gets its own temporary SQLite DB and data dir, and builds its zip bundles in code.

## Layout

```
src/main.rs        CLI: serve | seed | healthcheck
src/lib.rs         AppState, app(state) -> Router
src/config.rs      env config
src/db.rs          pool + migrations
src/error.rs       AppError -> {error:{code,message}}
src/extract.rs     Json/Query/Path/Multipart wrappers mapping rejections to AppError
src/auth.rs        argon2, JWT, AuthUser / MaybeAuthUser extractors
src/models.rs      camelCase DTOs + row mapping
src/bundle.rs      zip validation & extraction
src/storage.rs     data dir layout, image sniffing
src/seed.rs        demo seeding
src/ratelimit.rs   token buckets, play dedupe, client IP extractor
src/locks.rs       per-game bundle-replace claims
src/routes/        auth, users, games, comments, scores, tags, play, files,
                   favorites, achievements, saves, stats, reports (+ admin)
```

## Behaviour notes

- **Bundles**: the upload must be at most 50MB compressed and 200MB uncompressed, with at most 2000 files. Absolute paths, `..`, symlinks and encrypted entries are rejected, as are extensions outside the allowlist. A single top-level folder is stripped. `__MACOSX/`, `.DS_Store` and `Thumbs.db` are ignored. Each upload is extracted to a unique staging dir, then moved to `v{n}`. The previous version dir is deleted only after the DB update succeeds (see R1 below).
- **Sorting**: `top` orders by `(rating_sum + 3·2) / (rating_count + 2)` (a Bayesian average with prior 3.0 and weight 2), then by rating count, then by newest.
- **Search**: `q` matches with a case-insensitive `LIKE` on title, description and tags. `%` and `_` in the query are escaped.
- **Tokens**: JWTs carry a `scope` claim. Session tokens (`scope: "session"`, from register/login) are the only ones `AuthUser`/`MaybeAuthUser` accept on `/api`. `POST /api/games/{id}/preview-token` (owner only) mints `{scope: "preview", gid, sub}` valid for 10 minutes. It is accepted **only** by `/play/{id}?token=` for an unpublished game, and only when `gid` matches the id and `sub` is the owner. Session tokens are rejected there, so the owner's real JWT never enters the untrusted iframe. Tokens without a `scope` (from before this change) are rejected, so you have to log in again.
- **Player page**: the origin is `PUBLIC_ORIGIN` when set. Otherwise it comes from `Host` plus `X-Forwarded-Proto` (`http` by default), and a client-controlled `Host` decides which origin the page imports from, so set `PUBLIC_ORIGIN` in production. Behind the web dev server proxy (`Host: localhost:5173`), the player loads the engine and game files through the proxy, which is intended. Values are escaped for a JS string inside `<script>`. The page's CSP includes `sandbox allow-scripts allow-pointer-lock`, so game code keeps an opaque origin even if someone opens the page top-level.
- **Game files**: served with `Cache-Control: no-cache`, `nosniff` and `Content-Security-Policy: sandbox`. Files are also served for unpublished games, because the owner-preview iframe has no credentials to send.

## v2 notes

- **Roles**: `User.role` is `"user"` or `"admin"`, driven only by `ADMIN_USERNAMES`. `/api/admin/*` returns 401 without a token and 403 for non-admins.
- **Achievements**: definitions come from `achievements` in game.json (max 50; id `^[a-z0-9_-]{1,32}$`, unique; name 1-60 chars after trimming; description up to 200 and optional; icon optional, must be a png/jpg/jpeg/webp/gif/svg path that exists in the bundle). They're stored per game and synced on every upload. On a bundle replace, unlocks of ids that still exist are kept and unlocks of removed ids are deleted. `iconUrl` is `/games/{id}/files/{icon}` (percent-encoded).
- **User achievements** (`GET /api/users/{username}/achievements`) list unlocks on published games only, plus games the viewer owns.
- **Saves**: `data` must be a JSON object (anything else → 422). The size limit (256KB) applies to its compact serialization (→ 413). Key order is not preserved.
- **Plays/stats**: each `POST /play` also inserts a `play_events` row (UTC day, user id when authed). `daily` always has 30 entries ending today (UTC), oldest first, zero-filled. Totals `plays` use the game counters, which include plays from before v2.
- **Reports**: `targetPreview` is captured when the report is created, so it survives deletion of the target. Resolving an already-resolved report → 409. `unpublish` on a comment report → 422. Resolving applies the action, then resolves every open report on the same target with the same resolution. Acting on a target that's already gone is a no-op.
- **Rate limits**: buckets are keyed `user:{id}` (authed endpoints) or `ip:{addr}` (login/register). Every attempt counts, including failed ones. `Retry-After` is the number of seconds until one token is available.
- **Studio player** (`/play/studio`): same headers/CSP as `/play/{id}`. Errors are posted as `{type:"webgame:error", message, file?, line?, column?}`. Only the first `webgame:studio-load` is accepted; reload the iframe to run again.

## Review-fix notes (REVIEW-2026-11-14-1)

- **Bundle replace (R1)**: replaces are serialised per game by an in-process claim. A replace that finds another one running for the same game, or whose game version changed after the request read it, gets `409 conflict` and leaves the live files alone. The upload is extracted to a unique `.staging-{uuid}` dir and moved to `v{n+1}` only by the claim holder. The old `v{n}` is deleted only after the DB commit. (Single process only. Running several server processes on one `DATA_DIR` is not supported.)
- **Plays (R2)**: `POST /api/games/{id}/play` is rate limited at 30/min per user (when authed) or per IP (anonymous), giving `429 rate_limited` + `Retry-After`. At most one play per (game, viewer) is counted per 10 minutes, where the viewer is `user:{id}` or `ip:{addr}`. A deduplicated call still returns `200 {"plays": <current count>}`, but it neither bumps `games.plays` nor writes a `play_events` row. The dedupe window is in memory, so it resets on restart. The rate limit follows `RATE_LIMIT`. The dedupe always applies.
- **Studio modules (R3)**: `/play/studio` links every JS module reachable from the entry. Relative specifiers (`./`, `../`) in `import … from`, `export … from`, `import "…"` and `import("…")` with string literals are rewritten to blob URLs, dependencies first. Cycles, missing or non-JS targets and paths escaping the project give `webgame:error` with `file` set to the importing file. Load errors map blob URLs back to `file`. Rewriting is regex based, so an import-like string inside a comment or a string literal is rewritten too.
- **Shutdown (R5)**: the server drains on Ctrl+C and, on Unix, SIGTERM. Before listening, `serve` deletes `games/*/.staging-*` and game dirs that have no DB row, which an interrupted upload or create leaves behind.
- **Game/runtime files (R6)**: these are streamed, not buffered. Each response has a strong `ETag` (`"v{version}-{size}-{mtimeNs}"` for game files, `"rt-{size}-{mtimeNs}"` for `/runtime`). `If-None-Match` (`*`, lists and `W/` all accepted) gives `304` with the same `ETag`/CSP/`nosniff`/CORS headers. `Cache-Control: no-cache` stays, so clients revalidate on every load.
- **Listing indices (R7)**: migration `0004_perf_indices.sql` adds a trigger-maintained `games.favorites_count` and a generated `games.rating_score`, plus listing indices that end in `id`. `new`, `popular`, `top`, `favorites`, `owner=<name>` and `owner=me` are now index-ordered with no temp B-tree. `tag=` is driven from `game_tags(tag, game_id)` and only sorts that tag's games. The `COUNT(*)` is skipped when the page already shows the total. `q=` is still a `LIKE` scan over the filtered rows.
- **Bundles (R8)**: a path that is both a file and a folder (`x` and `x/y`, case-insensitive) is rejected with `422`.
- **Profile (R12)**: `GET /api/users/{username}?page=&perPage=` (default 24, max 100, `400` on non-integers) returns one page of `games`, newest first, plus `gamesTotal`.
- **Score retention (R12)**: after each submit, that user's scores for the game are pruned. A score is kept if it is in the user's best 20, or if it is less than 8 days old and the best of its UTC day or ISO week. All-time, today's and this week's bests always survive, so every leaderboard window is unchanged.
- **Health (R13)**: `webgame-server healthcheck` GETs `http://127.0.0.1:$PORT/api/health` and exits 0 on `200`. The Docker `HEALTHCHECK` uses it. MSRV is 1.89 (`rust-version`).

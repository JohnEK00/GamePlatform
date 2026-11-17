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

Startup tasks (`serve`), in order:
- apply `ADMIN_USERNAMES` roles and refresh the F003 trending snapshot;
- sweep stale upload/staging dirs, orphan game dirs and orphan screenshot files (F005);
- **F009 controls backfill** (`src/controls_backfill.rs`, spawned in the background): games whose `actions_json` is still `NULL` (stored before `0010_f009.sql`) get `actions_json` / `controls_hint` from their current `game.json`, in batches of 200. A stored `actions` that fails the strict rules becomes `[]` (logged at `info`), a missing or > 1 MiB file becomes `[]` / `""`. Idempotent and version-guarded; failures are logged and retried at the next start. Until a row is processed it reports `actions: []`, `controlsHint: ""`;
- the periodic trending/`PRAGMA optimize` maintenance task.

`/runtime/engine.js` is served from `ENGINE_DIST`. Build the engine first with `npm run build:engine` from the repo root. Until you do, that route returns 503 with a message telling you how to fix it.

## Environment

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `DATABASE_URL` | `sqlite://data/webgame.db?mode=rwc` | |
| `DATA_DIR` | `data` | `games/{id}/v{version}/…`, `thumbnails/`, `avatars/` |
| `JWT_SECRET` | random per process (logs a warning) | **set in production**. When unset, a random 256-bit secret is generated at every start, so sessions, preview tokens and anonymous play-dedup keys do not survive a restart (everyone has to log in again). There is no fixed fallback secret. Use a long random value, e.g. `openssl rand -hex 32` |
| `ENGINE_DIST` | `../packages/engine/dist` | must contain `engine.js` |
| `WEB_DIST` | unset | if set, serves the SPA: any GET not matched by a backend route falls back to `index.html`, including `/games/{id}` and `/games/{id}/edit` (only `/games/{id}/files/*` is backend-owned under `/games`) |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:1420,http://tauri.localhost,tauri://localhost` | applies to `/api/*` only; hosting routes use `*` |
| `PUBLIC_ORIGIN` | unset (logs a warning) | e.g. `https://arcade.example.com`; **recommended in production**. When set, `/play` uses it as `{ORIGIN}` (import URLs and CSP) and ignores `Host`/`X-Forwarded-Proto`. Must be `http(s)://host[:port]` with no path, query, fragment or user info; one trailing slash is stripped. An invalid value stops the server at startup with an error |
| `ADMIN_USERNAMES` | unset | comma list, case-insensitive. Applied at startup (listed users become `admin`, everyone else `user`) and on register. **A listed username that is not registered yet becomes admin for whoever registers it first**: register the admin accounts before listing them, and list only existing accounts |
| `RATE_LIMIT` | on | `off` / `0` / `false` disables the in-memory token buckets (tests run with it off) |
| `TRUST_PROXY` | off | number of trusted reverse-proxy hops in front of the server (`true` = 1, `off`/`0` = none; other values stop startup with an error). With `n` hops the client IP for rate limiting is the `n`-th `X-Forwarded-For` entry counted from the right (entries further left are client-controlled and ignored); if the header has fewer than `n` entries the connection address is used. `X-Real-IP` is used only when there is no `X-Forwarded-For`. Leave off unless every request passes through a proxy that appends to `X-Forwarded-For`, otherwise clients can spoof it |
| `TRENDING_TTL_SECS` | `600` | non-negative integer (anything else stops startup with an error). The trending snapshot (`sort=trending`, `/related`) is refreshed at startup and then by a background task every TTL seconds, which also runs `PRAGMA optimize`; requests only read the snapshot. A failed refresh keeps the old snapshot and is retried after `min(TTL, 60s)`. `0` disables the background task: every `sort=trending` / `/related` read refreshes inline first (skipped for 60 s after a failure). Meant for tests and development |
| `NOTIFICATION_POLL_SECS` | `60` | F007: integer 15-600 (anything else stops startup with an error), returned as `pollAfterSecs` by `GET /api/notifications/unread-count`. Notification pruning (API.md § F007 retention) runs at most hourly inside the `TRENDING_TTL_SECS` maintenance task, so it does not run when that is `0` |
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
                   favorites, achievements, saves, controls, stats, reports (+ admin)
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
- **Control bindings (F016)**: `GET`/`PUT 🔒 /api/games/{id}/controls` (`src/routes/controls.rs`, table `control_bindings` from `0020_f016.sql`) store one `ControlBindings` (`{keys, gamepad}`) per user per game. Visibility follows the cloud-save rule (unpublished → 404 unless owner). `PUT` validates strictly against the F009 tables in `src/bundle.rs` (first violation → 422 naming the path, e.g. `bindings.gamepad.jump[0] "Home" can't be bound`), then normalises against the game's current actions (undeclared ids and entries equal to the defaults dropped, manifest order) before storing; `GET` re-applies the normalisation, so a bundle replace filters stale entries without rewriting rows. An empty result is still a row (`{"keys":{},"gamepad":{}}`). Bodies over 16 KiB → 413. Rows cascade on game and user deletion. `tests/f016.rs` covers it.
- **Saves**: `data` must be a JSON object (anything else → 422). The size limit (256KB) applies to its compact serialization (→ 413). Key order is not preserved.
- **Plays/stats**: each `POST /play` also inserts a `play_events` row (UTC day, user id when authed). `daily` always has 30 entries ending today (UTC), oldest first, zero-filled. Totals `plays` use the game counters, which include plays from before v2.
- **Reports**: `targetPreview` is captured when the report is created, so it survives deletion of the target. Resolving an already-resolved report → 409. `unpublish` on a comment report → 422. Resolving applies the action, then resolves every open report on the same target with the same resolution. Acting on a target that's already gone is a no-op.
- **Rate limits**: in-memory token buckets (`src/ratelimit.rs`), keyed `user:{id}` (signed-in endpoints) or `ip:{addr}` (login/register, and anonymous callers of the public reads). Every attempt counts, including failed ones. Over the limit → `429 rate_limited` with `Retry-After` (seconds until one token is available). All of them follow `RATE_LIMIT`.

  | Bucket | Endpoints | Quota | Key |
  |---|---|---|---|
  | Auth | `POST /api/auth/login`, `/register` | 10/min | IP |
  | Upload | `POST /api/games`, `PUT /api/games/{id}/bundle` | 20/hour | user |
  | Comment | `POST …/comments` | 30 per 10 min | user |
  | Report | `POST /api/reports` | 10/hour | user |
  | Score | `POST …/scores` | 60/min | user |
  | Save | `PUT …/save` | 60/min | user |
  | Controls | `PUT …/controls` (F016; `GET` is not limited) | 60/min | user |
  | Leaderboard | `GET …/leaderboard` | 120/min | user, else IP |
  | ScoreList | `GET …/scores` (own bucket) | 120/min | user, else IP |
  | Play | `POST …/play` | 30/min | user, else IP |
  | Follow | `PUT`/`DELETE /api/users/{username}/follow` (shared) | 60 per 10 min | user |
  | Feed | `GET /api/feed`, `/api/feed/suggestions` (shared) | 60/min | user |
  | VersionNotes | `PATCH …/versions/{version}` | 30 per 10 min | user |
  | BundleDownload | `GET …/bundle` | 30/hour | user |
  | Image | `PUT /api/games/{id}/thumbnail`, `PUT /api/users/me/avatar` (shared) | 20/hour | user |
  | Screenshot | `POST /api/games/{id}/screenshots` (own bucket, separate from Image) | 10/hour | user |
- **Studio player** (`/play/studio`): same headers/CSP as `/play/{id}`. Errors are posted as `{type:"webgame:error", message, file?, line?, column?}`. Only the first `webgame:studio-load` is accepted; reload the iframe to run again.

## Review-fix notes (REVIEW-2026-11-14-1)

- **Bundle replace (R1)**: replaces are serialised per game by an in-process claim. A replace that finds another one running for the same game, or whose game version changed after the request read it, gets `409 conflict` and leaves the live files alone. The upload is extracted to a unique `.staging-{uuid}` dir and moved to `v{n+1}` only by the claim holder. The old `v{n}` is deleted only after the DB commit. (Single process only. Running several server processes on one `DATA_DIR` is not supported.)
- **Plays (R2)**: `POST /api/games/{id}/play` is rate limited at 30/min per user (when authed) or per IP (anonymous), giving `429 rate_limited` + `Retry-After`. At most one play per (game, viewer) is counted per 10 minutes, where the viewer is `user:{id}` or `ip:{addr}`. A deduplicated call still returns `200 {"plays": <current count>}`, but it neither bumps `games.plays` nor writes a `play_events` row. The dedupe window is in memory, so it resets on restart. The rate limit follows `RATE_LIMIT`. The dedupe always applies.
- **Studio modules (R3)**: `/play/studio` links every JS module reachable from the entry. Relative specifiers (`./`, `../`) in `import … from`, `export … from`, `import "…"` and `import("…")` with string literals are rewritten to blob URLs, dependencies first. Cycles, missing or non-JS targets and paths escaping the project give `webgame:error` with `file` set to the importing file. Load errors map blob URLs back to `file`. Import-like text inside comments, string/template literal text and regex literals is ignored (a small tokenizer masks those first; see N9 below).
- **Shutdown (R5)**: the server drains on Ctrl+C and, on Unix, SIGTERM. Before listening, `serve` deletes `games/*/.staging-*` and game dirs that have no DB row, which an interrupted upload or create leaves behind.
- **Game/runtime files (R6)**: these are streamed, not buffered. Each response has a strong `ETag` (`"v{version}-{size}-{mtimeNs}"` for game files, `"rt-{size}-{mtimeNs}"` for `/runtime`). `If-None-Match` (`*`, lists and `W/` all accepted) gives `304` with the same `ETag`/CSP/`nosniff`/CORS headers. `Cache-Control: no-cache` stays, so clients revalidate on every load.
- **Listing indices (R7)**: migration `0004_perf_indices.sql` adds a trigger-maintained `games.favorites_count` and a generated `games.rating_score`, plus listing indices that end in `id`. `new`, `popular`, `top`, `favorites`, `owner=<name>` and `owner=me` are now index-ordered with no temp B-tree. `tag=` is driven from `game_tags(tag, game_id)` and only sorts that tag's games. The `COUNT(*)` is skipped when the page already shows the total. `q=` is still a `LIKE` scan over the filtered rows.
- **Bundles (R8)**: a path that is both a file and a folder (`x` and `x/y`, case-insensitive) is rejected with `422`.
- **Profile (R12)**: `GET /api/users/{username}?page=&perPage=` (default 24, max 100, `400` on non-integers) returns one page of `games`, newest first, plus `gamesTotal`.
- **Score retention (R12)**: after each submit, that user's scores for the game are pruned. A score is kept if it is in the user's best 20, or if it is less than 8 days old and the best of its UTC day or ISO week. All-time, today's and this week's bests always survive, so every leaderboard window is unchanged.
- **Health (R13)**: `webgame-server healthcheck` GETs `http://127.0.0.1:$PORT/api/health` and exits 0 on `200`. The Docker `HEALTHCHECK` uses it. MSRV is 1.89 (`rust-version`).

## Review-fix notes (REVIEW-2026-11-14-2)

- **Feed (N1)**: `GET /api/feed` is a `UNION` of two index-driven branches (followed creators via `idx_activity_actor_id`; favorited games' publish/update events via `idx_favorites_user_game` + `idx_activity_game_kind`), each `ORDER BY id DESC LIMIT n+1` with all filters inside, then merged. `CROSS JOIN` / `INDEXED BY` pin the plan, so it never depends on statistics; `tests/review2.rs` asserts it. `PRAGMA optimize=0x10002` runs after migrations, and `PRAGMA optimize` on the trending cadence.
- **Leaderboards (N2)**: migration `0008_review2.sql` adds `score_bests` (one row per game, period `all`/`day`/`week`, period start and user), kept in sync by triggers on `scores` insert/delete and on `games.score_order` changes, and backfilled from the retained scores. Boards are `LIMIT n` index walks; ranks and totals are index counts. Results are identical to the old window-function query. `GET …/scores` is rate limited (ScoreList, 120/min).
- **Trending (N3)**: refreshed off the request path (see `TRENDING_TTL_SECS`). The `viewer_key` purge runs in its own short transaction through the partial index `idx_play_events_viewer_key_day`, so it only touches rows that still hold a key.
- **Images (N5)**: thumbnail and avatar uploads share the Image bucket (20/hour per user).
- **Screenshots (F005)**: `GET/POST /api/games/{id}/screenshots`, `DELETE /api/screenshots/{id}`. Uploads are decoded and re-encoded (`src/screenshots.rs`, `image` crate, png/jpeg/webp only): PNG stays PNG, JPEG/WebP become JPEG q90, alpha is flattened on black, no metadata is kept, plus a JPEG q80 thumbnail that fits 480×480. At most 2 decodes run at once (`503` + `Retry-After: 5`), 20 screenshots per user per game. Files live in `data/screenshots/{id}.{png|jpg}` + `{id}_t.jpg`, served at `/media/screenshots/` with `Cache-Control: public, max-age=3600` (no `immutable`, so a moderation delete reaches caches within an hour; 404s are `no-store`), `nosniff` and `CSP: sandbox`. Memory: each decode is budgeted at 80 MiB of pixel + decoder buffers, estimated from the header before decoding (16-bit 4096² PNGs, large progressive JPEGs etc. are refused with 422); with 2 slots that is ~160 MiB plus encoded outputs. A 503 (slots busy) or a server-side 5xx failure (decode task, file write, database) refunds the screenshot rate-limit token; a 422 (invalid, undecodable or over-budget image) stays charged. Reports carry `targetImageFullUrl` (the full image) next to `targetImageUrl` (the thumbnail). Migration `0009_f005.sql` rebuilds `reports` to allow `targetType: "screenshot"` (rows and indices preserved). `tests/f005.rs` covers it.
- **Notifications write path (F007, review 4)**: every notification write runs in its own `BEGIN IMMEDIATE` transaction with the dedupe folded into the upsert, so concurrent WAL writers can't make it fail with a stale snapshot. Un-heart / unfollow tombstones the event (`notification_events.retracted_at`); a re-heart / re-follow restores it without bumping `updated_at`, so toggling never re-notifies. `gamePublished` is queued in `notification_fanouts` inside the first-publish transaction and fanned out in the background (`AppState.fan_out`, chunks of 500 followers per transaction, each committing its cursor; retried up to 5 times, resumed at startup and by the maintenance task). A notification is deleted by trigger when its last event goes; pruning reads candidate ids first and deletes them in batches of 500 (per recipient for the 200 cap). Migration `0014_review4.sql`; `tests/review4.rs` covers it.
- **Review 3**: migration `0011_review3.sql` (L4): a `leaderboard.order` change only marks the game in `score_bests_stale`; boards of a stale game are computed from `scores` (`src/bests.rs` fallback) until a background rebuild (batches of 250 users, one short transaction each; restarted if the order flips again) clears the mark. The rebuild runs after the replace commits, at startup and on each maintenance tick. M2: the rate limiter takes an injectable `Clock` (`AppState::with_clock`); tests use a frozen `ManualClock` and advance it explicitly.
- **Studio linker (N9)**: see R3 above. A commented-out import of a missing file no longer fails the preview.
- **Bundle replace (N10)**: `published` is read inside the replace transaction (`UPDATE … RETURNING published`), so an unpublish that lands while an upload is in flight neither sets `last_updated_at` nor writes `gameUpdated`.

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
| Feature ideas, specs, contract additions | `product-planner` | `docs/ROADMAP.md`, `docs/features/**`, appended `## <feature id> additions` sections in docs |
| Whole-project review | `project-reviewer` | `docs/reviews/**` (read-only elsewhere) |

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
- **Dev ports**: backend `http://localhost:8080`, web dev server `http://localhost:5173` (proxies `/api`, `/play`, `/runtime`, `/media` and only `/games/{id}/files/*` to 8080; `/games/{id}` is an SPA route), Tauri dev server `http://localhost:1420`.
- **Production (web)**: backend serves `apps/web/dist` as the SPA (fallback to index.html) when `WEB_DIST` is set — a single process.

## Tech choices
- Engine: TypeScript, raw WebGL2 (no libs), Vite library build. TS 7 / Vite 8 are installed.
- UI: React 19, react-router-dom 7, plain CSS (CSS variables, dark theme default), no UI framework.
- Backend: Rust stable 1.96, axum, tokio, sqlx (sqlite, runtime-checked queries — NOT the compile-time `query!` macros), argon2, jsonwebtoken, zip, tower-http.
- Desktop: Tauri v2, reuses `@webgame/ui`.

## Dependency rule
JS dependencies are already installed from the repo root. Agents must NOT run `npm install` for new packages without the project manager's approval (parallel installs corrupt the shared `node_modules`). Rust crates are free to add in `backend/Cargo.toml` / `apps/desktop/src-tauri/Cargo.toml`.


## v2 features
- **Game Studio** (`/studio` route in @webgame/ui):
  - a textarea-based code editor with line numbers, a file list (text files editable, images importable), a game.json form and starter templates
  - a live preview in a sandboxed iframe at `{api}/play/studio` (Studio protocol in GAME_FORMAT.md)
  - **Publish** builds a zip client-side (a small store-only zip writer in @webgame/ui, no deps) and uses the normal upload API; **Export .zip** downloads it
  - hosts may provide `platform.openLocalProject?: () => Promise<StudioProject | null>`, with `StudioProject = { manifest: object; files: Record<string, string | ArrayBuffer> }`. The browser falls back to `<input webkitdirectory>`.
  - while mounted, the Studio page listens for a `window` CustomEvent named `webgame:studio-open-folder` and runs its normal "Open folder" flow, so hosts (e.g. a desktop menu) can trigger it after navigating to the Studio. The exported constant `STUDIO_OPEN_FOLDER_EVENT` holds the name. Hosts should dispatch it after the route has mounted; the Studio also checks `window.__webgameStudioOpenPending === true` on mount (and clears it) to handle the navigate-then-trigger race.
  - hosts may also provide `platform.saveFile?: (suggestedName: string, data: Blob) => Promise<boolean>` (true = saved, false = cancelled). The Studio's **Export .zip** uses it when present and otherwise falls back to an `<a download>` link.
- **Desktop extras**: native menu, F11 fullscreen, and "Open local game folder…", which reads the folder in Rust (same limits and validation as uploads) and opens it in the Studio via `openLocalProject`.
- **Ops**: a multi-stage `Dockerfile` (node builds engine/ui/web → cargo build → slim runtime serving WEB_DIST), `docker-compose.yml`, and `.github/workflows/ci.yml`. backend-dev owns these three files.


## F001 additions
Leaderboards 2.0 (spec: `docs/features/F001-leaderboards-2.md`).
- **First request/reply pair in the game protocol.** Until now, game → parent messages were fire-and-forget. `webgame:leaderboard-get` / `webgame:leaderboard` and `webgame:score{requestId}` / `webgame:score-result` are correlated by `requestId`. The engine keeps a pending-request map with timeouts (5s for leaderboards, 8s for scores) and a cap of 4 pending leaderboard requests. Later features that need replies should reuse this pattern: `requestId`, a timeout that resolves `null`, and replies carrying `error`.
- **Security model, extended.** The sandboxed game may now *read* platform data, but only through the parent, and only as a sanitised view (display names, ranks, scores, formatted strings, `isMe`). The parent never forwards raw API objects, user ids, avatar URLs or tokens into the iframe. Flooding is bounded at three layers: the engine pending cap, a 10s parent cache per `(period, limit)` with single flight, and a backend `Limit::Leaderboard` of 120/min.
- **Data**:
  - Migration `backend/migrations/0003_f001.sql` adds `games.score_order` (`desc`|`asc`), `games.score_format` (`number`|`time`) and `games.score_label`, plus an index `scores(game_id, created_at)`.
  - Period windows (UTC day, ISO week) are computed per request by comparing RFC3339-millis `Z` strings, so there are no stored period tables or background jobs.
- **UI**:
  - `formatScore(score, format)` in `@webgame/ui` is the single formatter for the leaderboard panel, toasts and the sanitised in-game views.
  - The Studio's game.json form and templates know the `leaderboard` block.
  - The desktop app inherits everything through `@webgame/ui`, with no desktop-specific code.


## F002 additions
Follow creators and an activity feed (spec: `docs/features/F002-follow-and-feed.md`).
- **Fan-out on read.** Actions append rows to a single `activity_events` table. `GET /api/feed` selects the events whose actor the viewer follows, plus publish/update events of games the viewer favorited, filtered by current visibility at read time. There are no per-follower inbox tables. The 2000-follow cap limits the follow list. Since review round 2 (N1) the query is two index-driven branches (followed creators; favorited games), so its cost grows with the activity of what the viewer follows and favorites, not with total platform activity. **Backfill caveat (N11):** 0005 sets `first_published_at` for currently-published games only, so a game that was unpublished before F002 emits one `gamePublished` item when next published; 0007 creates version rows only for each game's current version (empty notes), so older history starts at the migration.
- **Write path.** Events are written by a new `backend/src/activity.rs` module, called from the existing handlers (game create/publish/bundle replace, F001 score submit, achievement unlock) after the main write succeeds. Event writes are best effort: they log on failure and never fail the request. Coalescing (delete + re-insert) keeps one row per game per 24h for updates, and one per actor/game/UTC day for personal bests and achievement unlocks.
- **Data**: migration `backend/migrations/0005_f002.sql` (runs after F001's `0003` and `0004_perf_indices.sql`):
  ```sql
  CREATE TABLE follows (
      follower_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (follower_id, followee_id),
      CHECK (follower_id <> followee_id)
  );
  CREATE INDEX idx_follows_followee_created ON follows(followee_id, created_at DESC);
  CREATE INDEX idx_follows_follower_created ON follows(follower_id, created_at DESC);

  ALTER TABLE games ADD COLUMN first_published_at TEXT;   -- NULL until first published; gamePublished fires once
  UPDATE games SET first_published_at = created_at WHERE published = 1;

  CREATE TABLE activity_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,      -- feed cursor
      actor_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('gamePublished','gameUpdated','personalBest','achievementUnlocked')),
      game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      version     INTEGER,                                -- gamePublished / gameUpdated
      score       INTEGER,                                -- personalBest
      first_score INTEGER NOT NULL DEFAULT 0,             -- personalBest: 1 = actor's first score on the game
      ach_id      TEXT,                                   -- achievementUnlocked (latest); no FK, filtered by join at read time
      ach_count   INTEGER NOT NULL DEFAULT 0,             -- achievementUnlocked: unlocks that day
      day         TEXT NOT NULL,                          -- YYYY-MM-DD UTC of created_at (coalescing key)
      created_at  TEXT NOT NULL                           -- RFC3339 millis Z
  );
  CREATE INDEX idx_activity_actor_id  ON activity_events(actor_id, id DESC);
  CREATE INDEX idx_activity_game_kind ON activity_events(game_id, kind, id DESC);
  CREATE INDEX idx_activity_coalesce  ON activity_events(actor_id, game_id, kind, day);

  -- Backfill: one gamePublished per currently published game, oldest first (ids follow created_at).
  INSERT INTO activity_events (actor_id, kind, game_id, version, day, created_at)
  SELECT owner_id, 'gamePublished', id, version, substr(created_at, 1, 10), created_at
  FROM games WHERE published = 1 ORDER BY created_at;
  ```
- **Feed query** (normative shape; `?1` is the viewer id, `?2` the cursor or NULL, `?3` limit + 1, plus an optional `kind IN (…)` filter):
  ```sql
  SELECT e.* FROM activity_events e
  JOIN games g ON g.id = e.game_id
  LEFT JOIN achievements a ON a.game_id = e.game_id AND a.ach_id = e.ach_id
  WHERE (e.actor_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1)
         OR (e.kind IN ('gamePublished','gameUpdated')
             AND e.game_id IN (SELECT game_id FROM favorites WHERE user_id = ?1)))
    AND e.actor_id <> ?1
    AND g.published = 1
    AND (e.kind <> 'achievementUnlocked' OR a.ach_id IS NOT NULL)
    AND (?2 IS NULL OR e.id < ?2)
  ORDER BY e.id DESC LIMIT ?3
  ```
  Games, actors and achievement definitions for the page are then loaded in batched queries, not one per row.
- **UI**: `FollowProvider` (follow-state cache, same pattern as `FavoritesProvider`) is mounted in `WebGameApp`. New routes are `/feed` (auth), `/u/:username/followers` and `/u/:username/following`. Feed items reuse F001's `formatScore`.
- **Desktop**: the native menu forwards a new `"feed"` id (View → Feed, `CmdOrCtrl+Shift+F`) to the webview, which navigates to `/feed`. There is no other desktop-specific code.
- **Ownership**: unchanged. `activity.rs`, `routes/follows.rs` and `routes/feed.rs` belong to backend-dev.


## F003 additions
Trending and "More like this" discovery (spec: `docs/features/F003-trending-and-related.md`).
- **A snapshot, refreshed lazily.**
  - Trending is computed from `play_events` into a small `game_trending` table, with one row per game that has plays in the window.
  - The new `backend/src/trending.rs` refreshes it once at startup, and again when a `sort=trending` or `/related` read finds it older than `TRENDING_TTL_SECS` (600s).
  - Refreshes are single flight: concurrent readers wait for the running refresh, then re-check its age.
  - A failed refresh is logged, and the stale snapshot is served.
  - There is no background task, consistent with F001/F002.
  - `GAME_SELECT` reads `plays_week` from the snapshot by primary key, so every `GameSummary` carries `playsWeek`.
- **Play identity.**
  - Counted plays now store `play_events.viewer_key`. These are the plays that pass the review-fix `PlayDedupe` and `Limit::Play`; deduplicated plays write no row (the R2 behaviour).
  - The key is `u:<userId>` when signed in. Otherwise it is `a:` plus the first 16 hex chars of `SHA-256(JWT_SECRET + "|play|" + clientIp)`, with the same client IP and `TRUST_PROXY` handling as the dedupe.
  - The trending score counts distinct `viewer_key`s per game per UTC day.
  - Each refresh nulls keys older than the window, so stored IP hashes live for about 8 days at most.
- **Data**: migration `backend/migrations/0006_f003.sql` runs after `0004_perf_indices.sql` and F002's `0005_f002.sql`:
  ```sql
  ALTER TABLE play_events ADD COLUMN viewer_key TEXT;    -- NULL for rows before F003 and after the purge
  CREATE INDEX idx_play_events_day_game ON play_events(day, game_id);

  CREATE TABLE game_trending (
      game_id      TEXT PRIMARY KEY NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      plays_week   INTEGER NOT NULL,                     -- counted non-owner plays in the window
      score        REAL NOT NULL,                        -- trendingScore (API.md § F003)
      computed_at  TEXT NOT NULL                         -- RFC3339 millis Z of the refresh
  );
  CREATE INDEX idx_game_trending_score ON game_trending(score DESC);
  ```
- **Refresh SQL** (normative shape, run in one transaction). Binds: `?1` = the window's first day as `YYYY-MM-DD` (today − 6), `?2` = today, `?3` = now as RFC3339.
  ```sql
  DELETE FROM game_trending;
  INSERT INTO game_trending (game_id, plays_week, score, computed_at)
  SELECT d.game_id, SUM(d.plays),
         SUM(d.viewers * (7.0 - (julianday(?2) - julianday(d.day))) / 7.0), ?3
  FROM (
      SELECT e.game_id, e.day, COUNT(*) AS plays,
             COUNT(DISTINCT COALESCE(e.viewer_key, 'row:' || e.id)) AS viewers
      FROM play_events e JOIN games g ON g.id = e.game_id
      WHERE e.day >= ?1 AND e.day <= ?2
        AND (e.user_id IS NULL OR e.user_id <> g.owner_id)
      GROUP BY e.game_id, e.day
  ) d
  GROUP BY d.game_id;
  UPDATE play_events SET viewer_key = NULL WHERE day < ?1 AND viewer_key IS NOT NULL;
  ```
- **Related query.**
  1. Rust loads the source's tags (at most 8) and their published-game counts `n(tag)`, and computes `weight = 1 / log2(2 + n)` itself. SQLite math functions are not assumed.
  2. The weights are bound into the candidate query, one `WHEN ?tag THEN ?weight` pair per source tag:
     ```sql
     SELECT t.game_id,
            SUM(CASE t.tag WHEN ?t1 THEN ?w1 /* … one pair per source tag */ ELSE 0 END) AS tag_score,
            COUNT(*) AS shared,
            group_concat(t.tag, ',') AS shared_tags,
            MAX(g.owner_id) AS owner_id
     FROM game_tags t
     JOIN games g ON g.id = t.game_id
     LEFT JOIN game_trending tr ON tr.game_id = g.id
     WHERE t.tag IN (?t1 /* , … */) AND t.game_id <> ?src AND g.published = 1
     GROUP BY t.game_id
     ORDER BY tag_score DESC, shared DESC, COALESCE(MAX(tr.score), 0) DESC,
              MAX(g.plays) DESC, MAX(g.created_at) DESC, t.game_id
     LIMIT 100
     ```
  3. Rust applies the per-owner cap (2) in rank order, and fills from the trending order if the list is short.
  4. It then loads the summaries in one `GAME_SELECT … WHERE g.id IN (…)` query and keeps the computed order.
- **UI**:
  - `GameCard` gains `highlight?: "trending" | "related"`, which shows a weekly-plays line or the shared tags.
  - A new `RelatedGames` component sits at the bottom of `GamePage`, and a `TrendingShelf` sits on the home page.
  - The desktop app inherits all of this through `@webgame/ui`.
- **Ownership**: `trending.rs` and the `/related` handler belong to backend-dev. `RelatedGames.tsx` belongs to frontend-dev.


## F004 additions
Version changelogs and an "Updated" badge (spec: `docs/features/F004-version-changelogs.md`).
- **History is metadata only.** A new `game_versions` table stores one row per bundle version (number, notes, time). Bundle files for old versions are still deleted after a successful replace (R1), so history can't be used for rollback.
- **Write path, composed with R1.** `upload_bundle` keeps its order:
  1. Parse the multipart body (now also `notes` and `expectedVersion`, validated before any work).
  2. `bundle_locks.try_claim(id)`.
  3. Read the current version and compare it with both the loaded game and `expectedVersion` (409 on mismatch).
  4. Extract into staging, then rename to `v{new}`.
  5. One transaction: the guarded `UPDATE games … WHERE id = ? AND version = ?`, `sync_achievements`, **`INSERT game_versions`**, and when published **`UPDATE games SET last_updated_at`** plus the best-effort `activity::record_game_updated`.
  The history row and `last_updated_at` are part of the main write (a failure fails the request); only the activity event stays best effort.
- **Feed composition.** `record_game_updated` keeps F002's delete + insert coalescing but carries `from_version`: the minimum of the deleted rows' `COALESCE(from_version, version)` and the new version. `GET /api/feed` loads notes in one batched `game_versions` query for the page's `gameUpdated` game ids and slices `[from_version, version]` in Rust, so notes are always current.
- **Data**: migration `backend/migrations/0007_f004.sql` runs after F003's `0006_f003.sql`:
  ```sql
  CREATE TABLE game_versions (
      game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      version     INTEGER NOT NULL CHECK (version >= 1),
      notes       TEXT NOT NULL DEFAULT '',             -- plain text, <= 1000 chars (validated in Rust)
      created_at  TEXT NOT NULL,                        -- RFC3339 millis Z
      PRIMARY KEY (game_id, version)
  );

  ALTER TABLE games ADD COLUMN last_updated_at TEXT;   -- latest bundle replace while published; NULL if none
  ALTER TABLE activity_events ADD COLUMN from_version INTEGER;   -- gameUpdated: lowest covered version; NULL = version

  -- Backfill last_updated_at from F002's gameUpdated events (only published replaces produce them).
  UPDATE games SET last_updated_at = (
      SELECT MAX(e.created_at) FROM activity_events e
      WHERE e.game_id = games.id AND e.kind = 'gameUpdated'
  );

  -- Backfill: one row for each game's current version (no notes; date approximate).
  INSERT INTO game_versions (game_id, version, notes, created_at)
  SELECT id, version, '',
         CASE WHEN version = 1 THEN created_at
              ELSE COALESCE(last_updated_at, updated_at) END
  FROM games;
  ```
  No new index is needed. `/versions` and the feed lookup use the primary key `(game_id, version)`, and `GAME_SELECT` reads `last_updated_at` from the `games` row.
- **UI**:
  - `isRecentlyUpdated` / `UPDATED_BADGE_MS` in `util.ts` decide the card badge client-side (7 days).
  - New components: `VersionHistory` (the game page's "What's new" panel and history, with owner editing) and `ReleaseNotesField` (a shared textarea).
  - Notes are always rendered as text with `white-space: pre-wrap`.
  - The desktop app inherits everything through `@webgame/ui`.
- **Ownership**: `routes/versions.rs` (and the optional `versions.rs` notes helper) belong to backend-dev. `VersionHistory.tsx` and `ReleaseNotesField.tsx` belong to frontend-dev.

## F013 additions
Studio: publish updates to an existing game (spec: `docs/features/F013-studio-publish-updates.md`).
- **No migration.** F013 adds no tables or columns. Migration slot `0008` is not used by F013.
- **Backend export** (`backend/src/export.rs`, backend-dev):
  - `build_bundle_zip(dir, date)` walks `data/games/{id}/v{version}/` (regular files only; symlinks skipped). It writes a zip into memory, capped at 64 MiB, inside `spawn_blocking`, streaming each file into the writer. It uses the existing `zip` crate with the `deflate` feature: precompressed formats are stored, everything else deflated.
  - `GET /api/games/{id}/bundle` shares the `/games/{id}/bundle` route with `PUT`. Its order is: owner check → `Limit::BundleDownload` → `AppState.export_slots` (`tokio::sync::Semaphore`, 2 permits, `try_acquire`, else 503) → read the version → build → re-read the version (409 on change or vanished files).
  - It never takes `bundle_locks`.
  - The CORS layer exposes `X-Game-Version`, `Content-Disposition` and `Retry-After`.
- **UI zip reader** (`packages/ui/src/studio/unzip.ts`, frontend-dev): `readZip` is a central-directory reader for stored and deflate entries. It inflates with `DecompressionStream("deflate-raw")` (no dependencies), checks CRC-32 with the existing `crc32` from `zip.ts`, and enforces limits on actual inflated bytes (2000 entries, 200 MB). ZIP64, encryption and other methods are rejected.
  - `project.ts` gains `projectFromZip`, and both it and `projectFromFileList` go through a shared `projectFromEntries`, so folder and zip imports follow the same rules (strip a top-level folder only when it holds `game.json`).
  - The backend's own zip writer and this reader are independent implementations. The round-trip tests (backend `f013.rs` and UI `unzip.test.ts`) keep them compatible.
- **Studio session model** (`StudioPage.tsx` with `studio/PublishDialog.tsx` and `studio/OpenGameDialog.tsx`):
  - `StudioLink = { gameId: string; title: string; version: number; apiBase: string }` records which game the project was downloaded from or last published to. A link whose `apiBase` differs from `WebGameConfig.apiBaseUrl` is ignored.
  - `dirty: boolean` records edits since the last load or publish, and gates a confirm before any project replace.
  - Both are kept next to `StudioProject` (not inside it, so the host contract is unchanged).
  - The localStorage autosave (`webgame.studio.project`, format `v: 1`) gains optional top-level `link` and `dirty`. Readers ignore a malformed `link`, and a missing `dirty` means `false`.
  - The `/studio?open={gameId}` route query opens one of your games: it downloads `GET /api/games/{id}/bundle` and loads it with the link set. The query is removed at once with a replace navigation. It works with both `BrowserRouter` and the desktop `HashRouter`.
  - "Publish → Update an existing game" calls `PUT /api/games/{id}/bundle` with F004 `notes` and `expectedVersion` (the version the dialog fetched), and requires an explicit confirmation when the link doesn't match the selected game's current version.
- **Platform contract** (`PlatformConfig` in `packages/ui/src/context/config.tsx`; all optional, so older hosts still conform):
  - `openLocalProject?: () => Promise<LocalProject | null>`, where `LocalProject = StudioProject & { localFolder?: { id: string; name: string } }`. `id` is an opaque, session-scoped handle; `name` is for display only.
  - `reloadLocalProject?: (folderId: string) => Promise<LocalProject | null>` re-reads a folder picked earlier in this session, with no dialog, the same limits and the same validation. It rejects with an `Error` whose message says the folder is no longer available when the id is unknown or the folder is gone. The Studio then hides "↻ Reload folder".
  - `localFolder` is never written to the autosave.
- **Desktop folder registry** (`apps/desktop/src-tauri/src/project.rs`, desktop-dev):
  - `ProjectFolders` maps random `folderId`s to the canonical roots the user picked in the native dialog. It is in memory only, holds at most 16 entries (LRU) and is lost on restart.
  - `pick_project_folder` returns `folderId` in its `ProjectIndex`. The new command `reload_project_folder(folderId)` returns a fresh `ProjectIndex` (new binary ticket, same `folderId`) through the existing `read_project_dir(…, Limits::UPLOAD)`.
  - The webview still never supplies or receives a filesystem path. The registry is the allowlist of folders it may re-read.
- **Ownership**: `export.rs` and the handler belong to backend-dev. `unzip.ts`, `PublishDialog.tsx` and `OpenGameDialog.tsx` belong to frontend-dev. The folder registry and `platform.ts` changes belong to desktop-dev.


## F005 additions
Screenshot capture and share (spec: `docs/features/F005-screenshots.md`).
- **Capture pipeline**:
  ```
  iframe (opaque origin)                                  parent (@webgame/ui)                      backend
  tick → game.render → scenes.render → flush
       → [capture point] drawImage(glCanvas → scratch 2D canvas, output size)
       → debug / pause overlays → endFrame
  scratch → toBlob(PNG) ── postMessage(webgame:screenshot, Blob ≤ 8 MiB) ──► validate source + id
                                                                           launder: createImageBitmap → canvas → PNG
                                                                           tray (memory, ≤ 12)
                                                                           user clicks Post ── multipart ──► validate_image → decode → re-encode
                                                                                                             data/screenshots/{id}.{png|jpg}, {id}_t.jpg
  ```
- **Why not `preserveDrawingBuffer: true`.** It makes the browser keep (copy) the drawing buffer on every frame instead of swapping or discarding it. That costs bandwidth all the time, mostly on tiled mobile GPUs, to serve a rare user action. The renderer keeps `preserveDrawingBuffer: false`.
  - The WebGL spec guarantees that the drawing buffer is readable until the frame is composited, that is, within the task that rendered it.
  - So captures are **queued** and done inside `tick` at a fixed capture point after the game's draw calls are flushed. They never run from a `message` handler between frames, which would read a cleared buffer.
- **Why `drawImage` and not `readPixels` (primary path).**
  - `ctx2d.drawImage(glCanvas, …)` copies GPU-side in most browsers and scales and flips in one step.
  - `gl.readPixels` needs a synchronous GPU→CPU stall, a `4·w·h` byte buffer at backing (DPR) size, a manual row flip and premultiplied-alpha handling.
  - `readPixels` is only the fallback when `drawImage` of a WebGL canvas throws.
  - The engine then encodes asynchronously (`OffscreenCanvas.convertToBlob` / `toBlob`) outside the frame.
- **No tainting.** WebGL refuses cross-origin images without CORS (and the engine already loads with CORS), so the game canvas can't be tainted. A `SecurityError` is still mapped to `failed`.
- **Trust boundaries.**
  - Parent: the Blob from the iframe is untrusted (bytes and `type`), and blob URLs inherit the parent's origin. The parent therefore always re-encodes ("launders") through `createImageBitmap` + canvas before it makes any object URL, download, clipboard write or upload.
  - Server: it trusts nothing from the client. It runs `validate_image` (size, magic bytes), checks the header dimensions, then decodes with `image` crate limits and re-encodes, which strips metadata and defeats polyglots.
- **Backend**:
  - `src/screenshots.rs` holds `process_screenshot` (run in `spawn_blocking`) and file helpers.
  - `src/routes/screenshots.rs` holds the three handlers.
  - `AppState.image_slots: Arc<Semaphore>` has 2 permits; `try_acquire` fails → 503.
  - `Limit::Screenshot` (10/hour per user) is checked after the visibility check and before the body is read, following the N5 `Limit::Image` pattern.
  - New dependency: `image` 0.25 (`png`, `jpeg`, `webp` features only).
- **Storage**: `data/screenshots/{id}.png|jpg` and `data/screenshots/{id}_t.jpg`, written with temp file + rename. They are served by `ServeDir` under `/media/screenshots` with immutable caching, `nosniff` and `CSP: sandbox`.
  - `remove_game` deletes the files of the game's screenshots after the row cascade.
  - `sweep_stale_files` removes screenshot files without a row and stray `.tmp` files at startup.
- **Data**: migration `backend/migrations/0009_f005.sql` runs after the review-fix `0008_review2.sql`:
  ```sql
  CREATE TABLE screenshots (
      id            TEXT PRIMARY KEY NOT NULL,
      game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      author_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      caption       TEXT NOT NULL DEFAULT '',            -- plain text, <= 140 chars (validated in Rust)
      ext           TEXT NOT NULL CHECK (ext IN ('png', 'jpg')),
      width         INTEGER NOT NULL CHECK (width BETWEEN 64 AND 4096),
      height        INTEGER NOT NULL CHECK (height BETWEEN 64 AND 4096),
      bytes         INTEGER NOT NULL,                    -- stored full-image size
      game_version  INTEGER NOT NULL,
      created_at    TEXT NOT NULL                        -- RFC3339 millis Z
  );
  CREATE INDEX idx_screenshots_game_created ON screenshots(game_id, created_at DESC, id);
  CREATE INDEX idx_screenshots_author_game  ON screenshots(author_id, game_id);

  -- Widen reports.target_type to include 'screenshot' (SQLite can't alter a CHECK: rebuild).
  -- No table references reports, so the rebuild is safe with foreign_keys on.
  CREATE TABLE reports_new (
      id              TEXT PRIMARY KEY NOT NULL,
      target_type     TEXT NOT NULL CHECK (target_type IN ('game', 'comment', 'screenshot')),
      target_id       TEXT NOT NULL,
      target_game_id  TEXT NOT NULL,
      target_preview  TEXT NOT NULL,
      reason          TEXT NOT NULL,
      details         TEXT NOT NULL DEFAULT '',
      reporter_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      resolution      TEXT,
      created_at      TEXT NOT NULL,
      resolved_at     TEXT
  );
  INSERT INTO reports_new SELECT id, target_type, target_id, target_game_id, target_preview, reason,
                                 details, reporter_id, status, resolution, created_at, resolved_at
  FROM reports;
  DROP TABLE reports;
  ALTER TABLE reports_new RENAME TO reports;
  CREATE INDEX idx_reports_status_created ON reports(status, created_at DESC);
  CREATE INDEX idx_reports_target         ON reports(target_type, target_id, status);
  CREATE INDEX idx_reports_reporter       ON reports(reporter_id, target_type, target_id, status);
  ```
  The gallery is an index walk on `idx_screenshots_game_created`. The per-user cap count uses `idx_screenshots_author_game`. The admin list joins `screenshots` by primary key for `targetImageUrl`.
- **UI**:
  - `src/screenshot.ts` holds `launderImage`, `fitImageForUpload`, `screenshotFileName` and the exported `PLAYER_SCREENSHOT_EVENT = "webgame:player-screenshot"`. Hosts dispatch it as a `window` CustomEvent to trigger a capture in the mounted `GamePlayer` or `StudioPreview`, with no navigation.
  - New components: `ScreenshotTray`, `ScreenshotDialog`, `ScreenshotGallery`. `GamePlayer` and `StudioPreview` share the capture hook `useScreenshotCapture`.
- **Desktop**:
  - View → Take Screenshot (`CmdOrCtrl+Shift+S`, forwarded id `"screenshot"`) dispatches `PLAYER_SCREENSHOT_EVENT`.
  - `save_file` suggests the OS Pictures folder for image names (then the session's last image folder). It still writes only to the path the user picked.
- **Ownership**:
  - `capture.ts` belongs to engine-dev.
  - `screenshots.rs` and `routes/screenshots.rs` belong to backend-dev.
  - `screenshot.ts` and the three components belong to frontend-dev.
  - The menu item and `save.rs` directory hint belong to desktop-dev.


## F009 additions
Controls overlay and key remapping (spec: `docs/features/F009-controls-and-remapping.md`).
- **Data flow**:
  ```
  game.json actions ── upload/replace ──► bundle.rs parse_actions (strict, 422) ──► games.actions_json
                                                                                     │
  GET /api/games/{id} ◄── Game.actions / controlsHint ◄──────────────────────────────┤
  /play/{id} HTML ◄── boot({ …, actions: <escaped JSON literal> }) ◄─────────────────┘
        │ engine: parseActions (lenient) → defaults
        ▼
  iframe (opaque origin) ◄── webgame:controls { overrides: { actionId: codes[] } } ── GamePlayer
                                                                                       ▲
                                    ControlsPanel ── writeOverrides ── localStorage webgame.controls.{gameId}
  ```
  Defaults travel with the page, so a game opened outside the app (no parent) still has its declared actions. Overrides travel by message, so a remap applies to the running game without a reload.
- **Overrides live on the device.** No server storage, no new endpoints. Rationale: bindings depend on the physical keyboard, so per-device is the right default. Account sync is a later item.
  - Key `webgame.controls.{gameId}`, value `{ "v": 1, "overrides": { [actionId]: string[] } }`, at most 4096 bytes serialised. On read, malformed JSON, `v !== 1`, a non-object `overrides` or an oversize value → `{}` and the key is removed.
  - Only actions whose keys differ from the defaults are stored. Ids that are no longer declared are pruned on the next write. An empty result removes the key.
  - Key `webgame.controls.hinted.{gameId}` = `"1"` marks the one-time first-play hint as shown.
  - The Studio keeps overrides in memory only.
- **Layout privacy.** The parent may call `navigator.keyboard.getLayoutMap()` (top-level only, Chromium/WebView2) for labels in its own UI. The map and labels are never posted into the iframe, so a sandboxed game can't read the player's keyboard layout. In-game labels come from the engine's US-layout table.
- **Three copies of the key tables.** The bindable key list, gamepad names and validation rules exist in `backend/src/bundle.rs` (strict), `packages/engine/src/actions.ts` (lenient parse, labels) and `packages/ui/src/controls.ts` (Studio validation, labels). GAME_FORMAT § F009 is the single normative source; each area's tests assert the list length (86 codes, 16 buttons) and spot values. A change to the table is a contract change in all three.
- **Pause reasons.** The engine has a single host pause flag. `GamePlayer` (and `StudioPreview`) keep a set of parent pause reasons (`visibility`, `controls`): `webgame:pause` when the set becomes non-empty, `webgame:resume` when it becomes empty.
- **Data**: migration `backend/migrations/0010_f009.sql` runs after F005's `0009_f005.sql`:
  ```sql
  ALTER TABLE games ADD COLUMN actions_json  TEXT;   -- normalised ControlAction[] as compact JSON; '[]' when none; NULL = not yet backfilled
  ALTER TABLE games ADD COLUMN controls_hint TEXT;   -- normalised game.json `controls`, <= 300 chars; '' when none; NULL = not yet backfilled
  ```
  No index is needed: both are read with the `games` row in `GAME_SELECT` and in the `/play/{id}` lookup. The values are per current version, like `score_order`/`score_format`/`score_label` (F001).
- **Startup backfill** (`backend/src/controls_backfill.rs`, backend-dev): spawned after migrations, alongside the existing startup tasks.
  1. `SELECT id, version FROM games WHERE actions_json IS NULL LIMIT 200`, repeated until no rows are left.
  2. Read `data/games/{id}/v{version}/game.json` (skipped when larger than 1 MiB).
  3. `parse_actions` (strict; an error stores `[]` and logs at `info`) and `parse_controls_hint`. A missing or unreadable file stores `[]` and `''`.
  4. `UPDATE games SET actions_json = ?, controls_hint = ? WHERE id = ? AND version = ? AND actions_json IS NULL`, so a concurrent bundle replace wins.
  It is best effort and idempotent: a failure is logged, and remaining rows are retried at the next start.
- **UI**: `src/controls.ts` (tables, labels, `validateActions`, overrides store, `PLAYER_CONTROLS_EVENT = "webgame:player-controls"`). Hosts dispatch it as a `window` CustomEvent to open the controls panel of the mounted `GamePlayer` or `StudioPreview` (the F005 pattern). New components: `ControlsPanel`, `KeyCaptureButton`, `ControlsSummary`. The desktop app inherits them through `@webgame/ui`.
- **Desktop**: View → Controls (`CmdOrCtrl+Shift+K`, forwarded id `"controls"`) dispatches `PLAYER_CONTROLS_EVENT`. No Rust logic beyond the menu entry.
- **Ownership**:
  - `actions.ts` and the `input.ts` changes belong to engine-dev.
  - `parse_actions`, `parse_controls_hint`, `controls_backfill.rs` and the `play.rs` changes belong to backend-dev.
  - `controls.ts`, the three components and the Studio form belong to frontend-dev.
  - The menu item belongs to desktop-dev.


## F006 additions
Comment replies and reactions (spec: `docs/features/F006-comment-replies-and-reactions.md`).
- **Model.** Replies are rows in `comments` with `parent_id` set to a top-level comment. Nesting is one level by construction: the create handler normalises any reply target to its root, so `parent_id` always points at a row whose own `parent_id` is NULL. Hearts are a join table with one row per (comment, user). There are no stored counters: counts are computed per read from primary-key or index prefixes, which is cheap for a page (≤ 100 threads + ≤ 300 preview replies).
- **Data**: migration `backend/migrations/0012_f006.sql` runs after the review-fix `0011_review3.sql`:
  ```sql
  -- One level of replies. NULL = top-level. Always a top-level comment's id (enforced in Rust).
  -- SQLite allows ADD COLUMN with REFERENCES because the default is NULL; the cascade is honoured.
  ALTER TABLE comments ADD COLUMN parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE;
  -- Replies only: the author of the reply that was answered ("Replying to @x").
  ALTER TABLE comments ADD COLUMN reply_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

  CREATE INDEX idx_comments_game_top      ON comments(game_id, created_at DESC) WHERE parent_id IS NULL;
  CREATE INDEX idx_comments_parent_created ON comments(parent_id, created_at) WHERE parent_id IS NOT NULL;

  CREATE TABLE comment_hearts (
      comment_id  TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL,                       -- RFC3339 millis Z
      PRIMARY KEY (comment_id, user_id)
  );
  CREATE INDEX idx_comment_hearts_user ON comment_hearts(user_id);   -- user-delete cascade; F007 lookups
  ```
  Existing rows become top-level comments (`parent_id` NULL). `idx_comments_game_created` (v1) stays; it serves `totalAll` and the stats counts.
- **Read shape** (normative; `?v` = viewer id or NULL, `?a` = 1 when the viewer is an admin):
  ```sql
  SELECT c.id, c.game_id, c.parent_id, c.body, c.created_at,
         u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name,
         u.avatar_ext AS a_avatar_ext, u.avatar_version AS a_avatar_version,
         r.id AS r_id, r.username AS r_username, r.display_name AS r_display_name,
         r.avatar_ext AS r_avatar_ext, r.avatar_version AS r_avatar_version,
         (c.user_id = g.owner_id) AS is_creator,
         (SELECT COUNT(*) FROM comment_hearts h WHERE h.comment_id = c.id) AS hearts,
         EXISTS (SELECT 1 FROM comment_hearts h WHERE h.comment_id = c.id AND h.user_id = ?v) AS my_heart,
         EXISTS (SELECT 1 FROM comment_hearts h WHERE h.comment_id = c.id AND h.user_id = g.owner_id) AS creator_heart,
         (?v IS NOT NULL AND (?a = 1 OR c.user_id = ?v OR g.owner_id = ?v)) AS can_delete
  FROM comments c
  JOIN users u ON u.id = c.user_id
  JOIN games g ON g.id = c.game_id
  LEFT JOIN users r ON r.id = c.reply_to_user_id
  ```
  - Thread page: `WHERE c.game_id = ? AND c.parent_id IS NULL ORDER BY c.created_at DESC, c.rowid DESC LIMIT ? OFFSET ?` (walks `idx_comments_game_top`).
  - Previews, one query per page (ids = the page's thread ids):
    ```sql
    WITH p AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY parent_id ORDER BY created_at, rowid) AS rn
               FROM comments WHERE parent_id IN (/* ids */))
    /* read shape */ JOIN p ON p.id = c.id WHERE p.rn <= 3 ORDER BY c.parent_id, p.rn
    ```
  - Reply counts: `SELECT parent_id, COUNT(*) FROM comments WHERE parent_id IN (/* ids */) GROUP BY parent_id`.
  - `/replies`: `WHERE c.parent_id = ? ORDER BY c.created_at, c.rowid LIMIT ? OFFSET ?`.
- **Write paths**:
  - Reply insert, guarded for the cap: `INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id, reply_to_user_id) SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM comments WHERE parent_id = ?) < 200`. Zero rows → 422.
  - Delete (shared by `DELETE /api/comments/{id}` and admin resolve `delete`), one transaction:
    ```sql
    UPDATE reports SET status = 'resolved', resolution = 'delete', resolved_at = ?2
     WHERE target_type = 'comment' AND status = 'open'
       AND target_id IN (SELECT id FROM comments WHERE id = ?1 OR parent_id = ?1);
    DELETE FROM comments WHERE id = ?1;   -- replies and comment_hearts cascade
    ```
  - Hearts: `INSERT OR IGNORE INTO comment_hearts …` / `DELETE FROM comment_hearts WHERE comment_id = ? AND user_id = ?`, then read the counts back.
- **Feed and notifications (coordination with F002/F007).**
  - F006 writes **no** `activity_events`. The F002 feed shows what followed people *do* in games (publish, update, bests, unlocks); conversations are addressed to specific people and belong in F007 notifications, not in a follower fan-out. The `activity_events.kind` CHECK is unchanged.
  - F007 hook points (to be wired by F007, not F006): after a successful insert in `create_comment` and after a heart insert that changed a row. The rows already hold what F007 needs: `comments.parent_id`, `comments.reply_to_user_id`, `comments.user_id`, `games.owner_id`, `comment_hearts.user_id`, and the permalink `/games/{gameId}?comment={commentId}`.
  - Recommended F007 recipients (F007's spec is normative): a top-level comment → the game owner; a reply → the thread's root author and the `replyTo` user; a creator heart → the comment's author. Never the actor themself, and each recipient at most once per event.
- **Permalinks.** `?comment={id}` on the game page (a query string, so it works under the desktop HashRouter, like F004's `?section=versions`). The UI resolves it with `GET /api/comments/{id}`.
- **UI**: `Comments.tsx` is split into `Comments` (state), `CommentItem`, `CommentForm` and `HeartButton`. Threads are nested `<ul>`s of `<article>`s (spec § 2.6), not an ARIA tree.
- **Ownership**: the migration, `routes/comments.rs`, the hearts handlers, `Limit::Heart` and the `reports.rs` change belong to backend-dev. The four components, the client and types, `GamePage`/`AdminPage` changes and styles belong to frontend-dev. Desktop has no code changes.


## F007 additions
In-app notifications (spec: `docs/features/F007-in-app-notifications.md`).
- **Fan-out on write, unlike the F002 feed.** The feed is fan-out on read: one `activity_events` row per action, selected through the viewer's follows at read time. Notifications are written per recipient instead (one row per recipient and group), because:
  1. Each notification has **per-recipient state** (read/unread, coalescing that stops once read). Storing that against a shared event would need a per-recipient table anyway.
  2. **Recipients per event are few and known at write time** for four of the five kinds (the game owner, the thread author and `replyTo` user, the comment author, the followee). The write is one or two small upserts.
  3. The **unread count is polled** by every signed-in tab about once a minute. With per-recipient rows it is an index-prefix count; computing it on read would repeat the feed's follow/favorite joins plus read-state joins on every poll.
  4. **Coalescing** ("Mia and 3 others…") is a property of one recipient's unread state, which a shared event row can't express.
  The one wide kind is `gamePublished` (every follower of the owner). It fires at most once per game ever (the F002 `first_published_at` condition), and creating games is limited to 20/hour, so its total volume is bounded by games × followers. It is written in chunks of ≤ 500 recipients per transaction after the publish has committed, so the SQLite write lock is never held for long. If follower counts grow large, this is the step to move to a background task.
- **Groups and events.** A `notifications` row is a group (recipient, kind, `group_key`) with read state and timestamps. Each contributing action is a `notification_events` row (actor, optional comment). Counts, actors and the target comment are derived from the events at read time, so:
  - deleting a comment cascades its events away and the group shows what remains (or disappears when nothing remains);
  - an un-heart or unfollow can retract exactly one actor's event;
  - there are no counters to keep in sync.
  `group_key` values (built in Rust, never from input): `game:{gameId}` (`comment`, `gamePublished`), `thread:{rootCommentId}` (`reply`), `comment:{commentId}` (`heart`), `follow` (`follow`).
- **Data**: migration `backend/migrations/0013_f007.sql` runs after F006's `0012_f006.sql`:
  ```sql
  CREATE TABLE notifications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,      -- Notification.id; stable
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL CHECK (kind IN ('comment','reply','heart','follow','gamePublished')),
      group_key    TEXT NOT NULL,
      game_id      TEXT REFERENCES games(id) ON DELETE CASCADE,      -- NULL only for 'follow'
      comment_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,   -- 'heart': the hearted comment; 'reply': the thread root; else NULL
      read_at      TEXT,                                   -- NULL = unread; RFC3339 millis Z
      created_at   TEXT NOT NULL,                          -- first event
      updated_at   TEXT NOT NULL                           -- latest event (ordering key)
  );
  -- At most one UNREAD group per (recipient, kind, group): the upsert's conflict target, and the unread count's index.
  CREATE UNIQUE INDEX idx_notifications_open_group ON notifications(recipient_id, kind, group_key) WHERE read_at IS NULL;
  CREATE INDEX idx_notifications_group             ON notifications(recipient_id, kind, group_key);   -- dedupe across read states
  CREATE INDEX idx_notifications_recipient_updated ON notifications(recipient_id, updated_at DESC, id DESC);
  CREATE INDEX idx_notifications_game     ON notifications(game_id)    WHERE game_id IS NOT NULL;     -- game delete cascade
  CREATE INDEX idx_notifications_comment  ON notifications(comment_id) WHERE comment_id IS NOT NULL;  -- comment delete cascade
  CREATE INDEX idx_notifications_read_at  ON notifications(read_at)    WHERE read_at IS NOT NULL;     -- pruning
  CREATE INDEX idx_notifications_updated  ON notifications(updated_at);                               -- pruning

  CREATE TABLE notification_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      actor_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      comment_id      TEXT REFERENCES comments(id) ON DELETE CASCADE,   -- 'comment'/'reply': the new comment; else NULL
      created_at      TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_notification_events_dedupe  ON notification_events(notification_id, actor_id, IFNULL(comment_id, ''));
  CREATE INDEX idx_notification_events_actor          ON notification_events(actor_id);                               -- user delete cascade
  CREATE INDEX idx_notification_events_comment        ON notification_events(comment_id) WHERE comment_id IS NOT NULL; -- comment delete cascade

  CREATE TABLE notification_settings (            -- no row = everything on
      user_id    TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      comments   INTEGER NOT NULL DEFAULT 1 CHECK (comments  IN (0, 1)),
      replies    INTEGER NOT NULL DEFAULT 1 CHECK (replies   IN (0, 1)),
      hearts     INTEGER NOT NULL DEFAULT 1 CHECK (hearts    IN (0, 1)),
      follows    INTEGER NOT NULL DEFAULT 1 CHECK (follows   IN (0, 1)),
      new_games  INTEGER NOT NULL DEFAULT 1 CHECK (new_games IN (0, 1)),
      updated_at TEXT NOT NULL
  );
  ```
  No backfill: notifications start at the migration. The comment-delete cascades (F006 `remove_comment`, admin resolve) need the two `comment_id` indexes, or every comment delete would scan the notification tables.
- **Write path** (`backend/src/notifications.rs`, best effort like `activity.rs`: nested transaction / SAVEPOINT, `tracing::warn!` on failure, never fails the request). Normative statements; `{col}` is the kind's settings column from a fixed Rust `match`:
  ```sql
  -- 1. dedupe (heart, follow only): skip when this actor already has an event in any group row
  SELECT EXISTS (SELECT 1 FROM notifications n JOIN notification_events e ON e.notification_id = n.id
                 WHERE n.recipient_id = ?1 AND n.kind = ?2 AND n.group_key = ?3 AND e.actor_id = ?4);

  -- 2. join the unread group or open a new one; settings checked in the same statement.
  --    (The WHERE clause also resolves SQLite's INSERT … SELECT … ON CONFLICT parsing ambiguity.)
  INSERT INTO notifications (recipient_id, kind, group_key, game_id, comment_id, created_at, updated_at)
  SELECT ?1, ?2, ?3, ?5, ?6, ?7, ?7
  WHERE NOT EXISTS (SELECT 1 FROM notification_settings s WHERE s.user_id = ?1 AND s.{col} = 0)
  ON CONFLICT (recipient_id, kind, group_key) WHERE read_at IS NULL
  DO UPDATE SET updated_at = excluded.updated_at
  RETURNING id;                                         -- no row: the kind is muted, stop

  -- 3. the event
  INSERT OR IGNORE INTO notification_events (notification_id, actor_id, comment_id, created_at) VALUES (?, ?, ?, ?);

  -- retraction (un-heart, unfollow): only from the unread group
  DELETE FROM notification_events
   WHERE actor_id = ?4
     AND notification_id IN (SELECT id FROM notifications
                             WHERE recipient_id = ?1 AND kind = ?2 AND group_key = ?3 AND read_at IS NULL);
  ```
  Steps 1–3 run in one nested transaction per recipient, so a committed group row always has at least one event. Marking a row read takes it out of the partial unique index, which is what makes the next event open a new group.
- **Hook points**: `routes/comments.rs` `create_comment` (comment/reply) and `heart`/`unheart` (the F006 `// F007:` markers), `routes/follows.rs` `put_follow`/`delete_follow` (only when a row was inserted/deleted), and `routes/games.rs` create + `PATCH` first publish (fan-out after `tx.commit()`). Recipient selection follows API § F007 "Triggers and recipients", which supersedes the "recommended recipients" note in § F006 (all hearts notify, coalesced, not only creator hearts).
- **Read shape** (normative; `?1` = recipient, `?2` = 1 for `unread=true`, `?3`/`?4` = cursor `updatedAt`/`id` or NULL, `?5` = limit + 1):
  ```sql
  SELECT n.id, n.kind, n.group_key, n.game_id, n.comment_id, n.read_at, n.created_at, n.updated_at,
         g.title, g.owner_id /* + the columns GAME_SELECT uses for thumbnailUrl */,
         EXISTS (SELECT 1 FROM notification_events e WHERE e.notification_id = n.id AND e.actor_id = g.owner_id) AS creator_heart
  FROM notifications n
  LEFT JOIN games g ON g.id = n.game_id
  WHERE n.recipient_id = ?1
    AND (n.game_id IS NULL OR g.published = 1 OR g.owner_id = ?1)
    AND EXISTS (SELECT 1 FROM notification_events e WHERE e.notification_id = n.id)
    AND (?2 = 0 OR n.read_at IS NULL)
    AND (?3 IS NULL OR n.updated_at < ?3 OR (n.updated_at = ?3 AND n.id < ?4))
  ORDER BY n.updated_at DESC, n.id DESC
  LIMIT ?5
  ```
  Then, batched over the page's ids (never one query per row):
  ```sql
  -- counts
  SELECT notification_id, COUNT(*) AS events, COUNT(DISTINCT actor_id) AS actors
  FROM notification_events WHERE notification_id IN (/* ids */) GROUP BY notification_id;
  -- up to 3 most recent distinct actors
  SELECT notification_id, actor_id FROM (
      SELECT notification_id, actor_id,
             ROW_NUMBER() OVER (PARTITION BY notification_id ORDER BY MAX(created_at) DESC, actor_id) AS rn
      FROM notification_events WHERE notification_id IN (/* ids */) GROUP BY notification_id, actor_id)
  WHERE rn <= 3;
  -- newest comment of comment/reply groups
  SELECT notification_id, comment_id FROM (
      SELECT notification_id, comment_id,
             ROW_NUMBER() OVER (PARTITION BY notification_id ORDER BY created_at DESC, id DESC) AS rn
      FROM notification_events WHERE notification_id IN (/* comment/reply ids */) AND comment_id IS NOT NULL)
  WHERE rn = 1;
  -- excerpts and thread authors (substr counts characters on TEXT)
  SELECT id, user_id, substr(body, 1, 140) FROM comments WHERE id IN (/* target comment ids + reply roots */);
  ```
  plus one `users` query for the actors' `UserRef`s and the recipient's username (for the `follow` path). `creatorHeart` = `creator_heart` for `heart` rows and `false` for every other kind. `ownsThread` = the root comment's `user_id` equals the recipient. The cursor is `"{updatedAt}|{id}"`, base64url-encoded; it is opaque to clients.
- **Count shape** (the poll; walks the partial unique index by its `recipient_id` prefix):
  ```sql
  SELECT COUNT(*), MAX(updated_at) FROM (
      SELECT n.updated_at FROM notifications n LEFT JOIN games g ON g.id = n.game_id
      WHERE n.recipient_id = ?1 AND n.read_at IS NULL
        AND (n.game_id IS NULL OR g.published = 1 OR g.owner_id = ?1)
        AND EXISTS (SELECT 1 FROM notification_events e WHERE e.notification_id = n.id)
      ORDER BY n.updated_at DESC LIMIT 100)
  ```
- **Mark read**: `UPDATE notifications SET read_at = ?now WHERE recipient_id = ?1 AND read_at IS NULL AND updated_at <= ?upTo [AND id IN (…)]`. `upTo` is normalised in Rust to RFC3339 millis `Z` before the string comparison (all stored times use that format).
- **Pruning** (`notifications::prune(pool, now)`, called at most once per hour from the housekeeping task in `trending::spawn_maintenance`, which runs every 60 s even when `TRENDING_TTL_SECS=0` (review 5, L9); each statement is repeated while it deletes 1000 rows):
  ```sql
  DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE read_at IS NOT NULL AND read_at < ?30_days_ago LIMIT 1000);
  DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE updated_at < ?90_days_ago LIMIT 1000);
  DELETE FROM notifications WHERE id IN (SELECT n.id FROM notifications n
      WHERE NOT EXISTS (SELECT 1 FROM notification_events e WHERE e.notification_id = n.id) LIMIT 1000);
  DELETE FROM notifications WHERE id IN (SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY recipient_id ORDER BY updated_at DESC, id DESC) AS rn
      FROM notifications) WHERE rn > 200 LIMIT 1000);
  ```
  The last two scan the table; at hourly cadence and with the 200-per-recipient cap that is acceptable at this platform's scale.
- **Polling, not push.** The UI polls `GET /api/notifications/unread-count` (about 1/min per visible tab; cadence in the spec § 2.7, server-suggested via `pollAfterSecs`).
  - **No websockets or SSE.** They would need long-lived connections per tab, a broadcast layer inside the single axum process, proxy buffering configuration, and reconnection logic in two hosts. The rate limiter and auth are per request. A minute of latency is fine for this content.
  - **No ETag / `If-None-Match`.** The count response is about 80 bytes, so a 304 saves almost nothing. `If-None-Match` is not a CORS-safelisted request header, so the desktop and dev origins would need a CORS change. The count query is an index-prefix scan capped at 100 rows. A dedicated count endpoint is the cheaper design.
  - The list (`GET /api/notifications`) is fetched only when the panel or page is open, or when the desktop OS step needs the newest items.
- **UI**:
  - `NotificationsProvider` (in `WebGameProviders`, inside `AuthProvider`/`ToastProvider`) owns the poll loop, unread state, the polite live region and the OS notification step. `NotificationBell` sits in `Header` outside the collapsible nav. New route `/notifications` (auth). `src/notifications.ts` holds the normative summary text (spec § 2.5).
  - **Host contract** (`PlatformConfig` in `packages/ui/src/context/config.tsx`; optional, so older hosts conform):
    ```ts
    type OsNotifications = {
      isEnabled(): boolean;                                       // the user opted in on this device; checked before every use
      show(n: { title: string; body: string }): Promise<void>;    // best effort; never rejects
    }
    type PlatformConfig = { ...F013, osNotifications?: OsNotifications }
    ```
    The UI decides *when* to show (window not focused, newer than the device watermark `webgame.notifications.osShown.{userId}`, at most 3 or one summary per poll) and *what* (summary text only, never excerpts). The host only displays.
- **Desktop OS notifications** (desktop-dev):
  - **Dependency decision.** `tauri-plugin-notification` (official, v2) is used from Rust only. Weighed against the alternatives:
    - The Web Notification API inside the webview is not available in WKWebView (macOS), and its permission and behaviour in WebView2 and WebKitGTK differ per platform.
    - Calling WinRT toasts, `NSUserNotification` and D-Bus ourselves would mean writing three per-OS backends, which is the plugin's job.
    - The plugin pulls `notify-rust` (Linux/macOS: `zbus`, `mac-notification-sys`) and `tauri-winrt-notification` on Windows (which mostly reuses the `windows` crates already built for WebView2).
  - **Disk.** The plugin is an **optional dependency behind the default-on Cargo feature `os-notifications`**, so space-constrained dev machines can build with `--no-default-features`. The dev profile already builds dependencies without debug info. desktop-dev records the measured `target/debug` delta in `apps/desktop/README.md`.
  - **No npm package, no plugin permissions for the webview.** The webview calls three app commands in `src-tauri/src/notify.rs` (`os_notifications_status`, `request_os_notifications`, `show_os_notification`). `show_os_notification` sanitises (control and bidi characters), length-limits (title ≤ 64, body ≤ 240) and rate-limits (5 per 60 s) in Rust. `capabilities/default.json` gains no `notification:*` permission.
  - **Opt-in.** Off by default, stored per device in `localStorage["webgame.desktop.osNotifications"] = "1"`, toggled in the desktop `extraSettings`, and OS permission is requested only when the user turns it on.
  - OS notification clicks use the platform default (focus or open the app). The plugin has no desktop click callback, so there is no deep link.
  - The native menu forwards a new `"notifications"` id (View → Notifications, `CmdOrCtrl+Shift+N`) → `/notifications`.
- **Ownership**: the migration, `notifications.rs`, `routes/notifications.rs`, the hooks, `Limit::Notifications`, `NOTIFICATION_POLL_SECS` and pruning belong to backend-dev. `notifications.ts`, `context/notifications.tsx`, `NotificationBell`, `NotificationItem`, `NotificationsPage`, the settings fieldset, the `OsNotifications` type and styles belong to frontend-dev. `notify.rs`, the Cargo feature, `OsNotificationSetting.tsx`, the `platform.ts` implementation and the menu item belong to desktop-dev.


## F012 additions
Bitmap fonts, 9-slice and UI widgets (spec: `docs/features/F012-bitmap-fonts-and-ui-widgets.md`). The work is almost all engine. There is **no migration, no new endpoint and no new dependency** (Rust or JS).
- **Engine modules** (engine-dev, `packages/engine/src/`):
  - `bmfont.ts`: pure. Contains `parseBMFont`, `BitmapFont` (with `BitmapFont.grid`) and `layoutText`.
  - `pixelfont.ts`: the built-in `pixel` glyph table; the texture is built lazily from `ImageData`.
  - `nineslice.ts`: pure. Contains `NineSlice` and `nineSliceQuads`.
  - `ui.ts`: `Ui`, with its input and renderer passed in so it can be tested in node.
  - Changes in `renderer.ts` (the font registry, `drawNineSlice`), `assets.ts` (`loadBitmapFont`, `gridFont`, `loadNineSlice`), `engine.ts` (the `ui` and `NineSlice` members, step and render hooks) and `files.ts` (the `.fnt` MIME).
  - The pure modules carry the logic, so `drawText`/`measureText` and the widget rules are covered by node tests without WebGL.
- **Font registry.** `Renderer` keeps one `Map<string, FontSource>`, where a `FontSource` is either the canvas `FontAtlas` (existing) or a `BitmapFont`.
  - `drawText`/`measureText` dispatch on the kind. The canvas path is unchanged.
  - `default`, `mono` and `pixel` are reserved, so the engine's own overlays (loading bar, F3 debug, PAUSED) can never be broken by a game. `setFont("default" | "mono")` remains allowed for compatibility.
  - Bitmap pages are ordinary `Texture`s: nearest-filtered pages are atlas-packed and batch with sprites and shapes, and smooth pages get their own GL texture.
- **Frame order** (`Engine.render`):
  ```
  beginFrame (clear) → game.render → scenes.render → UI layer (engine.ui committed list, screen space)
      → flush → F005 capture point → F3 debug overlay → host PAUSED overlay → endFrame
  ```
  The UI layer is game content, so screenshots include it. It is drawn from the list built by the **last fixed step** (`ui.beginStep`/`endStep` wrap each step, inside `input.beginStep`/`endStep`), so widget logic follows the same per-step input edges as the rest of the game. Frames without a step redraw the previous list.
- **Menu navigation reuses F009.** `engine.ui` reads the game's declared `up`/`down`/`left`/`right`/`confirm` actions when present (so ⌨ remaps apply to menus), with fixed key fallbacks otherwise. It checks `input.actions` before calling `actionPressed`, so F009's unknown-id warning never fires. No new message and no host involvement.
- **Six copies of the bundle extension allowlist**, all gaining `fnt`, which must stay in sync (review 5, L7 adds the pack script):
  - `backend/src/bundle.rs` `ALLOWED_EXTS` (authoritative, enforced on upload and replace);
  - `backend/src/routes/files.rs` `mime_for` (Content-Type);
  - `packages/ui/src/studio/project.ts` `ALLOWED_EXTENSIONS` and `TEXT_EXTENSIONS`;
  - `apps/desktop/src-tauri/src/project.rs` `ALLOWED_EXTS` and `TEXT_EXTS`;
  - `packages/engine/src/files.ts` `MIME` and the dev harness map in `packages/engine/vite.config.ts`;
  - `scripts/pack-examples.mjs` (the example bundle validator).
  GAME_FORMAT § F012 "Bundle" is the normative list. Each area's tests assert `fnt` is present.
- **Security posture unchanged.** Font descriptors are parsed only inside the sandboxed, opaque-origin game iframe, with hard limits (GAME_FORMAT § F012). Page paths go through `normalizePath` and can't leave the bundle. The engine never uses `DOMParser` on bundle content. `.fnt` is served like `.txt` (`text/plain`, `nosniff`, CSP sandbox).
- **Studio**: the `menu-hud` template uses only procedural textures (templates ship no assets). `.fnt` is a text type in the Studio editor, the zip reader and writer, and the desktop folder opener.
- **Ownership**:
  - The engine modules, README, the `pixel` table, `scripts/gen-bitmap-font.mjs` and the Pixel Peaks assets and code belong to engine-dev.
  - The allowlist and MIME entries and `tests/f012.rs` belong to backend-dev.
  - `project.ts`, the template and the docs page belong to frontend-dev.
  - The desktop `project.rs` lists belong to desktop-dev.


## F017 additions
Creator comment tools: pin, lock and "Top" sort (spec: `docs/features/F017-creator-comment-tools.md`). No new tables, endpoints outside `routes/comments.rs`, or dependencies.
- **Model.** Pin and lock are nullable timestamps on the **top-level** `comments` row. They are not stored on `games` (`games.pinned_comment_id` would create a `games` ↔ `comments` FK cycle and a dangling-id case on delete). A partial unique index enforces one pinned comment per game. Replies never get either column set (enforced in Rust: the endpoints refuse replies).
- **Data**: migration `backend/migrations/0015_f017.sql` runs after `0014_review4.sql`:
  ```sql
  -- F017: creator comment tools (docs/ARCHITECTURE.md § F017 additions).
  ALTER TABLE comments ADD COLUMN pinned_at TEXT;   -- NULL = not pinned; RFC3339 millis Z; top-level only
  ALTER TABLE comments ADD COLUMN locked_at TEXT;   -- NULL = open; RFC3339 millis Z; top-level only
  -- At most one pinned comment per game; also the lookup for CommentListPage.pinned.
  CREATE UNIQUE INDEX idx_comments_game_pinned ON comments(game_id) WHERE pinned_at IS NOT NULL;
  ```
  Existing rows become unpinned and unlocked. No backfill, no table rebuild.
- **Read shape** (extends the F006 `comment_select()`; `?1` = viewer id or NULL, `?2` = 1 for admins):
  ```sql
  (c.pinned_at IS NOT NULL)                                              AS pinned,
  (c.parent_id IS NULL AND c.locked_at IS NOT NULL)                      AS locked,
  (?1 IS NOT NULL AND c.parent_id IS NULL AND (?2 = 1 OR g.owner_id = ?1)) AS can_moderate
  ```
  - Thread page: `WHERE c.game_id = ?3 AND c.parent_id IS NULL AND c.pinned_at IS NULL`, then
    - `sort=new`: `ORDER BY c.created_at DESC, c.rowid DESC` (walks `idx_comments_game_top`, unchanged);
    - `sort=top`: `ORDER BY hearts DESC, c.created_at DESC, c.rowid DESC` (`hearts` is the F006 correlated count alias; one `comment_hearts` PK-prefix probe per top-level comment of the game, then a sort; fine up to tens of thousands of threads per game. A maintained counter is the next step if that is ever exceeded).
  - Counts: `SELECT COALESCE(SUM(parent_id IS NULL AND pinned_at IS NULL), 0), COUNT(*) FROM comments WHERE game_id = ?` (`total`, `totalAll`).
  - Pinned: `/* read shape */ WHERE c.game_id = ?3 AND c.pinned_at IS NOT NULL` (via `idx_comments_game_pinned`). Its previews and reply count come from the same `into_threads` call as the page's threads (still one preview query and one count query per request).
- **Write paths**:
  - Pin, one transaction (the first statement writes, so the deferred transaction takes the write lock immediately):
    ```sql
    UPDATE comments SET pinned_at = NULL
     WHERE game_id = ?1 AND pinned_at IS NOT NULL AND id <> ?2 RETURNING id;     -- → unpinnedId
    UPDATE comments SET pinned_at = COALESCE(pinned_at, ?3)
     WHERE id = ?2 AND parent_id IS NULL;                                        -- 0 rows → 404 (rolled back)
    ```
  - Unpin: `UPDATE comments SET pinned_at = NULL WHERE id = ? AND parent_id IS NULL`.
  - Lock / unlock: `UPDATE comments SET locked_at = COALESCE(locked_at, ?) WHERE id = ? AND parent_id IS NULL` / `SET locked_at = NULL`.
  - Each handler then reads back `ThreadState` from the row (0 rows → 404).
  - Reply insert (F006 guarded insert, one more condition; `?9` = 1 when the poster is the game owner or an admin):
    ```sql
    INSERT INTO comments (id, game_id, user_id, body, created_at, parent_id, reply_to_user_id)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
    WHERE EXISTS (SELECT 1 FROM comments WHERE id = ?6)
      AND (?9 = 1 OR (SELECT locked_at FROM comments WHERE id = ?6) IS NULL)
      AND (SELECT COUNT(*) FROM comments WHERE parent_id = ?6) < ?8
    ```
    Zero rows → re-read the root: missing → 404; locked and `?9 = 0` → 422 "This thread is locked"; else 422 cap. The handler also checks the lock before the insert (validation order in API § F017); the insert condition closes the race.
  - Delete (`remove_comment`) is unchanged: pin and lock go with the row.
- **Feed and notifications (coordination with F002/F007/F018).**
  - F017 writes no `activity_events` and no notifications, and retracts none.
  - Lock/unlock never notify (a moderation action; see the spec § 5).
  - A future "your comment was pinned" notification needs a new `notifications.kind` value. The 0013 CHECK can't be widened in place, and rebuilding `notifications` with foreign keys on would cascade-delete `notification_events` on `DROP TABLE` (and fire the `0014` trigger), so the rebuild must drop the trigger, copy both tables, recreate them, and restore the indexes and trigger. That work is assigned to F018 (which already changes the notification write path), together with a `pins` setting column. `routes/comments.rs` carries a `// F018:` marker at the hook point (after a pin changed a row; recipient = the comment's author when not the pinner, dedupe once per comment).
- **UI**: `CommentSortToggle` (new), changes in `Comments`, `CommentItem`, `CommentForm`; the sort is a per-device `localStorage["webgame.comments.sort"]`. `Comments`' internal permalink flag is renamed from `pinned` to `linked` to avoid clashing with the server field.
- **Ownership**: the migration, `routes/comments.rs` changes, `Limit::ThreadTools`, routes and `tests/f017.rs` belong to backend-dev. Types, client, `api/comments.ts`, the components, styles and UI tests belong to frontend-dev. Desktop has no code changes.


## F008 additions
Collections (spec: `docs/features/F008-collections.md`). Two new tables, one `reports` rebuild, one new route module. No new dependencies, no engine changes, no new served files.
- **Model.** A collection is a row in `collections` (owner, title, description, visibility). Its games are rows in `collection_games` keyed by `(collection_id, game_id)`, with an integer `position` and a per-game `note`. Positions only need to be ordered, not dense: appends use `MAX(position) + 1`, removes leave gaps, and a reorder rewrites them as `0..n-1`. Visibility of the games inside is never stored; it is evaluated per viewer at read time with the `GET /api/games/{id}` rule (`GameRow::visible_to`), exactly like favorites.
- **Data**: migration `backend/migrations/0016_f008.sql` runs after `0015_f017.sql`:
  ```sql
  -- F008: collections, and reports on collections (docs/ARCHITECTURE.md § F008 additions).
  CREATE TABLE collections (
      id           TEXT PRIMARY KEY NOT NULL,                          -- UUID v4
      owner_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,                                      -- 1–60 chars (validated in Rust)
      description  TEXT NOT NULL DEFAULT '',                           -- 0–500 chars, ≤ 8 lines (validated in Rust)
      visibility   TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
      created_at   TEXT NOT NULL,                                      -- RFC3339 millis Z
      updated_at   TEXT NOT NULL                                       -- RFC3339 millis Z; list order key
  );
  CREATE INDEX idx_collections_owner_updated ON collections(owner_id, updated_at DESC, id DESC);

  CREATE TABLE collection_games (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL,
      note          TEXT NOT NULL DEFAULT '',                          -- 0–140 chars, single line (validated in Rust)
      added_at      TEXT NOT NULL,
      PRIMARY KEY (collection_id, game_id)
  );
  CREATE INDEX idx_collection_games_order ON collection_games(collection_id, position, added_at);
  CREATE INDEX idx_collection_games_game  ON collection_games(game_id);   -- game page shelf + game delete cascade

  -- Rebuild reports: drop the target_type CHECK (types are validated in Rust from now on, so later
  -- target types need no rebuild) and make target_game_id nullable (NULL for 'collection').
  -- As in 0009: no table references reports and it has no triggers, so this is safe with foreign_keys on.
  CREATE TABLE reports_new (
      id              TEXT PRIMARY KEY NOT NULL,
      target_type     TEXT NOT NULL,                                   -- 'game' | 'comment' | 'screenshot' | 'collection' (Rust TARGET_TYPES)
      target_id       TEXT NOT NULL,
      target_game_id  TEXT,                                            -- NULL for 'collection'
      target_preview  TEXT NOT NULL,
      reason          TEXT NOT NULL,
      details         TEXT NOT NULL DEFAULT '',
      reporter_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      resolution      TEXT,
      created_at      TEXT NOT NULL,
      resolved_at     TEXT
  );
  INSERT INTO reports_new SELECT id, target_type, target_id, target_game_id, target_preview, reason,
                                 details, reporter_id, status, resolution, created_at, resolved_at
  FROM reports ORDER BY rowid;   -- keeps rowid order (the admin list's tie-break)
  DROP TABLE reports;
  ALTER TABLE reports_new RENAME TO reports;
  CREATE INDEX idx_reports_status_created ON reports(status, created_at DESC);
  CREATE INDEX idx_reports_target         ON reports(target_type, target_id, status);
  CREATE INDEX idx_reports_reporter       ON reports(reporter_id, target_type, target_id, status);
  ```
  No backfill. The demo seed (`seed.rs`) creates one public collection of the example games.
- **Read shapes** (`?v` = viewer id or NULL; "visible" = `(g.published = 1 OR g.owner_id = ?v)`):
  - Collection page: one query over `collection_games cg JOIN games g JOIN users u` (the `GAME_SELECT` columns plus `cg.note`, `cg.added_at`) `WHERE cg.collection_id = ? ORDER BY cg.position, cg.added_at, cg.game_id`. Visibility is applied in Rust per row: visible → `game: Some`, invisible → `game: None` for the owner, dropped for everyone else.
  - Summaries for a page of collections (profile list, my list, game shelf), **one batched query** for all of the page's ids, aggregated in Rust into `gameCount` and the first 4 `coverUrls` (thumbnail present) per collection:
    ```sql
    SELECT cg.collection_id, g.id, g.thumbnail_ext, g.thumbnail_version
    FROM collection_games cg JOIN games g ON g.id = cg.game_id
    WHERE cg.collection_id IN (…page ids…) AND (g.published = 1 OR g.owner_id = ?v)
    ORDER BY cg.collection_id, cg.position, cg.added_at, cg.game_id
    ```
    At most 24 × 100 rows. `MyCollection.itemCount` is a separate `COUNT(*) … GROUP BY collection_id` without the visibility filter, and `containsGame` an `EXISTS` on the primary key.
  - Profile list for other viewers: `WHERE c.owner_id = ? AND c.visibility = 'public' AND EXISTS (SELECT 1 FROM collection_games cg JOIN games g ON g.id = cg.game_id WHERE cg.collection_id = c.id AND (g.published = 1 OR g.owner_id = ?v)) ORDER BY c.updated_at DESC, c.id DESC LIMIT/OFFSET` (walks `idx_collections_owner_updated`; at most 50 rows per owner, so the `EXISTS` is cheap).
  - Game shelf: `SELECT c.* FROM collection_games cg JOIN collections c ON c.id = cg.collection_id WHERE cg.game_id = ? AND c.visibility = 'public' ORDER BY c.updated_at DESC, c.id DESC LIMIT ?` (via `idx_collection_games_game`), plus a matching `COUNT(*)` for `total`.
- **Write paths** (`backend/src/routes/collections.rs`; every write that checks a cap runs in a `BEGIN IMMEDIATE` transaction, and every successful change sets `collections.updated_at` in the same transaction):
  - Create: `INSERT INTO collections … SELECT … WHERE (SELECT COUNT(*) FROM collections WHERE owner_id = ?) < 50`; zero rows → 422. With `gameId`, the first item is inserted in the same transaction at position 0.
  - Add (new item):
    ```sql
    INSERT INTO collection_games (collection_id, game_id, position, note, added_at)
    SELECT ?1, ?2, COALESCE((SELECT MAX(position) FROM collection_games WHERE collection_id = ?1), -1) + 1, ?3, ?4
    WHERE (SELECT COUNT(*) FROM collection_games WHERE collection_id = ?1) < 100
    ```
    Zero rows → 422 cap. An existing item is detected first (primary key lookup) and only gets `UPDATE … SET note = ?` when `note` is present.
  - Reorder: read the current id set; if it differs from the request's set → 409; else one statement:
    ```sql
    UPDATE collection_games
       SET position = (SELECT CAST(j.key AS INTEGER) FROM json_each(?2) j WHERE j.value = collection_games.game_id)
     WHERE collection_id = ?1
    ```
    (`?2` is the request's `gameIds` re-serialised by Rust as a JSON array.)
  - Delete: `remove_collection(state, id)` deletes the row (items cascade) and resolves open reports `WHERE target_type = 'collection' AND target_id = ?`. Admin resolve `delete` calls the same function.
  - Game delete (`remove_game`) needs no change: `collection_games` rows cascade through the foreign key and `idx_collection_games_game`.
- **Reports.** `Report.target_game_id` becomes `Option<String>`. `create_report` validates `target_type` against a Rust `TARGET_TYPES` list (the DB no longer checks it). The F005 `LEFT JOIN screenshots` in `REPORT_SELECT` is unchanged; collection rows simply get NULL image fields.
- **Feed and notifications.** F008 writes no `activity_events` and no notifications. "X added your game to a collection" and a `collectionUpdated` feed kind are proposed as F021, after F018 removes the `notifications.kind` CHECK.
- **Share URLs.** The UI builds `/c/{id}` links with `collectionShareUrl` (spec § 2.7): the page origin on the web; `apiBaseUrl` on desktop (hash router), because a `tauri://` or `#/` link is useless outside the app. That desktop link opens the collection only when the configured server also serves the web app (`WEB_DIST`, the documented production setup); operators who split API and web origins should know that desktop-copied links point at the API origin.
- **Caching and compression (review 5).** No new files are served. `/api/*` responses (including collection JSON) are not compressed and carry no cache headers, as before. The SPA routes fall back to `index.html` with `no-cache`, and the Vite dev proxy doesn't match them. Covers reuse thumbnail URLs (`?v=` versioned) and their existing caching.
- **UI**:
  - `src/collections.ts` (pure: limits, validators, `moveItem`, `collectionShareUrl`).
  - Components `CollectionCard`/`CollectionGrid`, `CollectionFormDialog`, `AddToCollectionDialog`/`AddToCollectionButton`, `GameCollections`, `CollectionItemRow`.
  - Pages `CollectionPage` (`/c/:id`) and `UserCollectionsPage` (`/u/:username/collections`); `/collections` redirects to the signed-in user's list inside `RequireAuth`.
  - Changes in `ProfilePage`, `GamePage`, `AdminPage`, `Report.tsx`, `Layout` (user menu) and `WebGameApp` (routes).
  - Reordering is button-based (Move up / Move down) and always sends the full order, so the client never computes partial positions.
- **Desktop**: the native menu forwards a new `"collections"` id (View → Collections, `CmdOrCtrl+Shift+L`) → `/collections`. No other desktop code.
- **Ownership**: the migration, `routes/collections.rs`, the `reports.rs` changes, `Limit::Collections`, the seed collection and `tests/f008.rs` belong to backend-dev. Types, client, `collections.ts`, the components, pages, styles and UI tests belong to frontend-dev. `menu.rs`, `nativeMenu.ts` and its test belong to desktop-dev.


## F018 additions
Notification controls (spec: `docs/features/F018-notification-controls.md`). One new table, one new settings column, a one-time rebuild of `notifications` and `notification_events`, five endpoints in `routes/notifications.rs`, and a client-side tab coordinator. No new dependencies (Rust or JS), no engine or desktop code.
- **Model.**
  - A mute is a row in `notification_mutes`: (user, game, optional thread). A game mute has `thread_id NULL`. A thread mute stores the thread's top-level comment **and** its game, so every write-path check is one probe of the `(user_id, game_id, …)` index prefix.
  - Mutes are checked **on write**, in the same statement that checks the per-kind settings, like F007 settings. Reads don't filter by mutes. Notifications written before a mute are marked read at mute time instead, so the list and the count need no extra join.
  - `pinned` is a normal F007 kind (group `pin:{commentId}`, `comment_id` = the pinned comment). It adds a third dedupe mode, **group dedupe**: at most one notification per recipient and group while any row for it is stored. It also adds a **withdraw** operation that tombstones every live event of the recipient's unread group (the F007 L1 `retracted_at` mechanism, for all actors).
  - `notifications.kind` loses its CHECK. `notifications::Kind` is the only list of kinds, as `TARGET_TYPES` is for `reports` since F008. F021 and later kinds need no rebuild.
- **Data**: migration `backend/migrations/0017_f018.sql` runs after `0016_f008.sql`. Normative, in this order:
  ```sql
  -- F018: notification controls (docs/ARCHITECTURE.md § F018 additions).

  -- 1. Mutes.
  CREATE TABLE notification_mutes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,                    -- list tie-break only; not exposed
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE, -- the muted game, or the muted thread's game
      thread_id  TEXT REFERENCES comments(id) ON DELETE CASCADE,       -- NULL = game mute; else a top-level comment of game_id
      created_at TEXT NOT NULL                                         -- RFC3339 millis Z
  );
  -- One row per target; its (user_id, game_id) prefix serves the write-path mute check.
  CREATE UNIQUE INDEX idx_notification_mutes_target ON notification_mutes(user_id, game_id, IFNULL(thread_id, ''));
  CREATE INDEX idx_notification_mutes_user_created  ON notification_mutes(user_id, created_at DESC, id DESC);     -- the list
  CREATE INDEX idx_notification_mutes_game          ON notification_mutes(game_id);                               -- game delete cascade
  CREATE INDEX idx_notification_mutes_thread        ON notification_mutes(thread_id) WHERE thread_id IS NOT NULL; -- comment delete cascade, thread unmute

  -- 2. The "pinned" kind's setting.
  ALTER TABLE notification_settings ADD COLUMN pins INTEGER NOT NULL DEFAULT 1 CHECK (pins IN (0, 1));

  -- 3. Rebuild notifications without the kind CHECK (kinds are validated in Rust: notifications::Kind).
  --    This runs inside sqlx's migration transaction with foreign_keys = ON, which can't be switched off
  --    inside a transaction. With FKs on, DROP TABLE runs an implicit DELETE that fires ON DELETE CASCADE
  --    actions, so the old parent must never be dropped while a child table references it:
  --      a. drop the 0014 trigger first (no step below may fire it; it is recreated in step 4);
  --      b. copy the parent, then copy the child into a new child that references the NEW parent;
  --      c. drop the old child, then the old parent (nothing references it any more, so nothing cascades);
  --      d. rename. SQLite >= 3.26 (legacy_alter_table OFF; sqlx 0.8 bundles a newer SQLite) rewrites
  --         notification_events_new's REFERENCES notifications_new(id) to notifications(id) and renames
  --         the sqlite_sequence rows.
  DROP TRIGGER notification_events_last_gone;

  CREATE TABLE notifications_new (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,      -- Notification.id; stable
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL,                          -- notifications::Kind::as_str (validated in Rust; no CHECK)
      group_key    TEXT NOT NULL,
      game_id      TEXT REFERENCES games(id) ON DELETE CASCADE,      -- NULL only for 'follow'
      comment_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,   -- 'heart': hearted comment; 'reply': thread root; 'pinned': pinned comment; else NULL
      read_at      TEXT,                                   -- NULL = unread; RFC3339 millis Z
      created_at   TEXT NOT NULL,                          -- first event
      updated_at   TEXT NOT NULL                           -- latest event (ordering key)
  );
  INSERT INTO notifications_new (id, recipient_id, kind, group_key, game_id, comment_id, read_at, created_at, updated_at)
  SELECT id, recipient_id, kind, group_key, game_id, comment_id, read_at, created_at, updated_at
  FROM notifications ORDER BY id;

  CREATE TABLE notification_events_new (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id INTEGER NOT NULL REFERENCES notifications_new(id) ON DELETE CASCADE,
      actor_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      comment_id      TEXT REFERENCES comments(id) ON DELETE CASCADE,   -- 'comment'/'reply': the new comment; else NULL
      created_at      TEXT NOT NULL,
      retracted_at    TEXT                                              -- NULL = live; RFC3339 millis Z (0014 L1)
  );
  INSERT INTO notification_events_new (id, notification_id, actor_id, comment_id, created_at, retracted_at)
  SELECT id, notification_id, actor_id, comment_id, created_at, retracted_at
  FROM notification_events ORDER BY id;

  -- Carry the AUTOINCREMENT high-water marks over, so ids of deleted rows are never reused
  -- (clients dedupe notifications by id). The copies above only set the new sequences to MAX(id).
  DELETE FROM sqlite_sequence WHERE name IN ('notifications_new', 'notification_events_new');
  INSERT INTO sqlite_sequence (name, seq)
  SELECT name || '_new', seq FROM sqlite_sequence WHERE name IN ('notifications', 'notification_events');

  DROP TABLE notification_events;   -- the old child: nothing references it and its trigger is gone
  DROP TABLE notifications;         -- the old parent: no table references it any more, so no cascade runs
  ALTER TABLE notifications_new RENAME TO notifications;
  ALTER TABLE notification_events_new RENAME TO notification_events;

  -- 4. Indexes (identical to 0013) and the 0014 trigger.
  CREATE UNIQUE INDEX idx_notifications_open_group ON notifications(recipient_id, kind, group_key) WHERE read_at IS NULL;
  CREATE INDEX idx_notifications_group             ON notifications(recipient_id, kind, group_key);
  CREATE INDEX idx_notifications_recipient_updated ON notifications(recipient_id, updated_at DESC, id DESC);
  CREATE INDEX idx_notifications_game     ON notifications(game_id)    WHERE game_id IS NOT NULL;
  CREATE INDEX idx_notifications_comment  ON notifications(comment_id) WHERE comment_id IS NOT NULL;
  CREATE INDEX idx_notifications_read_at  ON notifications(read_at)    WHERE read_at IS NOT NULL;
  CREATE INDEX idx_notifications_updated  ON notifications(updated_at);

  CREATE UNIQUE INDEX idx_notification_events_dedupe  ON notification_events(notification_id, actor_id, IFNULL(comment_id, ''));
  CREATE INDEX idx_notification_events_actor          ON notification_events(actor_id);
  CREATE INDEX idx_notification_events_comment        ON notification_events(comment_id) WHERE comment_id IS NOT NULL;

  CREATE TRIGGER notification_events_last_gone AFTER DELETE ON notification_events
  WHEN NOT EXISTS (SELECT 1 FROM notification_events WHERE notification_id = OLD.notification_id)
  BEGIN
      DELETE FROM notifications WHERE id = OLD.notification_id;
  END;
  ```
  - `notification_fanouts` and `notification_settings` don't reference the rebuilt tables and are untouched, apart from the new `pins` column. No other table references `notifications` or `notification_events` (checked against `0001`–`0016`).
  - The copy holds the write lock for the duration of the migration. With the F007 cap of 200 notifications per user, that is at most a few hundred thousand rows per thousand users, which is acceptable at startup.
  - The `sqlite_stat1` rows of the dropped tables are dropped with them. The startup `PRAGMA optimize = 0x10002` (N1) re-analyses the new tables.
  - The upgrade test in the spec § 6 is required. It checks that rows and ids are preserved, `foreign_key_check` is empty, the FK target is rewritten, there are no `_new` leftovers, the indexes and trigger exist and work, and the sequence is preserved.
- **Write path** (`backend/src/notifications.rs`; `try_notify` keeps its single `BEGIN IMMEDIATE` transaction).
  - Binds: `?1` recipient, `?2` kind, `?3` group, `?4` actor, `?5` game id, `?6` comment id, `?7` now, `?8` dedupe mode (0 none, 1 actor, 2 group), `?9` thread id.
  - `{col}` is the kind's settings column, from the fixed Rust `match` (`Kind::Pinned` → `pins`).
  - The shared mute predicate:
  ```sql
  -- MUTED(?1, ?5, ?9): a game mute of ?5, or a mute of thread ?9 (thread mutes also store their game).
  EXISTS (SELECT 1 FROM notification_mutes m
          WHERE m.user_id = ?1 AND m.game_id = ?5 AND (m.thread_id IS NULL OR m.thread_id = ?9))
  ```
  `?5 IS NULL` (follow) never matches. `?9 IS NULL` matches game mutes only.
  ```sql
  -- 1. restore (dedupe modes 1 and 2): un-tombstone; mode 2 restores every actor's events
  UPDATE notification_events SET retracted_at = NULL
  WHERE retracted_at IS NOT NULL AND (?8 = 2 OR actor_id = ?4)
    AND notification_id IN (SELECT id FROM notifications WHERE recipient_id = ?1 AND kind = ?2 AND group_key = ?3)
    AND NOT EXISTS (SELECT 1 FROM notification_settings s WHERE s.user_id = ?1 AND s.{col} = 0)
    AND NOT MUTED(?1, ?5, ?9);
  -- rows > 0 → commit and stop (no bump)

  -- 2. join or open the unread group
  INSERT INTO notifications (recipient_id, kind, group_key, game_id, comment_id, created_at, updated_at)
  SELECT ?1, ?2, ?3, ?5, ?6, ?7, ?7
  WHERE NOT EXISTS (SELECT 1 FROM notification_settings s WHERE s.user_id = ?1 AND s.{col} = 0)
    AND NOT MUTED(?1, ?5, ?9)
    AND (?8 = 0
         OR (?8 = 1 AND NOT EXISTS (SELECT 1 FROM notifications d JOIN notification_events e ON e.notification_id = d.id
                                    WHERE d.recipient_id = ?1 AND d.kind = ?2 AND d.group_key = ?3 AND e.actor_id = ?4))
         OR (?8 = 2 AND NOT EXISTS (SELECT 1 FROM notifications d
                                    WHERE d.recipient_id = ?1 AND d.kind = ?2 AND d.group_key = ?3)))
  ON CONFLICT (recipient_id, kind, group_key) WHERE read_at IS NULL
  DO UPDATE SET updated_at = excluded.updated_at
  RETURNING id;

  -- 3. the event: unchanged (INSERT OR IGNORE INTO notification_events …)
  ```
  - **Withdraw** (`withdraw_pool(pool, recipient, kind, group)`, best effort, autocommit; `?4` = now):
    ```sql
    UPDATE notification_events SET retracted_at = ?4
    WHERE retracted_at IS NULL
      AND notification_id IN (SELECT id FROM notifications
                              WHERE recipient_id = ?1 AND kind = ?2 AND group_key = ?3 AND read_at IS NULL)
    ```
  - **Fan-out** (`fan_out_chunk`, the `gamePublished` insert) gains `AND NOT EXISTS (SELECT 1 FROM notification_mutes m WHERE m.user_id = r.value AND m.game_id = ?3 AND m.thread_id IS NULL)`.
  - **Hooks** (`routes/comments.rs`):
    - Thread ids: for a reply, `thread_id = Some(root)`; for a heart, `thread_id = Some(meta.parent_id.unwrap_or(id))`; for comments and follows, `None`. `gamePublished` doesn't apply (fan-out).
    - `pin`: inside the existing transaction, first read `pinned_at IS NOT NULL, user_id` of the comment (so an idempotent re-`PUT` never notifies or restores), and change the unpin statement to `RETURNING id, user_id`. After `tx.commit()`:
      - if the row went from unpinned to pinned and its author is not the caller, `notify` with `Kind::Pinned`, group `pin:{id}`, `game_id`, `comment_id = id`, `event_comment_id = None`, `Dedupe::Group` and `thread_id = id`;
      - if a previous pin was removed (`unpinned_id = a`, author `u`), `withdraw_pool(u, Pinned, "pin:{a}")`.
    - `unpin`: in one transaction, read `pinned_at IS NOT NULL, user_id`, then run the F017 `UPDATE`. After the commit, if the comment was pinned, `withdraw_pool(author, Pinned, "pin:{id}")`.
- **Mute statements** (`notifications.rs`; each `PUT` is one `BEGIN IMMEDIATE` transaction; `?1` user, `?2` target id, `?3` now):
  ```sql
  -- game: already muted?
  SELECT 1 FROM notification_mutes WHERE user_id = ?1 AND game_id = ?2 AND thread_id IS NULL;
  -- if not: insert under the cap (0 rows → 422)
  INSERT INTO notification_mutes (user_id, game_id, thread_id, created_at)
  SELECT ?1, ?2, NULL, ?3 WHERE (SELECT COUNT(*) FROM notification_mutes WHERE user_id = ?1) < 500;
  -- always: mark read
  UPDATE notifications SET read_at = ?3 WHERE recipient_id = ?1 AND read_at IS NULL AND game_id = ?2;

  -- thread (?2 = top-level comment id): already muted?
  SELECT 1 FROM notification_mutes WHERE user_id = ?1 AND thread_id = ?2;
  -- if not: insert under the cap; 0 rows → re-check the comment (gone → 404) else 422
  INSERT INTO notification_mutes (user_id, game_id, thread_id, created_at)
  SELECT ?1, c.game_id, c.id, ?3 FROM comments c
  WHERE c.id = ?2 AND c.parent_id IS NULL
    AND (SELECT COUNT(*) FROM notification_mutes WHERE user_id = ?1) < 500;
  -- always: mark read in the thread's scope (?4 = the thread's game id)
  UPDATE notifications SET read_at = ?3
  WHERE recipient_id = ?1 AND read_at IS NULL AND game_id = ?4
    AND ((kind IN ('reply', 'pinned') AND comment_id = ?2)
         OR (kind = 'heart' AND comment_id IN (SELECT ?2 UNION ALL SELECT id FROM comments WHERE parent_id = ?2)));

  -- unmute
  DELETE FROM notification_mutes WHERE user_id = ?1 AND game_id = ?2 AND thread_id IS NULL;   -- game
  DELETE FROM notification_mutes WHERE user_id = ?1 AND thread_id = ?2;                         -- thread

  -- list
  SELECT m.game_id, m.thread_id, m.created_at, g.title, g.thumbnail_ext, g.thumbnail_version,
         substr(c.body, 1, 80) AS excerpt
  FROM notification_mutes m
  JOIN games g ON g.id = m.game_id
  LEFT JOIN comments c ON c.id = m.thread_id
  WHERE m.user_id = ?1 AND (g.published = 1 OR g.owner_id = ?1)
  ORDER BY m.created_at DESC, m.id DESC;
  ```
  `MuteState.unread` is `unread_count(db, user)`, read after the commit.
- **Read path**:
  - `comment_select()` gains a column (same binds as F017; `?1` = viewer or NULL):
    ```sql
    (?1 IS NOT NULL AND c.parent_id IS NULL AND EXISTS (SELECT 1 FROM notification_mutes m
        WHERE m.user_id = ?1 AND m.game_id = c.game_id AND m.thread_id = c.id)) AS thread_muted
    ```
  - Game detail: `notifications_muted` = `EXISTS (SELECT 1 FROM notification_mutes WHERE user_id = ? AND game_id = ? AND thread_id IS NULL)`, or `false` for anonymous viewers. It is computed next to `is_favorite` and is not added to `GAME_SELECT`, so cards and lists are unchanged.
  - `list_page`:
    - The excerpt query becomes `SELECT id, user_id, parent_id, substr(body, 1, ?2) FROM comments WHERE id IN (…)`.
    - `threadId`: for reply, `n.comment_id`; for heart, the hearted comment's `parent_id`, else its own id (null when the comment row is missing); for pinned, `n.comment_id`; otherwise null.
    - `Kind::Pinned`: the target comment is `n.comment_id`, `event_count` = `actor_count`, and the path is the permalink.
  - The unread count, list visibility, mark-read and pruning queries are unchanged, because they never named kinds.
- **Tab coordination (UI).** In `packages/ui/src/notificationsTabs.ts` (pure) and `context/notifications.tsx`:
  - **Why Web Locks for the election.** An election over `BroadcastChannel` alone needs heartbeats, timeouts and tie-breaking, and it can briefly have two leaders or none. `navigator.locks.request` gives exactly one holder per origin and name, queues the other tabs, and hands the lock over when the holder's document closes or is discarded. `BroadcastChannel` is only used to share results. Both APIs are same-origin, exist in every browser and Tauri webview this app targets, and need no dependency. Without either one, each tab polls as in F007.
  - The scope is the API base URL plus the user id, so desktop server switches and account switches never share counts.
  - The leader's visibility input is "this tab, or any follower that pinged within 75 s", so a background leader keeps polling for a visible follower. A `visible` ping also wakes a leader whose loop was paused.
  - Every tab applies counts through one function, whether the count came from its own poll or from a message. Announcements, `lastChange` and `arrivals` therefore behave the same in all tabs. Only the leader runs the OS-notification step, so the desktop never shows duplicates.
  - Writes (mark read, mutes) stay in the tab that made them, and that tab broadcasts the resulting `unread`.
  - Expected load: one count request per cadence per browser profile and user, instead of one per visible tab.
- **Ownership**:
  - backend-dev: the migration, `notifications.rs`, `routes/notifications.rs`, route registration, the `comments.rs`/`games.rs`/`models.rs` changes and `tests/f018.rs`.
  - frontend-dev: `notificationsTabs.ts`, the provider changes, types, client, `notifications.ts`, `MuteGameButton`, `MutedList`, the `CommentItem`/`NotificationItem`/`NotificationsPage`/`NotificationSettings`/`GamePage` changes, styles and tests.
  - desktop-dev: verification only.

### F018 implementation notes
- The game-mute insert carries an extra guard, `AND EXISTS (SELECT 1 FROM games WHERE id = ?2)`, so a game deleted between the visibility check and the write gives 404, not a foreign-key 500.
- `pin`/`unpin` run in `BEGIN IMMEDIATE` transactions (read-then-write without `SQLITE_BUSY`).
- `Game.notificationsMuted` is computed in `build_game`, so it appears on every response that returns a `Game` (not on `GameSummary`).


## F021 additions
Collection activity (spec: `docs/features/F021-collection-activity.md`). One migration (an `activity_events` rebuild plus two added columns), one activity writer, a third feed branch, one notification kind. No new endpoints, dependencies, engine or desktop code.
- **Model.**
  - A `collectionUpdated` event is an `activity_events` row with `game_id NULL`, `collection_id` set and `game_ids` = a JSON array of the game ids announced that day (newest first, at most 100). The row is keyed by (collection, UTC day); each announced add replaces it (delete + insert, so it gets a new, higher id and moves to the top, like `personalBest`).
  - The event stores **which** games were announced, so games added while the collection was private are never shown, even after it turns public. Everything else (still in the collection, added on that day, published, the collection public, its title, the notes) is evaluated at read time.
  - `addedToCollection` is a normal F007 kind with F018 group dedupe and withdrawal (the `pinned` pattern). The notification row carries `collection_id`, so it cascades with the collection and the read path can hide it while the collection is private.
  - `activity_events.kind` loses its CHECK. `activity::KINDS` is the only list of feed kinds, as `notifications::Kind` and `TARGET_TYPES` are for their tables. F015 and later feed kinds need no rebuild.
- **Data**: migration `backend/migrations/0019_f021.sql` runs after `0018_review6.sql`. Normative, in this order:
  ```sql
  -- F021: collection activity (docs/ARCHITECTURE.md § F021 additions).

  -- 1. Rebuild activity_events: no kind CHECK (validated in Rust: activity::KINDS), nullable game_id,
  --    and the collection columns. No table references activity_events and it has no triggers
  --    (checked against 0001–0017), so dropping the old table cascades nothing with foreign_keys ON.
  --    Columns keep their 0005/0007 order; the new ones are appended.
  CREATE TABLE activity_events_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,      -- feed cursor
      actor_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,                          -- activity::KINDS (validated in Rust; no CHECK)
      game_id       TEXT REFERENCES games(id) ON DELETE CASCADE,          -- NULL only for collectionUpdated
      version       INTEGER,                                -- gamePublished / gameUpdated
      score         INTEGER,                                -- personalBest
      first_score   INTEGER NOT NULL DEFAULT 0,             -- personalBest: 1 = actor's first score on the game
      ach_id        TEXT,                                   -- achievementUnlocked (latest)
      ach_count     INTEGER NOT NULL DEFAULT 0,             -- achievementUnlocked: unlocks that day
      day           TEXT NOT NULL,                          -- YYYY-MM-DD UTC of created_at (coalescing key)
      created_at    TEXT NOT NULL,                          -- RFC3339 millis Z
      from_version  INTEGER,                                -- gameUpdated (F004)
      collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,    -- collectionUpdated
      game_ids      TEXT,                                   -- collectionUpdated: JSON array of game ids, newest first, <= 100
      CHECK (game_id IS NOT NULL OR collection_id IS NOT NULL)
  );
  INSERT INTO activity_events_new (id, actor_id, kind, game_id, version, score, first_score, ach_id,
                                   ach_count, day, created_at, from_version)
  SELECT id, actor_id, kind, game_id, version, score, first_score, ach_id,
         ach_count, day, created_at, from_version
  FROM activity_events ORDER BY id;

  -- Carry the AUTOINCREMENT high-water mark over (feed cursors are ids; coalescing deletes rows,
  -- so MAX(id) can be below the sequence).
  DELETE FROM sqlite_sequence WHERE name = 'activity_events_new';
  INSERT INTO sqlite_sequence (name, seq)
  SELECT 'activity_events_new', seq FROM sqlite_sequence WHERE name = 'activity_events';

  DROP TABLE activity_events;       -- also removes its sqlite_sequence row
  ALTER TABLE activity_events_new RENAME TO activity_events;   -- renames the sqlite_sequence row too

  CREATE INDEX idx_activity_actor_id   ON activity_events(actor_id, id DESC);
  CREATE INDEX idx_activity_game_kind  ON activity_events(game_id, kind, id DESC);
  CREATE INDEX idx_activity_coalesce   ON activity_events(actor_id, game_id, kind, day);
  -- collectionUpdated coalescing + the collection delete cascade.
  CREATE INDEX idx_activity_collection ON activity_events(collection_id, kind, day) WHERE collection_id IS NOT NULL;

  -- 2. Notifications: the collection of an addedToCollection notification (NULL for every other kind).
  --    ADD COLUMN with REFERENCES is allowed because the default is NULL.
  ALTER TABLE notifications ADD COLUMN collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE;
  CREATE INDEX idx_notifications_collection ON notifications(collection_id) WHERE collection_id IS NOT NULL;

  -- 3. The addedToCollection kind's setting.
  ALTER TABLE notification_settings ADD COLUMN collections INTEGER NOT NULL DEFAULT 1 CHECK (collections IN (0, 1));
  ```
  - The copy holds the write lock for the migration's duration; `activity_events` is bounded by the coalescing rules, so this is acceptable at startup. `sqlite_stat1` rows of the old table go with it; the startup `PRAGMA optimize` (N1) re-analyses.
  - `PRAGMA foreign_key_check` must be empty after the migration (spec § 6 upgrade test).
- **Writer** (`activity::record_collection_added(conn, actor_id, collection_id, game_id, now)`; nested transaction like the other writers; `?2` day = `now[..10]`, where `now` is the exact `added_at` just written):
  ```sql
  DELETE FROM activity_events
  WHERE collection_id = ?1 AND kind = 'collectionUpdated' AND day = ?2
  RETURNING game_ids;
  -- Rust: merged = [game_id] followed by the ids of every returned array in order, without game_id
  -- and without duplicates, truncated to COLLECTION_EVENT_GAMES_MAX (100). Unparseable arrays count as [].
  INSERT INTO activity_events (actor_id, kind, game_id, collection_id, game_ids, day, created_at)
  VALUES (?3, 'collectionUpdated', NULL, ?1, ?4, ?2, ?5);   -- ?3 actor, ?4 merged JSON, ?5 now
  ```
  - Called inside the add transaction of `put_collection_game` (new item) and `create_collection` (with `gameId`), after the guarded insert, only when this query (same transaction) returns `visibility = 'public'` and `published = 1`:
    ```sql
    SELECT c.visibility, g.published, g.owner_id FROM collections c, games g WHERE c.id = ?1 AND g.id = ?2
    ```
    The same row decides the notification after the commit (`g.owner_id <> caller`).
- **Feed query** (`FEED_SQL`). Branches (a) followed creators and (b) favorited games stay exactly as they are: branch (a)'s `CROSS JOIN games g … g.id = e.game_id` already drops rows with `game_id NULL`. A third branch is added to the `picked` union:
  ```sql
  UNION
  SELECT id FROM (
    SELECT e.id FROM follows f
    CROSS JOIN activity_events e INDEXED BY idx_activity_actor_id
    CROSS JOIN collections c
    WHERE f.follower_id = ?1 AND e.actor_id = f.followee_id
      AND e.id < COALESCE(?2, 9223372036854775807)
      AND e.actor_id <> ?1
      AND e.kind = 'collectionUpdated'
      AND e.kind IN (SELECT value FROM json_each(?4))
      AND c.id = e.collection_id AND c.visibility = 'public' AND c.owner_id = e.actor_id
      AND EXISTS (SELECT 1 FROM json_each(e.game_ids) j
                  JOIN collection_games cg ON cg.collection_id = e.collection_id AND cg.game_id = j.value
                  JOIN games g2 ON g2.id = cg.game_id
                  WHERE substr(cg.added_at, 1, 10) = e.day AND g2.published = 1)
    ORDER BY e.id DESC LIMIT ?3)
  ```
  The outer `SELECT` adds `e.collection_id, e.game_ids, e.day`. Its `LEFT JOIN achievements` matches nothing for these rows. The extended `tests/review2.rs` N1 test asserts the plan still uses `idx_activity_actor_id (actor_id=? AND id<?)` and `idx_activity_game_kind (…)`, and scans none of `activity_events`, `games`, `collections` and `collection_games`.
- **Feed assembly** (`get_feed`, batched per page, never per row):
  1. `SELECT id, title FROM collections WHERE id IN (SELECT value FROM json_each(?)) AND visibility = 'public'` for the page's collection ids.
  2. `SELECT collection_id, game_id, note, added_at FROM collection_games WHERE collection_id IN (SELECT value FROM json_each(?))` (at most 20 × 100 rows).
  3. The game ids from every parsed `game_ids` array are added to the page's existing `GAME_SELECT … json_each` query.
  4. Per `collectionUpdated` row: keep, in array order, the ids that have an item row with `added_at[..10] == day` and a loaded game with `published`; `gameCount` = their number; `games` = the first 4 as `{ game: summary, note }`; `game` = the first. Skip the row when nothing is kept or its collection is missing from step 1 (a race with a delete or a PATCH to private).
- **Notification write.** `NewNotification` gains `collection_id`; `try_notify`'s insert becomes `INSERT INTO notifications (recipient_id, kind, group_key, game_id, comment_id, collection_id, created_at, updated_at) SELECT ?1, ?2, ?3, ?5, ?6, ?10, ?7, ?7 WHERE …` (F018 settings, mute and dedupe predicates unchanged). For this kind: recipient = the game owner, group `coll:{collectionId}:{gameId}`, `game_id` = the game, `comment_id` NULL, `Dedupe::Group`, `thread_id` NULL (so only game mutes match), `collection_id` = the collection, `{col}` = `collections`. Removal: `withdraw_pool(owner, Kind::AddedToCollection, group)` after the remove commits.
- **Notification read path.** The shared `VISIBLE` filter gains one predicate (alias `vc` so it can't clash with the list's join):
  ```sql
  AND (n.collection_id IS NULL OR EXISTS (SELECT 1 FROM collections vc
                                          WHERE vc.id = n.collection_id AND vc.visibility = 'public'))
  ```
  `list_page` adds `LEFT JOIN collections col ON col.id = n.collection_id` and selects `n.collection_id, col.title AS col_title`. Mark-read, mute mark-read and pruning are unchanged (they never named kinds; game mutes already match on `game_id`).
- **UI.** `FeedItem` renders the new kind with a compact game list; `FeedPage` gains a Collections tab (`kinds=collectionUpdated`); `notifications.ts` adds the summary, the game mute action and `osNotificationText` (no collection title in OS notifications); `NotificationSettings` gains the `collections` switch.
- **Ownership**:
  - backend-dev: the migration, `activity.rs`, `routes/feed.rs`, `routes/collections.rs`, `notifications.rs`, `models.rs`, `tests/f021.rs` and the `review2.rs` extension.
  - frontend-dev: types, `notifications.ts`, `FeedItem`, `FeedPage`, `NotificationItem`, `NotificationSettings`, styles and tests.
  - desktop-dev: verification only.


## F016 additions
Gamepad remapping and synced control bindings (spec: `docs/features/F016-gamepad-remapping-and-sync.md`). For signed-in players, this section supersedes the F009 rule "Overrides live on the device. No server storage".

- **Data flow**:
  ```
  ControlsPanel (keys + gamepad capture in the parent) ── writeBindings ──► localStorage webgame.controls.{gameId}
        │                                                                          │ (subscription)
        │                                    GamePlayer ── webgame:controls { overrides, gamepad } ──► iframe engine
        ▼
  useControlsSync (signed in, GamePlayer only) ── GET / PUT {api}/api/games/{id}/controls ──► control_bindings (user, game)
  ```
  The engine never talks to the server. The parent is still the only writer of the device store and the only sender of `webgame:controls`.
- **Data**: migration `backend/migrations/0020_f016.sql` runs after `0019_f021.sql`:
  ```sql
  CREATE TABLE control_bindings (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      bindings    TEXT NOT NULL,   -- normalised ControlBindings as compact JSON, e.g. {"keys":{},"gamepad":{"jump":["B"]}}
      updated_at  TEXT NOT NULL,   -- RFC3339
      PRIMARY KEY (user_id, game_id)
  );
  CREATE INDEX idx_control_bindings_game ON control_bindings(game_id);   -- cascade deletes per game
  ```
  Validation bounds the stored JSON (32 ids × (3 codes + 2 names)) well under 8 KiB. Bindings are not versioned. They are filtered against the current actions when read (API § F016 "Normalisation").
- **Device store** (extends ARCHITECTURE § F009): key `webgame.controls.{gameId}`, value `{ "v": 1, "overrides": { [actionId]: string[] }, "gamepad"?: { [actionId]: GamepadButtonName[] }, "unsynced"?: string }`.
  - The cap on the serialised entry rises from 4096 to **8192** bytes.
  - The other F009 read rules are unchanged: a malformed entry, `v !== 1`, a non-object `overrides` or an oversize entry reads as `{}` and the key is removed.
  - A missing or non-object `gamepad` reads as `{}`. An `unsynced` that is not a non-empty string reads as absent.
  - Entries written by F009 code (without `gamepad`) stay valid. A keys-only write keeps the stored `gamepad`, and a gamepad-only write keeps the stored keys.
  - `unsynced` is the id of the signed-in user whose latest change has not yet been confirmed by a successful `PUT`.
  - The entry is removed only when the bindings are empty **and** `unsynced` is absent. An empty entry that is still unsynced is kept, so a "Reset all" still reaches the account.
- **Sync algorithm** (`packages/ui/src/controlsSync.ts`, `useControlsSync`): mounted by `GamePlayer` only. Anonymous players and the Studio skip it.
  1. **On mount, and whenever the signed-in user changes**:
     - If the device entry's `unsynced` equals the user's id, `PUT` the device bindings without reading the account copy.
     - Otherwise `GET`:
       - If `bindings` is not `null`, write it to the device store (without `unsynced`). The store subscription then posts a fresh `webgame:controls`.
       - If it is `null` and the device bindings are non-empty, `PUT` them.
       - If it is `null` and the device has nothing, do nothing.
     - A failed `GET` leaves the device copy in charge until the next mount. There is no retry loop.
  2. **On every change in the panel**: write the device store at once with `unsynced = userId`, so the game updates immediately. Then debounce a `PUT` by **1000 ms**; changes within the window coalesce into one request.
  3. **On `PUT` success**: if the device entry still holds exactly the bindings that were sent, clear `unsynced` and adopt the server's normalised copy. Otherwise change nothing.
  4. **On `PUT` failure** (network, 401, 429, 5xx): keep `unsynced`, and the panel shows the failed-sync note. The upload is retried on the next change or the next mount. There is no automatic retry timer.
  5. **On unmount** with a pending debounce: send the `PUT` at once with `keepalive: true`.
  - **Conflict rule**: the account copy wins on load, unless this device has an unsynced change for the same user. When two devices edit concurrently, the last successful `PUT` wins. There is no merge.
  - Signing out never touches the device store. When a different user signs in on the device, they adopt the device bindings for a game only if their account has none for it.
- **Gamepad capture runs in the parent.** The parent document is top level, so it can use the Gamepad API in secure contexts (`https`, `localhost`, the Tauri webview). It polls only during capture (`packages/ui/src/gamepadCapture.ts`). The iframe keeps `allow="gamepad"` for gameplay. `Gamepad.id` is held in memory only during capture, as part of the baseline key.
- **Tables**: no new copy. The backend validates with the F009 tables in `bundle.rs`. The engine and the UI keep their own copies (ARCHITECTURE § F009 "Three copies").
- **Engine**: `applyOverrides` gains gamepad overrides. `Input` gains `lastDevice`, the `actionLabel` device option and `latchGamepads()`, which runs on host resume and on window focus. No new modules.
- **Ownership**:
  - engine-dev: `actions.ts`, `input.ts`, `engine.ts`, `index.ts`, the README and the examples.
  - backend-dev: the migration, `routes/controls.rs`, the router entry and body limit, `Limit::Controls` and `tests/f016.rs`.
  - frontend-dev: types, the client, `controls.ts`, `gamepadCapture.ts`, `controlsSync.ts`, `GamepadCaptureButton`, `ControlsPanel`, `ControlsSummary`, `GamePlayer`, `StudioPreview`, templates, the docs page, styles and tests.
  - desktop-dev: verification only (WebView2 gamepad capture, cross-app sync, CSP).

### F016 implementation notes (frontend)
- **Uploads stay with the user who made the change.** Each pending upload records the user id and token from when it was scheduled. Right before any `PUT`, the client checks them against the current session. If either differs, nothing is sent and the entry stays marked unsynced for the original user.
  - The check covers the debounce timer, the `pagehide` and unmount keepalive flushes, the upload at sign-in, and adopting or uploading after a `GET`.
  - There is no automatic retry. A later change or sign-in triggers the next attempt.
- **Another user's unsynced change on the device:** if the device holds an unsynced change that belongs to a different user, the signed-in user skips the `GET`. Their footer reads "Saved on this device".
  - The other user's change is neither overwritten nor uploaded into this account.
  - The signed-in user's own next change takes the entry over and uploads it to their account.
- **The unsynced marker in `writeBindings`:** leaving out `opts.unsynced` keeps the stored marker, `null` clears it, and a user id sets it. Writes that change only the marker don't notify subscribers, so no duplicate `webgame:controls` message is sent.
- **Failed `GET`:** the "Couldn't save to your account" note shows only when the device holds bindings the account might be missing. A 404 from a server older than F016 counts as an upload failure.
- **Games with no declared actions** never call the controls endpoints.
- **Capture:** only one capture slot, key or gamepad, can be listening at a time.
- **The row's Reset button** comes after the gamepad slots, because it resets both keys and gamepad buttons.


## Review-fix additions (REVIEW-2026-11-17-7)
These rules replace the F016 frontend implementation notes above where the two differ.

### Who an upload belongs to (M1, L1)
- A sync session starts on mount and whenever the signed-in user or the auth token changes. It records the user id and the client token once, when it starts.
- Every upload is sent only if both still match when it is about to go out. This covers the debounced upload, the keepalive flush, the upload when the session starts, and the upload after the `GET`.
- If either has changed, nothing is sent. The device entry stays marked unsynced for that user, and the panel shows the failed-sync note.
- When the token changes in another tab, `AuthProvider` sets the user to unknown at once and shows loading until `/users/me` confirms who the new token belongs to.
  - If `/users/me` fails, nobody is signed in; it never falls back to the old user.
  - An answer for a token that has since been replaced is dropped.

### Shared devices (L2)
- The device entry `webgame.controls.{gameId}` holds the bindings in play. `unsynced` names the signed-in user whose latest change there is not yet confirmed.
- A change made while signed out clears `unsynced`, so it is never uploaded as anyone's change.
- When user U's session starts:
  1. If the entry is unsynced for another user X, X's bindings are moved to `webgame.controls.{gameId}.pending.{X}` (same format, without `unsynced`). The device entry is then cleared, and the game gets the defaults.
  2. If a moved-aside entry exists for U, it becomes the device entry again with `unsynced = U`, and its separate key is removed.
  3. If the entry is unsynced for U, it is uploaded without a `GET`. Otherwise U's copy is fetched with `GET`:
     - if U has a copy, the device adopts it;
     - if not, and the device bindings aren't empty, they are marked `unsynced = U` and uploaded.
- So U never edits on top of X's bindings, and X's change is uploaded only to X's account, at X's next sign-in on this device.
- Edge case: if the device held another user's unsynced change and U's account has no copy, U starts from the defaults.

### One upload at a time (L3)
- Each game has at most one `PUT` in flight.
- Uploads requested in the meantime collapse into one waiting upload. When it runs, it reads the latest device bindings. It is skipped if the entry is no longer unsynced for that user.
- The keepalive flush on unmount or `pagehide` goes out at once when nothing is in flight. Otherwise it waits for the current request, then sends the latest bindings with `keepalive`. If the page is gone by then, the marker stays and the next session uploads the change.
- The marker is cleared only when the device bindings equal what the successful `PUT` sent.


## F019 additions
Engine UI widgets 2 (spec: `docs/features/F019-ui-widgets-2.md`). Engine-only. **No migration** (the latest stays `0020_f016.sql`; the next free number is still `0021`), no endpoints, no messages and no new Rust or JS dependencies.
- **Engine modules** (engine-dev, `packages/engine/src/`):
  - `ui.ts` gains `slider`, `toggle`, `textField`, `list`, `changed`, `committed`, `listCursor` and `editing`. The command union gains `slider`, `toggle`, `field` and `list` entries; `exec` draws them. Widget state lives in one `Map<string, WidgetState>` keyed by id (`{ kind, cursor, scroll, caret, runStart, original, pressRow, pressY, pressScroll, dragChanged }`), pruned in `endStep` to the ids declared in that step.
  - `uitext.ts` (new, pure, no DOM): code-point editing (`insertText`, `applyTextEvent`), the visible-run window, caret-from-x and `truncateToWidth`, all taking a `measure(text) → width` function so they are testable in node.
  - `input.ts`: the `textEvents` queue (keydown + `paste` listeners), `keyboardCaptured`, `setKeyboardCapture(on)` (engine-internal), `clearTextEvents()` (engine-internal) and a keyboard-filtering `ButtonSource` wrapper passed to `ActionMap.update` while captured (with the first-step synthetic release and the end-of-capture key latch).
  - `engine.ts`: passes the fixed-step `dt` to `ui.beginStep(dt)` (for hold repeat), and calls `input.clearTextEvents()` when a pause ends.
  - `UiInput` gains `actionDown`, `isDown`, `mouse.wheel`, `textEvents`, `gamepad(i).isDown` and an optional `setKeyboardCapture`. `UiRenderer` gains `measureText`. Both stay injected, so all rules are node-testable.
- **Step order** (unchanged hooks, one new hand-off):
  ```
  input.beginStep (textEvents handed over; capture state applied to actions) → ui.beginStep(dt)
      → game/scene update (widgets) → ui.endStep (commit list, prune state, input.setKeyboardCapture(editing !== null))
      → input.endStep
  ```
  Capture therefore lags editing by exactly one step on both ends, which is what makes the first-step `actionReleased` and the end-of-capture latch well defined.
- **Why keyboard capture lives in `Input`**, not in games: a name field on a game-over screen must not also trigger the game's `confirm`/`left`/`jump` actions bound to letter keys. Filtering at the `ActionMap` input keeps one rule for actions, `axis()` and F012 menu navigation, and leaves raw input untouched for games that need it.
- **No platform involvement.** Text typed into a field stays inside the sandboxed, opaque-origin game iframe. There is no new message, no host keyboard handling and no clipboard permission: `paste` events only fire on a user paste gesture into the iframe document.
- **Studio and docs** (frontend-dev): the `menu-hud` template gains a settings screen using all four widgets; the docs page section 16 gains a "Settings and text entry" subsection. Desktop: verification only.
- **Ownership**: `ui.ts`, `uitext.ts`, `input.ts`, `engine.ts`, the engine README and the Ember Garden settings scene belong to engine-dev; `templates.ts` and `DocsPage.tsx` to frontend-dev.

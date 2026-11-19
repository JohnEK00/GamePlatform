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
  - `uitext.ts` (new, pure, no DOM): code-point editing (`filterText`, `applyTextEvents`, `TEXT_EDIT_KEYS`), the visible-run window (`visibleRun`), caret-from-x (`caretFromX`) and `truncateToWidth`, all taking a `measure(text) → width` function so they are testable in node.
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


## F020 additions
Game comment settings (spec: `docs/features/F020-game-comment-settings.md`). Two `games` columns, one small table, one endpoint in `routes/comments.rs`, one new `AppError` variant. No new dependencies, no engine changes.
- **Model.** The mode and the slow-mode interval are per-game columns on `games` (read through `GAME_SELECT`, so `create_comment` and `list_comments` get them from the game row they already load). Slow mode is enforced from `comment_post_times`, one row per (game, user) holding the time of that user's last **successful** post on that game. It is written on every post, not only while slow mode is on, so turning slow mode on applies immediately and deleting a comment never resets the wait.
- **No CHECK constraints** on the new `games` columns: values are validated in Rust (`CommentMode`, `SLOW_MODE_SECS`), so later modes need no rebuild of `games` (which has many inbound FKs). Unknown stored values read as `on` / `0` with a warning.
- **Data**: migration `backend/migrations/0021_f020.sql` runs after `0020_f016.sql`:
  ```sql
  -- F020: game comment settings (docs/ARCHITECTURE.md § F020 additions).
  ALTER TABLE games ADD COLUMN comment_mode TEXT NOT NULL DEFAULT 'on';            -- 'on' | 'repliesOnly' | 'off' (validated in Rust)
  ALTER TABLE games ADD COLUMN comment_slow_mode_secs INTEGER NOT NULL DEFAULT 0;  -- 0 | 30 | 60 | 300 | 900 | 3600 (validated in Rust)

  CREATE TABLE comment_post_times (
      game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_posted_at TEXT NOT NULL,   -- RFC3339 millis Z (same format as comments.created_at)
      PRIMARY KEY (game_id, user_id)
  );
  CREATE INDEX idx_comment_post_times_user ON comment_post_times(user_id);   -- user delete cascade

  INSERT INTO comment_post_times (game_id, user_id, last_posted_at)
  SELECT game_id, user_id, MAX(created_at) FROM comments GROUP BY game_id, user_id;
  ```
- **Write path** (`create_comment`, one transaction; `now` is one `now_rfc3339()` value used for both tables):
  ```sql
  -- 1. Slow-mode claim (first statement writes, so the deferred transaction takes the write lock at once).
  --    ?4 = 1 when the check is skipped (slowModeSecs = 0 or the poster is the owner/an admin);
  --    ?5 = cutoff = now − slowModeSecs, formatted like now_rfc3339() (string comparison is chronological).
  INSERT INTO comment_post_times (game_id, user_id, last_posted_at) VALUES (?1, ?2, ?3)
  ON CONFLICT (game_id, user_id) DO UPDATE SET last_posted_at = excluded.last_posted_at
   WHERE ?4 = 1 OR comment_post_times.last_posted_at <= ?5;
  -- 0 rows → ROLLBACK; SELECT last_posted_at → AppError::SlowMode { retry_after: clamp(ceil(last + secs − now), 1, secs) }.
  -- 2. The existing insert: plain top-level INSERT, or the F017 guarded reply INSERT … SELECT … WHERE ….
  -- 0 rows → ROLLBACK; the F017 re-read decides 404 / 422 locked / 422 cap.
  -- 3. COMMIT, then the F007 notification hook (unchanged, after the commit).
  ```
  The mode check (API § F020 step 5b) happens before the transaction from the loaded game row and is not repeated inside it (a settings change racing a post may let one post through; accepted).
- **Read shapes**:
  - `GAME_SELECT` adds `g.comment_mode, g.comment_slow_mode_secs`; `GameRow::game` fills `Game.commentSettings`.
  - `list_comments` builds `CommentListPage.settings` from the game row and the already loaded `Viewer` (`canManage` = owner or admin). `waitSecs` needs one primary-key lookup, `SELECT last_posted_at FROM comment_post_times WHERE game_id = ? AND user_id = ?`, made only for a signed-in, non-managing viewer when `comment_slow_mode_secs > 0`.
- **Settings write**: `UPDATE games SET comment_mode = ?, comment_slow_mode_secs = ? WHERE id = ?`. It leaves `updated_at`/`last_updated_at` alone (those drive sorting and the F004 "Updated" badge).
- **Errors**: `AppError::SlowMode { retry_after }` → 429, code `slow_mode`, `Retry-After` set like `RateLimited`. It is not a `RateLimiter` bucket, so `RATE_LIMIT=off` doesn't disable it.
- **Feed and notifications**: none written or retracted by settings changes. Rejected posts write nothing, so F007 hooks run only for committed posts (unchanged).
- **UI**: `CommentSettingsForm` + `CommentSettingsDialog` (new), changes in `Comments`, `CommentForm`, `EditGamePage`; helpers in `api/comments.ts`. The slow-mode countdown is a monotonic deadline (`performance.now()`) seeded from server-relative seconds (`waitSecs`, `Retry-After`), so client clock skew never matters.
- **Ownership**: the migration, `error.rs`, `models.rs`, `routes/comments.rs`, `routes/mod.rs`, the `Limit::ThreadTools` doc comment and `tests/f020.rs` belong to backend-dev. Types, client, `api/comments.ts`, the components, `EditGamePage`, styles and UI tests belong to frontend-dev. Desktop has no code changes.


## F015 additions
Screenshots in the feed and on profiles (spec: `docs/features/F015-screenshots-in-feed-and-profiles.md`). One index-only migration, one activity writer, one predicate in branch (a) of `FEED_SQL`, one batched assembly query, and one public list endpoint. No `activity_events` rebuild (F021 removed the kind CHECK), and no new dependencies, engine or desktop code.
- **Model.** A `screenshotPosted` event is an `activity_events` row with `game_id` set and no other payload. It is keyed by (actor, game, UTC day), and each post replaces it (delete + insert, the `personalBest` pattern via `idx_activity_coalesce`). The row stores **no** screenshot ids: the shots of an item are those with `author_id = actor_id`, `game_id = game_id` and `substr(created_at, 1, 10) = day`, evaluated at read time. So deletes (author, owner, admin, report resolve) apply at once, and an item with no shots left is skipped.
- **Data**: migration `backend/migrations/0022_f015.sql` runs after `0021_f020.sql`. Normative:
  ```sql
  -- F015: screenshots in the feed and on profiles (docs/ARCHITECTURE.md § F015 additions).
  -- The profile list (an author's screenshots, newest first) without a temp B-tree sort.
  -- The feed uses the existing idx_screenshots_author_game (0009).
  CREATE INDEX idx_screenshots_author_created ON screenshots(author_id, created_at DESC, id);
  ```
- **Writer** (`activity::record_screenshot_posted(conn, actor_id, game_id, now)`; nested transaction and `log_failure` like the other writers; `?3` day = `now[..10]`; `now` is the exact `created_at` string bound in the screenshot insert):
  ```sql
  DELETE FROM activity_events
  WHERE actor_id = ?1 AND game_id = ?2 AND kind = 'screenshotPosted' AND day = ?3;
  INSERT INTO activity_events (actor_id, kind, game_id, day, created_at)
  VALUES (?1, 'screenshotPosted', ?2, ?3, ?4);
  ```
  Called from `routes/screenshots.rs::create_screenshot` after the guarded insert affected one row, and only when the game returned by the step-2 `fetch_visible_game` has `published`. It runs through `activity::acquire(&state.db)`, as `scores.rs` does for `personalBest`. The game owner is **not** excluded.
- **Feed query** (`FEED_SQL`): branch (a) gains one predicate, after the existing `achievementUnlocked` one. Branches (b) and (c) are unchanged; branch (b) already restricts kinds to `gamePublished`/`gameUpdated`.
  ```sql
  AND (e.kind <> 'screenshotPosted' OR EXISTS (
        SELECT 1 FROM screenshots s INDEXED BY idx_screenshots_author_game
        WHERE s.author_id = e.actor_id AND s.game_id = e.game_id
          AND substr(s.created_at, 1, 10) = e.day))
  ```
  The extended `tests/review2.rs` N1 test asserts that the plan contains `idx_screenshots_author_game (author_id=? AND game_id=?)` and never scans `screenshots`. All earlier plan assertions hold.
- **Feed assembly** (`get_feed`, one query per page, only when the page has `screenshotPosted` rows). `?1` is a JSON array of `[actorId, gameId, day]` triples taken from the page's rows (`u_id`, `game_id`, `day`). The column list matches `SCREENSHOT_SELECT`, so `screenshot_from_row` reads it.
  ```sql
  -- routes/screenshots.rs: FEED_SCREENSHOTS_SQL
  SELECT s.id, s.game_id, s.author_id, s.caption, s.ext, s.width, s.height, s.game_version, s.created_at,
         g.owner_id, g.title AS game_title,
         u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name,
         u.avatar_ext AS a_avatar_ext, u.avatar_version AS a_avatar_version,
         json_extract(p.value, '$[0]') AS p_actor, json_extract(p.value, '$[1]') AS p_game,
         json_extract(p.value, '$[2]') AS p_day
  FROM json_each(?1) p
  CROSS JOIN screenshots s INDEXED BY idx_screenshots_author_game
  JOIN users u ON u.id = s.author_id
  JOIN games g ON g.id = s.game_id
  WHERE s.author_id = json_extract(p.value, '$[0]') AND s.game_id = json_extract(p.value, '$[1]')
    AND substr(s.created_at, 1, 10) = json_extract(p.value, '$[2]')
  ORDER BY p.key, s.created_at DESC, s.id
  ```
  Rust groups the rows by `(p_actor, p_game, p_day)` in order. Per row: `count` = the group length, `items` = the first `FEED_SCREENSHOTS_MAX` (4) via `screenshot_from_row` with `Viewer { id: viewer, admin: is_admin(viewer) }` (`is_admin` is called once per page). An empty group skips the row.
- **Profile query** (`list_user_screenshots`; `?1` author id, `?2` viewer id or NULL):
  ```sql
  SELECT COUNT(*) FROM screenshots s JOIN games g ON g.id = s.game_id
  WHERE s.author_id = ?1 AND (g.published = 1 OR g.owner_id = ?2);

  {SCREENSHOT_SELECT} WHERE s.author_id = ?1 AND (g.published = 1 OR g.owner_id = ?2)
  ORDER BY s.created_at DESC, s.id LIMIT ?3 OFFSET ?4;
  ```
  `SCREENSHOT_SELECT` gains `g.title AS game_title`. A test asserts that the page plan uses `idx_screenshots_author_created` without `USE TEMP B-TREE FOR ORDER BY`. The response type `UserScreenshot` is `Screenshot` flattened with `game: ScreenshotGameRef { id, title }`.
- **UI.**
  - `ScreenshotLightbox` (extracted from `ScreenshotGallery`) is shared by the game page gallery, the feed's `ScreenshotFeedItem` and the new `ProfileScreenshots`. Only the game page shows "Set as thumbnail"; only the feed and the profile show "View on game page".
  - `FeedPage` gains a Screenshots tab (`kinds=screenshotPosted`).
  - `GamePage` handles `?section=screenshots`, and `util.ts` gains `gameScreenshotsPath`.
- **Ownership**:
  - backend-dev: the migration, `activity.rs`, `routes/screenshots.rs`, `routes/feed.rs`, `routes/mod.rs`, `tests/f015.rs` and the `review2.rs` extension.
  - frontend-dev: types, client, `util.ts`, `ScreenshotLightbox`, `ScreenshotGallery`, `FeedItem`, `FeedPage`, `ProfileScreenshots`, `ProfilePage`, `GamePage`, styles and tests.
  - desktop-dev: verification only.

### F015 desktop note: external links
In the desktop app, `target="_blank"` links (such as "Open image" in the screenshot lightbox on the game page, the feed and profiles, or the admin report thumbnail) used to do nothing: WebView2 drops new-window requests unless there is a handler.

`apps/desktop/src-tauri/src/external.rs` now handles them:
- **Never a second window:** it never opens a second webview.
- **Allowed URLs only:** it opens the URL in the default system browser only if the URL:
  - is `http` or `https`;
  - has a host;
  - has no credentials;
  - is at most 2048 bytes;
  - contains no whitespace, quotes or control characters.
- **Rate limited:** at most one URL every 500 ms.
- **No shell:** the browser is started directly with `rundll32 url.dll,FileProtocolHandler`, `open` or `xdg-open`.

The main window is now created in `setup` from its `tauri.conf.json` entry (`create: false`) so that it gets this handler. Game iframes can't trigger it, because their sandbox doesn't include `allow-popups`.


## F023 additions
On-screen keyboard for `ui.textField` (spec: `docs/features/F023-on-screen-keyboard.md`). Engine-only.

**No migration**: the latest stays `0022_f015.sql`, and the next free number is still `0023`. There are also no endpoints, no messages and no new Rust or JS dependencies. The examples don't change, so nothing is repacked.

- **Engine modules** (engine-dev, `packages/engine/src/`):
  - **`osk.ts`** (new; pure, with no DOM or renderer). It holds:
    - `OSK_ROWS` (the layout table);
    - `oskLayout(gameW, gameH, fieldRect)`, the sizing and docking formula, which returns `null` when the keyboard doesn't fit;
    - `oskKeyAt(layout, x, y)`;
    - `oskMove(cursor, dx, dy)`, for anchor-column movement with wrapping;
    - `oskLabel` and `oskChar`.

    It is node-testable without a `Ui`.
  - **`ui.ts`**:
    - `TextFieldOptions.keyboard` and the exported type `TextFieldKeyboard`.
    - One private keyboard state: `{ field, shown, upper, cursor { row, col, anchor }, pressKey, layout, fieldRect, mode }`, plus three repeat timers (vertical, horizontal, `DEL`).
    - The read-only `keyboardRect`.
    - An `osk` command kind drawn by `exec` (review 10, L4).
    - `UiInput` gains an optional `lastDevice`, and its gamepad button type widens to `A`, `B`, `X`, `Y`, `LB`, `Start` and the D-pad. `UiRenderer` gains optional `width`/`height`.

    `engine.input` and `engine.renderer` already provide all of these. Test doubles without them never show a keyboard.
  - **`index.ts`**: exports the type `TextFieldKeyboard`. `osk.ts` stays internal.
- **Step order** (no new engine hooks):
  ```
  input.beginStep → ui.beginStep(dt)
      pointerStep: keyboard panel hit-test first (previous step's layout), then widgets
      navigateStep (editing branch): revert / keyboard routing / raw Enter, ArrowUp/Down
      → oskEvents[] + editAction for this step
  → game/scene update: the editing textField applies input.textEvents then oskEvents;
      a step that starts editing decides `shown` from input.lastDevice and `keyboard`
  → ui.endStep: close when editing ended; otherwise lay out, evaluate disabled keys (allow, maxLength, caret),
      append the keyboard command after the widgets, set keyboardRect → input.endStep
  ```
  The keyboard therefore acts one step after it is first drawn, which is why the gamepad `A` that starts editing never also types.
- **Why it's in the engine** (not the host page, and not a hidden `<input>`):
  - Game iframes are sandboxed and opaque-origin.
  - Raising an OS keyboard needs focus inside the user gesture, which the fixed-step model can't promise (F019 § 5).
  - OS keyboards don't work with controllers.

  An engine-drawn keyboard keeps everything inside the frame and the fixed step, and uses the game's theme.
- **No platform involvement**: no message, no host UI, no permission. Keyboard events go only to the edited field. They never reach `input.textEvents`, actions or `lastDevice`.
- **Studio and docs** (frontend-dev):
  - The `menu-hud` template drops its "Type your name with a keyboard" hint.
  - The docs page section 16 gains an "On-screen keyboard (F023)" subsection.
  - Desktop: verification only.
- **Ownership**:
  - engine-dev: `osk.ts`, `ui.ts`, `index.ts`, the engine README and the engine tests.
  - frontend-dev: `templates.ts`, `DocsPage.tsx` and their tests.


## F024 additions
"Screenshot of your game" notifications (spec: `docs/features/F024-screenshot-notifications.md`). This round adds one migration (two added columns and one index swap; no table rebuild), one notification kind, one hook in `create_screenshot` and one batched read query. There are no new endpoints or dependencies, and no engine or desktop source changes.
- **Model.**
  - `screenshotPosted` is a normal F007 kind with `Dedupe::None`, grouped per game (`game:{gameId}`, `notifications::game_group`) for the game owner.
  - Each event stores its screenshot in `notification_events.screenshot_id` (`ON DELETE CASCADE`). Deleting a screenshot through any path (`remove_screenshot`, game delete, user delete) deletes its event through the foreign key, and the `0014` trigger `notification_events_last_gone` deletes a notification left with no events. That is how comment events already behave, so there is no withdraw/restore logic and no code in the delete paths.
- **Data**: migration `backend/migrations/0023_f024.sql` runs after `0022_f015.sql`. Normative, in this order:
  ```sql
  -- F024: "screenshot of your game" notifications (docs/ARCHITECTURE.md § F024 additions).

  -- 1. The screenshot of a screenshotPosted event (NULL for every other kind). Deleting the screenshot
  --    deletes the event; the 0014 trigger then deletes a notification left without events.
  --    ADD COLUMN with REFERENCES is allowed because the default is NULL.
  ALTER TABLE notification_events ADD COLUMN screenshot_id TEXT REFERENCES screenshots(id) ON DELETE CASCADE;
  CREATE INDEX idx_notification_events_screenshot ON notification_events(screenshot_id) WHERE screenshot_id IS NOT NULL;

  -- 2. One event per screenshot: append screenshot_id to the dedupe key, so two screenshots by one author in one
  --    unread group are two events (with the 0013 key the second INSERT OR IGNORE would be dropped). The new key is
  --    strictly finer than the old one, so existing rows can't violate it.
  DROP INDEX idx_notification_events_dedupe;
  CREATE UNIQUE INDEX idx_notification_events_dedupe ON notification_events(notification_id, actor_id, IFNULL(comment_id, ''), IFNULL(screenshot_id, ''));

  -- 3. The screenshotPosted kind's setting.
  ALTER TABLE notification_settings ADD COLUMN screenshots INTEGER NOT NULL DEFAULT 1 CHECK (screenshots IN (0, 1));
  ```
  - `tests/f018.rs` compares post-migration index SQL with its 0016 baseline. It excludes `idx_notification_events_screenshot` and normalises the dedupe entry after asserting its new definition (spec § 4 backend task 8).
- **Write path** (`routes/screenshots.rs::create_screenshot`). This runs after the guarded insert affected one row and after the F015 `record_screenshot_posted` block, and before the step-12 re-read:
  ```rust
  if game.published && game.owner_id != user.id {
      let at = DateTime::parse_from_rfc3339(&now).map(|t| t.with_timezone(&Utc)).unwrap_or_else(|_| Utc::now());
      notifications::notify_pool(&state.db, &NewNotification {
          recipient_id: game.owner_id.clone(), kind: Kind::ScreenshotPosted, group_key: game_group(&game_id),
          game_id: Some(game_id.clone()), comment_id: None, actor_id: user.id.clone(),
          event_comment_id: None, event_screenshot_id: Some(id.clone()), dedupe: Dedupe::None,
          thread_id: None, collection_id: None, now: at,
      }).await;
  }
  ```
  - `try_notify` is unchanged except for the event insert, which writes `screenshot_id`: `INSERT OR IGNORE INTO notification_events (notification_id, actor_id, comment_id, screenshot_id, created_at) VALUES (?, ?, ?, ?, ?)`. Settings (`{col}` = `screenshots`), F018 mutes (`?9` NULL, so only game mutes match) and the open-group upsert are unchanged.
  - If the screenshot was deleted in between, the event insert fails its foreign key check, the whole `BEGIN IMMEDIATE` transaction rolls back, and the failure is logged.
- **Read path** (`notifications::list_page`):
  - `eventCount` counts live events for `screenshotPosted`, as for `comment`/`reply`.
  - `path` = `/games/{gameId}?section=screenshots`.
  - `commentId`, `threadId`, `excerpt` and `collection` are `None`.
  - One batched query, only for the page's `screenshotPosted` ids:
  ```sql
  SELECT notification_id, screenshot_id FROM (
    SELECT notification_id, screenshot_id, ROW_NUMBER() OVER (
      PARTITION BY notification_id ORDER BY created_at DESC, id DESC) AS rn
    FROM notification_events
    WHERE notification_id IN (SELECT value FROM json_each(?1))
      AND screenshot_id IS NOT NULL AND retracted_at IS NULL)
  WHERE rn = 1
  ```
  → `Notification.screenshot = Some(NotificationScreenshot { id, thumb_url: screenshots::thumb_url(&id) })`. `VISIBLE`, `unread_count`, `mark_read`, mutes and pruning are unchanged (none of them names kinds, except `mute_thread`, which correctly doesn't include this kind).
- **Settings**: `notification_settings.screenshots` ↔ `NotificationSettings.screenshots`. `SettingsPatch.screenshots` is bound as `?10` in `update_settings`.
- **UI.**
  - `notifications.ts` adds the summary, the game mute action and `screenshotThumb`.
  - `NotificationItem` adds the 📷 glyph and a decorative 48 px thumbnail (`NotificationShot`, resolved with `api.url`, so desktop gets an absolute URL on the configured server).
  - `NotificationSettings` adds the eighth switch.
  - `osNotificationText` needs no change (no user free text beyond names and the game title).
- **Ownership**:
  - backend-dev: the migration, `notifications.rs`, `models.rs`, `routes/notifications.rs`, `routes/screenshots.rs`, the `event_screenshot_id: None` additions in `routes/comments.rs`, `routes/follows.rs` and `routes/collections.rs`, `tests/f024.rs`, and the `tests/f007.rs` and `tests/f018.rs` adjustments.
  - frontend-dev: types, `index.ts`, `notifications.ts`, `NotificationItem`, `NotificationSettings`, styles and tests.
  - desktop-dev: `apps/desktop/src/__tests__/f024.desktop.test.tsx` only.


## F028 additions
Public profiles 2 (spec: `docs/features/F028-public-profiles-2.md`). This round adds one migration (three added columns; no rebuild, no index), two banner endpoints, link validation, profile stats, a `user` report target, a profile shell in the UI and one desktop menu item. There are no new dependencies and no engine changes.
- **Data**: migration `backend/migrations/0024_f028.sql` runs after `0023_f024.sql`. Normative:
  ```sql
  -- F028: public profiles 2 (docs/ARCHITECTURE.md § F028 additions).

  -- Profile banner: always "jpg" when set (re-encoded server-side); the version busts caches like avatar_version.
  ALTER TABLE users ADD COLUMN banner_ext TEXT;
  ALTER TABLE users ADD COLUMN banner_version INTEGER NOT NULL DEFAULT 0;

  -- Profile links: a JSON array of {"label","url"} (0-3 items), validated by PATCH /api/users/me.
  ALTER TABLE users ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]';
  ```
- **Model** (`models.rs`):
  - `ProfileLink { label, url }`;
  - `User.banner_url` (via `banner_url(id, ext, version)` → `/media/banners/{id}.{ext}?v={version}`) and `User.links`;
  - `USER_COLUMNS` gains `banner_ext, banner_version, links_json`;
  - `user_from_row` parses `links_json` leniently (`unwrap_or_default`);
  - `UserRef` and `user_ref_from_row` are unchanged.
- **Storage and media.**
  - `Storage::banners_dir()` = `{DATA_DIR}/banners`, created by `ensure_dirs`. Files are `{userId}.jpg`, written with `replace_image` (atomic rename) and removed with `remove_images`.
  - `public_router` serves `/media/banners` through `ServeDir` behind the same `screenshot_media_headers` response layer as `/media/screenshots` (1 h cache, `nosniff`, `CSP: sandbox`, `no-store` on errors).
- **Banner pipeline** (`screenshots.rs`):
  - `process_screenshot`'s steps 1–3 (header checks, decode budget, limited decode, flatten to RGB8) move unchanged into `decode_rgb(bytes) -> (RgbImage, ImageFormat)`, which both pipelines use.
  - `banner_crop(w, h)`:
    ```text
    if w >= 3*h { cw = 3*h; ch = h;     x = (w - cw) / 2; y = 0 }
    else        { cw = w;   ch = w / 3; x = 0;            y = (h - ch) / 2 }     // integer division
    ```
  - `process_banner`:
    1. `decode_rgb`;
    2. `crop_imm(x, y, cw, ch)`;
    3. require `cw >= 600 && ch >= 200`;
    4. if `cw > 1500`, `resize(.., 1500, 500, FilterType::Triangle)`;
    5. `encode_jpeg(.., 85)`.
  - `users::upload_banner` runs it in `spawn_blocking` while holding an `image_slots` permit (otherwise it returns `routes::screenshots::busy()`, now `pub(crate)`), after `Limit::Image` and `validate_image(&bytes, "banner")`.
- **Link validation**: `users::validate_links`, a pure function implementing API § F028 "Link rules". `update_me` validates displayName, bio and links, then writes all present fields in one transaction (`UPDATE users SET … WHERE id = ?`).
- **Stats** (`users::get_user`). `?1` = the profile user id, `?2` = the viewer id or NULL, and `{filter}` = the existing games filter (`""` for the owner, `AND g.published = 1` otherwise):
  ```sql
  -- plays (same rows as games_total)
  SELECT COALESCE(SUM(g.plays), 0) FROM games g WHERE g.owner_id = ?1 {filter};
  -- achievements (the list_user_achievements rule, without LIMIT)
  SELECT COUNT(*) FROM user_achievements ua
    JOIN achievements a ON a.game_id = ua.game_id AND a.ach_id = ua.ach_id
    JOIN games g ON g.id = ua.game_id
   WHERE ua.user_id = ?1 AND (g.published = 1 OR g.owner_id = ?2);
  ```
  - `screenshots` runs `routes::screenshots::user_screenshots_count_sql()` with binds (author, viewer).
  - `collections` runs `SELECT COUNT(*) FROM collections c WHERE {USER_COLLECTIONS_FILTER}` with binds (owner, viewer, is_self). The filter string moves out of `list_user_collections` into `routes::collections::USER_COLLECTIONS_FILTER`, and both callers use it.
  - Each count therefore equals its list endpoint's `total`.
- **Reports**:
  - `TARGET_TYPES` gains `"user"` (no schema change since `0016`).
  - `create_report`'s `user` branch stores `target_game_id` NULL and `target_preview` `@{username}`.
  - `admin_resolve_report` applies the validity table in API § F028 and calls `users::clear_profile`: one `UPDATE` (display name ← username, bio, links, avatar and banner cleared, versions + 1), then file removal for both images.
- **UI** (`@webgame/ui`):
  - **Shell.** `ProfilePage` is now a layout route at `u/:username` with child routes:
    - index → `ProfileOverview`;
    - `games` → `ProfileGamesTab`;
    - `screenshots` → `ProfileScreenshotsTab`;
    - `collections` → `UserCollectionsPage`.

    It fetches `GET /api/users/{username}` once per (username, viewer) and passes `{ profile, isMe, reload }` through `useOutletContext` (`useProfileOutlet()`). It renders `ProfileHeader` and the `.pf-profile-tabs` `<nav>` of `NavLink`s. `/me` → `MyProfileRedirect`.
  - **Followers/following** stay standalone routes outside the shell.
  - **Games section** pages through `GET /api/games?owner={username|me}&sort=new`, not the profile endpoint.
  - **Sharing.** `share.ts` (`appShareUrl`, `profileShareUrl`, `LINK_COPIED_MS`) generalises `collectionShareUrl`, which keeps its output.
  - **New components.** `CopyLinkButton`, `ProfileHeader`, `ProfileLinksEditor` and `BannerSettings`.
  - **Links.** `profile.ts` mirrors the server URL rule (`isSafeProfileUrl`). Links are rendered only when safe, with `target="_blank" rel="noopener noreferrer nofollow ugc"`.
- **Desktop**:
  - View → My Profile (`profile`, forwarded, no accelerator) → `nativeMenu.ts` `ROUTES.profile = "/me"`.
  - Profile links reach the system browser through the existing `external.rs` new-window handler.
  - Banner URLs are absolute on the configured server (`api.url`), which the CSP `img-src` already allows.
- **Ownership**:
  - backend-dev: the migration, `storage.rs`, `models.rs`, `screenshots.rs`, `routes/users.rs`, `routes/mod.rs`, `routes/reports.rs`, `routes/collections.rs` (the filter constant), `routes/screenshots.rs` (`busy` visibility), `tests/f028.rs`, and the one `tests/f008.rs` message update.
  - frontend-dev: `api/types.ts`, `api/client.ts`, `share.ts`, `profile.ts`, `util.ts`, `collections.ts`, the new components, `ProfileScreenshots`, `ProfilePage`, `ProfileSections`, `UserCollectionsPage`, `SettingsPage`, `Report.tsx`, `AdminPage`, `Layout.tsx` (the user menu's Profile → `/me`), `WebGameApp.tsx`, `index.ts`, `styles.css` and tests.
  - desktop-dev: `src-tauri/src/menu.rs`, `src/nativeMenu.ts` and `src/__tests__/f028.desktop.test.tsx`.


## F030 additions
User posts (spec: `docs/features/F030-user-posts.md`). This round adds:
- one migration: a `posts` table and one `activity_events` rebuild following the F021 template;
- `routes/posts.rs` with four endpoints;
- `Limit::Post`;
- a fourth `FEED_SQL` branch with batched assembly;
- a `post` report target;
- `ProfileStats.posts`;
- a Posts section, permalink and feed tab in the UI.

There are no new dependencies, no engine changes, no desktop source changes and no notifications.
- **Why a rebuild.** Since F021, `activity_events` has `CHECK (game_id IS NOT NULL OR collection_id IS NOT NULL)`. A post without an attachment has neither column, and SQLite can't alter a CHECK. So the table is rebuilt once, with a `post_id` column and the CHECK extended to `post_id`.
  - A `postCreated` row always has `game_id` and `collection_id` NULL. The attachment lives only in `posts`, so branches (a) and (c) never pick these rows, and the feed shows an attachment by its current state.
  - No table references `activity_events`, and it has no triggers (checked against `0001`–`0024`).
- **Data**: migration `backend/migrations/0025_f030.sql` runs after `0024_f028.sql`. Normative, in this order:
  ```sql
  -- F030: user posts (docs/ARCHITECTURE.md § F030 additions).

  -- 1. Posts: public, plain text (validated in Rust: routes::posts::validate_post_body).
  --    attachment_type is 'game' | 'collection' | NULL (validated in Rust; no CHECK, like the other
  --    kind columns). The target column is SET NULL when its target is deleted, so the type survives
  --    and clients show "no longer available".
  CREATE TABLE posts (
      id              TEXT PRIMARY KEY,                                      -- UUID v4
      author_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body            TEXT NOT NULL,
      attachment_type TEXT,                                                  -- NULL = no attachment
      game_id         TEXT REFERENCES games(id) ON DELETE SET NULL,          -- attachment_type 'game'
      collection_id   TEXT REFERENCES collections(id) ON DELETE SET NULL,    -- attachment_type 'collection'
      created_at      TEXT NOT NULL,                                         -- RFC3339 millis Z
      CHECK (game_id IS NULL OR collection_id IS NULL)
  );
  -- The profile list (an author's posts, newest first, no temp B-tree) and the 24-hour cap count.
  CREATE INDEX idx_posts_author_created ON posts(author_id, created_at DESC, id);
  -- ON DELETE SET NULL lookups when a game or collection is deleted.
  CREATE INDEX idx_posts_game       ON posts(game_id)       WHERE game_id IS NOT NULL;
  CREATE INDEX idx_posts_collection ON posts(collection_id) WHERE collection_id IS NOT NULL;

  -- 2. Rebuild activity_events (the 0019 layout + post_id; the CHECK gains post_id).
  --    Columns keep their 0019 order; post_id is appended.
  CREATE TABLE activity_events_new (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,      -- feed cursor
      actor_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,                          -- activity::KINDS (validated in Rust; no CHECK)
      game_id       TEXT REFERENCES games(id) ON DELETE CASCADE,          -- NULL for collectionUpdated and postCreated
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
      post_id       TEXT REFERENCES posts(id) ON DELETE CASCADE,          -- postCreated (F030)
      CHECK (game_id IS NOT NULL OR collection_id IS NOT NULL OR post_id IS NOT NULL)
  );
  INSERT INTO activity_events_new (id, actor_id, kind, game_id, version, score, first_score, ach_id,
                                   ach_count, day, created_at, from_version, collection_id, game_ids)
  SELECT id, actor_id, kind, game_id, version, score, first_score, ach_id,
         ach_count, day, created_at, from_version, collection_id, game_ids
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
  CREATE INDEX idx_activity_collection ON activity_events(collection_id, kind, day) WHERE collection_id IS NOT NULL;
  -- F030: the post delete cascade.
  CREATE INDEX idx_activity_post       ON activity_events(post_id) WHERE post_id IS NOT NULL;
  ```
  - The copy holds the write lock for the migration's duration. `activity_events` is bounded by the coalescing rules, so this is acceptable at startup (the F021 reasoning). The startup `PRAGMA optimize` re-analyses.
  - `tests/f015.rs`'s replay test stops at `0022` and is unaffected.
- **Writer** (`activity::record_post_created(conn, actor_id, post_id, now)`). It uses a nested transaction and `log_failure`, like the other writers. `?3` day = `now[..10]`, and `now` is the exact `created_at` bound in the post insert:
  ```sql
  INSERT INTO activity_events (actor_id, kind, post_id, day, created_at)
  VALUES (?1, 'postCreated', ?2, ?3, ?4);
  ```
  It is called inside `create_post`'s transaction, right after the guarded insert affected one row. No coalescing.
- **Guarded insert** (`create_post`; `?8` = now − 24 h in the same RFC3339 millis Z format; `?4` = `'game'`, `'collection'` or NULL):
  ```sql
  INSERT INTO posts (id, author_id, body, attachment_type, game_id, collection_id, created_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
  WHERE (SELECT COUNT(*) FROM posts WHERE author_id = ?2 AND created_at > ?8) < 25;   -- POSTS_PER_DAY_MAX
  ```
  0 rows affected → 422 `You can post at most 25 times in 24 hours`. The count uses `idx_posts_author_created`.
- **Feed query** (`FEED_SQL`). Branches (a), (b) and (c) stay as they are. Branch (a)'s `CROSS JOIN games g … g.id = e.game_id` drops `postCreated` rows, and (b) and (c) restrict their kinds. A fourth branch is added to the `picked` union:
  ```sql
  UNION
  SELECT id FROM (
    SELECT e.id FROM follows f
    CROSS JOIN activity_events e INDEXED BY idx_activity_actor_id
    WHERE f.follower_id = ?1 AND e.actor_id = f.followee_id
      AND e.id < COALESCE(?2, 9223372036854775807)
      AND e.actor_id <> ?1
      AND e.kind = 'postCreated'
      AND e.kind IN (SELECT value FROM json_each(?4))
      AND e.post_id IS NOT NULL
    ORDER BY e.id DESC LIMIT ?3)
  ```
  - The outer `SELECT` adds `e.post_id`.
  - The branch joins nothing else, because the FK cascade guarantees that the post exists.
  - The extended `tests/review2.rs` N1 test (kinds include `postCreated`) keeps every assertion: `idx_activity_actor_id (actor_id=? AND id<?)`, and no scan of `activity_events`, `games`, `collections` or `screenshots`. It also asserts that the plan never scans `posts`.
- **Read assembly** (`routes/posts.rs`). `POST_SELECT`:
  ```sql
  SELECT p.id, p.author_id, p.body, p.attachment_type, p.game_id, p.collection_id, p.created_at,
         u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name,
         u.avatar_ext AS a_avatar_ext, u.avatar_version AS a_avatar_version
  FROM posts p JOIN users u ON u.id = p.author_id
  ```
  `posts_for(state, rows, viewer)` uses a fixed number of queries per call, never one per row:
  1. `is_admin(viewer)` (only when signed in).
  2. `{GAME_SELECT} WHERE g.id IN (SELECT value FROM json_each(?))` for the rows' `game_id`s. Only games with `visible_to(viewer)` are kept.
  3. `{COLLECTION_SELECT} WHERE c.id IN (SELECT value FROM json_each(?))` for the rows' `collection_id`s (`COLLECTION_SELECT`, `collections_from_rows` are now `pub(crate)`). These are filtered by `visible_to(viewer, admin)`, then passed to `summaries_for(state, &rows, viewer)`.
  4. Per row:
     - `author` = `user_ref_from_row(row, "a_")`;
     - `canDelete` = viewer is the author or `admin`;
     - `attachment` = `None` when `attachment_type` is NULL, else `Some { type, game, collection }` with the visible target or `None`;
     - a stored `attachment_type` other than `game`/`collection` reads as `attachment: null` and logs a warning.

  Callers:
  - `get_post`: `{POST_SELECT} WHERE p.id = ?`.
  - `list_user_posts`:
    ```sql
    SELECT COUNT(*) FROM posts WHERE author_id = ?1;
    {POST_SELECT} WHERE p.author_id = ?1 ORDER BY p.created_at DESC, p.id LIMIT ?2 OFFSET ?3;
    ```
    A test asserts that the page plan uses `idx_posts_author_created` without `USE TEMP B-TREE FOR ORDER BY`.
  - `get_feed`: `{POST_SELECT} WHERE p.id IN (SELECT value FROM json_each(?))` for the page's `post_id`s, then `posts_for` with the viewer. A `postCreated` row whose post is missing is skipped.
- **Delete** (`remove_post(state, id)`, used by `DELETE /api/posts/{id}` and the report `delete` action), in one transaction:
  ```sql
  UPDATE reports SET status = 'resolved', resolution = 'delete', resolved_at = ?2
   WHERE target_type = 'post' AND target_id = ?1 AND status = 'open';
  DELETE FROM posts WHERE id = ?1;   -- the activity_events row cascades (idx_activity_post)
  ```
- **Stats.** `ProfileStats.posts` = `SELECT COUNT(*) FROM posts WHERE author_id = ?1`, the same set as the list's `total`.
- **Reports.** `TARGET_TYPES` gains `"post"`, with no schema change since `0016`. `create_report`'s `post` branch stores `target_game_id` NULL and `target_preview` = the first 140 chars of the body. The resolve validity table is unchanged; `("delete", "post")` calls `remove_post`.
- **UI** (`@webgame/ui`):
  - **Pure helpers.** `posts.ts`: body rules, `linkifyPost` (spec § 0.4; links only what `isSafeProfileUrl` accepts), paths and `parseAttachParam`. `share.ts`: `postShareUrl`.
  - **Components.** `PostCard`, `PostAttachmentCard`, `PostComposer` and `ProfilePosts` (the `ProfileScreenshots` loading model with `pagesForOffset`).
  - **Routes.**
    - `u/:username/posts` → `ProfilePostsTab`, inside the F028 shell.
    - `p/:id` → `PostPage`.
    - The Overview gains a Posts shelf.
    - `FeedPage` gains a Posts tab (`kinds=postCreated`).
    - `FeedItem` renders `postCreated` with `PostCard`.
    - `GamePage` and `CollectionPage` link to the composer with `?attach=`.
  - **Typing.** `FeedItem.game` becomes nullable. The existing renderers take `GameFeedItem` (`FeedItem & { game: GameSummary }`), and `isKnownFeedItem` drops non-post items without a game.
- **Desktop.** No source changes. Links in posts go through the existing `external.rs` handler. Attachment images use `api.url`, which the CSP `img-src` already allows. `f030.desktop.test.tsx` verifies this.
- **Ownership**:
  - backend-dev: the migration, `ratelimit.rs`, `activity.rs`, `routes/posts.rs`, `routes/feed.rs`, `routes/users.rs`, `routes/collections.rs` (visibility of three items), `routes/reports.rs`, `routes/mod.rs`, `tests/f030.rs`, and the `tests/f008.rs`, `tests/f028.rs` and `tests/review2.rs` updates.
  - frontend-dev: `api/types.ts`, `api/client.ts`, `posts.ts`, `share.ts`, `profile.ts`, the new components, `ProfilePage`, `ProfileSections`, `PostPage`, `NotFoundPage`, `FeedPage`, `FeedItem`, `GamePage`, `CollectionPage`, `Report.tsx`, `AdminPage`, `WebGameApp.tsx`, `index.ts`, `styles.css` and tests.
  - desktop-dev: `src/__tests__/f030.desktop.test.tsx`.


## F031 additions
Post replies and hearts (spec: `docs/features/F031-post-replies-and-hearts.md`). This round adds one migration (two tables, added columns, four counter triggers and one dedupe index swap; **no table rebuild**), seven endpoints, `Limit::PostReply`, two notification kinds with settings, a `postReply` report target, and a thread UI on the permalink page. There are no new dependencies, no engine changes and no desktop source changes.
- **Model.**
  - Hearts and the reply count are counter columns on `posts`, maintained by triggers (the review 6 `comments.hearts` pattern), so `posts_for` needs no aggregate per row and cascades keep them right.
  - Replies are a flat table per post. A reply stores only `reply_to_user_id`, not the answered reply's id.
  - Notifications reuse the F007 write path. `notifications.post_id` (`ON DELETE CASCADE`) ties both kinds to the post; `notification_events.post_reply_id` (`ON DELETE CASCADE`) ties each `postReply` event to its reply, so deleting a reply removes its event and the `0014` trigger removes an emptied notification (the F024 model). Post kinds have `game_id` NULL, so F018 `MUTED` never matches and `VISIBLE` always passes.
- **Data**: migration `backend/migrations/0026_f031.sql` runs after `0025_f030.sql`. Normative, in this order:
  ```sql
  -- F031: post replies and hearts (docs/ARCHITECTURE.md § F031 additions).

  -- 1. Post counters and the reply lock. Counters are maintained by the triggers below; never write them directly.
  ALTER TABLE posts ADD COLUMN hearts      INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE posts ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE posts ADD COLUMN locked_at   TEXT;                         -- NULL = replies on; RFC3339 millis Z

  -- 2. Hearts (one per user and post). Never use INSERT OR REPLACE here: its implicit delete skips the trigger.
  CREATE TABLE post_hearts (
      post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,                                         -- RFC3339 millis Z
      PRIMARY KEY (post_id, user_id)
  );
  CREATE INDEX idx_post_hearts_user ON post_hearts(user_id);           -- user-delete cascade
  CREATE TRIGGER trg_post_hearts_insert AFTER INSERT ON post_hearts
  BEGIN
      UPDATE posts SET hearts = hearts + 1 WHERE id = NEW.post_id;
  END;
  CREATE TRIGGER trg_post_hearts_delete AFTER DELETE ON post_hearts
  BEGIN
      UPDATE posts SET hearts = hearts - 1 WHERE id = OLD.post_id;
  END;

  -- 3. Replies: one flat thread per post, oldest first (created_at, then rowid).
  CREATE TABLE post_replies (
      id               TEXT PRIMARY KEY,                                         -- UUID v4
      post_id          TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      author_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reply_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,             -- "Replying to @x"; NULL = answering the post
      body             TEXT NOT NULL,                                            -- routes::posts::validate_post_body
      created_at       TEXT NOT NULL                                             -- RFC3339 millis Z
  );
  CREATE INDEX idx_post_replies_post_created ON post_replies(post_id, created_at);   -- the thread (rowid tie-break), cap count
  CREATE INDEX idx_post_replies_author       ON post_replies(author_id);              -- user-delete cascade
  CREATE INDEX idx_post_replies_reply_to     ON post_replies(reply_to_user_id) WHERE reply_to_user_id IS NOT NULL;   -- SET NULL
  CREATE TRIGGER trg_post_replies_insert AFTER INSERT ON post_replies
  BEGIN
      UPDATE posts SET reply_count = reply_count + 1 WHERE id = NEW.post_id;
  END;
  CREATE TRIGGER trg_post_replies_delete AFTER DELETE ON post_replies
  BEGIN
      UPDATE posts SET reply_count = reply_count - 1 WHERE id = OLD.post_id;
  END;

  -- 4. Notifications. ADD COLUMN with REFERENCES is allowed because the default is NULL.
  ALTER TABLE notifications ADD COLUMN post_id TEXT REFERENCES posts(id) ON DELETE CASCADE;          -- postReply / postHeart
  CREATE INDEX idx_notifications_post ON notifications(post_id) WHERE post_id IS NOT NULL;
  ALTER TABLE notification_events ADD COLUMN post_reply_id TEXT REFERENCES post_replies(id) ON DELETE CASCADE;   -- postReply
  CREATE INDEX idx_notification_events_post_reply ON notification_events(post_reply_id) WHERE post_reply_id IS NOT NULL;
  --    One event per reply: append post_reply_id to the dedupe key (strictly finer than the 0023 key, so existing rows fit).
  DROP INDEX idx_notification_events_dedupe;
  CREATE UNIQUE INDEX idx_notification_events_dedupe ON notification_events(notification_id, actor_id, IFNULL(comment_id, ''), IFNULL(screenshot_id, ''), IFNULL(post_reply_id, ''));
  ALTER TABLE notification_settings ADD COLUMN post_replies INTEGER NOT NULL DEFAULT 1 CHECK (post_replies IN (0, 1));
  ALTER TABLE notification_settings ADD COLUMN post_hearts  INTEGER NOT NULL DEFAULT 1 CHECK (post_hearts IN (0, 1));

  -- 5. Reports: the post of a post / postReply report (no FK, like target_game_id).
  ALTER TABLE reports ADD COLUMN target_post_id TEXT;
  UPDATE reports SET target_post_id = target_id WHERE target_type = 'post';
  ```
  - Existing posts have no hearts or replies, so the counters start correct at 0.
  - `tests/f018.rs` `SCHEMA_OF` excludes `idx_notifications_post` and `idx_notification_events_post_reply`; its dedupe normalisation still holds (the definition still contains `IFNULL(screenshot_id, '')`, which `tests/f024.rs` also checks).
- **Post assembly** (`routes/posts.rs`). `POST_SELECT` adds `p.hearts, p.reply_count, p.locked_at`. `posts_for` adds one query when the viewer is signed in and rows are non-empty:
  ```sql
  SELECT post_id FROM post_hearts WHERE user_id = ?1 AND post_id IN (SELECT value FROM json_each(?2))
  ```
  → `myHeart`; `locked` = `locked_at IS NOT NULL`. Still a fixed number of queries per call.
- **Reply select** (`routes/post_replies.rs`):
  ```sql
  SELECT r.id, r.post_id, r.author_id, r.body, r.created_at, p.author_id AS post_author_id,
         u.id AS a_id, u.username AS a_username, u.display_name AS a_display_name,
         u.avatar_ext AS a_avatar_ext, u.avatar_version AS a_avatar_version,
         t.id AS t_id, t.username AS t_username, t.display_name AS t_display_name,
         t.avatar_ext AS t_avatar_ext, t.avatar_version AS t_avatar_version
  FROM post_replies r
  JOIN posts p ON p.id = r.post_id
  JOIN users u ON u.id = r.author_id
  LEFT JOIN users t ON t.id = r.reply_to_user_id
  ```
  - `replyTo` = `user_ref_from_row(row, "t_")` only when `t_id` is non-NULL (that helper requires an id), else `None`.
  - `byPostAuthor` = `author_id == post_author_id`; `canDelete` = viewer is `author_id`, `post_author_id` or admin (`is_admin` once per request); `path` = `/p/{post_id}?reply={id}`.
  - List page: `{REPLY_SELECT} WHERE r.post_id = ?1 ORDER BY r.created_at, r.rowid LIMIT ?2 OFFSET ?3`; `total` = `SELECT reply_count FROM posts WHERE id = ?1`. A test asserts the plan uses `idx_post_replies_post_created` without `USE TEMP B-TREE FOR ORDER BY`.
- **Guarded reply insert** (`create_post_reply`, inside `BEGIN IMMEDIATE`; `?7` = 200, `?8` = 1 when the caller is the post author or an admin):
  ```sql
  INSERT INTO post_replies (id, post_id, author_id, reply_to_user_id, body, created_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6
  WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?2)
    AND (?8 = 1 OR (SELECT locked_at FROM posts WHERE id = ?2) IS NULL)
    AND (SELECT COUNT(*) FROM post_replies WHERE post_id = ?2) < ?7
  ```
  0 rows → roll back, then re-read `SELECT locked_at IS NOT NULL FROM posts WHERE id = ?`: no row → 404 `Post not found`; locked and `?8 = 0` → 422 `Replies are turned off for this post`; else 422 `This post has reached 200 replies`.
- **Hearts.** `PUT`: `INSERT OR IGNORE INTO post_hearts (post_id, user_id, created_at) SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?1)`; a changed row → `notify_pool` `postHeart` with `Dedupe::Actor`. `DELETE`: `DELETE FROM post_hearts WHERE post_id = ? AND user_id = ?`; a removed row → `retract_pool(author, Kind::PostHeart, post_group(id), user)`. The response re-reads `posts.hearts`.
- **Lock.** `UPDATE posts SET locked_at = COALESCE(locked_at, ?2) WHERE id = ?1` / `UPDATE posts SET locked_at = NULL WHERE id = ?1`.
- **Write path** (`notifications.rs`). `Kind::PostReply` (`postReply`, column `post_replies`) and `Kind::PostHeart` (`postHeart`, column `post_hearts`); `post_group(id)` = `post:{id}`. `NewNotification` gains `post_id` and `event_post_reply_id` (every existing literal passes `None`). In `try_notify` the notifications insert becomes
  ```sql
  INSERT INTO notifications (recipient_id, kind, group_key, game_id, comment_id, collection_id, post_id, created_at, updated_at)
  SELECT ?1, ?2, ?3, ?5, ?6, ?10, ?11, ?7, ?7
  WHERE … (unchanged settings, MUTED and dedupe clauses) …
  ON CONFLICT (recipient_id, kind, group_key) WHERE read_at IS NULL DO UPDATE SET updated_at = excluded.updated_at
  RETURNING id
  ```
  and the event insert becomes `INSERT OR IGNORE INTO notification_events (notification_id, actor_id, comment_id, screenshot_id, post_reply_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`. A reply deleted between commit and notify fails its FK; the transaction rolls back and the failure is logged.
- **Reply notifications** (`create_post_reply`, after the commit): recipients = `[post author, replyTo user]`, deduplicated, minus the poster; each gets `Kind::PostReply`, `post_group(post_id)`, `post_id`, `event_post_reply_id = reply id`, `Dedupe::None`, all game/comment/thread/collection fields `None`.
- **Read path** (`notifications::list_page`). The base select adds `n.post_id`. Two extra batched queries, only when the page has post kinds:
  ```sql
  -- newest live reply per postReply notification
  SELECT notification_id, post_reply_id FROM (
    SELECT notification_id, post_reply_id, ROW_NUMBER() OVER (
      PARTITION BY notification_id ORDER BY created_at DESC, id DESC) AS rn
    FROM notification_events
    WHERE notification_id IN (SELECT value FROM json_each(?1))
      AND post_reply_id IS NOT NULL AND retracted_at IS NULL)
  WHERE rn = 1;
  -- excerpts and authors
  SELECT id, author_id, substr(body, 1, 140) FROM posts WHERE id IN (SELECT value FROM json_each(?1));
  SELECT id, substr(body, 1, 140) FROM post_replies WHERE id IN (SELECT value FROM json_each(?1));
  ```
  Per kind: `postReply` → `eventCount` = live events, `excerpt` = the newest reply's, `ownsThread` = post author == recipient, `path` = `/p/{postId}?reply={newestReplyId}` (`/p/{postId}` if none); `postHeart` → `eventCount` = `actorCount`, `excerpt` = the post's, `path` = `/p/{postId}`. `postId` = `n.post_id` for both. `VISIBLE`, `unread_count`, `mark_read`, mutes and pruning are unchanged.
- **Settings.** `post_replies` ↔ `postReplies`, `post_hearts` ↔ `postHearts`; `update_settings` binds them as `?11` and `?12`.
- **Delete.**
  - `remove_post(state, id)`, in one transaction:
    ```sql
    UPDATE reports SET status = 'resolved', resolution = 'delete', resolved_at = ?2
     WHERE status = 'open' AND ((target_type = 'post' AND target_id = ?1)
       OR (target_type = 'postReply' AND target_id IN (SELECT id FROM post_replies WHERE post_id = ?1)));
    DELETE FROM posts WHERE id = ?1;   -- cascades: post_replies, post_hearts, activity_events, notifications (post_id), notification_events (post_reply_id)
    ```
  - `remove_post_reply(state, id)`, in one transaction: resolve open `postReply` reports with `target_id = ?1`, then `DELETE FROM post_replies WHERE id = ?1` (its events cascade; the `0014` trigger removes an emptied notification; the counter trigger decrements `reply_count`).
- **Reports.** `TARGET_TYPES` += `"postReply"`. `create_report` writes `target_post_id` (post → its id; postReply → `post_replies.post_id`; else NULL). `Report.target_post_id` is read in `report_from_row`. `("delete", "postReply")` calls `remove_post_reply`.
- **UI** (`@webgame/ui`):
  - `HeartButton` gains `subject` and `onToggle`, so posts reuse it without a second heart component.
  - `PostCard` gains the heart and a replies link (`inThread` hides the link on `/p/{id}`).
  - `components/PostThread.tsx`: `PostThread` (loads the whole thread with `perPage: 200`, which equals the cap, so there is no paging UI), `PostReplyItem`, `PostReplyForm`; `?reply=` highlight and focus.
  - `PostPage` keeps a local post state updated through `onPostChange` (lock, `replyCount`).
  - `notifications.ts`, `NotificationItem` and `NotificationSettings` add the two kinds; `muteActionFor` returns null for them.
  - `AdminPage` adds `postReply` rows with `View in context →` (`/p/{targetPostId}?reply={targetId}`).
- **Desktop.** No source changes. Reply links go through `external.rs`; OS notification bodies are the summaries, which hold no post or reply text. `f031.desktop.test.tsx` verifies this.
- **Ownership**:
  - backend-dev: the review 11 carry-over in `routes/users.rs` (shared forbidden set = the client's `isForbiddenLabelCodePoint`; `displayName`/`bio` character checks; the conditional banner `UPDATE`, see API § "Review-fix additions (REVIEW-2026-11-18-11)"), the migration, `ratelimit.rs`, `notifications.rs`, `routes/notifications.rs`, `routes/posts.rs`, `routes/post_replies.rs` (new), `routes/reports.rs`, `routes/mod.rs`, the `NewNotification` literals in `routes/comments.rs`, `routes/follows.rs`, `routes/collections.rs` and `routes/screenshots.rs`, `tests/f031.rs`, and the `tests/f007.rs`, `tests/f008.rs`, `tests/f018.rs`, `tests/f028.rs`, `tests/f030.rs` and `tests/review4.rs` updates.
  - frontend-dev: `api/types.ts`, `api/client.ts`, `posts.ts`, `notifications.ts`, `HeartButton`, `PostCard` (plus the `Delete post by {name}` / `Report post by {name}` names), `PostThread` (new), `NotificationItem`, `NotificationSettings`, `Report.tsx` (`ReportButton.ariaLabel`), `PostPage`, `AdminPage`, `index.ts`, `styles.css` and tests.
  - desktop-dev: `src/__tests__/f031.desktop.test.tsx`.


## F035 additions
Explore creators page (spec: `docs/features/F035-explore-creators.md`). There is one read endpoint and one page, with no migration (the next free number stays `0027` after F031's `0026`), no new dependencies and no engine changes.
- **Backend** (`routes/creators.rs`, new). `list_creators` (🔓 `MaybeAuthUser`) parses `sort` first, then paging (`parse_paging(…, 24)` and a 1–48 clamp), and runs 2 or 3 statements:
  ```sql
  -- total (independent of sort)
  SELECT COUNT(DISTINCT owner_id) FROM games WHERE published = 1;

  -- the page; {ORDER} is one of three fixed strings chosen in Rust (never interpolated from input):
  --   popular: followers DESC, plays DESC, u.username_lower ASC
  --   active:  last_act DESC, u.username_lower ASC
  --   new:     first_pub DESC, u.username_lower ASC
  WITH c AS (
    SELECT owner_id,
           COUNT(*)   AS games,
           SUM(plays) AS plays,
           MIN(COALESCE(first_published_at, created_at)) AS first_pub,
           MAX(MAX(COALESCE(first_published_at, created_at), COALESCE(last_updated_at, ''))) AS last_act
    FROM games WHERE published = 1 GROUP BY owner_id
  )
  SELECT u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name,
         u.avatar_ext AS u_avatar_ext, u.avatar_version AS u_avatar_version,
         u.banner_ext, u.banner_version, substr(u.bio, 1, 160) AS bio_excerpt,
         c.games, c.plays, c.first_pub, c.last_act,
         (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS followers
  FROM c JOIN users u ON u.id = c.owner_id
  ORDER BY {ORDER}
  LIMIT ?1 OFFSET ?2;

  -- isFollowing, only when signed in and the page is non-empty
  SELECT followee_id FROM follows WHERE follower_id = ?1 AND followee_id IN (SELECT value FROM json_each(?2));
  ```
  - `substr` on TEXT counts characters, so `bioExcerpt` is exactly the first 160 code points.
  - `bannerUrl` comes from `models::banner_url`.
  - The scalar two-argument `MAX` inside the aggregate is SQLite's multi-argument `max()`.
  - The cost is one pass over published games plus a follower count per creator (the plan uses `idx_follows_followee_follower`; review 12). If the catalogue grows, a periodic snapshot like F003's `trending.rs` can replace the CTE without a contract change.
- **UI** (`@webgame/ui`):
  - `creators.ts` (pure helpers);
  - `components/CreatorCard.tsx` (`CreatorCard`, `CreatorCardSkeleton`);
  - `pages/CreatorsPage.tsx` (route `creators`, public). It seeds the F002 follow store from the page, so `FollowButton`s and counts agree app-wide;
  - a `Creators` link in the header nav and footer, and `Explore all creators →` under the feed's suggestions.
- **Desktop.** View → Creators (forwarded menu id `"creators"`, no accelerator) → `/creators` through `nativeMenu.ts` `ROUTES`. Banners load from the configured server, which the F028 CSP `img-src` already allows.
- **Ownership**:
  - backend-dev: `routes/creators.rs` (new), `routes/mod.rs`, `tests/f035.rs`.
  - frontend-dev: `api/types.ts`, `api/client.ts`, `creators.ts` (new), `CreatorCard.tsx` (new), `CreatorsPage.tsx` (new), `WebGameApp.tsx`, `Layout.tsx`, `FeedPage.tsx` (one link), `index.ts`, `styles.css`, `packages/ui/README.md` and tests.
  - desktop-dev: `src-tauri/src/menu.rs`, `src/nativeMenu.ts`, `src/__tests__/nativeMenu.test.ts`, `src/__tests__/f035.desktop.test.tsx`, `apps/desktop/README.md`.

## F032 additions
Home and discover 2, with F029 featured games on profiles (spec: `docs/features/F032-home-and-discover-2.md`; contract: API § F032). One migration, `0027_f032.sql` (the next free number becomes `0028`), no new dependencies and no engine changes.

- **Migration `0027_f032.sql`** (verbatim):
  ```sql
  -- F032 (+ F029): featured games on profiles, and indexes for the home page reads (docs/ARCHITECTURE.md § F032 additions).

  -- 1. F029: up to 4 featured games per user (the limit is enforced in Rust), in display order.
  CREATE TABLE profile_featured (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      position   INTEGER NOT NULL,                                      -- 0..3, display order
      created_at TEXT NOT NULL,                                         -- RFC3339 millis Z
      PRIMARY KEY (user_id, game_id)
  );
  CREATE INDEX idx_profile_featured_game ON profile_featured(game_id);   -- game-delete cascade

  -- 2. GET /api/games?sort=updated (filter last_updated_at IS NOT NULL, order last_updated_at DESC, id).
  CREATE INDEX idx_games_pub_updated ON games(published, last_updated_at DESC, id) WHERE last_updated_at IS NOT NULL;

  -- 3. GET /api/collections (public, updated_at DESC, id DESC).
  CREATE INDEX idx_collections_public_updated ON collections(updated_at DESC, id DESC) WHERE visibility = 'public';
  ```
- **`sort=updated`** (`routes/games.rs`): `list_order` maps it to `g.last_updated_at DESC, g.id`, and `list_filter` adds `g.last_updated_at IS NOT NULL` when the trimmed sort is `updated`. The partial index applies because the query repeats its `WHERE` term. The count query shares the `WHERE`, so `total` matches.
- **Explore collections** (`routes/collections.rs` `list_collections`; constants `EXPLORE_MIN_GAMES = 3`, `EXPLORE_PER_PAGE_DEFAULT = 12`, `EXPLORE_PER_PAGE_MAX = 48`):
  ```sql
  -- {EXPLORE_WHERE}, shared by both statements ({EXPLORE_MIN_GAMES} is a Rust constant, never input):
  WHERE c.visibility = 'public'
    AND (SELECT COUNT(*) FROM collection_games cg JOIN games g ON g.id = cg.game_id
         WHERE cg.collection_id = c.id AND g.published = 1) >= {EXPLORE_MIN_GAMES}

  SELECT COUNT(*) FROM collections c {EXPLORE_WHERE};
  {COLLECTION_SELECT} {EXPLORE_WHERE} ORDER BY c.updated_at DESC, c.id DESC LIMIT ?1 OFFSET ?2;
  ```
  Items go through the existing `summaries_for(state, rows, viewer)`, one batched query for `gameCount`/`coverUrls`.
- **Creator spotlight** (`routes/creators.rs` `get_spotlight`):
  - `page_sql(order)` becomes `creator_sql(owner_filter, order)`; with `owner_filter` the CTE reads `FROM games WHERE published = 1 AND owner_id = ?3 GROUP BY owner_id`. `list_creators` is unchanged in behaviour. The row → `Creator` mapping and the `IS_FOLLOWING_SQL` batch become shared helpers.
  - Steps:
    ```sql
    -- 1. N (the F035 COUNT_SQL)
    SELECT COUNT(DISTINCT owner_id) FROM games WHERE published = 1;
    -- 2. the pick; ?1 = spotlight_index(utc_day_number(now), N). Served by idx_games_owner_pub_new.
    SELECT owner_id FROM (SELECT DISTINCT owner_id FROM games WHERE published = 1)
    ORDER BY owner_id LIMIT 1 OFFSET ?1;
    -- 3. creator_sql(true, "u.username_lower ASC") with ?1 = 1, ?2 = 0, ?3 = the picked id
    -- 4. IS_FOLLOWING_SQL when signed in (one id)
    -- 5. games
    {GAME_SELECT} LEFT JOIN profile_featured pf ON pf.game_id = g.id AND pf.user_id = g.owner_id
    WHERE g.owner_id = ?1 AND g.published = 1
    ORDER BY (pf.position IS NULL), pf.position, g.plays DESC, g.created_at DESC, g.id
    LIMIT 3;
    ```
  - `N = 0` → `creator: null`, `games: []` (skip steps 2–5). If step 2 or 3 finds no row because a creator unpublished in between, retry step 2 once with offset 0; if that also fails, return `creator: null`.
  - `spotlight_index(day, n) = day.rem_euclid(n)`; `utc_day_number(now)` = days since 1970-01-01 of `now.date_naive()`; `day` in the response is `now.format("%Y-%m-%d")`. Both helpers are `pub` for tests. No cache: the five statements are index-backed and tiny.
- **Featured games** (`routes/users.rs`, `FEATURED_GAMES_MAX = 4`):
  ```sql
  -- read (get_user and the PUT response)
  {GAME_SELECT} JOIN profile_featured pf ON pf.game_id = g.id
  WHERE pf.user_id = ?1 AND g.published = 1
  ORDER BY pf.position, pf.game_id;
  ```
  `put_featured`: validate the count and duplicates in Rust (API § F032 order), then in one `begin_with("BEGIN IMMEDIATE")` transaction:
  1. `SELECT value FROM json_each(?1) WHERE value IN (SELECT id FROM games WHERE published = 1)` with the ids as a JSON array; the first id (in request order) missing from the result → 422 `gameIds[{i}] is not a published game` (rollback);
  2. `DELETE FROM profile_featured WHERE user_id = ?1`;
  3. one `INSERT INTO profile_featured (user_id, game_id, position, created_at) VALUES (?1, ?2, ?3, ?4)` per id, `position` = its index.

  Commit, then run the read. `BEGIN IMMEDIATE` takes the write lock first, so concurrent saves serialise and the last one wins completely.
- **UI** (`@webgame/ui`):
  - `home.ts` (pure): sizes, `browsePath`, `legacyHomeRedirect`, `isValidSpotlight`, `moveItem`;
  - `components/HomeSections.tsx`: `GameShelf`, `CreatorSpotlightSection`, `CollectionsShelf`, `TagsSection`;
  - `pages/HomePage.tsx` (sections + legacy redirect) and `pages/BrowsePage.tsx` (route `browse`, the grid that used to be on `/`);
  - `components/CreatorCard.tsx` gains `headingLevel`;
  - `components/FeaturedGamesDialog.tsx` and the Featured row in `pages/ProfileSections.tsx` `ProfileOverview`;
  - `Layout.tsx` (`Browse` and search → `/browse`), `GamePage.tsx` (tag chips), `FavoritesPage.tsx`/`CollectionPage.tsx` (empty-state links).
  - The home page fires 7 independent requests; each section hides on error or when empty, so no single failure blanks the page.
- **Desktop.** View → Home (`"home"` → `/`) and View → Browse games (`"browse"` → `/browse`), forwarded ids without accelerators, routed through `nativeMenu.ts` `ROUTES`.
- **Ownership**:
  - backend-dev: `migrations/0027_f032.sql` (new), `routes/games.rs`, `routes/collections.rs`, `routes/creators.rs`, `routes/users.rs`, `routes/mod.rs`, `tests/f032.rs` (new), `tests/f003.rs` (one message).
  - frontend-dev: `api/types.ts`, `api/client.ts`, `home.ts` (new), `components/HomeSections.tsx` (new), `components/FeaturedGamesDialog.tsx` (new), `components/CreatorCard.tsx`, `components/Layout.tsx`, `pages/HomePage.tsx`, `pages/BrowsePage.tsx` (new), `pages/ProfileSections.tsx`, `pages/GamePage.tsx`, `pages/FavoritesPage.tsx`, `pages/CollectionPage.tsx`, `WebGameApp.tsx`, `index.ts`, `styles.css`, `packages/ui/README.md` and tests.
  - desktop-dev: `src-tauri/src/menu.rs`, `src/nativeMenu.ts`, `src/__tests__/nativeMenu.test.ts`, `src/__tests__/f032.desktop.test.tsx` (new), `apps/desktop/README.md`.

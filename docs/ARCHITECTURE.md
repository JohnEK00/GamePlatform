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
- **Fan-out on read.** Actions append rows to a single `activity_events` table. `GET /api/feed` selects the events whose actor the viewer follows, plus publish/update events of games the viewer favorited, filtered by current visibility at read time. There are no per-follower inbox tables and no background jobs. A follow cap of 2000 per user bounds the query.
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

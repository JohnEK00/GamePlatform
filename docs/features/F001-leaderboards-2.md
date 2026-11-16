# F001: Leaderboards 2.0

Status: **specced**. Size: **M**. Areas: engine (+ examples), backend, frontend, desktop (verify only).
Contracts: `docs/API.md` § F001 additions, `docs/GAME_FORMAT.md` § F001 additions, `docs/ARCHITECTURE.md` § F001 additions.

## 1. Goal and user stories
Today a game has one all-time leaderboard: it ranks descending, it's visible only on the game page, and the game itself can't read it. After a few days the top is unreachable, so it stops motivating anyone. F001 adds:
- **Periods**: `day` (UTC day) and `week` (ISO week, Monday 00:00 UTC) boards alongside `all`.
- **Score semantics per game**: `order` (`desc` or `asc`, where lower is better, e.g. times) and `format` (`number` or `time` in milliseconds), plus an optional column `label`, all declared in game.json.
- **In-game access**: `engine.platform.getLeaderboard()` and a `submitScore()` that now resolves with the player's ranks and personal-best flag.
- **Better panel**: period tabs, the viewer's own row even when outside the top N, and a player count.

User stories:
1. As a player, I see a "Today" board I can actually top, and after a run I get a toast like "New personal best! #2 today · #7 this week · #41 all time".
2. As a player, the game's own game-over screen shows the top 5 of the week with my row highlighted.
3. As a creator of a racing/puzzle game, I declare `"leaderboard": { "order": "asc", "format": "time", "label": "Best time" }` and times render as `1:23.456`, lowest first.
4. As a creator in the Studio, I can test my in-game leaderboard screen with sample data before publishing.
5. As a desktop user, all of the above works identically (shared GUI).

Non-goals: per-level/multiple boards per game, friends-only boards, anti-cheat beyond the existing rate limit, score deletion by owners (candidates for later items).

## 2. UX notes
- **Leaderboard panel** (game page, `packages/ui/src/components/Leaderboard.tsx`):
  - Title: trophy + `label` (default "Leaderboard"; when `label` is set, the score column header shows it, e.g. "Best time").
  - Segmented tabs: **Today · This week · All time**. Default is **This week**. The last choice is remembered in localStorage key `webgame.lb.period`, wrapped in try/catch.
  - Rows are as today (rank, avatar, name, score), and scores are formatted with `formatScore(score, format)`.
  - If `me` is set and not among the entries, show a divider then the viewer's row (highlighted, `is-me`).
  - Footer, small and muted: "{totalPlayers} players · resets in 5h 12m" (day/week; computed from `periodEnd`), or "{totalPlayers} players" for all time.
  - Empty state per period: "No scores today yet — be the first!" / "…this week…" / existing text.
  - The panel reloads after a submit (existing `refreshKey`).
- **Score toast** (GamePlayer): uses `ScoreSubmitResult`.
  - When `personalBest`: title "New personal best: {display}", body "#{ranks.day} today · #{ranks.week} this week · #{ranks.all} all time".
  - Otherwise: title "Score saved: {display}" with the same body.
- **Studio**:
  - The game.json form gains a "Leaderboard" fieldset: Order (Higher is better / Lower is better), Format (Number / Time), Label (text, max 24).
  - New template **"Time trial"**: reach the goal as fast as possible. It uses `order: "asc"`, `format: "time"`, `submitScore(ms)` and `getLeaderboard({ period: "day", limit: 5 })` on its end screen.
  - Preview leaderboard requests get sample data, and a small "sample leaderboard data" note appears in the Studio console/toast once per session.
- **Docs page** (`DocsPage.tsx`): document `getLeaderboard`, the new `submitScore` result and the game.json `leaderboard` block.

## 3. Contract changes (summary; normative text lives in docs/)
- **game.json**: the optional `leaderboard: { order?: "desc"|"asc", format?: "number"|"time", label?: string }` block, with validation and defaults.
- **API**:
  - `Game.leaderboard: LeaderboardConfig`.
  - New `GET /api/games/{id}/leaderboard?period=&limit=` → `Leaderboard`.
  - `GET /api/games/{id}/scores` gains `period` and honours `order`.
  - `POST /api/games/{id}/scores` returns `ScoreSubmitResult` (a superset of `Score`), with time-format validation.
  - New rate limit bucket for leaderboard reads.
- **Engine ↔ parent protocol**:
  - `webgame:leaderboard-get` → `webgame:leaderboard`.
  - `webgame:score` gains an optional `requestId` → `webgame:score-result`.
  - Studio behaviour for both.
- **Engine API**: `platform.getLeaderboard(opts)`, plus `platform.submitScore(n)` now returns `Promise<ScoreResultView | null>`.
- **Architecture**: notes on the new message pair in the security model, and the migration `0003_f001.sql`.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0003_f001.sql`:
   ```sql
   ALTER TABLE games ADD COLUMN score_order  TEXT NOT NULL DEFAULT 'desc';   -- 'desc' | 'asc'
   ALTER TABLE games ADD COLUMN score_format TEXT NOT NULL DEFAULT 'number'; -- 'number' | 'time'
   ALTER TABLE games ADD COLUMN score_label  TEXT NOT NULL DEFAULT '';
   CREATE INDEX idx_scores_game_created ON scores(game_id, created_at);
   ```
2. **`backend/src/bundle.rs`**: `parse_leaderboard(&Value) -> Result<LeaderboardMeta, AppError>` per GAME_FORMAT § F001. Add `leaderboard: LeaderboardMeta` to `BundleMeta`.
3. **`backend/src/routes/games.rs`**: persist the three columns on create and on bundle replace. Add `leaderboard: LeaderboardConfig` to `Game` in `backend/src/models.rs`, serialised as `{ order, format, label }`.
4. **`backend/src/routes/scores.rs`**:
   - A shared helper `period_bounds(period, now) -> Option<(String, String)>` that returns RFC3339 millis `Z` strings. Stored `created_at` uses the same format, so string comparison is correct.
   - A shared "best per user in [start, end)" query that uses `MIN` or `MAX` per `score_order`. Ties go to the earlier `created_at`. Ranks use competition ranking (same score = same rank).
   - `list_scores`: accept `period` (default `all`) and honour order.
   - New `get_leaderboard` handler: `GET /api/games/{id}/leaderboard`, with the response computed per API § F001 (`totalPlayers` = distinct users with ≥ 1 score in the window; `me` is the viewer's best with rank, 🔓).
   - `submit_score`:
     - Validate `time` format (0 ≤ score ≤ 86,400,000).
     - Compute `personalBest` against the previous all-time best, using the game's order.
     - Compute `ranks.{day,week,all}` for the user's best in each window.
     - Keep `rank` with its v1 meaning.
5. **`backend/src/routes/mod.rs`**: route `/games/{id}/leaderboard`.
6. **`backend/src/ratelimit.rs`**: `Limit::Leaderboard`, 120/min (per user, or per IP when anonymous), applied to `GET …/leaderboard` only.
7. **Tests** `backend/tests/f001.rs`:
   - game.json validation (bad order/format/label → 422; defaults applied).
   - asc ordering for both endpoints.
   - Period filtering: insert rows with backdated `created_at` directly via the test pool (see `tests/common`).
   - `me` outside the top N.
   - `personalBest` true/false/first.
   - `ranks` per period.
   - The time-format range → 422.
   - `period=bogus` → 400.
   - Unpublished game → 404 for non-owners.
   - Rate limit → 429 (with `RATE_LIMIT` on).

**Acceptance:** `cd backend && cargo test` (all green, including the existing `api.rs` and `v2.rs`) and `cargo clippy --all-targets -- -D warnings`.

### engine-dev (`packages/engine/**`, `examples/**`)
1. **`packages/engine/src/platform.ts`**:
   - Add message types: `webgame:leaderboard-get`, `webgame:score` with `requestId?`, and the reply types `webgame:leaderboard` and `webgame:score-result`.
   - Add exported types `LeaderboardPeriod`, `LeaderboardView`, `ScoreResultView` (shapes per GAME_FORMAT § F001).
   - `getLeaderboard(opts?)`: defaults `period: "all"`, `limit: 10`, with limit clamped 1–25. An invalid period → warn and resolve `null`. At most 4 pending requests; a 5th resolves `null` immediately with a warning. Each request times out after `LEADERBOARD_TIMEOUT_MS = 5000` and resolves `null`. Resolves `null` immediately when there is no parent (same check as `storageHandshake`).
   - `submitScore(n)`: still validates and posts as before, now with `requestId`. It returns `Promise<ScoreResultView | null>`, which resolves on a matching `webgame:score-result` (null when it carries `error`) or after `SCORE_RESULT_TIMEOUT_MS = 8000`. Callers that ignore the return value must keep working.
   - `handleReply(data)`: an engine-internal method that resolves the pending request by `requestId`. Unknown ids are ignored.
   - Request ids: `"lb-" + n` / `"sc-" + n` with a per-instance counter.
2. **`packages/engine/src/engine.ts`**: in the existing `message` listener, already filtered to `window.parent`, route the `webgame:leaderboard` and `webgame:score-result` messages to `this.platform.handleReply(d)`. On destroy, resolve all pending requests with `null`.
3. **`packages/engine/src/index.ts`**: export the new types.
4. **`packages/engine/README.md`**: document the API.
5. **Examples**:
   - `examples/space-dodge/main.js`: the game-over screen shows "This week" top 5 from `getLeaderboard({ period: "week", limit: 5 })` (feature-detect `typeof engine.platform.getLeaderboard === "function"`), highlights `isMe`, and shows "NEW BEST!" when the awaited `submitScore` result has `personalBest`. If the result is null (offline/anonymous), show nothing extra.
   - `examples/pixel-peaks/game.json`: add `"leaderboard": { "label": "Points" }`. Brick Breaker: unchanged (it is a regression check for defaults).
6. **Tests** `packages/engine/test/platform.test.ts`:
   - Request/reply matching and out-of-order replies.
   - Timeouts (fake timers).
   - The concurrency cap.
   - The no-parent → null path.
   - Limit clamping.
   - `submitScore` still posts synchronously, with `requestId`.
   - Replies with unknown ids are ignored.
   - Destroy resolves pending requests with null.

**Acceptance:** `npm test -w @webgame/engine`, `npm run typecheck -w @webgame/engine`, `npm run build:engine`, `npm run examples`.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **`packages/ui/src/api/types.ts`**: add `LeaderboardPeriod`, `LeaderboardConfig`, `Leaderboard`, `ScoreSubmitResult`, and `Game.leaderboard`.
2. **`packages/ui/src/api/client.ts`**:
   - `getLeaderboard(id, { period?, limit? }): Promise<Leaderboard>`.
   - `listScores(id, limit?, period?)`.
   - `submitScore` now returns `ScoreSubmitResult`.
3. **`packages/ui/src/util.ts`**: `formatScore(score: number, format: "number" | "time"): string`.
   - number → `toLocaleString()`.
   - time (ms) → `m:ss.mmm`, or `h:mm:ss.mmm` when ≥ 1h. Negative or non-finite values → `"—"`.
   - Export it from `index.ts`.
4. **`packages/ui/src/components/Leaderboard.tsx`**: implement the UX in §2. Its props are `{ gameId, config: LeaderboardConfig, limit?, refreshKey? }`, and `GamePage.tsx` passes `game.leaderboard`.
5. **`packages/ui/src/components/GamePlayer.tsx`**: handle the new messages per GAME_FORMAT § F001 "Parent behaviour":
   - Validate the message.
   - Keep a per-`(period, limit)` 10s cache and at most one in-flight request per key.
   - Sanitise the leaderboard into a `LeaderboardView` (no ids, no avatar URLs) and reply to `event.source`.
   - For `webgame:score` with `requestId`: when anonymous, reply `error: "anonymous"` immediately (keep the existing "log in" toast). Otherwise submit, then reply with the result, or with `error: "rate_limited"`/`"failed"`.
   - Update the toast per §2.
6. **`packages/ui/src/studio/StudioPreview.tsx`**:
   - Answer `webgame:leaderboard-get` with a sample board: 5 entries named "Player 1"…"Player 5", deterministic scores matching the manifest's order/format, `me: null`, `sample: true`.
   - Answer `webgame:score` with `requestId` with `error: "studio"`.
   - Keep the existing "would submit" toast.
7. **Studio form** (`StudioPage.tsx` / `studio/project.ts`): the Leaderboard fieldset, with values written to `manifest.leaderboard`. Omit the key entirely when all values are defaults.
8. **`packages/ui/src/studio/templates.ts`**: the "Time trial" template.
9. **`packages/ui/src/pages/DocsPage.tsx`**: the new docs section.
10. **Tests**:
    - `ApiClient.f001.test.ts`: URLs and query params.
    - `GamePlayer.f001.test.tsx`: request → sanitised reply, cache, anonymous score → `error: "anonymous"`, ignores messages from other sources, malformed requests are ignored.
    - `Leaderboard` render test: tabs, the `me` row outside the top, time formatting.
    - `formatScore` unit tests.
    - Studio sample-board test.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
There are no functional changes: the desktop app renders the shared `GamePlayer`/`Leaderboard`.
1. Verify the build against the new UI package, and that the HashRouter game page shows the period tabs and the in-game leaderboard in Space Dodge (manual smoke test against a local backend).
2. If `apps/desktop/src/platform.ts` or `App.tsx` needs type updates because of `@webgame/ui` export changes, make them; otherwise make no edits.

**Acceptance:** `npm run build -w @webgame/desktop`, plus `cd apps/desktop/src-tauri && cargo check`.

### Sequencing
- Backend and engine can start in parallel right away.
- Frontend can start in parallel against the contracts (mock the API in tests).
- Desktop runs last, after `build:ui`.
- QA: an end-to-end pass with the seeded examples.

## 5. Edge cases and security
- **Untrusted game code** can now *read* leaderboards. It only gets the sanitised `LeaderboardView`: display name (or username), rank, score, a formatted string and an `isMe` flag. That is all already public on the game page. No user ids, avatar URLs, tokens or emails. The parent never forwards raw API responses.
- **Request flooding** from a game: the engine caps pending requests at 4. The parent also caches each `(period, limit)` pair for 10s with one in-flight request, and the backend rate-limits at 120/min. A malicious bundle bypassing the engine still hits the parent cache.
- **Messages** are accepted only when `event.source === iframe.contentWindow` (existing rule). `requestId` must be a string of 1–64 chars, `period` one of three values, and `limit` an integer (clamped 1–25), or the message is ignored.
- **Order change on bundle replace**: existing scores are reinterpreted under the new order, which is expected. The upload UI can warn later; it's not in scope.
- **Time format**: a score outside 0..86,400,000 → 422. Existing scores on a game that switches to `time` are shown as-is (`formatScore` handles any non-negative value).
- **Period boundaries** are UTC, computed per request from server time. At boundaries a score belongs to the window containing its `created_at`. The week starts Monday (ISO).
- **Unpublished games**: `/leaderboard` follows `fetch_visible_game` (404 unless owner). In preview (`/play/{id}?token=`), the owner's player still sends requests through the parent, which uses the owner's session. That's fine because it is the owner.
- **Anonymous viewers**: `me` is null, and in-game `isMe` is always false.
- **Old engines/parents**: an old engine never sends a `requestId`, so the parent behaves as before. With an old parent, the new engine's promises resolve `null` on timeout, and games must handle `null`.
- **Deleted users**: scores cascade (existing FK), so counts stay consistent.
- **Performance**: the best-per-window query is bounded by the `(game_id, created_at)` and `(game_id, user_id, score)` indexes. That's acceptable at the current SQLite scale, and `limit` is ≤ 100.

## 6. Test expectations
- **Backend**: a new `tests/f001.rs` covering every bullet in the backend task 7 list. Existing tests stay green, and `/scores` without `period` returns exactly what v1 returned for desc games.
- **Engine**: new platform tests as listed, with no timing flakiness (fake timers). The bundle size increase stays under 3 KB minified.
- **UI**: new tests as listed. Existing `GamePlayer.v2` and `Studio` tests stay green.
- **QA end-to-end**:
  1. Seed, then play Space Dodge logged in and submit twice (lower, then higher). Expect a personal-best toast only on the higher one, ranks shown, and the in-game board showing my row.
  2. Log out: the in-game board renders with no `isMe`, and the score toast prompts login.
  3. Create a Studio "Time trial" project: the preview shows the sample board, and after publishing, times render as `m:ss.mmm` lowest-first.
  4. Desktop: the same flow as step 1.

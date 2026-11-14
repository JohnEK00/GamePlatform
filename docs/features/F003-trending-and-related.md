# F003: Trending and "More like this" discovery

Status: **specced**. Size: **S** (backend + frontend, one round). Areas: backend, frontend. Engine: no changes. Desktop: verification only.
Contracts: `docs/API.md` § F003 additions, `docs/GAME_FORMAT.md` § F003 additions, `docs/ARCHITECTURE.md` § F003 additions.
Depends on: the review-fix play dedupe (REVIEW-2026-11-14-1 R2: `Limit::Play` plus `PlayDedupe`, one counted play per viewer and game per 10 minutes). Migration `0006_f003.sql` runs after `0004_perf_indices.sql` (review fix) and `0005_f002.sql` (F002). See "Sequencing".

## 1. Goal and user stories
Discovery today has four sorts: new, popular (all-time plays), top rated and most favorited. All of them except "new" favour old games, so a game that is popular *this week* is buried under games that were popular a year ago. A game page also ends in a dead end: after a session, nothing points the player to a next game. F003 adds:
- **Trending**: `sort=trending` on `GET /api/games`, ranked by distinct players over the last 7 UTC days, with recent days weighted higher. It also adds a "Trending this week" shelf on the home page and a `playsWeek` count on every `GameSummary`.
- **More like this**: `GET /api/games/{id}/related` and a shelf at the bottom of every game page, ranked by shared tags (rarer tags count more) and filled up with trending games when too few share tags.

The review-fix round made plays trustworthy enough to rank on: they are rate-limited and deduplicated per viewer. F003 hardens this further. It counts **distinct viewers per day** rather than raw plays, and it ignores the owner's own plays.

User stories:
1. As a player on the home page, I see a "Trending this week" row of 8 games, each showing "🔥 1.2k this week", and a "Trending" sort tab that ranks the full catalogue the same way.
2. As a player who just finished "Pixel Peaks" (`platformer`, `pixel`), I scroll down and see "More like this": other platformers first, each card showing the shared tag(s).
3. As a player on a game with a unique tag set, I still see a full "More like this" row, filled with trending games.
4. As a creator, my new game climbs "Trending" in its first week if people actually play it, even though it has a fraction of the all-time plays of older games.
5. As a creator, I can't push my game up by replaying it myself or by reloading it from one IP all day.

Non-goals (later items): "players also played" (co-play) recommendations, per-user personalised ranking, trending per tag as its own page (it already works via `?tag=x&sort=trending`), full-text search (R7), and editorial "featured" picks.

## 2. UX notes
- **Home page** (`HomePage.tsx`):
  - `SORTS` gains `{ key: "trending", label: "Trending" }` as the **second** entry (after "New"). The default sort stays `new`, so existing links keep their meaning.
  - New **`TrendingShelf`** section, rendered below `Featured` only when there is no `q` and no `tag` and `page === 1`. It shows the heading "Trending this week" with a "See all →" link to `/?sort=trending`, and calls `listGames({ sort: "trending", perPage: 8 })`.
    - Cards only show when `playsWeek > 0`, so a fresh install with no recent plays shows no shelf (the section is hidden when no item has `playsWeek > 0`).
    - It uses the existing `GameGrid`, with 8 skeletons while loading. A failed request hides the shelf silently, since the main grid reports errors.
  - When `sort === "trending"`, the main grid's cards show the trending meta line (below).
- **GameCard** (`GameCard.tsx`): new optional prop `highlight?: "trending" | "related"`.
  - `"trending"`: when `playsWeek > 0`, the meta row shows `🔥 {formatCount(playsWeek)} this week` (title attribute "{n} plays in the last 7 days") **in place of** the all-time `▶` count.
  - `"related"`: when `sharedTags` is non-empty, a small line under the owner shows up to 2 shared tags as `#tag` (muted, not links, so the card stays a single tab stop plus its existing links). Pass `sharedTags` via a second optional prop `sharedTags?: string[]`.
  - Without `highlight`, the card renders exactly as today.
  - `GameGrid` forwards `highlight` and a `sharedTagsById?: Record<string, string[]>` map.
- **Game page** (`GamePage.tsx`): new **`RelatedGames`** component (`packages/ui/src/components/RelatedGames.tsx`), rendered **after** the two-column layout so it spans the full width.
  - It is a `<section aria-labelledby>` with the heading "More like this".
  - It calls `getRelatedGames(game.id, { limit: 8 })` and shows a `GameGrid` with `highlight="related"`. Items with `reason: "trending"` show no tag line.
  - While loading, it shows 4 skeletons. It is hidden when the result is empty or the request fails.
  - It refetches when `game.id` changes (navigating from one related game to another must not show stale cards; use the `useAsync` deps).
  - Owners see it on their unpublished games too (the endpoint allows it), which shows where the game would sit.
- **Docs page** (`DocsPage.tsx`), "Publishing" area: one short paragraph, "Tags drive *More like this*. Use specific tags (`platformer`, `roguelike`) over generic ones (`game`, `fun`); rarer shared tags weigh more."
- No new routes and no desktop-specific UI.

## 3. Contract changes (summary; normative text lives in docs/)
- `GameSummary.playsWeek: number`: plays by non-owners in the last 7 UTC days (today included), from the trending snapshot. It is present on every `GameSummary` in every response.
- `GET /api/games?sort=trending`, ordered by `trendingScore` desc. It combines with `q`, `tag` and `owner` like the other sorts. The unknown-sort 400 message lists `trending`.
- `GET 🔓 /api/games/{id}/related?limit=8` returns `RelatedGame[]` (`GameSummary & { reason: "tags" | "trending"; sharedTags: string[] }`), with `limit` 1–24.
- `play_events.viewer_key` (new column, migration `0006_f003.sql`), a `game_trending` snapshot table and the `TRENDING_TTL_SECS` env var.
- GAME_FORMAT: no format change; a creator note on tags.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0006_f003.sql` (exact SQL in ARCHITECTURE § F003):
   - `ALTER TABLE play_events ADD COLUMN viewer_key TEXT`.
   - Index `idx_play_events_day_game ON play_events(day, game_id)`.
   - `game_trending(game_id PK → games ON DELETE CASCADE, plays_week INTEGER, score REAL, computed_at TEXT)` and index `idx_game_trending_score(score DESC)`.
2. **`Cargo.toml`**: add `sha2 = "0.10"` (hashing the anonymous viewer key). No other new dependencies.
3. **`backend/src/routes/games.rs::record_play`** (after R2 has landed): when the play is **counted** (it passed `PlayDedupe`), the `play_events` insert also writes `viewer_key`:
   - authenticated: `"u:" + user_id`
   - anonymous: `"a:" + first 16 hex chars of SHA-256(JWT_SECRET + "|play|" + client_ip)`, where `client_ip` is the same value `PlayDedupe` keys on (`ratelimit::client_ip` with `TRUST_PROXY`).
   - Deduplicated (not counted) plays must keep writing **no** `play_events` row and must not bump `games.plays`. That is R2's behaviour; F003 relies on it, so add a test.
   - Put the hashing in a small helper (`trending::viewer_key(config, user_id, ip) -> String`) so it is unit-testable.
4. **`backend/src/trending.rs`** (new module, re-exported from `lib.rs`):
   - `pub async fn refresh(db: &SqlitePool, now: DateTime<Utc>) -> sqlx::Result<()>` runs the snapshot SQL from ARCHITECTURE § F003 in one transaction: it deletes all rows, then inserts the aggregate, and finally sets `viewer_key = NULL` on rows older than the window (privacy).
   - `pub struct TrendingCache` lives in `AppState` (new field `trending: trending::TrendingCache`). It holds `Mutex<Option<Instant>>` plus a `tokio::sync::Mutex<()>` for single flight.
     - `ensure_fresh(&state)` refreshes when the last refresh is older than `config.trending_ttl`, or when none has happened since startup. Concurrent callers wait on the single-flight lock and then re-check, so one refresh runs at a time.
     - A refresh failure is logged with `tracing::warn!` and serves the existing (stale) snapshot. It never fails the request.
   - Call `ensure_fresh` at the start of `list_games` **only when** `sort=trending`, and at the start of `related_games`. Also call it once at startup, after migrations, in `AppState::new` or `main` (log on failure).
5. **`backend/src/config.rs`**: `TRENDING_TTL_SECS` (default `600`; `0` = refresh on every trending/related read, which tests use). Invalid → startup error, like other numeric env vars.
6. **`backend/src/models.rs`**:
   - Add `plays_week: i64` to `GameRow` and `GameSummary` (serialised `playsWeek`).
   - `GAME_SELECT` gains `COALESCE((SELECT tr.plays_week FROM game_trending tr WHERE tr.game_id = g.id), 0) AS plays_week`. Every `GameSummary` producer (listings, profile, favorites, feed, related) then carries it without per-route changes; grep `GAME_SELECT` (8 uses) and the `GameSummary {` literals to be sure.
7. **`backend/src/routes/games.rs::list_games`**: add the `"trending"` sort.
   - Order: `COALESCE((SELECT tr.score FROM game_trending tr WHERE tr.game_id = g.id), 0) DESC, plays_week DESC, g.plays DESC, g.created_at DESC, g.id`.
   - Update the unknown-sort message: "expected new, popular, top, favorites or trending".
   - Keep the R7 query-shape fixes from the review round intact (don't reintroduce the `EXISTS` tag scan if R7 replaced it).
8. **`backend/src/routes/games.rs::related_games`** (new handler, or `routes/related.rs` if `games.rs` is crowded) for `GET /api/games/{id}/related`:
   - `fetch_visible_game(&state, &id, viewer.id())` (404 rules as `GET /api/games/{id}`).
   - Parse `limit`: default 8, clamp to 1–24, non-integer → 400 `bad_request` (same parser style as `/scores`).
   - Run the tag-candidate query from ARCHITECTURE § F003 (up to 100 rows), then apply the owner cap (at most **2** results per owner, the source's owner included) in Rust, in rank order, until `limit`.
   - If fewer than `limit`, fill from the trending order (published, not the source, not already chosen, same owner cap, `score > 0` first, then by `g.plays`), each with `reason: "trending"` and `sharedTags: []`.
   - `sharedTags`: the shared tags in the **source** game's tag order.
   - Load summaries in one batched query (`GAME_SELECT … WHERE g.id IN (…)`), not one per row, and keep the computed order.
9. **`backend/src/routes/mod.rs`**: register `GET /api/games/{id}/related`. No rate limit (like other public reads; the query is bounded).
10. **Tests** `backend/tests/f003.rs` (with `TRENDING_TTL_SECS=0` and `RATE_LIMIT=off` unless a test says otherwise):
    - `viewer_key`: an authed play stores `u:<id>`; an anonymous play stores `a:` + 16 hex chars, the same for the same IP and different for another IP (via `X-Forwarded-For` with `TRUST_PROXY=1`); a deduplicated second play within 10 min writes no row and returns the unchanged count.
    - Trending order: game A with 3 distinct viewers today beats game B with 1 viewer who played 5 times on different days within the window; a game whose plays are all 8+ days old has `playsWeek` 0 and sorts by the fallback order; owner plays do not count towards `playsWeek` or score; a play 6 days ago weighs less than one today (two games with one viewer each).
    - Insert `play_events` rows with explicit `day`/`created_at` directly via the pool to control the window, and call `trending::refresh(&pool, fixed_now)` for exact assertions.
    - Old rows keep `viewer_key` NULL after the window passes (refresh purges them); rows with NULL keys from before the migration each count as one viewer.
    - `sort=trending` works with `tag=` and `q=`; `total` equals the same filter with `sort=new`; unpublished games never appear; unknown sort → 400 with the new message.
    - `playsWeek` appears on `GET /api/games/{id}`, listings, favorites and profiles.
    - Related: ordering by weighted shared tags (a shared rare tag beats a shared common tag); `sharedTags` in source order; owner cap of 2; trending fill when nothing shares a tag; never includes the source or unpublished games; `limit` clamp and non-integer → 400; unpublished source → 404 for others and 200 for the owner; unknown id → 404.
    - Refresh failure tolerance: drop `game_trending` mid-test, then a `sort=trending` request still answers 200. If the harness can't express this, document why in the test file.
    - TTL: with a non-zero TTL, two reads within the TTL trigger one refresh (expose a refresh counter behind `cfg(test)` or assert via `computed_at`).

**Acceptance:** `cd backend && cargo test` (all suites green: `api.rs`, `v2.rs`, `f001.rs`, `f002.rs` if landed, `f003.rs`) and `cargo clippy --all-targets -- -D warnings`.

### engine-dev (`packages/engine/**`, `examples/**`)
No engine tasks.
- Optional, small: review the example games' `tags` in `examples/*/game.json` so related shelves on the seeded data are meaningful. Each should have at least two specific tags (e.g. `arcade`, `shooter`, `space` / `platformer`, `pixel` / `breakout`, `arcade`). Run `npm run examples` after any change.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **`packages/ui/src/api/types.ts`**:
   - `GameSort` adds `"trending"`.
   - `GameSummary` adds `playsWeek: number`.
   - New `RelatedGame = GameSummary & { reason: "tags" | "trending"; sharedTags: string[] }`.
2. **`packages/ui/src/api/client.ts`**: `getRelatedGames(id: string, query?: { limit?: number }, signal?: AbortSignal): Promise<RelatedGame[]>` → `GET /api/games/{id}/related?limit=` (id `encodeURIComponent`-ed, `limit` omitted when undefined).
3. **`packages/ui/src/components/GameCard.tsx`**: the `highlight` / `sharedTags` props and `GameGrid` forwarding, per §2. Treat a missing `playsWeek` as 0 (older servers).
4. **`packages/ui/src/components/RelatedGames.tsx`** (new): per §2. Export it from `index.ts`.
5. **`packages/ui/src/pages/HomePage.tsx`**: the `trending` sort tab, `TrendingShelf`, and `highlight="trending"` on the main grid when `sort === "trending"`.
6. **`packages/ui/src/pages/GamePage.tsx`**: render `<RelatedGames gameId={game.id} />` after the layout.
7. **`packages/ui/src/pages/DocsPage.tsx`**: the tags paragraph.
8. CSS (existing stylesheet, existing variables): `.pf-card__shared` (muted, small, single line with ellipsis), `.pf-related` spacing, and `.pf-shelf__head` (heading plus "See all" link on one row, wrapping on phones).
9. Update every test fixture/mock that builds a `GameSummary` to include `playsWeek` (typecheck will flag them).
10. **Tests**:
    - `ApiClient.f003.test.ts`: the `getRelatedGames` path/query, encoding, and `listGames({ sort: "trending" })` → `sort=trending`.
    - `GameCard.f003.test.tsx`: the trending meta line replaces the play count only when `playsWeek > 0`; up to 2 shared tags shown; no `highlight` → unchanged markup (snapshot or explicit asserts).
    - `RelatedGames.test.tsx`: renders items; hidden on empty and on error; refetches when `gameId` changes and never shows the previous game's cards (resolve the promises out of order).
    - `HomePage.f003.test.tsx`: the shelf appears only on page 1 without `q`/`tag` and hides when all `playsWeek` are 0; the "Trending" tab sets `?sort=trending`.
    - Existing `render.test.tsx`, `GamePlayer*`, `Leaderboard*` and `Studio*` tests stay green.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
No code changes. The desktop app inherits the shelf, tab and related section through `@webgame/ui`.
1. After `build:ui`, run `npm run build -w @webgame/desktop`.
2. Smoke-test against a local backend: the home page shows the Trending tab and shelf (after a few plays from two accounts), and a game page shows "More like this". Clicking a related card navigates in-app.

**Acceptance:** `npm run build -w @webgame/desktop`.

### Sequencing
- **Backend**:
  - Number the migration `0006`. It must run after the review-fix `0004_perf_indices.sql` and F002's `0005_f002.sql`. If F003 lands before F002, F002 must keep `0005`: don't renumber, since sqlx applies by version and a gap is fine while the files are added in order before any deployment.
  - Implement the `record_play` change (task 3) **after** R2's dedupe/rate-limit change is merged, on top of it. Everything else (migration, `trending.rs`, sort, related) can start at once.
  - If R7 adds denormalised columns or rewrites `list_games` filters, rebase onto it rather than duplicating.
- **Frontend** can start at once against the contract (mocked `ApiClient`). It doesn't depend on F002. If F002's frontend lands first, its feed items reuse `GameSummary` and just gain `playsWeek` in fixtures.
- **Desktop**: last, verification only.

## 5. Edge cases and security
- **Gaming the ranking**:
  - Raw plays are already bounded by `Limit::Play` and the 10-minute per-viewer dedupe (R2), but one viewer could still log up to 144 counted plays per game per day.
  - The trending **score** counts each `viewer_key` once per game per UTC day, so a single account or IP adds at most 1 point/day, and the owner's own authenticated plays count 0.
  - `playsWeek` (the displayed number) counts deduplicated, non-owner plays, so it can be inflated more cheaply than the score, but it doesn't decide the order beyond ties.
  - Farming from many IPs/accounts is out of scope (as is anti-cheat in F001). Moderation (unpublish) removes a game from all listings immediately.
- **Privacy**:
  - Anonymous viewers are stored only as a truncated, secret-keyed SHA-256 of their IP, never the IP itself.
  - Keys older than the 7-day window are nulled on each refresh, so they can't be used to track anyone over time.
  - Keys are never exposed through the API. Changing `JWT_SECRET` merely changes future keys.
- **Staleness**:
  - `playsWeek` and the trending order come from a snapshot refreshed at most every `TRENDING_TTL_SECS` (10 min) and only when a trending/related read happens. Other listings show the last snapshot's `playsWeek`, which may be older. That's acceptable and documented as approximate.
  - A server restart refreshes at startup.
  - Games created after the last refresh have `playsWeek` 0 until the next one.
- **Visibility**: `game_trending` may hold rows for unpublished games. Every read filters `g.published = 1` (except the owner-visible source in `/related`), so unpublishing or moderation takes effect at once without a refresh. Deleted games cascade out of `game_trending`.
- **Window boundaries**: the window is 7 UTC days by `play_events.day` (today and the 6 days before), computed from server time at refresh. Weights: today 7/7, yesterday 6/7, … six days ago 1/7.
- **Rows from before F003**: `viewer_key` is NULL, so each row counts as its own viewer. Older rows (pre-R2) may be inflated; that washes out of the window within 7 days of deployment. Acceptable.
- **Related with no tags or a tiny catalogue**: the trending fill (then all-time plays) keeps the shelf useful. With only one published game, the result is `[]` and the UI hides the section.
- **Tag weighting**: the weight is `1 / log2(2 + n)`, where `n` is the number of published games with the tag (n ≥ 1 for any shared tag, so the weight is at most 0.63 and strictly decreasing). Generic tags still count, just less.
- **Performance**:
  - The refresh is one aggregate over ≤ 7 days of `play_events` via `idx_play_events_day_game`, at most once per TTL, behind single flight.
  - The related candidate query reads `game_tags` by `idx_game_tags_tag` for ≤ 8 tags and is capped at 100 rows.
  - `sort=trending` sorts the filtered published set like `top` does today. That's fine at SQLite scale; revisit along with R7's denormalisation if needed.
  - The `plays_week` subquery in `GAME_SELECT` is a PK lookup.
- **Old clients** ignore `playsWeek` and never send `sort=trending`. New clients against an old server get a 400 for `sort=trending`; the shelf then hides silently and the grid shows its error state. Acceptable, since web and server ship together.

## 6. Test expectations
- **Backend**: `tests/f003.rs` covers every bullet of backend task 10, plus unit tests in `trending.rs` for `viewer_key` (stable, 16 hex chars, prefix) and the weight function. Existing suites stay green; update any exact-JSON assertions on `GameSummary` for the new `playsWeek` field.
- **UI**: the new tests listed, with no network calls (mocked `ApiClient`). Typecheck clean.
- **Desktop**: the build is green.
- **QA end-to-end** (seeded examples, accounts A = the seed owner, B and C, `TRENDING_TTL_SECS=0`):
  1. On a fresh seed with no recent plays, the home page has no "Trending this week" shelf, and the "Trending" tab lists games in the fallback order (all-time plays).
  2. B plays Brick Breaker, then C plays Brick Breaker, and B plays Space Dodge 5 times within a minute. Trending shows Brick Breaker first (2 viewers vs 1). Space Dodge shows "🔥 1 this week", since dedupe counted one play.
  3. A (the owner) plays Pixel Peaks 3 times, 11 minutes apart. Pixel Peaks' `playsWeek` and position don't change.
  4. On Pixel Peaks' page, "More like this" lists the other games that share tags first, with their shared tags shown, and is filled to the limit with trending games.
  5. A unpublishes Brick Breaker. It disappears from Trending and from every related shelf at once. It still shows its related shelf to A on its own page.
  6. Clicking a related card navigates to that game, and the shelf updates without flashing the previous game's items.
  7. Desktop: steps 2 and 4 render identically.

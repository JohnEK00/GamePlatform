# F002: Follow creators and an activity feed

Status: **specced**. Size: **M**. Areas: backend, frontend, desktop (menu entry). Engine: no changes.
Contracts: `docs/API.md` § F002 additions, `docs/GAME_FORMAT.md` § F002 additions, `docs/ARCHITECTURE.md` § F002 additions.
Depends on: **F001** (backend) for `ScoreSubmitResult.personalBest` and `Game.leaderboard`. See "Sequencing".

## 1. Goal and user stories
The platform has no way to keep up with a person. Favorites track games; nothing tracks creators or players, so there is no reason to come back unless you remember a title. F002 adds:
- **Follows**: follow any user (creators, but also players whose runs you want to see). Follower/following counts and lists on profiles.
- **An activity feed** at `/feed`: new games and bundle updates from people you follow, their new personal bests (F001) and achievement unlocks (v2), plus updates to games you have **favorited** even when you don't follow the owner.
- **Cold-start suggestions**: an empty feed suggests creators, ranked first by the games you already favorited.

User stories:
1. As a player, I click **Follow** on a creator's profile or game page, and when they publish a new game it appears at the top of my `/feed`.
2. As a player who favorited "Pixel Peaks", I see "Pixel Peaks was updated to v4" in my feed even though I don't follow its creator.
3. As a player following a friend, I see "Sam set a new personal best in Space Dodge: 12,400" and "Sam unlocked Flawless and 2 more in Brick Breaker".
4. As a creator, my profile shows "128 followers · 12 following", and the list of who follows me.
5. As a new user with an empty feed, I see up to 6 suggested creators (those whose games I favorited first) with Follow buttons.
6. As a desktop user, **View → Feed** opens the feed.

Non-goals (later items): unread badges and push/OS notifications (F007), private accounts or hiding play activity (scores and unlocks are already public on leaderboards/profiles), blocking, comment events in the feed, a home-page "following" shelf, emails.

## 2. UX notes
- **FollowButton** (`packages/ui/src/components/Follow.tsx`), props `{ username, isFollowing, followers?, variant?: "default" | "compact", onChange?(r: FollowResponse) }`.
  - Not following: primary button "Follow". Following: ghost button "Following", whose label becomes "Unfollow" on hover/focus.
  - Optimistic toggle; revert and toast the error on failure. 429 → toast "Slow down — try again in {retryAfter}s".
  - Anonymous: navigates to `/login?next=<current path>`.
  - Hidden when the viewer is that user.
- **Profile page** (`ProfilePage.tsx`):
  - FollowButton in the header (where "Edit profile" sits for yourself).
  - Stats row gains `{followers} followers` and `{following} following`, linking to `/u/:username/followers` and `/u/:username/following`. Use `formatCount`.
- **Follow list page** (`FollowListPage.tsx`, routes `u/:username/followers` and `u/:username/following`): title "People following {name}" / "{name} follows", a list of `UserLink` rows (avatar + name + @username) with `Pagination` (24 per page). Empty: "No followers yet." / "Not following anyone yet."
- **Game page** (`GamePage.tsx`): a compact FollowButton next to the owner `UserLink`, unless the viewer is the owner. `Game` does not carry follow state; the page reads it from `GET /api/users/{owner.username}` lazily only when logged in (or use the `FollowProvider` cache below).
- **Follow state cache**: a small `FollowProvider` (same pattern as `FavoritesProvider`) keeps `username(lowercased) → isFollowing` so that buttons for the same user on one screen stay in sync (feed suggestions, profile, game page).
- **Feed page** (`FeedPage.tsx`, route `feed`, wrapped in `RequireAuth`):
  - Title "Feed". Segmented tabs: **Everything · New games** (New games = `kinds=gamePublished,gameUpdated`). The last tab is remembered in localStorage key `webgame.feed.tab` (try/catch).
  - Each item: actor avatar, a sentence, `timeAgo(createdAt)`, and a compact game row (thumbnail via `Thumbnail`, title, link to `/games/{id}`). Sentences:
    - `gamePublished`: "**{actor}** published **{game}**"
    - `gameUpdated`: "**{actor}** updated **{game}** to v{version}"
    - `personalBest`: `score.first` ? "**{actor}** scored {display} in **{game}**" : "**{actor}** set a new personal best in **{game}**: {display}", where `display = formatScore(score.value, score.leaderboard.format)`, prefixed by the label when set ("Best time 1:02.345").
    - `achievementUnlocked`: count 1 → "**{actor}** unlocked **{name}** in **{game}**"; count > 1 → "…unlocked **{name}** and {count−1} more in **{game}**". Show the achievement icon when `iconUrl` is set.
  - Items with `reason: "favorite"` carry a small muted tag "From your favorites".
  - "Load more" button while `nextCursor` is non-null (no infinite scroll). Skeleton rows while loading; `ErrorState` with retry on failure.
  - Empty state (no items on the first page, Everything tab): EmptyState "Your feed is empty" + "Follow creators to see their new games and high scores here." Below it, **Suggested creators** from `/api/feed/suggestions`: avatar, name, "{games} games", reason hint ("You favorited their games" / "Popular creator"), FollowButton. After following someone, show a "Refresh feed" button.
  - New games tab empty: "No new games from people you follow yet."
- **Navigation** (`Layout.tsx`): a "Feed" `NavLink` (logged in only) placed before "Favorites", and a "Feed" entry in the user menu.
- **Docs page**: a short "Your players can follow you" note in the creator docs: what produces feed events (see GAME_FORMAT § F002).

## 3. Contract changes (summary; normative text lives in docs/)
- **API**:
  - `PUT|DELETE /api/users/{username}/follow` → `FollowResponse`.
  - `GET /api/users/{username}/followers` and `/following` → `Page<UserRef>`.
  - `GET /api/users/{username}` (`UserProfileResponse`) gains `followers`, `following`, `isFollowing`.
  - `GET /api/feed?cursor=&limit=&kinds=` → `FeedPage`.
  - `GET /api/feed/suggestions` → `SuggestedCreator[]`.
  - New rate-limit buckets `Follow` and `Feed`; a cap of 2000 follows per user.
- **Event production rules** (server side, no client calls): which actions write activity events, coalescing, visibility.
- **Game format**: no protocol change; documents which game actions become feed events.
- **Architecture**: migration `0005_f002.sql`, the fan-out-on-read model, and coalescing.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0005_f002.sql` (exact schema in ARCHITECTURE § F002):
   - `follows` table with a self-follow `CHECK`, and indexes on `(followee_id, created_at DESC)` and `(follower_id, created_at DESC)`.
   - `games.first_published_at TEXT` (nullable), backfilled with `created_at` for published games.
   - `activity_events` table and indexes.
   - Backfill one `gamePublished` event per currently published game, inserted in `created_at` order, so following someone is useful from day one.
2. **`backend/src/routes/follows.rs`** (new):
   - `put_follow`, `delete_follow` (🔒): resolve the username case-insensitively (404 `not_found` "User"). Self → 422 `validation`. `Limit::Follow`. PUT is idempotent (`ON CONFLICT DO NOTHING`); a PUT that would create follow #2001 → 422. Both return `{ following, followers }`.
   - `list_followers`, `list_following`: `parse_paging(page, perPage, 24)` (max 100), newest follow first, `Page<UserRef>`.
3. **`backend/src/routes/users.rs`**: `UserProfile` gains `followers: i64`, `following: i64`, `is_following: bool` (serialised camelCase; false when anonymous or self).
4. **`backend/src/activity.rs`** (new module): the event writers. Each takes a `&mut SqliteConnection`/transaction (or the pool) and is called **after** the main write succeeds. A failure to write an event is logged with `tracing::warn!` and **never** fails the request.
   - `record_game_published(game_id, owner_id, version)`.
   - `record_game_updated(game_id, owner_id, version)`: coalesces (deletes a `gameUpdated` row for the same game created in the last 24h, then inserts).
   - `record_personal_best(actor, game_id, score, first)`: coalesces per `(actor, game, UTC day)`.
   - `record_achievement(actor, game_id, ach_id)`: coalesces per `(actor, game, UTC day)` and carries `ach_count = previous + 1`.
5. **Hook the writers** per API § F002 "Event production":
   - `games.rs::create_game_record`: when `published`, set `first_published_at = now` and record `gamePublished` in the same transaction.
   - `games.rs::update_game`: when the game goes from unpublished to published **and** `first_published_at IS NULL`, set it and record `gamePublished`. Re-publishing never emits.
   - `games.rs::upload_bundle`: when the game is published, record `gameUpdated` with the new version (inside the existing transaction, after the version `UPDATE` succeeds).
   - `scores.rs::submit_score` (F001 version): when `personalBest` is true, the game is published and the submitter is not the owner → `record_personal_best` with `first = (no previous score)`.
   - `achievements.rs::unlock_achievement`: when `new` is true, the game is published and the user is not the owner → `record_achievement`.
   - Studio sessions never reach these endpoints (existing parent rule), so nothing else is needed.
6. **`backend/src/routes/feed.rs`** (new):
   - `get_feed` (🔒, `Limit::Feed`): the query in ARCHITECTURE § F002. Parse `cursor` (decimal string of a positive i64, else 400), `limit` (default 20, 1–50 clamped; non-integer → 400), `kinds` (comma list of the four kinds; unknown kind → 400; empty → all).
     - Build `FeedItem`s: `game` via `GAME_SELECT`/`game_row_from_row(...).summary()`, `actor` as `UserRef`, `score.leaderboard` from the game's F001 columns, `achievement` from the `achievements` table joined on `(game_id, ach_id)`.
     - Drop `achievementUnlocked` rows whose definition no longer exists.
     - `reason` is `"following"` when the viewer follows the actor, otherwise `"favorite"`.
     - `nextCursor` = id of the last item when more rows exist (fetch `limit + 1`), else null.
   - `get_suggestions` (🔒, `Limit::Feed`): the algorithm in API § F002.
7. **`backend/src/routes/mod.rs`**: register `/users/{username}/follow` (PUT, DELETE), `/users/{username}/followers`, `/users/{username}/following`, `/feed`, `/feed/suggestions`. Keep `/users/me/*` routes ahead of `/users/{username}` as today; `me` is not a valid username for follow routes (it resolves through the normal lookup and 404s unless a user is literally named "me", which is fine).
8. **`backend/src/ratelimit.rs`**: `Limit::Follow` = 60 per 10 min (PUT and DELETE share it), `Limit::Feed` = 60/min (feed and suggestions share it). Both per user.
9. **`backend/src/seed.rs`**: no changes. Seeded games are created through `create_game_record`, so they emit `gamePublished` like any upload.
10. **Tests** `backend/tests/f002.rs`:
    - Follow/unfollow idempotency and counts; self-follow → 422; unknown user → 404; anonymous → 401; the 2001st follow → 422 (insert 2000 rows directly via the pool).
    - Follower/following lists: order, paging, and that deleting a user removes their rows (cascade).
    - Profile `followers`/`following`/`isFollowing` for anonymous, self and another viewer.
    - Events: publish-on-create → one `gamePublished`; create unpublished then PATCH publish → one; unpublish + re-publish → still one; two bundle replaces within 24h → one `gameUpdated` with the latest version; a bundle replace of an unpublished game → none.
    - `personalBest`: only on PB, not for the owner, one row per actor/game/day (the second PB on the same day replaces the first), `first` true for the first score.
    - `achievementUnlocked`: count coalescing; an event disappears from the feed when a bundle replace removes the definition.
    - Feed: shows followed actors only, plus `gamePublished`/`gameUpdated` for favorited games with `reason: "favorite"`; never the viewer's own events; unpublished games hidden (including after a moderation unpublish); deleted games gone; cursor paging without duplicates or gaps; `kinds` filter; bad `cursor`/`kinds`/`limit` → 400.
    - Suggestions: favorited owners first, excludes self, already-followed users and users without published games; max 6.
    - Rate limits → 429 with `RATE_LIMIT` on.
    - The migration backfill: a published game created before the migration appears as `gamePublished` (create the game, then run the backfill SQL in the test, or assert on a fresh DB that new games emit; pick whichever `tests/common` supports).

**Acceptance:** `cd backend && cargo test` (all green, including `api.rs`, `v2.rs` and `f001.rs`) and `cargo clippy --all-targets -- -D warnings`.

### engine-dev (`packages/engine/**`, `examples/**`)
No tasks. The engine protocol is unchanged; feed events come from the existing `submitScore`/`unlockAchievement` paths.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **`packages/ui/src/api/types.ts`**: `FollowResponse`, `FeedItemKind`, `FeedItem`, `FeedPage`, `FeedQuery`, `SuggestedCreator`; extend `UserProfileResponse` with `followers`, `following`, `isFollowing`.
2. **`packages/ui/src/api/client.ts`**:
   - `followUser(username)`, `unfollowUser(username)`, `setFollowing(username, follow: boolean)` → `FollowResponse`.
   - `listFollowers(username, query?: PageQuery)`, `listFollowing(username, query?)` → `Page<UserRef>`.
   - `getFeed(query?: { cursor?: string; limit?: number; kinds?: FeedItemKind[] }, signal?)` → `FeedPage` (`kinds` joined with commas, omitted when empty).
   - `getFeedSuggestions()` → `SuggestedCreator[]`.
   - Usernames are `encodeURIComponent`-ed in paths.
3. **`packages/ui/src/components/Follow.tsx`**: `FollowProvider`, `useFollows()`, `FollowButton` per §2. Mount `FollowProvider` next to `FavoritesProvider` in `WebGameApp.tsx`. Export the button and provider from `index.ts`.
4. **`packages/ui/src/components/FeedItem.tsx`**: renders one `FeedItem` per §2 sentences (pure, easy to test). Unknown `kind` values render nothing (forward compatibility).
5. **`packages/ui/src/pages/FeedPage.tsx`**: tabs, paging with cursor, empty state with suggestions.
6. **`packages/ui/src/pages/FollowListPage.tsx`**: one component, `mode: "followers" | "following"`.
7. **`packages/ui/src/pages/ProfilePage.tsx`** and **`GamePage.tsx`**: FollowButton and counts per §2.
8. **`packages/ui/src/WebGameApp.tsx`**: routes `feed` (RequireAuth), `u/:username/followers`, `u/:username/following`.
9. **`packages/ui/src/components/Layout.tsx`**: "Feed" nav link and user-menu entry.
10. **`packages/ui/src/pages/DocsPage.tsx`**: the creator note.
11. CSS for feed rows and follow buttons in the existing stylesheet, using existing CSS variables.
12. **Tests**:
    - `ApiClient.f002.test.ts`: paths, methods, encoding of usernames, `kinds` serialisation, cursor passing.
    - `Follow.test.tsx`: optimistic toggle, revert on error, anonymous redirect, hidden for self, two buttons for the same user stay in sync via the provider.
    - `FeedItem.test.tsx`: each kind's sentence, time-format scores via `formatScore`, achievement count text, the "From your favorites" tag, unknown kind → nothing.
    - `FeedPage.test.tsx`: load more appends and hides when `nextCursor` is null; empty state shows suggestions; tab switch sends `kinds`.
    - Existing `render.test.tsx`, `GamePlayer*` and `Studio` tests stay green (update mocks of `getUser` to include the new fields).

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
1. **`apps/desktop/src-tauri/src/menu.rs`**: add a **View → Feed** item, id `"feed"`, accelerator `CmdOrCtrl+Shift+F`, placed first in the View menu followed by a separator. Add `"feed"` to `FORWARDED` and update the module doc comment.
2. **`apps/desktop/src/nativeMenu.ts`**: `ROUTES.feed = "/feed"`. (The route is behind `RequireAuth`, which already redirects to login when signed out.)
3. Smoke-test against a local backend: follow the demo user, then replace a bundle, and see the feed update via the menu item.

**Acceptance:** `npm run build -w @webgame/desktop`, plus `cd apps/desktop/src-tauri && cargo check` and `cargo clippy -- -D warnings`.

### Sequencing
- **Backend**: the event hooks in `scores.rs` need F001's `personalBest`. Start with the migration, follows, feed and the game/achievement hooks in parallel with F001. Land the `personalBest` hook after F001's backend is merged. The migration is numbered `0005`: it runs after F001's `0003` and the review-fix index migration `0004_perf_indices.sql`.
- **Frontend** can start at once against the contracts (mock the API). `FeedItem` uses F001's `formatScore` and `LeaderboardConfig`, which already exist in `@webgame/ui`.
- **Desktop** last, after `build:ui`.
- **QA**: the end-to-end pass in §6.

## 5. Edge cases and security
- **Privacy**: the feed only exposes data that is already public (published games, versions, leaderboard scores, profile achievements). Events on unpublished games are never shown to anyone, the owner included (the actor's own events are excluded anyway). Follower lists are public, like favorites counts.
- **Visibility is checked at read time**: unpublishing (by the owner or by moderation) hides every event about that game immediately. Re-publishing shows them again, which is acceptable. Deleting a game or a user cascades its events and follows.
- **Spam and flooding**:
  - `gamePublished` happens at most once per game (`first_published_at`), so toggling publish can't spam followers.
  - `gameUpdated` is coalesced to one per game per rolling 24h.
  - `personalBest` and `achievementUnlocked` are coalesced per actor/game/UTC day.
  - Owners never produce score/achievement events on their own games (stops testing noise and self-promotion).
  - Follow toggles are rate-limited (60/10 min), and a user can follow at most 2000 people, which also bounds the feed's `IN (…)` subquery.
- **Fake scores**: a cheating score already shows on the public leaderboard. The feed adds no new exposure, and moderation (unpublish) hides it. Anti-cheat stays out of scope (as in F001).
- **Removed achievements**: a bundle replace that drops a definition cascades its `user_achievements`. Feed rows referencing it are filtered out by the join, not deleted.
- **Leaderboard order changes** (F001 edge case): an old `personalBest` event keeps its stored score; it is shown with the game's *current* format. Acceptable.
- **Cursor**: an opaque decimal id string. Events are append-only apart from coalescing (delete + insert gets a new, higher id), so paging never duplicates; a coalesced row may jump to the top, which is the intended "bump".
- **Case-insensitive usernames**: all follow routes resolve via `username_lower`.
- **Self**: you cannot follow yourself (422 and a DB `CHECK`); your own actions never appear in your feed.
- **Performance**: the feed query uses `idx_activity_actor_id` per followee and the favorites index, limited to 51 rows. That's fine at SQLite scale with the 2000-follow cap. No fan-out-on-write tables or background jobs.
- **Old clients**: the new profile fields are additive; old UIs ignore them.

## 6. Test expectations
- **Backend**: `tests/f002.rs` covers every bullet of backend task 10. Existing suites stay green. Event-writer failures are logged, never surfaced: one test drops `activity_events` mid-test (or uses a failing writer behind `cfg(test)`) and asserts the bundle replace still returns 200. If that's impractical with the test harness, document why in the test file.
- **UI**: the new tests listed, with no network calls (mocked `ApiClient`).
- **Desktop**: build + `cargo check`/clippy green.
- **QA end-to-end** (seeded examples, two accounts A and B):
  1. B follows A (the owner of the seeded games) from A's profile. The counts update on both profiles, and A's followers list shows B.
  2. A replaces Space Dodge's bundle twice. B's feed shows **one** "updated to v3" item at the top.
  3. A creates a new game as unpublished, then publishes it. B sees "published"; A unpublishes and re-publishes, and B still sees a single item.
  4. B unfollows A but has Pixel Peaks favorited. A replaces Pixel Peaks's bundle, and B sees it tagged "From your favorites".
  5. A follows B. B beats their personal best in Space Dodge twice in one day, and A sees a single PB item with the higher score. B unlocks three Brick Breaker achievements, and A sees "unlocked X and 2 more".
  6. A new account C sees the empty state with suggestions; following one from there and refreshing fills the feed.
  7. Desktop: View → Feed opens `/feed`, and step 2 renders identically.

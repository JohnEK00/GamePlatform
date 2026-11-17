# F021: Collection activity: feed items and "added to a collection" notifications

Status: **specced**. Size: **M** (backend medium: one migration with an `activity_events` rebuild, one activity writer, a third feed branch, one notification kind with a read-time filter; frontend small: one feed item, one feed tab, one notification text, one settings switch; desktop verification only; one round). Areas: backend, frontend, desktop (verification only). No engine changes.
Contracts: `docs/API.md` § F021 additions (feed kind and types, notification kind, setting, triggers, visibility, withdrawal), `docs/ARCHITECTURE.md` § F021 additions (migration `0019_f021.sql` with the exact SQL, writer, feed branch, notification write and read paths), `docs/GAME_FORMAT.md` § F021 additions (no changes).
Depends on: F002 (feed), F007 (notifications), F008 (collections) and F018 (no `notifications.kind` CHECK, mutes, group dedupe, `withdraw_pool`), all shipped. The migration is **`0019_f021.sql`** and runs after `0017_f018.sql`. **No new Rust or JS dependencies.**
Unblocks: F015 (`screenshotPosted` feed kind) needs no `activity_events` rebuild after this one.

## 1. Goal and user stories
F008 made collections a people-driven discovery channel, but it is silent: the curator's followers never hear about new picks, and creators never learn that a player championed their game. Both groups only find out by visiting a profile or a game page shelf.

F021 adds:
- A **feed item** `collectionUpdated`: "Mia added 3 games to *Cozy games*", with up to 4 of the added games and the curator's notes. One item per collection per UTC day, moving to the top as more games are added.
- A **notification** `addedToCollection` for game creators: "Mia added Space Dodge to *Cozy games*", linking to the collection. Once per collection and game, withdrawn if the game is removed before the creator reads it.
- A Settings switch **"My games added to collections"** (`collections`, default on), and a **Collections** tab on `/feed`.
- **Private collections never generate activity.** Adds to private collections write nothing, and making a collection private hides its feed items and notifications at once.
- `activity_events` is rebuilt once **without the `kind` CHECK** (kinds are validated in Rust, as `reports.target_type` since F008 and `notifications.kind` since F018), so F015 and later feed kinds need no rebuild.

User stories:
1. As a player who follows a curator, I open `/feed` and see "Mia added 3 games to Cozy games" with three game thumbnails and her one-line notes, and click through to the collection or straight to a game.
2. As a curator, I add five games to my public "Best platformers" list over an afternoon. My followers see one item that grows, not five.
3. As a creator, my bell says "Mia added Space Dodge to Cozy games". I click it and land on `/c/{id}`, where I can thank her in a comment on my game, follow her, or report the collection if it is abusive.
4. As a player with a private "Play later" list, nothing I add there ever shows up in anyone's feed or bell.
5. As a curator, I add a game by mistake and remove it a minute later. Its creator never sees a notification (withdrawn while unread), and my followers' feed item no longer lists it.
6. As a creator of a popular game, I switch off "My games added to collections", or mute the game (F018), and these notifications stop.
7. As a keyboard or screen-reader user, the feed item is one article with real links for the curator, the collection and each game, and the notes are plain text.

Non-goals (later items): announcing a collection when it changes from private to public (proposed as F022), following a collection, notifying when a game's note changes or the list is reordered, notifying collection owners when a game in their list is updated (F002 favorites already cover that pattern for favorites), a "who collected my game" list for creators, email or push.

## 2. UX notes

### 2.1 Feed item `collectionUpdated` (`FeedItem.tsx`)
- Sentence (normative): **"{actor} added {title of the newest game} to {collection title}"** when `collection.gameCount === 1`, else **"{actor} added {gameCount} games to {collection title}"**. The actor links to `/u/{username}`; the collection title links to `collection.path`; a single game title links to `/games/{id}`.
- Under the sentence, a compact list (`<ul class="pf-feed-collection-games">`) of `collection.games` (up to 4, newest added first). Each `<li>`: the game thumbnail (40 px, `alt=""`, decorative), the game title as a link to `/games/{id}`, "by {owner}" in muted text, and the curator's note in muted text in typographic quotes when non-empty (plain text, single line, ellipsis at the item width, full text in `title`).
- When `gameCount > games.length`: a last line **"+{gameCount - games.length} more in {collection title}"** linking to `collection.path`.
- The time (`createdAt`, relative, as other feed items) and the existing feed item layout (actor avatar, sentence, time).
- Icon: the 📚 glyph used by `CollectionCard` placeholders (`aria-hidden`).
- An item with `collection: null` or `collection.games` empty is not rendered (defensive; the server never sends one).
- `isKnownFeedItem` / `FEED_ITEM_KINDS` gain `"collectionUpdated"`.

### 2.2 Feed tab
- `/feed` tabs become **Everything**, **New games**, **Collections**. Collections → `kinds: ["collectionUpdated"]`. The stored tab (`FEED_TAB_KEY`) accepts `"collections"`; unknown stored values still fall back to "Everything".
- Empty state for the Collections tab: "No collection updates yet. Follow players who curate collections to see their picks here." with the existing suggestions block below (as for the other tabs).

### 2.3 Notification `addedToCollection`
- Summary (normative, `notificationParts`): **"{actor} added {game title} to {collection title}"**. Parts: `name`, `text(" added ")`, `title(game.title)`, `text(" to ")`, `title(collection.title)`. When `collection` is missing (defensive): "… to a collection".
- No excerpt. Icon: 📚 (`aria-hidden`).
- `path` is `/c/{collectionId}` (validated by the existing `safeNotificationPath`).
- **OS notifications** (desktop, `osNotificationsFor`) use **"{actor} added {game title} to a collection"**: the collection title is free text written by another user and never goes to the OS (the F007 rule for comment text, extended). Implement it as a pure `osNotificationText(n)` that equals `notificationText(n)` for every other kind.
- `/notifications` page item action (F018 § 2.3): `muteActionFor` returns the **game** mute for `addedToCollection` items with a `game` ("Mute notifications for {title}").

### 2.4 Settings → Notifications
- A seventh switch after "New games from creators I follow": **"My games added to collections"**, hint "Someone adds a game you made to a public collection." Key `collections`. Hidden when the settings response has no `collections` field (older server), using the existing per-field rule.

### 2.5 Accessibility (normative)
- The feed item stays one `<article>` with an accessible sentence; every link has visible text (no icon-only links). Notes are text nodes (never HTML), quoted visually with `“ ”` characters that are part of the text.
- The new feed tab uses the existing `Tabs` component (roving focus, `aria-selected`).

## 3. Contract changes (summary; normative text lives in docs/)
- **API.md § F021 additions**:
  - `FeedItemKind` += `"collectionUpdated"`; new types `FeedCollection`, `FeedCollectionGame`; `FeedItem.collection`.
  - Event production and coalescing rules; feed source rule for the new kind; `kinds` filter accepts it.
  - `NotificationKind` += `"addedToCollection"`; `Notification.collection`; `NotificationSettings.collections`.
  - Trigger, recipient, group, dedupe, withdrawal, visibility, mute scope and path for the new kind.
  - No new endpoints and no new rate limits.
- **ARCHITECTURE.md § F021 additions**: migration `0019_f021.sql` (exact SQL: `activity_events` rebuild without the kind CHECK, nullable `game_id`, `collection_id`, `game_ids`; `notifications.collection_id`; `notification_settings.collections`; two indexes), the writer, the third feed branch, the notification write and read paths.
- **GAME_FORMAT.md § F021 additions**: none.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0019_f021.sql`: copy the SQL in ARCHITECTURE § F021 "Data" **verbatim** (order matters). Never edit `0001`–`0017`.
2. **`src/activity.rs`**:
   - `pub const KIND_COLLECTION_UPDATED: &str = "collectionUpdated"`; `KINDS` becomes 5 entries. Update the module doc: `KINDS` is now the only guard on `activity_events.kind`.
   - `pub const COLLECTION_EVENT_GAMES_MAX: usize = 100`.
   - `pub async fn record_collection_added(conn: &mut SqliteConnection, actor_id: &str, collection_id: &str, game_id: &str, now: &str)`: the coalescing write in ARCHITECTURE § F021 "Writer", in a nested transaction (savepoint), best effort like the other writers. `now` is the exact `added_at` string just written, and `day = &now[..10]`.
   - The four existing writers keep binding `game_id` (unchanged).
3. **`src/routes/collections.rs`**:
   - `put_collection_game`: in the `None` (new item) branch, after the guarded insert succeeded and inside the same `BEGIN IMMEDIATE` transaction, read `(c.visibility, g.published, g.owner_id)` with the query in ARCHITECTURE § F021 "Writer"; if the collection is `public` and the game `published = 1`, call `activity::record_collection_added(&mut tx, user, id, game_id, &now)`. After `tx.commit()`, if the same condition held and the game owner is not the caller, `notifications::notify_pool` with the `addedToCollection` notification (§ ARCHITECTURE "Notification write"). Note-only updates (`added: false`) write nothing.
   - `create_collection`: the same two steps when `gameId` was given and the new collection is public.
   - `delete_collection_game`: when `removed` is true, after the commit, `notifications::withdraw_pool(game_owner, Kind::AddedToCollection, &collection_group(id, game_id))` (best effort; look the owner up with `SELECT owner_id FROM games WHERE id = ?`; a deleted game needs nothing, its rows cascaded).
   - `update_collection`, `put_collection_order`, `delete_collection`, the seed: **no** activity or notification writes (deletes cascade through the new foreign keys).
4. **`src/routes/feed.rs`**:
   - `FEED_SQL`: add branch (c) and the extra outer columns exactly as in ARCHITECTURE § F021 "Feed query". Branches (a) and (b) are unchanged.
   - Rows: `game_id` is now `Option<String>`. For `collectionUpdated` rows, load in batched queries per page (never per row): the collections (`id, title` where public), the item rows (`collection_id, game_id, note, added_at`) of the page's collections, and the needed games through the existing `GAME_SELECT … json_each` query (published only). Build `FeedCollection` per ARCHITECTURE § F021 "Feed assembly"; skip an item whose filtered game list is empty (the cursor stays the last row, as today).
   - `FeedItem.collection: Option<FeedCollection>` (serialised as `null` for other kinds); `FeedItem.game` = the first entry's game for `collectionUpdated`.
   - `parse_kinds` accepts the new kind automatically through `KINDS`.
5. **`src/notifications.rs`**:
   - `Kind::AddedToCollection` (`"addedToCollection"`, setting column `collections`); add to `Kind::ALL`.
   - `pub fn collection_group(collection_id, game_id) -> String` = `"coll:{collectionId}:{gameId}"`.
   - `NewNotification.collection_id: Option<String>` (`Some` only for this kind; every existing constructor passes `None`). `try_notify`'s insert writes it (`?10`).
   - `VISIBLE`: the collection predicate in ARCHITECTURE § F021 "Notification read path" (used by the count and the list).
   - `list_page`: `LEFT JOIN collections c ON c.id = n.collection_id`, select `n.collection_id, c.title AS c_title`; for the new kind: `commentId`/`excerpt`/`threadId` null, `ownsThread`/`creatorHeart` false, `eventCount = actorCount`, `path = "/c/{collectionId}"`, `collection = { id, title, path }`. Other kinds: `collection: null`.
   - Settings: `collections` in `NotificationSettings`, `SettingsPatch`, `load_settings`, `update_settings`.
   - Unit test `kinds()` covers the new kind and column.
6. **`src/models.rs`** (or `feed.rs`): `FeedCollection`, `FeedCollectionGame`, `NotificationCollection`, all `#[serde(rename_all = "camelCase")]`.
7. **Existing tests**: if any test asserts that `activity_events` rejects an unknown kind, change it to assert that the insert now succeeds (documents the Rust-side check), as F008 did for reports. `tests/review2.rs` N1 must stay green unchanged; extend it with the branch (c) assertion in § 6.
8. **`tests/f021.rs`** (§ 6), using `common::setup()` and `t.clock` (`ManualClock`) for the rate-limit test.

**Acceptance:** `cd backend && cargo test` (all suites green, including `f002`, `f004`, `f007`, `f008`, `f018`, `review2`, `review4`, `review5`) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`): `FeedItemKind` += `"collectionUpdated"`; `FeedCollectionGame`, `FeedCollection`; `FeedItem.collection?: FeedCollection | null`; `NotificationKind` += `"addedToCollection"`; `NotificationCollection`; `Notification.collection?: NotificationCollection | null`; `NotificationSettings.collections?: boolean`. Export new types from `src/index.ts`. The client needs no new methods (`getFeed` already passes `kinds`).
2. **`src/notifications.ts`**: `NOTIFICATION_KINDS` += `"addedToCollection"`; the summary (§ 2.3); `muteActionFor` → game mute; new pure `osNotificationText(n)` used by `osNotificationsFor`.
3. **`components/FeedItem.tsx`**: `FEED_ITEM_KINDS` += `"collectionUpdated"`; the item (§ 2.1), with a small `FeedCollectionGames` subcomponent in the same file.
4. **`pages/FeedPage.tsx`**: the Collections tab and its empty state (§ 2.2).
5. **`components/NotificationSettings.tsx`**: the `collections` switch (§ 2.4).
6. **`components/NotificationItem.tsx`**: the 📚 icon for the new kind (text comes from `notificationParts`).
7. **Styles** (`styles.css`): `.pf-feed-collection-games` (compact rows, 40 px thumbs, note ellipsis); existing tokens, 4.5:1 contrast.
8. **Tests**:
   - `notifications.test.ts`: the `addedToCollection` summary with and without `collection`; `isKnownNotification` accepts it; `muteActionFor` → game; `osNotificationText` omits the collection title and equals `notificationText` for every other kind; `osNotificationsFor` uses it.
   - `FeedItem.test.tsx` (extend or new `FeedItem.f021.test.tsx`): one game (title in the sentence), three games ("added 3 games"), notes quoted and omitted when empty, "+N more" link, links to `/c/{id}`, `/games/{id}`, `/u/{name}`; `collection: null` or empty `games` renders nothing.
   - `FeedPage` test: the Collections tab requests `kinds=collectionUpdated`, remembers the tab, shows its empty state.
   - `NotificationSettings` test: the `collections` switch shown when present, hidden when absent, round trip.
   - Existing suites stay green.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
No code changes. Verify on the desktop build:
- an `addedToCollection` notification fires one OS notification whose body is "{actor} added {game} to a collection" (no collection title);
- clicking the in-app item opens `#/c/{id}`;
- the feed's Collections tab works under the hash router.
**Acceptance:** `npm run build -w @webgame/desktop`, `npm test -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo check`. Record the result in the round notes; no file changes expected.

### engine-dev
None.

### Sequencing
backend-dev and frontend-dev work in parallel against API § F021 (frontend mocks the responses). desktop-dev verifies after both land.

## 5. Edge cases and security
- **Private collections never generate activity.** The add path checks `visibility = 'public'` inside the same `BEGIN IMMEDIATE` transaction that inserts the item, so a concurrent PATCH to private can't slip between check and write. A notification is written after the commit; if the collection turns private in that gap, the read-time filter hides it. Making a collection private hides its feed items and `addedToCollection` notifications for everyone at once (read-time filter on both paths). Making it public again shows only items for games that were added **while it was public** (the event stores those game ids), never games added while it was private.
- **Unpublished games.** Only published games are announced (the curator can add their own unpublished game to a public list; that writes nothing). At read time a feed item lists only games that are still published and still in the collection, added on the item's UTC day; an item with none left is skipped. A notification follows the F007 game visibility rule (the recipient owns the game, so it stays visible to them).
- **Never the actor.** A curator adding their own game gets no notification. The feed never shows a viewer their own items (F002 rule).
- **Dedupe and withdrawal.** One `addedToCollection` notification per (creator, collection, game) while any row for it is stored (F018 group dedupe). Remove while unread → withdrawn (not listed or counted); re-add → restored without moving (`updatedAt` unchanged). Remove after it was read → unchanged. Add/remove cycles therefore never spam the creator.
- **Spam bounds.** A curator can notify a creator at most once per (collection, game): at most 50 × 100 ever, and all collection writes share `Limit::Collections` (120 per 10 min). A 429 add writes nothing. Creators can switch the kind off or mute the game (F018); abusive collection titles can be reported (F008), and admin delete cascades the feed rows and notifications.
- **User text.** Collection titles and notes are F008-validated plain text (no control or bidi characters) and rendered as text nodes. The OS notification never contains the collection title or notes.
- **Title changes.** Feed items and notifications show the collection's **current** title; renames apply at once. The notification links to `/c/{id}`, which shows the current content.
- **Deletes.** Deleting a collection (owner, admin, report resolve) cascades its feed rows and notifications through the new foreign keys. Deleting a game removes it from items (read-time join) and cascades its notifications. Deleting a user cascades everything they acted in.
- **Migration safety.** `activity_events` has no referencing tables and no triggers (checked against `0001`–`0017`), so dropping the old table cascades nothing. Rows, ids and the `AUTOINCREMENT` high-water mark are preserved (feed cursors are ids). `ALTER TABLE … ADD COLUMN … REFERENCES` is allowed because the default is NULL. An upgrade test proves it (§ 6).
- **Performance.** Branch (c) is driven by `follows` → `idx_activity_actor_id`, like branch (a), with primary-key probes of `collections`; its `json_each` over at most 100 ids runs only for candidate rows. The page assembly adds three batched queries (collections, items of at most 20 collections × 100 rows, games). The notification visibility predicate is a primary-key probe of `collections` only for rows that have a `collection_id`.
- **Clients.** Older clients ignore the unknown feed and notification kinds (F002/F007 rule) and hide no settings they don't know.

## 6. Test expectations

### Backend (`tests/f021.rs`)
- **Upgrade test (required):** build a database at migration version ≤ 17 (pattern of `tests/f018.rs`), insert users, a published game, `activity_events` rows of all four kinds with explicit ids `3`, `7`, `8`, `15` (including `from_version`, `ach_count`, `first_score`), insert and delete a row with id `30` (so the sequence is 30), plus a `notifications` row with an event and a `notification_settings` row. Run the full migrator, then assert:
  1. `activity_events` holds exactly the same rows with equal columns, and the new columns are NULL;
  2. `PRAGMA foreign_key_check` is empty and `PRAGMA integrity_check` is `ok`; no schema object mentions `activity_events_new`;
  3. the table `sql` has no `CHECK (kind`; inserting a `collectionUpdated` row with `game_id` NULL succeeds; a row with both `game_id` and `collection_id` NULL fails;
  4. index names on `activity_events` are exactly `idx_activity_actor_id`, `idx_activity_game_kind`, `idx_activity_coalesce`, `idx_activity_collection`;
  5. the next insert without an id gets id `31`;
  6. `notifications.collection_id` exists and is NULL on the old row; `notification_settings.collections` is `1`.
- **Feed**: follower of curator C sees one `collectionUpdated` item after C adds 3 published games to a public collection (`gameCount: 3`, games newest first with notes, `game` = newest, `reason: "following"`, `collection.path`); a 4th and 5th add on the same day keep one item with a new, higher `id` and `games.length == 4`, `gameCount == 5`; an item written for a previous day (insert the row directly with yesterday's `day` and `added_at` values) stays separate; `kinds=collectionUpdated` returns only these; `kinds=gamePublished` excludes them; non-followers and C themself don't see it.
- **Privacy**: adds to a private collection write no `activity_events` row and no notification; PATCH public → private hides the feed item and the notification (list and `unread-count`); back to public shows them again, and a game added while private is not in the item; `POST /api/collections` with `gameId` and `visibility: "private"` writes nothing, with `"public"` writes both.
- **Read-time filters**: unpublishing a listed game drops it from the item (`gameCount` decreases); removing all announced games drops the item; removing and re-adding a game on a later day moves it to the later day's item only; the curator's own unpublished game writes nothing; deleting the collection removes the feed rows and the notifications (cascade).
- **Notifications**: owner of game G gets `addedToCollection` (`actors` = curator, `game`, `collection { id, title, path }`, `path: "/c/{id}"`, `commentId`/`excerpt`/`threadId` null, `eventCount == actorCount == 1`); curator adding their own game → none; adding G to a second collection → a second notification; remove while unread → not listed or counted; re-add → listed again with the original `updatedAt`; read, then remove and re-add → no new notification; `collections: false` → none; F018 game mute of G → none, and muting marks an unread one read; renaming the collection changes `collection.title` in the next list.
- **Settings**: `collections` defaults to true, round-trips through `PUT`, non-boolean → 422.
- **Note-only and reorder**: a re-PUT with a new note, a reorder and a details PATCH write no activity rows and no notifications.
- **Rate limit** with `ManualClock`: 120 collection writes succeed, the 121st add → 429 and writes no activity row or notification; after `t.clock.advance(Duration::from_secs(5))` the add succeeds and writes both.
- **Feed plan** (`tests/review2.rs`, extended): the N1 assertions still hold with the new `FEED_SQL`, and the plan has no full scan of `activity_events`, `collections` or `collection_games`.

### Frontend (vitest)
As listed in § 4 frontend-dev task 8.

### Manual end to end
User A follows curator B; creator C owns Space Dodge. B adds Space Dodge and two other games to a public collection with notes: A sees one feed item with three games and notes, C gets "B added Space Dodge to Cozy games" and opens `/c/{id}`. B removes one game before its creator reads the notification: it disappears from that creator's bell. B makes the collection private: A's item and C's notification disappear. B adds a game to a private "Play later": nothing appears anywhere. On desktop, C's OS notification says "… to a collection" without the title.

# F007: In-app notifications

Status: **specced**. Size: **M** (backend medium, frontend medium, desktop small; one round). Areas: backend, frontend, desktop. No engine changes.
Contracts: `docs/API.md` § F007 additions (types, endpoints, triggers, validation, rate limits, env), `docs/ARCHITECTURE.md` § F007 additions (fan-out on write, migration `0013_f007.sql`, upsert, read/count queries, pruning, polling, desktop OS notifications), `docs/GAME_FORMAT.md` § F007 additions (no changes; noted for completeness).
Depends on: F006 (backend committed; frontend in progress). It wires the two `// F007:` hook points in `backend/src/routes/comments.rs`, plus hooks in `routes/follows.rs` (follow) and `routes/games.rs` (first publish). It reuses F006 permalinks `/games/{id}?comment={commentId}`. The migration is **`0013_f007.sql`** and runs after `0012_f006.sql`. **No new JS dependencies and no `npm install`.** One new optional Rust crate on desktop (`tauri-plugin-notification`, § 4 desktop-dev); none on the backend.

## 1. Goal and user stories
Creators find out about new comments only by revisiting each game page. Players who ask a question in a thread can't tell when somebody answered. Nobody knows when they gain a follower or when a creator they follow ships a new game, unless they open `/feed`. F006 made conversations possible; without notifications most replies go unread.

F007 adds:
- **A bell in the header** (signed in) with an unread count, and a panel with the 10 latest notifications. Every item links to the place it is about (F006 comment permalinks, a profile's followers list, a game page).
- **Five kinds**: a top-level comment on your game, a reply in your thread or to you, a heart on your comment, a new follower, and a new game from a creator you follow.
- **Coalescing**: while a notification is unread, new events of the same group join it ("Mia and 3 others hearted your comment", "Noah left 4 comments on Space Dodge"). Once read, it stays as you saw it, and the next event starts a fresh one.
- **A `/notifications` page** with All/Unread views, paging and "Mark all as read".
- **Preferences**: per-kind on/off switches in Settings.
- **Desktop OS notifications** (opt-in per device, off by default): when the app window is not focused, new notifications also appear as native OS notifications.

User stories:
1. As a creator, I see "🔔 3" in the header after lunch. I open the panel and read "Mia and 2 others commented on Pixel Peaks". I click it, land on the newest comment with its thread focused, and the count drops to 2.
2. As a player, I asked how to skip the intro. A day later "Noah replied to your comment on Pixel Peaks: “Press Esc twice”" is in my bell. When the creator also replies, the same unread item becomes "Pixel Peaks Dev and Noah replied to your comment".
3. As a player, my tip got hearted by 12 people, and one of them was the creator. I get one notification, "Ava and 11 others hearted your comment", with a "♥ Creator" mark, not 12 separate ones.
4. As a creator, someone follows, unfollows and re-follows me ten times. I get at most one notification from them.
5. As a player who follows a creator, I get "Rex published Lava Leap" the moment their new game first goes public.
6. As a creator with a busy game, I switch off "Hearts on my comments" in Settings and keep the rest.
7. As a desktop user, I turn on "Show desktop notifications". While I'm in another app, a Windows toast says "Mia replied to you on Space Dodge". It never shows comment text on my lock screen.
8. As a keyboard or screen-reader user, the bell says how many are unread, opens a panel I can Tab through, closes with Escape and returns focus to the bell. When new notifications arrive, a polite announcement says so once.

Non-goals (later items): muting a single game or thread, email or web push, websockets or SSE, notifications for game updates of favorited games or for personal bests (the F002 feed covers them), @mention parsing, deleting individual notifications, cross-tab poll sharing (see F018 in the roadmap), deep links from OS notification clicks.

## 2. UX notes

### 2.1 Bell (`NotificationBell`, in `Header`)
- Shown only when signed in. It is rendered **outside** the collapsible `#pf-mainnav`, between the logo and the ☰ toggle, so it stays visible on narrow screens without opening the menu. On wide screens it sits visually before "+ Upload".
- A `<button class="pf-iconbtn pf-bell">` with a bell glyph (`aria-hidden`) and a badge showing the unread count (`1`–`99`, `99+` when the server says 100). No badge at 0.
- Accessible name: "Notifications" at 0, "Notifications, {n} unread", or "Notifications, more than 99 unread". The badge is `aria-hidden` (the name carries the count). `aria-expanded` and `aria-controls="pf-notif-panel"`.
- The badge has a number in it, so the state is not conveyed by colour only. A brief pop when the count goes up is skipped under `prefers-reduced-motion`.

### 2.2 Panel
- Opens below the bell as a **non-modal disclosure** (not `role="menu"`, which would require arrow-key navigation, and not a modal dialog). Markup: `<section id="pf-notif-panel" class="pf-notif-panel" aria-labelledby="pf-notif-title">` → `<h2 id="pf-notif-title" tabIndex={-1}>Notifications</h2>`, a **Mark all as read** button (shown when anything listed is unread), the list, and a footer with **See all** (`/notifications`) and **Settings** (`/settings#notifications`).
- When it opens, it fetches `GET /api/notifications?limit=10` (spinner while loading; inline `Alert` with **Retry** on error) and focus moves to the heading.
- **Escape** (anywhere in the panel or on the bell) closes it and returns focus to the bell. A click outside closes it without moving focus. Focus leaving both the bell and the panel (Tab past the end) closes it. A route change closes it.
- List: `<ul class="pf-notif-list">`, one `<li>` per item, each containing a single `<a href={path}>` (a router `Link`) so the whole row is one Tab stop. Inside the link:
  - up to 2 stacked avatars of `actors` (decorative, `alt=""`);
  - the summary text (§ 2.5), with names in `<strong>`;
  - the excerpt, when present, in quotes on its own line, one line with ellipsis (CSS);
  - for hearts with `creatorHeart`, the existing "♥ Creator" mark (F006 style);
  - a relative `<time dateTime={updatedAt}>` ("5 min ago").
- Unread items have a visible dot **and** a visually hidden "Unread: " prefix, and a tinted background. Read items have none. Not colour only.
- Activating an item: optimistically marks it read (`POST /api/notifications/read { ids: [id], upTo: item.updatedAt }`), lowers the badge, closes the panel and navigates to `path`. The link's default navigation is kept (middle-click and "open in new tab" still work on web). A failed mark-read is ignored (the next poll corrects the count).
- **Mark all as read**: `POST …/read { upTo: <updatedAt of the newest listed item> }`. Every listed item becomes read, the badge takes the returned `unread`, focus stays on the heading (the button disappears), and the live region says "All notifications marked as read".
- Empty: "You're all caught up." plus, when the user has never had a notification, "Comments on your games, replies, hearts and new followers show up here."
- If the panel is open when a poll sees a new `latestAt`, the list refetches without moving focus.

### 2.3 `/notifications` page (signed in; anonymous → login redirect like `/feed`)
- Title "Notifications". The existing `Tabs` component with **All** and **Unread** (`?filter=unread`, query string so it works under the desktop HashRouter). **Mark all as read** at the top right.
- 20 per page via `cursor`; **Load more** while `nextCursor` is non-null. Items are deduplicated by `id` (a group that got a new event while paging moves to the top and may come back; keep the newest copy).
- Same item markup as the panel, with the excerpt allowed to wrap to 2 lines. Clicking marks read and navigates, as in the panel.
- Empty states: All → as in the panel; Unread → "No unread notifications." with a link to All.
- A link "Notification settings" → `/settings#notifications`.

### 2.4 Settings (`SettingsPage`, section `id="notifications"`)
- A `<fieldset><legend>Notifications</legend>` with five checkboxes, each with a label and a short hint:
  - "Comments on my games" (`comments`)
  - "Replies to my comments and to me" (`replies`)
  - "Hearts on my comments" (`hearts`)
  - "New followers" (`follows`)
  - "New games from creators I follow" (`newGames`)
- Loaded with `GET /api/notifications/settings`. Each change is saved at once with `PUT` (only the changed field). The checkbox stays enabled while saving; a failure reverts it and shows the error in a toast. Success toast: "Notification settings saved".
- A note under the fieldset: "Turning a type off stops new notifications of that type. Existing ones stay until they expire."
- Desktop adds its own toggle through the existing `platform.extraSettings` slot (§ 4 desktop-dev). The web app shows nothing extra.
- `/settings#notifications` scrolls the fieldset into view on mount.

### 2.5 Summary text (normative; `notificationText` in `src/notifications.ts`)
`A`, `B` = the first two `actors` (display name, else username). `G` = `game.title`. `others` = `actorCount − 1`, with "1 other" / "{k} others".

| Kind | actorCount = 1 | actorCount = 2 | actorCount ≥ 3 |
|---|---|---|---|
| `comment` | `A commented on G` (eventCount > 1: `A left {eventCount} comments on G`) | `A and B commented on G` | `A and {others} commented on G` |
| `reply` (`ownsThread`) | `A replied to your comment on G` | `A and B replied to your comment on G` | `A and {others} replied to your comment on G` |
| `reply` (not `ownsThread`) | `A replied to you on G` | `A and B replied to you on G` | `A and {others} replied to you on G` |
| `heart` | `A hearted your comment on G` | `A and B hearted your comment on G` | `A and {others} hearted your comment on G` |
| `follow` | `A followed you` | `A and B followed you` | `A and {others} followed you` |
| `gamePublished` | `A published G` | – | – |

- For `reply`, when `eventCount > actorCount` and `actorCount = 1`: `A replied {eventCount} times …`.
- Items with an unknown `kind` are ignored (not rendered, not counted locally).
- The function returns plain text; the components render the same parts with `<strong>` names. Names and titles are always text nodes.

### 2.6 Live updates and announcements
- The `NotificationsProvider` polls `GET /api/notifications/unread-count` (§ 2.7). A single polite live region (in the provider, rendered once) announces "{d} new notification(s)" when `unread` goes **up** between two polls. It never announces the first load or decreases.
- The document title is not changed.

### 2.7 Polling cadence (normative for frontend-dev)
- On sign-in (and when the provider mounts with a user): fetch the count immediately.
- Then every `pollAfterSecs` from the last response (server default 60) while `document.visibilityState === "visible"`.
- While hidden: stop polling, **unless** `platform.osNotifications?.isEnabled()` is true; then poll every `2 × pollAfterSecs`.
- On `visibilitychange` to visible and on window `focus`: fetch at once if the last fetch is older than 15 s.
- After a 429: wait `Retry-After` seconds (minimum `pollAfterSecs`). After other errors (network, 5xx): back off 2×, 4×, … up to 10 min, and reset after a success. On 401: stop until the user changes.
- After any local action that changes read state (item click, mark all), use the `unread` returned by the server.
- On sign-out: stop, clear state.
- One timer per tab. No `setInterval`; schedule the next fetch after each response so slow responses never overlap.

### 2.8 Desktop OS notifications (desktop only, opt-in)
- Settings (desktop `extraSettings`): a checkbox "Show desktop notifications" with the hint "When the app isn't focused, new notifications also appear in your system's notification area. Comment text is never shown." Off by default, stored per device.
- Turning it on asks the OS for permission where the OS requires it (macOS). If permission is denied, the checkbox turns off again with the message "Notifications are blocked in your system settings."
- In builds without OS notification support (§ 4 desktop-dev, `os-notifications` feature off), the checkbox is not rendered.
- When enabled and a poll returns `latestAt` newer than the device watermark, and the window does **not** have focus, the provider fetches `GET /api/notifications?unread=true&limit=5` and calls `platform.osNotifications.show` for items with `updatedAt` newer than the watermark:
  - 1–3 new items: one OS notification each, title "Pixelforge Arcade", body `notificationText(item)` (no excerpt), oldest first.
  - More than 3: a single one, "You have {n} new notifications".
  - The watermark (`webgame.notifications.osShown.{userId}` in `localStorage`, an RFC3339 string) then moves to the newest `updatedAt`. When the toggle is turned on, the watermark is set to the current newest unread `latestAt` (or now), so old notifications don't burst out.
- Clicking an OS notification focuses or opens the app (platform default). It does not deep-link (the plugin has no desktop click callback). The bell is the place to act.

## 3. Contract changes (summary; normative text lives in docs/)
- `docs/API.md` § F007 additions:
  - Types `NotificationKind`, `NotificationGame`, `Notification`, `NotificationPage`, `UnreadCount`, `NotificationSettings`, `MarkReadRequest`, `MarkReadResponse`.
  - Endpoints `GET /api/notifications`, `GET /api/notifications/unread-count`, `POST /api/notifications/read`, `GET`/`PUT /api/notifications/settings`.
  - Triggers, recipients, grouping, dedupe and retraction rules; visibility; retention.
  - `Limit::Notifications` (120/min per user, shared by all five endpoints).
  - Env `NOTIFICATION_POLL_SECS`.
  - Privacy note: the author of a comment now learns who hearted it.
- `docs/ARCHITECTURE.md` § F007 additions: fan-out on write (and why, versus the F002 feed's fan-out on read), migration `0013_f007.sql`, the upsert, read and count queries, pruning, polling rather than push, the `PlatformConfig.osNotifications` host contract, and the desktop plugin decision.
- `docs/GAME_FORMAT.md` § F007 additions: none (games can't read or create notifications).

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration `backend/migrations/0013_f007.sql`** exactly as in ARCHITECTURE § F007 (`notifications`, `notification_events`, `notification_settings`, indexes).
2. **`src/notifications.rs`** (new module, registered in `lib.rs`), following the `activity.rs` style (best effort, SAVEPOINT, `tracing::warn!` on failure, never fails the request):
   - `pub enum Kind { Comment, Reply, Heart, Follow, GamePublished }` with `as_str()` (the API strings) and `setting_column()` (a fixed `match` → `"comments" | "replies" | "hearts" | "follows" | "new_games"`; never built from input).
   - `pub async fn notify(conn, n: &NewNotification)` where `NewNotification { recipient_id, kind, group_key, game_id: Option, comment_id: Option, actor_id, event_comment_id: Option, dedupe_actor: bool, now }`. Steps in one nested transaction:
     1. Return early if `recipient_id == actor_id`.
     2. If `dedupe_actor`: skip when an event by this actor exists in **any** notification of (recipient, kind, group_key) (ARCHITECTURE § F007 dedupe query).
     3. The upsert (ARCHITECTURE § F007) with the settings check and `RETURNING id`. No row returned (kind muted) → done.
     4. `INSERT OR IGNORE INTO notification_events …`.
   - `pub async fn retract(conn, recipient_id, kind, group_key, actor_id)`: deletes this actor's events from the **unread** notification of that group (ARCHITECTURE § F007). Best effort.
   - `pub async fn fan_out_game_published(pool, game_id, owner_id, now)`: loads the owner's follower ids, then processes them in chunks of at most 500 recipients per transaction with the `gamePublished` rules (settings `new_games`, one per (recipient, game) ever). Logged on failure; never fails the request.
   - `pub async fn prune(pool, now: DateTime<Utc>) -> sqlx::Result<u64>`: the retention rules in API § F007, batched (`LIMIT 1000` per statement, looped), returns rows deleted. Takes `now` as a parameter so tests are deterministic.
   - Read helpers for the handlers: page query, batched actors/counts/excerpts, count query, path building (ARCHITECTURE § F007).
3. **Hooks** (all after the main write succeeded):
   - `routes/comments.rs` `create_comment`, at the `// F007:` marker (replace the marker): top-level → `notify(Comment)` to the game owner, group `game:{gameId}`, `event_comment_id` = new id. Reply → `notify(Reply)` to the root's author and to `reply_to_user_id` when set and different, group `thread:{rootId}`, `comment_id` = root id, `event_comment_id` = new reply id. Each recipient at most once; never the poster. Load the root author and game owner with one query.
   - `routes/comments.rs` `heart`, at the `// F007:` marker, when a row was inserted: `notify(Heart)` to the comment's author, group `comment:{commentId}`, `comment_id` = that id, `dedupe_actor: true`. **All** hearts notify (coalesced), not only creator hearts; the `creatorHeart` flag is computed at read time.
   - `routes/comments.rs` `unheart`, when a row was deleted: `retract(author, Heart, comment:{id}, user)`.
   - `routes/follows.rs` `put_follow`, when a row was inserted: `notify(Follow)` to the followee, group `follow`, `dedupe_actor: true`. `delete_follow`, when a row was deleted: `retract(followee, Follow, "follow", user)`.
   - `routes/games.rs`: in `create_game` (published at creation) and in the `PATCH` first-publish branch (`first.rows_affected() == 1`), set a flag and call `fan_out_game_published` **after `tx.commit()`**, awaited inline, before building the response.
   - Comment deletes (`remove_comment`, used by `DELETE` and admin resolve) need no code: events and heart/reply groups cascade through the FKs.
4. **`src/routes/notifications.rs`** (new) with five handlers; routes in `routes/mod.rs`:
   - `/notifications` → `get(list)`; `/notifications/unread-count` → `get(unread_count)`; `/notifications/read` → `post(mark_read)`; `/notifications/settings` → `get(get_settings).put(put_settings)`. Register the literal paths so they don't clash with any future `/notifications/{id}`.
   - Order in every handler: auth (401) → `Limit::Notifications` → parse/validate (400/422) → work.
   - Validation and responses exactly as in API § F007 (cursor format, `limit`, `unread`, `ids`/`upTo`, settings booleans).
5. **`src/ratelimit.rs`**: `Limit::Notifications` = (120, 60 s), with a doc comment like the others.
6. **`src/config.rs`**: `NOTIFICATION_POLL_SECS` (default 60, integer 15–600; anything else is a startup error with a clear message). Returned as `pollAfterSecs`.
7. **Pruning**: call `notifications::prune(&db, Utc::now())` from `trending::spawn_maintenance` at most once per hour (keep a `last_prune: Option<Instant>` in the loop). Log the deleted count at `debug`. When `TRENDING_TTL_SECS=0` (no maintenance task) pruning does not run; that is acceptable for tests and dev.
8. **Seed** (`seed.rs`): if the demo seeds comments, hearts or follows through SQL, also insert one unread `comment` notification for the demo account so the bell shows something. Otherwise skip.
9. **Tests** (`tests/f007.rs`, `common::setup()`; `t.clock` (`ManualClock`) for rate limits; `prune` called directly with chosen `now` values):
   - Triggers: a top-level comment notifies the owner (not when the owner comments); a reply notifies the root author and the `replyTo` user once each, never the poster; root author = `replyTo` → one notification; heart notifies the author; follow notifies the followee; a first publish (create with `published` true, and PATCH false → true) notifies each follower once; a re-publish doesn't.
   - Coalescing: two comments by A and one by B on the same game while unread → one item, `actorCount 2`, `eventCount 3`, actors newest first, `commentId` = latest; after mark-read, the next comment creates a new unread item.
   - Dedupe and retraction: heart → unheart while unread → the item disappears and `unread` drops; heart/unheart/heart × 10 → one item with `actorCount 1`; after it's read, another heart/unheart/heart by the same user adds nothing. Same for follow/unfollow.
   - Settings: `hearts: false` → no heart notifications; other kinds still arrive; `newGames: false` excludes the follower from the fan-out; GET returns defaults (all true) for a user without a row; PUT partial updates; `"yes"` → 422.
   - Visibility: unpublishing the game hides its items from list and count; re-publishing shows them again. Deleting the game removes them. Deleting a comment (author, owner, admin resolve) removes the heart group, the reply group for a deleted thread, and that comment's event from a `comment` group (the group stays with the remaining events, `commentId` = the previous comment); a group whose last event is gone is hidden and pruned.
   - List: order by `updatedAt` desc; `cursor` paging with no duplicates when nothing changes; `unread=true` filter; `excerpt` ≤ 140 chars; `ownsThread`; `creatorHeart`; `path` values for every kind; a bad cursor → 400; `limit=0` clamps to 1; `limit=abc` → 400.
   - Count: `unread` caps at 100 (insert 120 rows directly); `latestAt`; `pollAfterSecs` = config.
   - Mark read: `ids` limited to the recipient's own rows (another user's id is ignored, no error); `upTo` older than an item's `updatedAt` leaves it unread (race guard); `ids` with 101 entries → 422; non-numeric id → 400; missing `upTo` → 422; returns `unread`.
   - Rate limit (with `RATE_LIMIT` on): 120 mixed notification requests → the 121st → 429 with `Retry-After`; `t.clock.advance(Duration::from_secs(1))` → allowed. Comment/heart/follow writes don't consume this bucket.
   - Fan-out: 1200 followers (insert follows directly) → 1200 notifications after one publish (exercises 3 chunks).
   - Pruning: read > 30 days → deleted; unread > 90 days → deleted; per-recipient rows beyond 200 → oldest deleted; empty groups deleted; recent rows kept.
   - Migration upgrade: a DB at `0012` migrates; existing suites (`f006.rs`, `f002.rs`, `api.rs`) stay green.

**Acceptance:** `cd backend && cargo test` (all suites) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`): the API § F007 types. **Client** (`src/api/client.ts`): `listNotifications({ cursor?, limit?, unread? })`, `unreadNotificationCount()`, `markNotificationsRead({ ids?, upTo })`, `getNotificationSettings()`, `updateNotificationSettings(partial)`. `ApiError` already carries `retryAfter` for 429 (reuse; add it if missing).
2. **`src/notifications.ts`**: `notificationText(n)` and `notificationParts(n)` (§ 2.5), `isKnownNotification(n)`, the OS watermark helpers (`readOsWatermark(userId)`, `writeOsWatermark(userId, iso)`; malformed values → null), and the poll-delay function (§ 2.7) as a pure function for tests.
3. **`src/context/notifications.tsx`**: `NotificationsProvider` + `useNotifications()` → `{ unread, latestAt, refresh(), markRead(item), markAllRead(upTo), lastChange }`. It owns the poll loop (§ 2.7), the live region (§ 2.6) and the OS notification step (§ 2.8). Mount it in `WebGameProviders` inside `AuthProvider` and `ToastProvider`.
4. **`src/context/config.tsx`**: add `osNotifications?: OsNotifications` to `PlatformConfig` (ARCHITECTURE § F007), exported from `index.ts`.
5. **Components/pages**:
   - `src/components/NotificationBell.tsx` (bell, badge, panel; § 2.1–2.2), placed in `Header` per § 2.1.
   - `src/components/NotificationItem.tsx` (shared row for the panel and page).
   - `src/pages/NotificationsPage.tsx` and the `/notifications` route (auth-only, like `/feed`).
   - `SettingsPage.tsx`: the Notifications fieldset (§ 2.4), with `id="notifications"` and hash scroll.
6. **Styles** (`styles.css`): `.pf-bell`, `.pf-bell__badge`, `.pf-notif-panel` (max-height with internal scroll, width ≤ 92vw on mobile), `.pf-notif-list`, `.pf-notif--unread` (dot + tint), pop animation only under `prefers-reduced-motion: no-preference`. Use existing tokens.
7. **Tests**:
   - `notifications.test.ts`: every row of the § 2.5 table, "1 other" vs "others", unknown kind, the poll-delay function (visible/hidden/OS on, 429, error backoff and reset), watermark parsing.
   - `NotificationBell.test.tsx`: accessible name for 0 / n / 100; `aria-expanded`/`aria-controls`; open moves focus to the heading; Escape closes and returns focus; outside click closes; Tab out closes; item click marks read with `upTo` = its `updatedAt` and navigates; Mark all sends the newest `updatedAt`; error + Retry; unread items have the hidden "Unread: " text.
   - `NotificationsProvider` tests with fake timers: first fetch on mount, re-schedule after `pollAfterSecs`, no polling while hidden, polling at 2× while hidden with OS notifications on, focus refetch after 15 s, 429 backoff, live region announces increases only, OS `show` called for 1–3 new items / one summary for more, never while the window has focus, watermark updated.
   - `NotificationsPage` test: All/Unread tabs via query, Load more with cursor and id dedupe, empty states.
   - `SettingsPage` test: loads settings, PUT with only the changed field, revert on error.
   - `ApiClient` tests for the five methods (paths, methods, bodies, query strings).
8. **Sequencing**: start after the F006 frontend work in `packages/ui` is merged (both touch `client.ts`, `types.ts`, `index.ts`, `styles.css`), or rebase onto it.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
1. **Dependency, behind a feature** (`src-tauri/Cargo.toml`):
   ```toml
   [features]
   default = ["os-notifications"]
   os-notifications = ["dep:tauri-plugin-notification"]

   [dependencies]
   tauri-plugin-notification = { version = "2", optional = true }
   ```
   Register the plugin in `lib.rs` under `#[cfg(feature = "os-notifications")]`. **Do not** add the npm package `@tauri-apps/plugin-notification` and **do not** grant any `notification:*` permission in `capabilities/default.json`: the webview never calls the plugin directly (same least-privilege pattern as dialogs).
   Before and after adding it, record `cargo tree -d -e normal | wc -l` and the size of `src-tauri/target/debug` after `cargo build`, and write both deltas in `apps/desktop/README.md` together with how to build without it (`cargo build --no-default-features`, or `npm run tauri -- dev -- --no-default-features`). If it pulls a second major version of `windows`/`windows-sys` or more than ~150 MB of extra debug artefacts, report that to the project manager in your hand-back; don't silently drop the feature.
2. **`src-tauri/src/notify.rs`** (new), three commands, registered in `invoke_handler`:
   - `os_notifications_status() -> String`: `"unsupported"` when the feature is off; else the plugin's permission state mapped to `"granted" | "denied" | "prompt"`.
   - `request_os_notifications() -> String`: asks for permission where needed and returns the new state (`"unsupported"` without the feature).
   - `show_os_notification(title: String, body: String) -> Result<bool, String>`: strips control and bidi-override characters, trims, then requires title 1–64 and body 1–240 characters (else `Err`). It is rate limited in Rust to **5 per 60 s** (a small token bucket in managed state; over the limit → `Ok(false)`, nothing shown). It shows the notification with the app's identifier and returns `Ok(true)`. Without the feature it returns `Ok(false)`.
   - Unit tests: sanitising and length checks, the bucket (inject the time like the existing ticket tests), `unsupported` without the feature (`#[cfg(not(feature = …))]` test).
3. **`src/platform.ts`**: `osNotifications` implementing `OsNotifications` (ARCHITECTURE § F007): `isEnabled()` reads `localStorage["webgame.desktop.osNotifications"] === "1"` (and returns false in a plain browser); `show()` invokes `show_os_notification` and swallows errors. Pass it in the platform config in `App.tsx`.
4. **`src/OsNotificationSetting.tsx`** (new), rendered inside the existing `extraSettings` next to `ServerSettings`: the checkbox in § 2.8. On mount it calls `os_notifications_status` and renders nothing for `"unsupported"`. Turning it on calls `request_os_notifications`; `"granted"` → store `"1"`; `"denied"` → stay off with the § 2.8 message. Turning it off removes the key. Hidden in a plain browser.
5. **Menu**: View → Notifications (`CmdOrCtrl+Shift+N`, forwarded id `"notifications"`) in `menu.rs` (`FORWARDED` and its test), mapped to `/notifications` in `nativeMenu.ts`.
6. **Verify** in the Tauri app: the bell and panel under the HashRouter (`#/notifications?filter=unread`), focus and Escape in WebView2, an OS toast on Windows when the window is unfocused (dev builds show it under the dev process's identity; check an installed build if possible), no toast while focused.

**Acceptance:** `npm run build -w @webgame/desktop`; `cd apps/desktop/src-tauri && cargo check && cargo check --no-default-features && cargo test`.

### engine-dev
None.

### Sequencing
- Backend first or in parallel with frontend; frontend can mock API § F007.
- Frontend starts after the F006 UI work is merged (§ 4 frontend-dev 8).
- Desktop steps 1–2 and 5 can start at once; steps 3–4 need the `OsNotifications` type from the UI build. Desktop verification runs last.

## 5. Edge cases and security
- **Visibility.** Notifications are filtered at read time by the game's current visibility to the recipient (`published` or the recipient owns it). An unpublished game's notifications disappear from list and count, and come back when it is re-published (unless pruned). Deleted games, comments and threads remove their rows through FK cascades, so deleted or moderated text never lingers in a bell, an excerpt or an OS toast history we control.
- **Excerpts.** Computed at read time from the current comment row (first 140 characters, counted in Unicode scalar values), plain text, rendered as React text. OS notifications never include excerpts (lock screens, shared screens).
- **Hearts reveal who hearted, to the author only.** F006 exposed only counts and `creatorHeart`. F007 deliberately tells a comment's author who hearted it (standard practice; it is the point of the notification). Nobody else can see it. This is recorded in API § F007.
- **Toggle spam.** Hearts and follows notify once per (actor, group) for as long as the earlier event is kept (dedupe across read states), and an un-heart or unfollow retracts the event while the notification is unread. Repeated toggling therefore produces at most one item. Writes stay bounded by `Limit::Heart` and `Limit::Follow`.
- **Comment floods.** Top-level comments and replies coalesce into one unread item per game or thread, and are bounded by `Limit::Comment` (30 per 10 min per user).
- **Fan-out abuse.** `gamePublished` fires once per game ever (first publish), only to followers, and creating games is bounded by `Limit::Upload` (20/hour). Followers can switch off `newGames` or unfollow.
- **IDOR.** Every read, count and mark-read query is scoped by `recipient_id = <caller>`. Unknown or foreign ids in `ids` are ignored silently, so the endpoint doesn't confirm that a notification id exists.
- **Races.** The partial unique index makes "join the unread group or create one" a single atomic upsert. A mark-read with `upTo` only touches rows whose `updatedAt ≤ upTo`, so an event that arrives after the client rendered the list stays unread. A heart posted while its comment is deleted either fails the FK (the best-effort write logs and drops it) or is removed by the cascade.
- **Paging while things change.** A group that gets a new event moves to the top (`updatedAt` changes). Clients dedupe by `id`; an item may be seen again on refresh but never lost from the unread count.
- **Self-actions** never notify (the poster, hearter, follower or publisher is never a recipient).
- **Ownership transfer** doesn't exist; `creatorHeart` and `ownsThread` are computed against current data.
- **Multiple tabs** each poll (1/min each while visible). That is well within `Limit::Notifications`; sharing a poll across tabs is roadmap F018.
- **Desktop.** The webview gets no plugin permissions; only the app's own `show_os_notification` command, which sanitises, length-limits and rate-limits (5/min) its input. Game iframes are remote content without IPC access. The setting is per device, off by default, and asks for OS permission only when the user turns it on.
- **Older clients** never call the new endpoints and are unaffected. Newer clients against an older server get 404 from `unread-count`: the provider then stops polling for the session and hides the bell.

## 6. Test expectations
- **Backend**: `tests/f007.rs` as listed (triggers, recipients, coalescing, dedupe, retraction, settings, visibility, cascades, list/count/mark-read contracts, rate limit with `ManualClock`, fan-out chunks, pruning with explicit `now`, migration upgrade). Existing suites stay green.
- **UI**: text table, poll scheduling with fake timers, bell/panel accessibility and focus, page paging and filters, settings form, OS notification step, client methods.
- **Desktop**: unit tests for sanitising, the bucket and the feature-off path; `cargo check` with and without default features; manual toast check on Windows.
- **Manual end to end**: three accounts (creator C, players P and Q). P follows C → C's bell "P followed you". P comments on C's game, Q comments twice → C sees "Q and P commented…" with `eventCount` 3; open it → lands on Q's latest comment. C replies to P → P gets "C replied to your comment"; Q replies to C's reply → C and P get one item each. Q hearts P's comment, un-hearts, hearts → one item for P; C hearts it → "C and Q hearted your comment" with "♥ Creator". C publishes a new game → P and Q get "C published …". Unpublish → items vanish; delete a comment → its items vanish. Switch hearts off → no new heart items. Repeat with keyboard only and a screen reader, and once in the desktop app with OS notifications on and the window in the background.

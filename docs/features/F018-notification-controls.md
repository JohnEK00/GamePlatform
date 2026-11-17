# F018: Notification controls: mutes, shared polling and "pinned" notifications

Status: **specced**. Size: **M** (backend medium: one migration with a table rebuild, five endpoints and write-path changes; frontend medium: tab coordination, mute actions, settings and a new kind; desktop verification only; one round). Areas: backend, frontend, desktop (verification only). No engine changes.
Contracts: `docs/API.md` § F018 additions (types, five endpoints, validation order, mute scopes, `pinned` kind, `pins` setting, rate limits), `docs/ARCHITECTURE.md` § F018 additions (migration `0017_f018.sql` with the exact rebuild SQL, write-path and read-path changes, tab coordination), `docs/GAME_FORMAT.md` § F018 additions (no changes; noted for completeness).
Depends on: F007 (notifications, shipped and hardened in reviews 4 and 5) and F017 (pin endpoints and the `// F018:` hook, shipped). The migration is **`0017_f018.sql`** and runs after `0016_f008.sql`. **No new Rust or JS dependencies.**
Unblocks: F021 (collection notifications), which needs a new `notifications.kind` value without a table rebuild.

## 1. Goal and user stories
F007 made the bell useful. Two kinds of users now have problems with it, and F017 left one notification unwritten:
- **Creators of busy games** get a notification for every comment, reply and heart on one popular game. Turning off the "comments" kind globally also silences their quieter games.
- **Players in long threads** get every reply in a thread they posted in once, long after they stopped caring.
- **Heavy users with many tabs** send one `unread-count` request per visible tab per minute. Ten tabs are ten requests that all return the same number, and they burn the shared `Limit::Notifications` budget (120/min).
- **Comment authors** never learn that a creator pinned their comment (F017 deferred the `pinned` kind, because adding a kind needs a rebuild of the `notifications` table).

F018 adds:
- **Mute a game**: no new notifications of any kind about that game (comments, replies, hearts, pins, publish) for you. Existing unread ones about it are marked read at once.
- **Mute a thread**: no new reply, heart or pin notifications for that thread. Existing unread ones are marked read.
- A **Muted** list in Settings with Unmute buttons, and a "Pins on your comments" switch next to the F007 kind switches.
- A **"Mute"** action on items of the `/notifications` page, where the noise is noticed.
- **One polling tab per browser**: tabs of the same user and server elect a leader with the Web Locks API. Only the leader polls `unread-count` and shares the result with the other tabs over a `BroadcastChannel`. Without those APIs every tab polls as before.
- A **`pinned` notification kind**: "Mia pinned your comment on Space Dodge", once per comment, withdrawn if it is unpinned before you read it.
- The `notifications` table is rebuilt once **without the `kind` CHECK** (kinds are validated in Rust from now on, like `reports.target_type` since F008), so F021 and later kinds need no rebuild.

User stories:
1. As the creator of a popular game, I click **Mute notifications** on its game page. My bell drops from 99+ to 4 (the other games), and new comments on that game stop notifying me. My other games still notify me.
2. As a player, I open a reply notification about a thread I'm done with and choose **Mute this thread** on `/notifications`. The item is marked read and further replies in that thread don't notify me. Replies in my other threads still do.
3. As a player, I see "Kai pinned your comment on Pixel Peaks" and click it; it opens my comment's permalink, labelled "Pinned".
4. As a creator, I pin a comment by mistake and unpin it a few seconds later. The author never sees a notification (it was withdrawn while unread), and pinning it again later doesn't notify twice.
5. As a user with eight tabs open, only one of them requests the unread count each minute. All eight bells update together, and when I mark everything read in one tab, every bell clears at once.
6. As a user, I open Settings → Notifications and unmute a game I muted months ago.
7. As a keyboard or screen-reader user, the mute buttons are native buttons with `aria-pressed`, and muting or unmuting is announced through the existing toast.

Non-goals: muting a user (blocking), time-limited mutes ("for 8 hours"), muting the F002 feed, digest emails, push or websockets, notifying on lock/unlock, notifying the thread's participants about a pin, cross-device mute sync beyond the server-side list (mutes are server-side, so they already apply on every device).

## 2. UX notes

### 2.1 Game page: "Mute notifications"
- In the game page's action row (next to Favorite and **+ Collection**), signed-in users see a native `<button type="button" aria-pressed>`:
  - not muted: **"Mute notifications"** (`aria-pressed="false"`), `title="Stop notifications about this game: comments, replies, hearts and pins"`;
  - muted: **"Notifications muted"** (`aria-pressed="true"`), `title="Click to get notifications about this game again"`.
- Shown only when `game.notificationsMuted` is a boolean (older servers omit it: hide the button) and the notifications API is supported (`useNotifications().supported`). Hidden for anonymous viewers.
- Click: optimistic toggle, `PUT`/`DELETE /api/notifications/mutes/games/{id}`, then adopt `MuteState.unread` into the bell (`syncUnread`, which also broadcasts, § 2.6).
  - Mute success toast: "Muted notifications for {title}" with an **Undo** action (calls `DELETE`). Unmute toast: "You'll get notifications for {title} again".
  - Failure: revert, error toast with the server message (422 cap: "You can mute at most 500 games and threads; unmute some in Settings").
- Owners see it too: the owner is the main audience.

### 2.2 Threads: "Mute thread"
- In the action row of **top-level** comments (`CommentItem`, after Reply/heart, before Report), signed-in users see a link-style button **"Mute thread"** / **"Unmute thread"** (`aria-pressed`, `aria-label="Mute notifications for the thread by {name}"` / "Unmute …").
- Shown only when `c.threadMuted` is a boolean (older servers omit it) and notifications are supported. Never on replies (the server sets `threadMuted: false` on replies and refuses replies anyway).
- Same optimistic flow, toasts "Thread muted. Replies, hearts and pins in it won't notify you." (Undo) / "Thread unmuted."
- Shown to every signed-in user, not only participants: the client can't know whether you replied, and muting a thread you never posted in is harmless.

### 2.3 `/notifications` page item action
- Each item on the full page (not in the bell panel, which stays compact) gets a small **"Mute"** link-style button at the end of its row (outside the item's link, so it is a separate tab stop):
  - `reply`, `heart`, `pinned` items with a `threadId`: **"Mute thread"** → `PUT …/mutes/threads/{threadId}`.
  - `comment` and `gamePublished` items with a `game`: **"Mute game"** → `PUT …/mutes/games/{game.id}`.
  - `follow` items and items missing those fields: no button.
- After success: the toast from § 2.1 / § 2.2 (with Undo), then the page refetches its first page (muting marks matching items read on the server). `aria-label` names the target: "Mute notifications for Space Dodge" / "Mute notifications for this thread on Space Dodge".

### 2.4 Settings → Notifications
- The F007 fieldset gains a sixth switch, **"Pins on your comments"** (`pins`), after "Hearts on your comments". Hidden when the settings response has no `pins` field (older server).
- New section below it, **"Muted"** (`<h3>`), loaded from `GET /api/notifications/mutes` when the settings page opens:
  - Empty: "You haven't muted any games or threads."
  - Each row: game thumbnail (24 px), game title linked to `/games/{id}`; for threads, "Thread: “{excerpt}”" linked to the permalink (`path`); the mute date (`formatDate`); an **Unmute** button (`aria-label="Unmute {title}"` / "Unmute thread on {title}"). Unmute removes the row and shows a toast.
  - A count line "{total} of 500" when `total >= 400`.
  - 404 from the endpoint (older server): hide the section.

### 2.5 Notification text for `pinned`
- Summary (normative, `notificationParts`): **"{actor} pinned your comment on {title}"**. Only the newest actor is named (pins are once per comment; a second actor appears only in rare unpin/re-pin cases by a different moderator).
- `excerpt` shows under it like `heart` items. Icon: the same pin glyph the F017 "Pinned" badge uses.
- `path` is the F006 permalink; the comment shows its F017 "Pinned" badge when it is still pinned.
- OS notifications (desktop) use the same summary text, never the excerpt (F007 rule).

### 2.6 One polling tab per browser (`NotificationsProvider`)
Users see no new UI. Behaviour, normative for frontend-dev:
- **Coordinated mode** is used when both `typeof BroadcastChannel === "function"` and `navigator.locks?.request` exist. Otherwise every tab polls exactly as in F007 (no behaviour change).
- **Scope** (`tabScope(apiBaseUrl, userId)`): `"webgame.notifications." + encodeURIComponent(apiBaseUrl) + "." + userId`. Lock name: `scope + ".leader"`; channel name: `scope`. The scope changes on sign-in, user change and server change (desktop "configurable server"), which restarts coordination.
- **Election**: on start, each tab calls `navigator.locks.request(scope + ".leader", { signal }, () => heldPromise)`. The tab whose callback runs is the **leader** and keeps the lock (the callback's promise) until `stop()` or unload, when the browser hands it to the next queued tab. Other tabs are **followers**.
- **Leader**:
  - runs the F007 poll loop unchanged, except that its `visible` input is `ownVisible || (Date.now() - lastVisiblePing < VISIBLE_TTL_MS)` (75 s), so a hidden leader keeps polling for visible followers;
  - after every successful count it applies the result locally (exactly as F007) and posts `{ type: "count", count }`; after a 404 it posts `{ type: "unsupported" }`; 401 and 429 are not broadcast (each tab's auth handles 401; followers keep their last count);
  - is the only tab that runs the desktop OS-notification step;
  - on `{ type: "poll" }`: polls now when its last response is older than `POLL_STALE_MS` (15 s), else re-posts its last `count`.
  - on becoming leader: polls at once when its last applied count (own or received) is older than `POLL_STALE_MS`, else schedules from it.
- **Followers**:
  - never schedule count requests; they apply each received `count` through the **same** function as an own poll response (unread, `latestAt`, `lastChange`, `arrivals`, live-region announcement), without the OS step;
  - post `{ type: "visible" }` when they become visible and every `VISIBLE_PING_MS` (30 s) while visible;
  - on start and on wake (focus / visible) with a count older than `POLL_STALE_MS`, post `{ type: "poll" }`;
  - **watchdog**: while visible, request the count directly once and post the result as `count` when no `count` has arrived within 5 s after start, or for `max(3 × pollAfterSecs, 180)` s since the last one.
- **Leader wake-up**: a `visible` ping wakes a leader whose loop was paused (hidden leader, no OS notifications), like a focus event does in F007.
- **Any tab**:
  - `refresh()` requests the count directly in the calling tab and posts the result as `count`;
  - `markRead`, `markAllRead`, `syncUnread` (used after mutes and page loads) post `{ type: "unread", unread }`; receivers adopt it like `setServerUnread`;
  - a received `count` also counts as a fresh response for the leader's schedule (resets `lastResponseAt`), so a follower's direct request never causes a double poll.
- **Messages** (`TabMessage`, all `{ v: 1, userId, … }`): `count` (an `UnreadCount`), `unread` (a number), `poll`, `visible`, `unsupported`. Receivers drop messages that fail `parseTabMessage` (wrong `v`, other `userId`, wrong shapes; numbers clamped like F007's `clampUnread`). Messages never contain tokens, notification items or excerpts.
- `stop()` (sign-out, user/token/client change, unmount): abort the queued lock request (`AbortController`; swallow the `AbortError`), resolve the held lock's promise, close the channel, clear timers.

## 3. Contract changes (summary; normative text lives in docs/)
- **API.md § F018 additions**:
  - `NotificationKind` gains `"pinned"`; `Notification` gains `threadId`; `NotificationSettings` gains `pins`.
  - `Game.notificationsMuted` (detail only) and `Comment.threadMuted` (top-level only), both viewer-specific.
  - New types `NotificationMute`, `NotificationMuteList`, `MuteState`.
  - Five endpoints: `GET /api/notifications/mutes`, `PUT`/`DELETE /api/notifications/mutes/games/{gameId}`, `PUT`/`DELETE /api/notifications/mutes/threads/{commentId}`, with validation order, cap (500), mute scopes and the mark-read-on-mute rule.
  - Pin hook: trigger, recipient, dedupe, withdrawal on unpin.
  - Rate limit: the five endpoints share `Limit::Notifications`.
- **ARCHITECTURE.md § F018 additions**: migration `0017_f018.sql` (exact SQL: `notification_mutes`, `notification_settings.pins`, the FK- and trigger-safe rebuild of `notifications` and `notification_events`, sequence preservation), the write-path statements (mute check, group dedupe, pin withdrawal, fan-out), read-path changes and the tab coordination design.
- **GAME_FORMAT.md § F018 additions**: no changes.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0017_f018.sql`: copy the SQL in ARCHITECTURE § F018 "Data" **verbatim** (order matters). Never edit `0013`–`0016`.
2. **`src/notifications.rs`**:
   - `Kind::Pinned` (`"pinned"`, setting column `pins`); add to `Kind::ALL`. Update the "CHECK constraint keeps unknown kinds out" comment: `Kind::parse` is now the only guard; unknown stored kinds are skipped in reads, as today.
   - `pub fn pin_group(comment_id) -> String` = `"pin:{commentId}"`.
   - `NewNotification`: replace `dedupe_actor: bool` with `dedupe: Dedupe` (`None`, `Actor`, `Group`), and add `thread_id: Option<String>` (the root of the related thread: `reply` → root; `heart` → the hearted comment's `parent_id` or itself; `pinned` → the comment; else `None`). Update every constructor (`routes/comments.rs`, `routes/follows.rs`).
   - `try_notify`: the restore step and the insert gain the mute check, and the insert gains the group dedupe (ARCHITECTURE § F018 "Write path"). `Dedupe::Group` restores tombstoned events of **any** actor in the group.
   - `pub async fn withdraw_pool(pool, recipient_id, kind, group_key)`: tombstone every live event of the recipient's **unread** group (best effort, like `retract`).
   - `fan_out_chunk`: add the game-mute `NOT EXISTS` to the `gamePublished` insert.
   - `NotificationSettings`/`SettingsPatch`/`load_settings`/`update_settings`: `pins`.
   - `list_page`: `Kind::Pinned` target = `n.comment_id`, path = permalink, `event_count` = `actor_count`; new `thread_id` field (ARCHITECTURE § F018 "Read path"); the comments lookup also selects `parent_id`.
   - Mutes: `mute_game`, `unmute_game`, `mute_thread`, `unmute_thread`, `list_mutes` (statements in ARCHITECTURE § F018), `pub const MUTES_PER_USER: i64 = 500`.
3. **`src/routes/notifications.rs`**: five handlers; order auth → `Limit::Notifications` → lookup/validation (API § F018). `put_settings` accepts `pins`. Path ids longer than 64 bytes → 404.
4. **`src/routes/mod.rs`**: literal routes `/notifications/mutes`, `/notifications/mutes/games/{gameId}`, `/notifications/mutes/threads/{commentId}`.
5. **`src/routes/comments.rs`**:
   - `comment_select()` gains `thread_muted` (ARCHITECTURE § F018); `Comment.thread_muted` in `models.rs` (`threadMuted`).
   - Heart hook: `thread_id` = `meta.parent_id.unwrap_or(id)`; reply hook: `thread_id` = root.
   - `pin`: replace the `// F018:` marker with the pin notification (recipient = comment author when not the pinner; `Dedupe::Group`; `thread_id` = the comment), and `withdraw_pool` for the author of `unpinned_id` (if any). `unpin`: `withdraw_pool` for the comment's author when the request changed the row from pinned to unpinned. All after commit, best effort.
6. **`src/routes/games.rs`** + `models.rs`: `Game.notifications_muted` (`notificationsMuted`) on the detail response, computed like `is_favorite` (`false` for anonymous viewers). Not added to `GameSummary`/cards.
7. **`tests/f018.rs`** (see § 6), using `ManualClock` for the rate-limit test (no sleeps).

**Acceptance:** `cd backend && cargo test` (all suites green, including the earlier `f007`, `f017`, `review4`, `review5` suites) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types and client** (`src/api/types.ts`, `src/api/client.ts`): `NotificationKind` += `"pinned"`; `Notification.threadId?: string | null`; `NotificationSettings.pins?: boolean`; `Game.notificationsMuted?: boolean`; `Comment.threadMuted?: boolean`; `NotificationMute`, `NotificationMuteList`, `MuteState`; methods `listNotificationMutes()`, `muteGame(id)`, `unmuteGame(id)`, `muteThread(commentId)`, `unmuteThread(commentId)`. Export new types from `src/index.ts`.
2. **`src/notifications.ts`**: `NOTIFICATION_KINDS` += `"pinned"`; the `pinned` summary (§ 2.5); a pure `muteActionFor(n: Notification): { target: "game" | "thread"; id: string; label: string } | null` (§ 2.3).
3. **New `src/notificationsTabs.ts`** (pure, testable in node): `tabScope`, `parseTabMessage`, `TabMessage`, constants `VISIBLE_TTL_MS = 75_000`, `VISIBLE_PING_MS = 30_000`, `FOLLOWER_START_GRACE_MS = 5_000`, `followerWatchdogMs(pollAfterSecs)`, and `createTabCoordinator(deps)` where `deps = { locks?: LockManagerLike; createChannel?: (name) => ChannelLike | null }` (defaults: `navigator.locks`, `new BroadcastChannel`). Returns `null` when unsupported.
4. **`src/context/notifications.tsx`**: integrate the coordinator per § 2.6. Accept an optional `tabs?: TabDeps` prop on `NotificationsProvider` (tests inject in-memory fakes; production omits it). Factor the response handling into one `applyCount(c, { fromPeer })` used by own polls and received `count` messages; `osStep` runs only in the leader (or uncoordinated mode).
5. **Components**:
   - New `MuteGameButton.tsx` (game page action row, § 2.1) in `pages/GamePage.tsx`.
   - `CommentItem.tsx`: "Mute thread" (§ 2.2), local state seeded from `c.threadMuted`.
   - `NotificationItem.tsx` / `pages/NotificationsPage.tsx`: the item mute action (§ 2.3), full page only (a `showMute` prop).
   - `NotificationSettings.tsx`: the `pins` switch and the new `MutedList` section (new `MutedList.tsx`) (§ 2.4).
   - Styles in the existing stylesheet (reuse `pf-linkbtn`, `pf-muted`, pressed-button tokens).
6. **Tests** (§ 6). **Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
No code changes. Verify on the desktop build:
- The single webview becomes leader at once (Web Locks exist in WebView2, WKWebView (macOS 12.3+) and WebKitGTK 2.36+; when absent, the F007 per-tab behaviour is used, which is identical for one window).
- OS notifications still fire for new notifications, including the `pinned` text, and only once per notification.
- Changing the server in desktop settings restarts polling against the new server (new scope).
**Acceptance:** `npm run build -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo check`. Record the result in the round notes; no file changes expected.

### engine-dev
None.

### Sequencing
backend-dev and frontend-dev can work in parallel against API § F018. frontend-dev's tab coordination (tasks 3–4) has no backend dependency and can land first. desktop-dev verifies after both.

## 5. Edge cases and security
- **Migration safety.** The rebuild runs inside sqlx's migration transaction with `foreign_keys = ON` (it can't be turned off inside a transaction). It is written so that no `DROP TABLE` has a referencing child: the old `notification_events` (child) is dropped before the old `notifications` (parent), and the new child references `notifications_new`, which SQLite rewrites to `notifications` on rename (SQLite ≥ 3.26, `legacy_alter_table` off, as bundled by sqlx 0.8). The `0014` trigger is dropped first and recreated last, so no copy or drop fires it. `AUTOINCREMENT` sequences are carried over, so notification ids are never reused (clients dedupe by id). An upgrade test proves all of this (§ 6).
- **Unknown kinds.** Without the CHECK, a bad `kind` could only come from Rust code; `Kind` is the single source, and reads skip unparseable kinds. Clients already ignore unknown kinds (F007).
- **Mute scope is server-side and private.** Nobody else can see who muted a game or thread; owners get no signal. Mutes affect only notifications: not the feed, comments, hearts or analytics.
- **Visibility.** Muting needs the target to be visible to the caller (else 404, so mutes can't probe unpublished games). Unmuting never checks visibility and never 404s, so a user can always remove their own row. Mutes on games that become invisible are kept but not listed; they reappear if the game is re-published.
- **Cascades.** Deleting the game, the thread's top-level comment or the user removes the mute (foreign keys). Deleting a reply removes nothing.
- **Mute + settings.** Both must allow a notification. A muted game with the kind switched on still notifies nothing.
- **Mark read on mute** only touches the caller's **unread** notifications in scope. Unmuting doesn't mark anything unread or restore missed events (events during a mute were never written).
- **Coalescing during a mute.** An unread group in scope was marked read at mute time, so after unmuting, the next event opens a fresh unread group.
- **Heart/follow toggles while muted** (review 5 L5 rule, extended): a re-heart while the game or thread is muted restores nothing.
- **Pinned dedupe.** Once per (author, comment) for as long as a row for it exists (read, unread, or withdrawn). Pin → unpin while unread → pin again restores the withdrawn event without moving the item (`updatedAt` unchanged), like F007 L1. After the author has read it, unpin changes nothing. After pruning (90 days), a new pin can notify again; acceptable.
- **Pin by an admin** notifies like an owner pin (the admin is the actor). Owners pinning their own comments: nobody is notified (never the actor).
- **Replace-pin**: pinning B while A is pinned notifies B's author and withdraws A's author's unread pin notification, in that order, after the commit.
- **Cap**: 500 mutes per user, checked inside `BEGIN IMMEDIATE`; re-muting an already muted target is not counted and never 422s.
- **Tab messages** are same-origin by the BroadcastChannel spec, but still validated (`parseTabMessage`) and filtered by `userId`, and they carry counts only. A malicious same-origin script could already call the API directly, so the channel adds no capability.
- **Throttled leaders.** Browsers throttle timers in hidden tabs (about once per minute in Chrome's intensive throttling), which matches the default 60 s cadence. The follower watchdog covers a frozen or discarded leader; a discarded tab releases its lock.
- **Signing out in one tab** stops that tab's coordinator and releases its lock; the remaining tabs re-elect. If they are also signed out (shared storage), their own auth stops them.
- **Rate limits.** Mute endpoints share `Limit::Notifications` (120/min/user) with polling. With coordination, polling uses about one request per minute per browser, leaving the budget for the rest.

## 6. Test expectations

### Backend (`tests/f018.rs`)
- **Upgrade test (required):** build a database at migration version ≤ 16 (pattern of `tests/f008.rs`: `sqlx::migrate!` filtered by `version <= 16`, `foreign_keys(true)`), then insert:
  - users `u1`–`u3`, a game `g1`, a root comment `c1` and a reply `c2`;
  - notifications with explicit ids `5` (unread `heart` on `c1`, two events, one with `retracted_at` set), `9` (read `reply`, group `thread:c1`, two events with `comment_id`), `12` (unread `follow`, one event by `u3`);
  - a notification with id `20` and one event, then delete it (so `sqlite_sequence` for `notifications` is 20 and its rows are gone via the trigger);
  - a `notification_settings` row and a `notification_fanouts` row.
  Run the full migrator, then assert:
  1. both tables contain exactly the same rows, all columns equal (including `retracted_at` and ids);
  2. `PRAGMA foreign_key_check` returns no rows and `PRAGMA integrity_check` returns `ok`;
  3. `PRAGMA foreign_key_list(notification_events)` has a row with `table = 'notifications'`, `on_delete = 'CASCADE'`; no `sqlite_master` entry's name or `sql` contains `_new`;
  4. the `notifications` table `sql` contains no `CHECK (kind`; inserting a `pinned` row succeeds;
  5. the index names on both tables equal the expected list (the ten F007 indexes in ARCHITECTURE § F018) and trigger `notification_events_last_gone` exists on `notification_events`;
  6. the next notification inserted without an id gets id `21` (sequence preserved);
  7. deleting the only event of notification 12 deletes notification 12 (trigger); deleting notification 5 deletes its events (cascade); deleting user `u3` removes the events it acted in;
  8. `notification_settings.pins` is `1` for the existing row, and `notification_mutes` exists and is empty; the fan-out row is unchanged.
- **Fresh database**: `setup()` migrates from zero (covered by every suite).
- **Game mute**: owner mutes → a new comment, reply in their thread, heart and pin on their comment in that game produce no notifications; another game still notifies; unread ones about the game became read and the response `unread` matches `unread-count`; unmute → the next event creates a new unread group; `Game.notificationsMuted` true/false for the owner, false for anonymous and other users.
- **Thread mute**: replies in the thread, hearts on the root and on replies in it, and a pin of the root don't notify; replies in another thread of the same game do; a `comment` notification for a new top-level comment still does; `Comment.threadMuted` true only for the muter, only on that top-level comment; replies always false.
- **Validation**: 401 anonymous; game unknown / unpublished for a non-owner → 404; reply id → 422; comment on an invisible game → 404; ids over 64 bytes → 404; DELETE of a never-muted or deleted target → 200 `{ muted: false }`; re-PUT is idempotent and keeps `createdAt`; with 500 mutes inserted directly into `notification_mutes` (500 API calls would exceed the rate limit), a new mute → 422 and a re-PUT of an existing one → 200.
- **List**: order `createdAt desc`; game and thread rows with `path` and `excerpt`; invisible games omitted; `total`.
- **Cascades**: deleting the game, the thread root or the user removes mutes; deleting a reply doesn't.
- **Pinned**: pin notifies the author once (`kind: "pinned"`, actor, `commentId`, `excerpt`, `threadId`, permalink `path`); owner pinning own comment → none; `pins: false` → none; unpin while unread → not listed or counted; re-pin → listed again with the original `updatedAt`; unpin after read → still listed (read); pin by an admin, then a re-pin by the owner → still one notification; replace-pin withdraws the previous author's unread pin; game mute and thread mute suppress it; deleting the comment removes it.
- **`threadId`** on `reply` (root), `heart` (root of the hearted reply / the root itself), `pinned` (the comment), null otherwise.
- **Fan-out**: a follower who muted the game (owner-visible case set up directly in the DB) gets no `gamePublished`.
- **Settings**: `pins` defaults true, round-trips through `PUT`, non-boolean → 422.
- **Rate limit** with `ManualClock`: 120 mixed requests across `unread-count` and the mute endpoints succeed, the 121st → 429 with `Retry-After`; after `clock.advance(60 s)` → 200.

### Frontend (vitest)
- `notifications.test.ts`: the `pinned` summary (`isKnownNotification` accepts it), `muteActionFor` for every kind (and missing fields → null).
- `notificationsTabs.test.ts`: `tabScope` encodes the base URL; `parseTabMessage` rejects wrong `v`, other `userId`, bad shapes and clamps counts; `followerWatchdogMs`.
- `NotificationsProvider.f018.test.tsx` with an in-memory lock manager and channel bus shared by two providers (fake timers):
  - only the leader requests `unread-count`; both bells show the same count; a new arrival is announced in both live regions;
  - closing (unmounting) the leader → the follower acquires the lock and polls (immediately when stale);
  - a hidden leader keeps polling while a follower is visible (ping) and stops when no ping arrived for 75 s and no OS notifications are on;
  - `markAllRead` in one tab updates the other tab's unread;
  - a follower's `refresh()` makes one request and resets the leader's schedule (no double poll);
  - watchdog: with a silent leader, a visible follower polls once after the watchdog delay;
  - messages for another `userId` are ignored; without `locks`/`BroadcastChannel` each provider polls on its own (F007 tests still pass unchanged);
  - only the leader calls `osNotifications.show`.
- Component tests: `MuteGameButton` (hidden without the field or when anonymous; optimistic toggle, revert on error, Undo); `CommentItem` mute (top-level only); `NotificationsPage` item mute (label per kind, refetch after success); `NotificationSettings` (`pins` switch hidden on older servers; `MutedList` empty state, rows, unmute, 404 hides the section).
- `ApiClient.f018.test.ts`: paths and methods of the five calls, `pins` in settings.

### F018 implementation notes (backend)
- **Upgrade test, item 3 (corrected):** older migrations legitimately contain `_new` index names (`idx_games_pub_new`, `idx_games_owner_pub_new`, `idx_games_owner_new` from 0004). The test therefore asserts that the set of `_new` names is unchanged by 0017 and that no schema object mentions `notifications_new` or `notification_events_new`.
- **Re-pinned after "mark all read":** "Mark all read" (`upTo`) and mark-read-on-mute also mark withdrawn (invisible) pinned rows as read. A comment re-pinned later restores that notification as read, consistent with "a read pinned notification is never changed".

### Review-6 UI changes (supersede the labels in §§ 2.1–2.3)
- **Mute game button:** visible text is "Mute notifications" / "Unmute notifications". No `aria-pressed`; the muted state is shown visually and in the text. The "Notifications muted" wording is no longer used.
- **Mute thread button:** the label changes with state ("Mute thread by {name}" / "Unmute thread by {name}"), with no `aria-pressed`.
- **Notification item actions:** "Mute game: {title}" / "Mute thread on {title}", so the accessible name contains the visible text (WCAG 2.5.3).
- **Undo toasts:** toasts with an action stay at least 10 s, pause while hovered or focused, and return focus to where it came from when they close.
- **Muted list:** mutes on unavailable games show as "Unavailable game" with an Unmute button.

# F024: "Screenshot of your game" notifications for creators

Status: **shipped**. Size: **S** (backend small: one migration with two added columns and one index swap, one notification kind, one hook, one batched read query; frontend small: one summary text, one thumbnail, one icon, one settings switch; desktop: one verification test file, no source changes; one round). Areas: backend, frontend, desktop (verification test only). Engine: none.
Contracts: `docs/API.md` § F024 additions (kind, `Notification.screenshot`, `NotificationScreenshot`, `NotificationSettings.screenshots`, trigger, deletion, path), `docs/ARCHITECTURE.md` § F024 additions (migration `0023_f024.sql` with the exact SQL, write path, read path, the `f018.rs` test adjustment), `docs/GAME_FORMAT.md` § F024 additions (no changes).
Depends on: F005 (screenshots), F007 (notifications), F015 (`screenshotPosted` feed event, `?section=screenshots`), F018 (mutes, no `notifications.kind` CHECK) and F021 (`NewNotification.collection_id`, the settings pattern). All shipped.

The migration is **`0023_f024.sql`** and runs after `0022_f015.sql`. No new endpoints, no new rate limits, **no new Rust or JS dependencies**, no engine or example changes.

## 0. Decisions on ambiguities (read first)
API § F024 is normative. Tests assert the texts below verbatim.

1. **Kind name.** The notification kind is `screenshotPosted`, the same string as the F015 feed kind. Feed kinds and notification kinds are separate lists (`activity::KINDS`, `notifications::Kind`), so there is no clash. Rust: `Kind::ScreenshotPosted`; setting column `screenshots`; JSON setting key `screenshots`.
2. **Who is notified.** Only the game's **owner**, and only when **all** of these hold:
   - `POST /api/games/{id}/screenshots` returned 201 (the guarded insert affected one row);
   - the game was **published** at the request's visibility check (step 2, the same `game.published` value F015 uses for the feed event);
   - the author is not the owner.

   Nobody else is notified: not the author's followers (F015's feed covers them), not other players who posted shots of the game, not admins. Screenshots posted before this round are never notified (no backfill).
3. **Grouping.** One unread notification per (owner, game): group key `game:{gameId}` (the existing `notifications::game_group`). Every screenshot is one event (`Dedupe::None`), so `eventCount` = screenshots and `actorCount` = distinct authors. While it is unread, new posts join it and move it to the top. Once it is read, the next post opens a new unread notification. There is no per-day split.
4. **Deletion (replaces the roadmap's "withdrawn while unread").** Each event stores its screenshot (`notification_events.screenshot_id`, `ON DELETE CASCADE`). Deleting a screenshot, by its author, the game owner, an admin or a report resolution, deletes its event from the notification **whether it is read or unread**. A notification left with no events is deleted by the existing `0014` trigger, so it disappears from the list and the count. This is the F007 rule for deleted comments: a notification never points at an image that no longer exists. Deleting the game or the author's account cascades in the same way. No code runs in `remove_screenshot` for this.
5. **Timing.** The notification is written **synchronously inside the POST handler**: after the screenshot insert and after the F015 feed event, and before the 201 response is built. It is best effort: a failure is logged and the response is still 201. Its `createdAt`/`updatedAt` are **exactly** the new screenshot's `createdAt` (the handler's one `now` string, parsed). The owner sees it on the next unread-count poll (`pollAfterSecs`, default 60 s). There is no push, and no OS notification beyond the existing F007 desktop path.
6. **Payload.**
   - `Notification.screenshot` = `{ id, thumbUrl }` of the group's **newest remaining** screenshot (the newest live event that has one), else `null`. It is computed at read time, so deleting the newest shows the next one.
   - `screenshotPosted` has no `excerpt`: captions are never put in notifications, in-app or OS. `commentId`, `excerpt`, `threadId` and `collection` are `null`; `ownsThread` and `creatorHeart` are `false`.
   - `game` is the game.
7. **Path and activation.** `path` = `/games/{gameId}?section=screenshots` (the F015 route). Activating the item uses the existing behaviour: it marks the item read, closes the bell panel and navigates. The game page then **scrolls** (it doesn't focus) to the Screenshots gallery, as for F015 feed links. Focus follows the existing route change. No lightbox opens automatically (non-goal).
8. **Summary texts** (normative; `{A}`/`{B}` = display name, falling back to username, then "Someone"; `{game}` = `game.title`, or `a game` when `game` is missing; `{n}` = `eventCount`; `{k}` = `actorCount − 1`):

   | actorCount | eventCount | Text |
   |---|---|---|
   | 1 | 1 | `{A} posted a screenshot of {game}` |
   | 1 | n ≥ 2 | `{A} posted {n} screenshots of {game}` |
   | 2 | n ≥ 2 | `{A} and {B} posted {n} screenshots of {game}` |
   | ≥ 3 | n ≥ 3 | `{A} and {k} others posted {n} screenshots of {game}` |

   The `who` part is built by the existing code in `notificationParts`. `actorCount = 2` with only one actor sent gives `{A} and 1 other`, also existing behaviour.

   Parts:
   - `name(A)`;
   - the who-suffix parts;
   - `text(" posted a screenshot of ")` or `text(" posted {n} screenshots of ")`;
   - `title(game)`.
9. **Icon and thumbnail** (`NotificationItem`, both the `panel` and `page` variants):
   - The meta line shows a 📷 glyph before the time: `<span class="pf-notif__kind pf-notif__kind--screenshot" aria-hidden="true">📷</span>`.
   - When `screenshot` is an object with a string `thumbUrl`, the link contains `<img class="pf-notif__shot" src={api.url(thumbUrl)} alt="" loading="lazy" width="48" height="48">`. It goes after `.pf-notif__body` and before the unread dot. It is decorative (`alt=""`), because the summary already says what it is.
   - Otherwise there is no `<img>`, and the rest renders unchanged.
   - The item is still exactly **one Tab stop** (the link), plus the F018 mute button on the page variant.
10. **Settings switch.** It is the **eighth** and last switch, after "My games added to collections":
    - label **`Screenshots of my games`**;
    - hint **`Someone posts a screenshot of a game you made.`**;
    - key `screenshots`, default `true`.

    It is hidden when the settings response has no `screenshots` field (older server), by the existing per-field rule.
11. **Mutes (F018).**
    - A **game** mute of the game suppresses the notification, and muting marks an unread one read (both existing, `game_id`-based).
    - **Thread mutes never apply** (`thread_id` NULL).
    - `/notifications` item action: `muteActionFor` returns `{ target: "game", id: game.id, label: "Mute game: {title}" }`, and the button text is "Mute game" (existing).
12. **OS notifications (desktop).** The body is the in-app summary unchanged, e.g. `Mia posted 2 screenshots of Space Dodge`. It contains no caption and no URL. `osNotificationText` needs no special case.
13. **Old clients and servers.** Older clients ignore the unknown kind (the F007 rule). Clients treat a missing `screenshot` as `null` and a missing `screenshots` setting as "not supported".
14. **Migration and the F018 upgrade test.** `0023` drops and recreates `idx_notification_events_dedupe` with `IFNULL(screenshot_id, '')` appended. Without that, two screenshots by one author in one unread group would collide on `(notification_id, actor_id, '')` and the second event would be silently ignored. `tests/f018.rs` compares post-migration index SQL with the 0016 baseline, so it is adjusted exactly as in § 4 backend task 8.

Non-goals (later items):
- notifying other posters or followers;
- per-screenshot hearts;
- owner-featured screenshots (proposed as F027);
- opening the lightbox from the notification;
- email or push;
- a digest.

## 1. Goal and user stories
F005 lets any player post a screenshot to a game page, and F015 shows those posts to the author's followers. The person who most needs to know, the game's creator, hears nothing. They find community shots only by revisiting their own game page. So they can't thank players, can't use a great shot as the thumbnail ("Set as thumbnail", F005), and can't quickly remove an inappropriate one.

F024 adds a creator-facing notification kind `screenshotPosted`. It reuses the F007 pipeline, F018 mutes and the F015 gallery deep link.

User stories:
1. As a creator, my bell says "Mia posted a screenshot of Space Dodge" with a small preview. I click it and land on my game page, scrolled to the Screenshots gallery, where I can set it as the thumbnail.
2. As a creator of a popular game, three players post seven shots in an evening. I see one item: "Mia and 2 others posted 7 screenshots of Space Dodge".
3. As a creator, I delete an inappropriate screenshot from my gallery. The notification's count drops, or the notification disappears if that was the only one.
4. As a creator, I switch off "Screenshots of my games", or mute one game, and these notifications stop.
5. As a player, I post screenshots of my own game. I get no notification about my own shots.
6. As a desktop user with OS notifications on, I get "Mia posted a screenshot of Space Dodge" with no caption text.
7. As a keyboard or screen-reader user, the item is one link whose name is the summary. The preview image is decorative and adds no extra stop.

## 2. UX notes
See § 0 items 7–12 for the exact texts, placement and focus. Additional notes:
- **Bell panel and `/notifications` page:** the same component (`NotificationItem`) is used in both. The thumbnail box is 48×48 CSS px, `object-fit: cover`, `border-radius: 6px`, `flex: none`, with a 1 px `var(--pf-border)` border so dark shots are visible on dark themes. It makes screenshot rows 48 px tall, slightly taller than other rows (about 39 px); this is accepted (review 10, L5).
- **Contrast and motion:** no new colours (existing tokens) and no animation.
- **Unread dot, time and mute button:** unchanged.
- **Error states:** a thumbnail that fails to load shows the browser's empty box at 48×48. There is no `onError` handling, because the image is decorative and the link still works.

## 3. Contract changes (summary; normative text lives in docs/)
- **API.md § F024 additions**:
  - `NotificationKind` += `"screenshotPosted"`.
  - New type `NotificationScreenshot`, and `Notification.screenshot`.
  - `NotificationSettings.screenshots`.
  - The trigger and recipient table, coalescing, deletion, visibility, mutes, path and OS text.
  - No new endpoints, no new status codes and no new rate limits.
- **ARCHITECTURE.md § F024 additions**:
  - Migration `0023_f024.sql`: `notification_events.screenshot_id`, the partial index, the dedupe index swap and `notification_settings.screenshots`.
  - `NewNotification.event_screenshot_id`, the hook in `create_screenshot`, and the read-path query for `screenshot`.
  - The cascade and trigger rule, and ownership.
- **GAME_FORMAT.md § F024 additions**: none.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0023_f024.sql`. Copy the SQL in ARCHITECTURE § F024 "Data" **verbatim** (order matters). Never edit `0001`–`0022`.
2. **`src/notifications.rs`**:
   - `Kind::ScreenshotPosted` (doc comment `/// F024: a player posted a screenshot of the recipient's game.`). `as_str` → `"screenshotPosted"`, `setting_column` → `"screenshots"`. Add it to `Kind::ALL`, which becomes `[Kind; 8]`.
   - `NewNotification` gains `pub event_screenshot_id: Option<String>`, with the doc `/// F024 \`screenshotPosted\`: the posted screenshot; else \`None\`.`
   - `try_notify`'s event insert becomes `INSERT OR IGNORE INTO notification_events (notification_id, actor_id, comment_id, screenshot_id, created_at) VALUES (?, ?, ?, ?, ?)`, binding `n.event_screenshot_id`. The notifications upsert is unchanged.
   - `NotificationSettings.screenshots: bool` (default `true`) and `SettingsPatch.screenshots: Option<bool>` (also in `is_empty`). `load_settings` selects `screenshots` as the 8th column. `update_settings` binds it as `?10`: `COALESCE(?10, 1)` in `VALUES` and `screenshots = COALESCE(?10, screenshots)` in the update.
   - `Notification` gains `pub screenshot: Option<NotificationScreenshot>`, with the doc `/// F024: \`screenshotPosted\` only; \`null\` for every other kind.`
   - `list_page`:
     - `target_of`: `ScreenshotPosted` → `None`.
     - `thread_id`: → `None`.
     - `path`: → `format!("/games/{gid}?section=screenshots")`.
     - `collection`: `None`.
     - `event_count`: `Kind::Comment | Kind::Reply | Kind::ScreenshotPosted => events`.
     - One batched query for the page's `ScreenshotPosted` ids only (skip it when there are none). The SQL is in ARCHITECTURE § F024 "Read path". It fills `screenshot = Some(NotificationScreenshot { id, thumb_url: crate::screenshots::thumb_url(&id) })`. Rows without a match get `None`.
   - Unit test `kinds()`: `Kind::ALL.len() == 8`, the new `as_str`/`setting_column`, `Kind::parse("screenshotPosted")`.
3. **`src/models.rs`**: `NotificationScreenshot { id: String, thumb_url: String }`, with `#[derive(Debug, Clone, Serialize)]`, `#[serde(rename_all = "camelCase")]`, next to `NotificationCollection`.
4. **`src/routes/notifications.rs`** (`put_settings`): `screenshots: field("screenshots")?`. A non-boolean → 422 `screenshots must be a boolean` (existing message format).
5. **Every existing `NewNotification { … }` literal** passes `event_screenshot_id: None`. There are six of them: four in `routes/comments.rs`, one in `routes/follows.rs` and one in `routes/collections.rs`. The `gamePublished` fan-out uses raw SQL and is unchanged.
6. **`src/routes/screenshots.rs`** (`create_screenshot`): right after the F015 `record_screenshot_posted` block and before step 12, add the hook from ARCHITECTURE § F024 "Write path". The condition is `game.published && game.owner_id != user.id`. The hook calls `crate::notifications::notify_pool(&state.db, &NewNotification { … })` with:
   - `recipient_id: game.owner_id.clone()`;
   - `kind: Kind::ScreenshotPosted`;
   - `group_key: game_group(&game_id)`;
   - `game_id: Some(game_id.clone())`;
   - `comment_id: None`;
   - `actor_id: user.id.clone()`;
   - `event_comment_id: None`;
   - `event_screenshot_id: Some(id.clone())`;
   - `dedupe: Dedupe::None`;
   - `thread_id: None`;
   - `collection_id: None`;
   - `now` = `now` parsed with `DateTime::parse_from_rfc3339(&now).map(|t| t.with_timezone(&Utc)).unwrap_or_else(|_| Utc::now())`.

   `remove_screenshot` and `delete_screenshot` are **unchanged**: the foreign key cascade and the `0014` trigger do the work.
7. **`tests/f007.rs`**: the two full-settings `json!` literals (`all_on` and the `hearts: false` one) gain `"screenshots": true`.
8. **`tests/f018.rs`** (`migration_upgrade_from_0016`). This test runs every migration and compares index SQL with the 0016 baseline.
   - `SCHEMA_OF` also excludes `'idx_notification_events_screenshot'`: `AND name NOT IN ('idx_notifications_collection', 'idx_notification_events_screenshot')`.
   - After `AppState::new`, and before `assert_eq!(schema, schema_before)`, find the `idx_notification_events_dedupe` entry in `schema`. Assert that its SQL contains `IFNULL(screenshot_id, '')`, then replace that entry's SQL with the `schema_before` entry's SQL.
   - Add a comment: `// 0023 (F024) appends screenshot_id to the dedupe index; tests/f024.rs checks it.`
   - Every other assertion stays unchanged.
9. **`tests/f024.rs`** (§ 6), using `common::setup()`, `TestApp::register`, `create_game`, `multipart` and `png_bytes`, and `t.clock` (`ManualClock`) for the rate-limit case.

**Acceptance:** `cd backend && cargo test` (every suite green, including `f005`, `f007`, `f015`, `f018`, `f021` and `review2`) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`):
   - `NotificationKind` += `"screenshotPosted"`.
   - `export type NotificationScreenshot = { id: string; thumbUrl: string }`.
   - `Notification.screenshot?: NotificationScreenshot | null`, with the doc "F024: screenshotPosted only; null for every other kind. Older servers omit it (treat as null)."
   - `NotificationSettings.screenshots?: boolean`, with the doc "F024: "screenshotPosted" kind. Older servers omit it: hide the switch."
   - Export `NotificationScreenshot` from `src/index.ts`.
2. **`src/notifications.ts`**:
   - `NOTIFICATION_KINDS` += `"screenshotPosted"` (last).
   - `notificationParts` gets a `case "screenshotPosted"` built from `who` and `eventCount`, with the exact texts in § 0.8.
   - `muteActionFor` adds `case "screenshotPosted"` to the game group (with `comment`, `gamePublished` and `addedToCollection`).
   - `osNotificationText` is unchanged: it falls through to `notificationText`.
3. **`components/NotificationItem.tsx`**:
   - The 📷 meta glyph (§ 0.9).
   - The thumbnail `<img>` (§ 0.9) goes in a small child component `NotificationShot({ thumbUrl })` in the same file. It calls `useApi()` from `../context/config` and resolves the URL with `.url(thumbUrl)`. Because the hook lives in the child, `NotificationItem` renders of other kinds never need the API context.
   - A small pure guard `screenshotThumb(item): string | null` in `notifications.ts`, exported. It returns `thumbUrl` only for `kind === "screenshotPosted"` with an object `screenshot` and a non-empty string `thumbUrl`.
4. **`components/NotificationSettings.tsx`**: append `{ key: "screenshots", label: "Screenshots of my games", hint: "Someone posts a screenshot of a game you made." }` to `NOTIFICATION_SETTING_FIELDS`, and update the doc comment ("F024 adds `screenshots`").
5. **Styles** (`styles.css`, next to `.pf-notif__kind`): add `.pf-notif__shot` (§ 2) with existing tokens only.
6. **Tests**:
   - `src/__tests__/notifications.f024.test.ts`:
     - the four summary forms of § 0.8 verbatim;
     - a missing `game` → `… of a game`;
     - `isKnownNotification` accepts the kind;
     - `muteActionFor` → `{ target: "game", id: "g1", label: "Mute game: Pixel Peaks" }`;
     - `osNotificationText(n) === notificationText(n)`;
     - `osNotificationsFor([n])[0].body === "Mia posted a screenshot of Pixel Peaks"`;
     - `screenshotThumb` returns null for other kinds, for `screenshot` null, missing or malformed, and for an empty `thumbUrl`.
   - `src/__tests__/NotificationItem.f024.test.tsx` (use `notifFixtures.ts`):
     - the link `href` is `/games/g1?section=screenshots`;
     - the link contains one `img` with `alt=""` whose `src` is the client's resolved `/media/screenshots/s1_t.jpg`;
     - the `aria-hidden` 📷 glyph is present;
     - there is no excerpt;
     - with `screenshot: null`, there is no `img`;
     - the page variant with `showMute` shows "Mute game";
     - exactly one link in the `li`.
   - `src/__tests__/NotificationSettings.f024.test.tsx`:
     - the switch is shown last, directly after `collections`, with label and hint verbatim;
     - toggling sends `{ screenshots: false }` and then `{ screenshots: true }`;
     - when the field is absent, the switch is hidden and the other seven are unchanged.
   - Existing suites stay green (`NotificationSettings.f021.test.tsx` asserts `collections` directly after `newGames`, which still holds).
7. **Docs**: none in the UI (no docs page change).

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`, `npm test -w @webgame/desktop`.

### desktop-dev (`apps/desktop/**`)
No source changes. Add one verification test, `apps/desktop/src/__tests__/f024.desktop.test.tsx`. Follow the pattern of `f015.desktop.test.tsx`: the real `App` under the hash router, `SERVER_STORAGE_KEY` set to `http://192.168.1.5:8080`, a mocked `fetch` and mocked Tauri modules. With a signed-in user whose `GET /api/notifications` returns one `screenshotPosted` item (`screenshot: { id: "s1", thumbUrl: "/media/screenshots/s1_t.jpg" }`), on `#/notifications` it asserts:
- the item's thumbnail `src` is `http://192.168.1.5:8080/media/screenshots/s1_t.jpg`, and the `tauri.conf.json` CSP `img-src` allows it (reuse the `imgAllowed` helper approach);
- the item's link `href` is `#/games/g1?section=screenshots`;
- `osNotificationsFor([item])` (from `@webgame/ui`) yields exactly one entry, with the title `OS_NOTIFICATION_TITLE` ("Pixelforge Arcade") and the body `Mia posted a screenshot of Pixel Peaks`. Give the item a caption-like string nowhere in the payload, and assert that the body contains neither `/media/` nor `s1`.

**Acceptance:** `npm run build -w @webgame/desktop`, `npm test -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo check`.

### engine-dev
None.

### Docs (project-manager, after the round)
- README "Features → Social": add "creators are notified when players post screenshots of their games" to the notifications clause.
- ROADMAP: F024 → shipped.

### Sequencing
backend-dev and frontend-dev work in parallel against API § F024 (the frontend mocks responses). desktop-dev starts after frontend-dev lands, because its test needs the built `@webgame/ui` with the new kind.

## 5. Edge cases and security
- **Never the actor.** The owner posting shots of their own game writes nothing: the hook's condition is checked first, and `notify` checks it again.
- **Unpublished games.** Only the owner can post to an unpublished game (F005 visibility), so posting there writes nothing. If the game is unpublished later, the owner still sees the notification (F007 visibility: the recipient owns the game).
- **Races.**
  - If the screenshot is deleted between its insert and the hook, the event insert fails the foreign key check and the whole notification transaction rolls back. This is logged as a warning, and the 201 still goes out.
  - Two concurrent posts by different players both land in the one unread group (`BEGIN IMMEDIATE`, M1).
  - A post racing a mark-read either joins the group before the read (then it is read) or opens a new one. This is existing F007 behaviour.
- **Deletes.**
  - Screenshot: its event is removed, read or unread (§ 0.4).
  - All screenshots of a notification: the notification is removed by the `0014` trigger.
  - Game: the notifications cascade.
  - Author account: their screenshots cascade, and with them their events.
  - The F005 report resolution `delete` goes through `remove_screenshot`, so it is covered.
- **Spam bounds.** `Limit::Screenshot` (10 per hour per user) and the 20-per-user-per-game cap bound the events per author. Coalescing keeps one unread item per game. The owner can turn the kind off or mute the game. Delete-and-repost cycles are limited by the same bucket.
- **User text.** Captions never reach notifications, in-app or OS. Display names and game titles are already rendered as text nodes and are already in other kinds' OS texts.
- **Images.** `thumbUrl` is a server-built path (`/media/screenshots/{uuid}_t.jpg`) of an image the server re-encoded (F005). The client resolves it with `api.url`, so the desktop app gets an absolute URL on the configured server, which the CSP `img-src` already allows.
- **Privacy.** The owner learns who posted shots of their game. Those shots are already public on the game page with the author's name, so nothing new is revealed.
- **Performance.**
  - The write is one extra `BEGIN IMMEDIATE` transaction per accepted post, at most 10 per user per hour.
  - The read adds one batched query per page, only when the page has `screenshotPosted` items.
  - The cascade uses the new partial index `idx_notification_events_screenshot`.
- **Migration safety.**
  - `ADD COLUMN … REFERENCES` is allowed because the default is NULL (as in `0019`).
  - The new dedupe index is strictly finer than the old one, so existing rows can't violate it.
  - The `0014` trigger references only `notification_id` and is untouched.
  - No table is rebuilt.

## 6. Test expectations

### Backend (`tests/f024.rs`)
- **Upgrade test (required).**
  1. Migrate a fresh file database to version ≤ 22 (the `tests/f018.rs` pattern, with a `filter(|x| x.version <= 22)` migrator).
  2. Insert two users, a published game, one screenshot row, one `comment` notification with two events (comment ids set), and one `notification_settings` row.
  3. Run `AppState::new`, then assert:
     - the existing `notification_events` rows are unchanged, with `screenshot_id` NULL;
     - `notification_settings.screenshots` is `1`;
     - the `idx_notification_events_dedupe` SQL contains `IFNULL(screenshot_id, '')`;
     - `idx_notification_events_screenshot` exists on `notification_events`;
     - the trigger `notification_events_last_gone` still exists;
     - `PRAGMA foreign_key_check` is empty and `integrity_check` is `ok`;
     - two events with the same `(notification_id, actor_id)`, NULL `comment_id` and different `screenshot_id`s both insert;
     - repeating one of them with `INSERT OR IGNORE` changes 0 rows.
- **Basic.** Owner O, player P, published game G. P posts a screenshot (201), and O's list has one `screenshotPosted` item with:
  - `actors` = [P], `actorCount` = `eventCount` = 1;
  - `game.id` = G;
  - `screenshot` = `{ id: <the 201 id>, thumbUrl: "/media/screenshots/<id>_t.jpg" }`;
  - `path` = `/games/G?section=screenshots`;
  - `commentId`, `excerpt`, `threadId` and `collection` null; `ownsThread` and `creatorHeart` false;
  - `createdAt` = `updatedAt` = the screenshot's `createdAt`.

  `unread-count` is 1. P sees nothing.
- **Coalescing.**
  - A second post by P while the item is unread keeps the same notification `id`, with `eventCount` 2, `actorCount` 1, `updatedAt` = the second screenshot's `createdAt`, and `screenshot.id` = the second shot.
  - A post by a third user Q gives `actors` = [Q, P], `actorCount` 2 and `eventCount` 3.
  - After `POST /api/notifications/read`, P's next post opens a new notification (a different `id`, `eventCount` 1). The read one is unchanged.
- **Own and unpublished.** O posting to G writes no notification. O posting to their unpublished game H writes none.
- **Deletes.**
  - P deletes the newest of two shots: `eventCount` 1, and `screenshot.id` = the remaining one.
  - O deletes the remaining one: the notification is gone from the list, `unread-count` is 0, and `SELECT COUNT(*) FROM notifications WHERE kind = 'screenshotPosted'` is 0.
  - The same for a **read** notification: mark it read, then delete its only screenshot, and the row is gone.
  - Deleting G removes all its `screenshotPosted` notifications.
- **Rejected posts.** A post refused with 422 (not a PNG/JPEG; or the 21st screenshot of P on G, by inserting 20 rows directly) writes no notification and no event. With `ManualClock`, P's 11th post within the hour → 429 and no new event.
- **Settings.**
  - `GET /api/notifications/settings` includes `screenshots: true`.
  - `PUT { "screenshots": false }` → P's post writes nothing. `PUT { "screenshots": true }` → the next post notifies.
  - `PUT { "screenshots": "no" }` → 422 `screenshots must be a boolean`.
- **Mutes.**
  - An F018 game mute of G by O → no notification, and muting G marks an existing unread one read.
  - A thread mute by O of a top-level comment on G does **not** suppress it.
- **Feed unchanged.** The F015 `screenshotPosted` feed event is still written for P's followers (one assertion that `activity_events` has the row).
- **Unit.** `notifications::tests::kinds` (8 kinds).

### Frontend (vitest)
As listed in § 4 frontend-dev task 6.

### Desktop (vitest)
As listed in § 4 desktop-dev.

### Manual end to end
1. Creator O owns Space Dodge. Player Mia posts two screenshots with captions.
2. Within a minute, O's bell shows "Mia posted 2 screenshots of Space Dodge" with a preview of the second shot.
3. Clicking it marks it read and scrolls the game page to the gallery. O uses "Set as thumbnail" on one shot and deletes the other, and the notification (now read) shows 1 screenshot.
4. O switches "Screenshots of my games" off, and Mia's next post doesn't notify.
5. On desktop with OS notifications on, the OS toast reads "Mia posted a screenshot of Space Dodge" with no caption.

## Implementation notes (as shipped)
- **Backend:**
  - Seven `NewNotification` literals needed `event_screenshot_id: None`, not six. The extra one is `tests/review4.rs:126`.
  - `tests/f018.rs`: the `notification_events` foreign-key count goes from 3 to 4 because of the new `screenshot_id` FK.
  - Successful-post tests build a real 64×64 PNG; `png_bytes()` is only a header and is used for the rejected-image case.
- **Frontend:**
  - `NotificationItem` still needs the API context for every kind, because `Avatar` already uses it. `NotificationShot` only keeps the `<img>` logic separate.
  - Singular or plural comes from `eventCount === 1` alone, because `eventCount >= actorCount` always holds.

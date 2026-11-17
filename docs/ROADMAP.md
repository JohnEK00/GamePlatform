# Roadmap

Owned by the `product-planner` agent. Items are listed in priority order (highest first). Sizes: S (one specialist, under a day), M (several specialists, one round). Anything L gets split before it's specced.
Status values: `proposed`, `specced` (spec in `docs/features/`), `in progress`, `shipped`.

## Shipped (v1 + v2): do not re-propose
- **Accounts and profiles**: register/login (JWT), display name, bio, avatar, profile page with the user's games.
- **Games**: zip bundle upload, replace bundle (versioned), thumbnail, publish/unpublish, delete, owner preview tokens.
- **Discovery**: search, tag filter, sort by new/popular/top/favorites, top tags.
- **Social**: 1–5 star ratings, comments (author or owner can delete), favorites plus a favorites page.
- **Leaderboards (basic)**: an all-time list with each user's best score, descending only, via `engine.platform.submitScore`.
- **Achievements**: declared in game.json, unlocked via `engine.platform.unlockAchievement`, shown on game pages and profiles.
- **Cloud saves**: `engine.storage` synced per user per game (256KB), with a localStorage fallback.
- **Game Studio**: in-browser editor, templates, sandboxed live preview (`/play/studio`), publish or export .zip, open a local folder (desktop + `webkitdirectory`).
- **Creator analytics**: totals and a 30-day plays chart, overall and per game.
- **Moderation**: reports on games/comments, an admin queue, `ADMIN_USERNAMES`.
- **Security/ops**: sandboxed iframes, CSP sandbox on files, rate limits, Docker, CI.
- **Engine**: WebGL2 batching, input (keyboard/mouse/touch/gamepad), audio, scenes, tilemaps, physics, particles, tweens, in-memory files, F3 debug overlay; three example games.
- **Ember Garden** (`examples/ember-garden`): a fourth example and showcase game, added by the user after F017.
- **Desktop**: native menu, F11 fullscreen, native open/save dialogs, configurable server, offline banner.

## Backlog

| Id | Title | Size | Status |
|---|---|---|---|
| F001 | Leaderboards 2.0: daily/weekly boards, time/ascending scores, in-game leaderboard API | M | shipped |
| F002 | Follow creators and an activity feed | M | shipped |
| F003 | Trending and "More like this" discovery | S | shipped |
| F004 | Version changelogs and an "Updated" badge | S | shipped |
| F013 | Studio: publish updates to an existing game | M | shipped |
| F005 | Screenshot capture and share | M | shipped |
| F009 | Controls overlay and key remapping | M | shipped |
| F006 | Comment replies and reactions | M | shipped |
| F007 | In-app notifications | M | shipped |
| F012 | Engine bitmap fonts, 9-slice and UI widgets | M | shipped |
| F017 | Creator comment tools: pin, lock and "top" sort | S | shipped |
| F008 | Collections (curated game lists) | M | shipped |
| F018 | Notification controls: mutes, shared polling, "pinned" notifications | M | shipped |
| F021 | Collection activity: feed items and "added to a collection" notifications | M | shipped |
| F016 | Gamepad remapping, synced control bindings and device-aware prompts | M | shipped |
| F019 | Engine UI widgets 2: slider, toggle, text field and vertical list | M | shipped |
| F020 | Game comment settings: comments on / replies only / off, slow mode | S | shipped |
| F015 | Screenshots in the feed and on profiles | S | specced |
| F023 | Engine on-screen keyboard for `ui.textField` (touch and gamepad) | S | proposed |
| F022 | Announce a collection when it goes public | S | proposed |
| F024 | "Screenshot of your game" notifications for creators | S | proposed |
| F014 | Desktop Studio: save to local folder and watch for changes | S | proposed |
| F011 | Studio sprite tools (sheet slicer and pixel editor) | M | proposed |
| F010 | Desktop offline library | M | proposed |

### F001: Leaderboards 2.0 (M, shipped → [spec](features/F001-leaderboards-2.md))
- **Pitch**: daily and weekly boards next to all-time ones, ascending/time-based scoring for speedruns, and an API so games can show leaderboards and "new personal best!" in-game.
- **User value**: players get a fresh, winnable board every day and week, and see their rank without leaving the game. Creators can build time trials and in-game high-score screens, which drives replays.
- **Areas**: engine (+ examples), backend, frontend (player, Leaderboard panel, Studio), desktop (verification only).

### F002: Follow creators and an activity feed (M, shipped → [spec](features/F002-follow-and-feed.md))
- **Pitch**: follow any user, then see their new games, bundle updates, personal bests (F001) and achievement unlocks in a `/feed` page, plus updates to games you favorited. Follower counts and lists on profiles, and creator suggestions for an empty feed.
- **User value**: a reason to come back, and creators build an audience.
- **Areas**: backend (follows, activity events, feed and suggestions), frontend (follow button, feed page, profile counts and lists), desktop (View → Feed). No engine changes.
- **Depends on**: F001 backend (`personalBest`) for the personal-best events only.

### F003: Trending and "More like this" (S, shipped → [spec](features/F003-trending-and-related.md))
- **Pitch**:
  - A `sort=trending` option that ranks games by distinct players per day over the last 7 UTC days, with recent days weighted higher. It is built on the deduplicated `play_events`, with owner plays excluded.
  - A "Trending this week" home shelf, and a `playsWeek` count on every game card.
  - A "More like this" shelf on each game page, ranked by shared tags (rarer tags weigh more) and filled with trending games.
- **User value**: it surfaces active games beyond the all-time "popular" list, and keeps players browsing after a session.
- **Areas**: backend (migration `0006_f003.sql`, `trending.rs` snapshot, `/related`), frontend (sort tab, shelves, card highlights), desktop (verification only). No engine changes.
- **Depends on**: the review-fix play dedupe and rate limit (R2) for the `viewer_key` write; everything else is independent of F002.

### F004: Version changelogs and an "Updated" badge (S, shipped → [spec](features/F004-version-changelogs.md))
- **Pitch**:
  - Bundle uploads and replacements take an optional plain-text "What's new" note (up to 1000 chars), which the owner can edit later.
  - The game page shows a "What's new" panel and the version history.
  - Cards show an "Updated" badge for 7 days after a replace of a published game.
  - F002 `gameUpdated` feed items quote the notes of every version they cover, including versions merged by the 24h coalescing.
  - Replace forms send `expectedVersion`, so a stale tab gets a clear 409 on top of the R1 per-game claim.
- **User value**: players see why to replay, and creators can talk to their players.
- **Areas**: backend (migration `0007_f004.sql`: `game_versions`, `games.last_updated_at`, `activity_events.from_version`; `/versions` endpoints; feed `update` field), frontend (notes fields, `VersionHistory`, badge, feed notes), desktop (verification only). No engine changes.
- **Depends on**: F002 (shipped) and the R1 bundle replace serialisation. Lands after F003's `0006` migration.

### F013: Studio: publish updates to an existing game (M, shipped → [spec](features/F013-studio-publish-updates.md))
- **Pitch**:
  - The Studio's Publish dialog gains "Update an existing game": it replaces the bundle with F004 release notes and `expectedVersion`, and asks for confirmation when the project isn't linked to that game's current version.
  - "Open in Studio" (owner) loads the current bundle through a new owner-only `GET /api/games/{id}/bundle`. The Studio's Open menu adds ".zip file…" and "My game…", and a project remembers its linked game.
  - The edit page gets "Download current bundle". On desktop, "↻ Reload folder" re-reads a local folder after edits on disk.
- **User value**: today Studio creators can only create new games, and zip-uploaded games can't be opened in the Studio at all. This closes the edit → ship loop and makes changelogs part of it.
- **Areas**: backend (export endpoint, `Limit::BundleDownload`, CORS expose headers; no migration), frontend (zip reader, Open menu/dialog, Publish modes, link/dirty state, entry points), desktop (session folder registry + `reload_project_folder`).
- **Depends on**: F004 (`notes`/`expectedVersion`, `ReleaseNotesField`).

### F005: Screenshot capture and share (M, shipped → [spec](features/F005-screenshots.md))
- **Pitch**:
  - The engine captures a frame at a fixed point (after the game's draw calls, before the debug and pause overlays), at a predictable resolution, without `preserveDrawingBuffer`.
  - It is exposed three ways: a 📷 button in the player (parent request), `engine.platform.shareScreenshot()` (game offers a shot to the player), and `engine.captureFrame()` (the game keeps the Blob).
  - A screenshot tray offers download (native save on desktop), copy, "Post to game page" with a caption, and "Set as thumbnail" for owners.
  - Each game page gets a Screenshots gallery. Screenshots can be reported and deleted by the author, owner or admin.
  - The server re-encodes every upload, which strips metadata.
- **User value**: real thumbnails for creators in one click, shareable moments for players, and community content on game pages.
- **Areas**: engine (`capture.ts`, messages, examples), backend (migration `0009_f005.sql`: `screenshots` + `reports` CHECK rebuild; `image` crate; `Limit::Screenshot`), frontend (tray, dialogs, gallery, admin), desktop (View → Take Screenshot, Pictures default in `save_file`).
- **Depends on**: nothing unshipped. It reuses `validate_image`, the N5 `Limit::Image` pattern, the F001 request/reply pattern, `useModal` and `platform.saveFile`.

### F006: Comment replies and reactions (M, shipped → [spec](features/F006-comment-replies-and-reactions.md))
- **Pitch**:
  - One level of replies under each top-level comment, oldest first, with a 3-reply preview and "Show N more replies". Replying to a reply stays in the thread and records "Replying to @name".
  - A heart on any comment or reply (not your own), with a public count and a "♥ Creator" mark when the game owner hearts it. A "Creator" badge on the owner's comments.
  - Permalinks `/games/{id}?comment={commentId}` (thread shown, scrolled and focused), which F007 notifications will link to.
  - Moderation: admins can delete any comment; deleting a thread removes its replies and resolves open reports on everything removed; "View in context" from `/admin`.
- **User value**: real conversations between players and creators, "+1" without noise, and creator answers that stand out.
- **Areas**: backend (migration `0012_f006.sql`: `comments.parent_id`, `comments.reply_to_user_id`, `comment_hearts`; replies/heart/context endpoints; `Limit::Heart`; delete cascade + report resolution), frontend (threaded `Comments` split into `CommentItem`/`CommentForm`/`HeartButton`, permalinks, admin link, accessibility), desktop (verification only). No engine changes.
- **Depends on**: nothing unshipped. Writes no F002 activity events; F007 consumes its hook points.

### F007: In-app notifications (M, shipped → [spec](features/F007-in-app-notifications.md))
- **Pitch**:
  - A header bell with an unread count and a panel of the latest 10, plus a `/notifications` page (All/Unread, paging, "Mark all as read").
  - Five kinds: comments on your games, replies in your threads or to you, hearts on your comments, new followers, and first publishes by creators you follow. Items link to F006 permalinks, the followers list or the game.
  - Coalescing while unread ("Mia and 3 others hearted your comment"); hearts and follows notify once per actor, and an un-heart or unfollow retracts.
  - Per-kind switches in Settings. Visibility is checked at read time, deletes cascade, and old rows are pruned (30 days after read, 90 days max, 200 per user).
  - The client polls a small count endpoint (`pollAfterSecs`, default 60 s; paused in hidden tabs). No websockets.
  - Desktop: opt-in native OS notifications (no comment text) via `tauri-plugin-notification`, used from Rust only and behind a default-on Cargo feature. View → Notifications.
- **User value**: creators notice feedback quickly, F006 conversations get answered, and players hear about new games from creators they follow.
- **Areas**: backend (migration `0013_f007.sql`: `notifications`, `notification_events`, `notification_settings`; `notifications.rs`; five endpoints; `Limit::Notifications`; hooks in comments/hearts/follows/publish; pruning), frontend (provider + poll loop, bell, page, settings, `OsNotifications` host contract), desktop (`notify.rs` commands, feature-gated plugin, settings toggle, menu item). No engine changes.
- **Depends on**: F006 (hook points, permalinks). Fan-out on write per recipient, unlike the F002 feed (see ARCHITECTURE § F007).

### F015: Screenshots in the feed and on profiles (S, specced → [spec](features/F015-screenshots-in-feed-and-profiles.md))
- **Pitch**:
  - A F002 feed kind `screenshotPosted`: "Mia posted 3 screenshots of Kiln Clash", with up to 4 thumbnails that open the F005 lightbox. One item per author, game and UTC day, for the author's followers, which includes owners posting shots of their own games. A **Screenshots** tab on `/feed`.
  - A **Screenshots** section on every profile (`GET /api/users/{username}/screenshots`): a personal gallery across games, labelled with each game, showing published games only (plus the viewer's own games), with "Load more" and delete from the lightbox.
  - Everything is evaluated at read time (the event stores no screenshot ids), so deletes and unpublishing apply at once. `?section=screenshots` deep-links the game page gallery.
- **User value**: followers see what their friends play and make, creators' promo shots reach their audience, and every player gets a personal gallery. It turns the six examples' 📷 button into social content.
- **Areas**: backend (migration `0022_f015.sql` with one index, writer, one branch (a) predicate, batched assembly, profile endpoint), frontend (`ScreenshotLightbox` extraction, feed item and tab, `ProfileScreenshots`, game page section link), desktop (verification only). No engine changes.
- **Depends on**: F002, F005, F021 (all shipped). No `activity_events` rebuild. Follow-up: F024.

### F008: Collections (M, shipped → [spec](features/F008-collections.md))
- **Pitch**:
  - Users create ordered lists of up to 100 games ("Best platformers") with a title, a description and a one-line note per game. A collection is public or private ("play later").
  - **+ Collection** on every game page opens a checklist of your collections (add/remove in place, or create one with the game already in it).
  - Public collections appear on the owner's profile, in a "Featured in collections" shelf on the pages of their games, and at a shareable `/c/{id}` with **Copy link**.
  - Owners reorder with Move up / Move down (keyboard and screen-reader friendly, no drag-and-drop required), edit notes and remove games. Games that become unavailable are hidden from visitors and shown to the owner as removable placeholders.
  - Collections can be reported; admins can view and delete them. `reports` is rebuilt once (no `target_type` CHECK, nullable `target_game_id`), so later report targets need no rebuild.
- **User value**: curation becomes a discovery channel driven by people rather than algorithms, players get shareable lists and a private play-later list, and creators can group a series.
- **Areas**: backend (migration `0016_f008.sql`: `collections`, `collection_games`, `reports` rebuild; `routes/collections.rs` with ten endpoints; `Limit::Collections`; report changes; seed collection), frontend (collection page, add dialog, cards, profile section, game shelf, admin rows, `/collections` route), desktop (View → Collections menu item, share-link verification). No engine changes.
- **Depends on**: nothing unshipped. Follow-up: F021 (feed and notifications for collections, after F018).

### F009: Controls overlay and key remapping (M, shipped → [spec](features/F009-controls-and-remapping.md))
- **Pitch**:
  - game.json declares named `actions` with default keys (up to 3) and gamepad buttons (up to 2), validated on upload (422) and exposed as `Game.actions`. The free-text `controls` string that bundles already carry becomes `Game.controlsHint` (lenient, never 422).
  - The engine adds `input.actionDown/actionPressed/actionReleased(id)`, `input.actionLabel(id)` for prompts, and `input.axis()` that follows `left/right/up/down` actions.
  - A ⌨ controls panel in the player and Studio preview: remap keys with live apply (`webgame:controls`), conflict warnings, reset, saved per game on the device. A game-page "Controls" section and a one-time first-play hint.
  - The Studio game.json form gets a Controls fieldset. Desktop gets View → Controls (`CmdOrCtrl+Shift+K`).
- **User value**: accessibility and non-QWERTY layouts, and controls players can discover. Existing games get a visible controls hint with no re-upload (startup backfill).
- **Areas**: engine (`actions.ts`, `input.ts`, message, examples), backend (migration `0010_f009.sql`: `games.actions_json`, `games.controls_hint`; strict/lenient parsing; player page injection; startup backfill; no new crates), frontend (`controls.ts`, `ControlsPanel`, `KeyCaptureButton`, `ControlsSummary`, Studio form, templates), desktop (menu item).
- **Depends on**: nothing unshipped. Follow-ups: gamepad remapping and account sync of bindings (see F016).

### F010: Desktop offline library (M, proposed)
- **Pitch**: "Download for offline" on desktop caches a game's bundle and the engine locally, and plays it from a local player when the server is unreachable.
- **User value**: play on planes and trains, which is the desktop app's clearest advantage.
- **Areas**: desktop (Rust cache plus a local protocol), frontend (download toggle, offline library view), backend (none beyond the existing files).

### F011: Studio sprite tools (M, proposed)
- **Pitch**: an in-Studio pixel editor for small PNGs and a sprite-sheet slicer that previews frames and shows the `loadSpriteSheet` call to use.
- **User value**: creators can make art without leaving the browser.
- **Areas**: frontend only.

### F012: Engine bitmap fonts, 9-slice and UI widgets (M, shipped → [spec](features/F012-bitmap-fonts-and-ui-widgets.md))
- **Pitch**:
  - Bitmap fonts through the existing `drawText`/`measureText`: `assets.loadBitmapFont` (AngelCode BMFont text `.fnt` or JSON, with kerning), `assets.gridFont` for fixed-cell glyph sheets, and a built-in crisp 5×7 `pixel` font that needs no asset.
  - `NineSlice` + `renderer.drawNineSlice` (with a pixel-art `scale` and a shrink rule) and `assets.loadNineSlice`.
  - `engine.ui`: an immediate-mode `panel`/`label`/`button` helper with a theme. It takes mouse, touch, keyboard and gamepad input; menu navigation follows the game's F009 `up`/`down`/`confirm` actions, so remaps apply. Widgets are drawn before the F005 capture point.
  - `.fnt` becomes an allowed bundle extension (text). There is a "Menu & HUD" Studio template, a docs section, and Pixel Peaks gets a crisp HUD, a kerned title font, a 9-slice message box and a navigable title menu.
- **User value**: pixel-art games get sharp text at native resolution. Creators can use fonts from any BMFont exporter and get menus that work with mouse, touch, keys and controllers without hand-rolled code.
- **Areas**: engine (`bmfont.ts`, `pixelfont.ts`, `nineslice.ts`, `ui.ts`, renderer/assets/engine hooks, Pixel Peaks), frontend (`.fnt` as a Studio text type, template, docs page), backend (allowlist + MIME + tests only), desktop (folder opener allowlist). No migration, no endpoints, no new dependencies.
- **Depends on**: nothing unshipped (reuses F009 actions and the F005 capture point).

### F014: Desktop Studio: save to local folder and watch for changes (S, proposed; after F013)
- **Pitch**: for a project opened from a local folder (F013 `localFolder`), "Save to folder" writes Studio edits back to disk through a Rust command limited to the registered folder, and an optional file watcher auto-reloads on external changes.
- **User value**: desktop creators can mix Studio edits and their own editor without exporting zips or losing edits on reload.
- **Areas**: desktop (write command scoped to the F013 folder registry, `notify` watcher), frontend (Save button, auto-reload toggle). No backend changes.

### F016: Gamepad remapping, synced control bindings and device-aware prompts (M, shipped → [spec](features/F016-gamepad-remapping-and-sync.md))
- **Pitch**:
  - The F009 controls panel's gamepad column becomes two capture slots per action. The parent page captures the button through its own Gamepad API (standard-mapping controllers, with a baseline so held or "wake-up" presses never count). Changes apply to the running game at once through an optional `gamepad` field on `webgame:controls`.
  - Signed-in players' bindings (keys and gamepad) sync per user per game through `GET`/`PUT /api/games/{id}/controls`, so they follow the account between the web and desktop apps. The account copy wins on load unless this device has an unsynced change. Device-only bindings from F009 are uploaded on first sign-in. Anonymous players keep device storage.
  - Engine: `input.lastDevice` and `actionLabel(id, "auto")`, so prompts say "Space" or "A" depending on what the player last touched, plus a resume latch so a button held when the game resumes never fires `pressed`.
  - Migration `0020_f016.sql` (`control_bindings`), `Limit::Controls` (60 `PUT`/min), a 16 KiB body limit, strict validation and read-time filtering against the current actions.
- **User value**: controller players get the same accessibility as keyboard players, bindings survive a device or app switch, and games can show the right button in prompts. This is the first engine capability since F012.
- **Areas**: engine (gamepad overrides, `lastDevice`, label option, latch, examples), backend (table, two endpoints, limit), frontend (`gamepadCapture.ts`, `GamepadCaptureButton`, panel, sync hook, store extension), desktop (verification only).
- **Depends on**: F009 (shipped). The opt-in switch from the original pitch is dropped: sync is automatic for signed-in players, like cloud saves, and the panel footer says where bindings are saved.

### F017: Creator comment tools: pin, lock and "top" sort (S, shipped → [spec](features/F017-creator-comment-tools.md))
- **Pitch**:
  - The game owner (and admins) can pin one top-level comment, shown above all threads in every sort with a "Pinned" badge; pinning another replaces it after a confirmation.
  - Owners and admins can lock a thread: only they can still reply, hearts/delete/report keep working, and the thread says "Replies are turned off".
  - Anyone can sort threads by "Top" (hearts on the top-level comment, then newest); the choice is remembered per device.
  - No notifications for pins or locks in this round (the `pinned` kind moves to F018, which owns the notification table rebuild).
- **User value**: creators can keep an FAQ or known-issues answer visible and stop a thread that has gone off the rails, and the most useful tips surface first.
- **Areas**: backend (migration `0015_f017.sql`: `comments.pinned_at`, `comments.locked_at`, one partial unique index; `sort=top`; four pin/lock endpoints; `Limit::ThreadTools`; lock check in the guarded reply insert), frontend (sort toggle, pinned slot, Pin/Lock buttons, locked-thread UI), desktop (verification only). No engine changes.
- **Depends on**: F006 and F007 (shipped).

### F018: Notification controls: mutes, shared polling and "pinned" notifications (M, shipped → [spec](features/F018-notification-controls.md))
- **Pitch**:
  - "Mute notifications" for a game (game page) and "Mute thread" (top-level comments and `/notifications` items), stored server-side in `notification_mutes` and checked in the F007 write path next to the per-kind settings. Muting marks existing unread notifications in scope as read. A "Muted" list with Unmute in Settings (cap 500).
  - One polling tab per browser: tabs of the same user and server elect a leader with the Web Locks API, and only the leader polls `unread-count`, sharing results over `BroadcastChannel`. Without those APIs every tab polls as before.
  - A `pinned` kind ("Mia pinned your comment on Space Dodge") from F017's hook: once per comment, withdrawn if unpinned while unread, with a `pins` setting.
  - Migration `0017_f018.sql` rebuilds `notifications` and `notification_events` once, FK- and trigger-safe, without the `kind` CHECK, so later kinds (F021) need no rebuild.
- **User value**: creators of popular games keep the bell useful, players leave long threads behind, heavy users with many tabs make far fewer requests, and players learn when a creator featured their comment.
- **Areas**: backend (migration, five mute endpoints, write-path mute check and group dedupe, `pinned` kind, `threadId`, `Game.notificationsMuted`, `Comment.threadMuted`), frontend (tab coordinator, mute buttons, item mute action, Muted list, `pins` switch, `pinned` text), desktop (verification only). No engine changes.
- **Depends on**: F007 and F017 (shipped). Unblocks F021.

### F019: Engine UI widgets 2: slider, toggle, text field and list (M, shipped → [spec](features/F019-ui-widgets-2.md))
- **Pitch**:
  - `ui.slider` (drag, or left/right with hold repeat), `ui.toggle` (a labelled switch), a single-line `ui.textField` (caret, paste, `maxLength`, an `allow` filter) and `ui.list` (rows with a cursor, wheel and drag scrolling, and keyboard/gamepad movement that leaves the list at its ends). All follow the F012 theme, phase and navigation rules; the focused widget decides what each navigation intent does.
  - Value in, value out (`v = ui.slider(id, v, …)`), plus `ui.changed(id)` / `ui.committed(id)` so games save once per drag or per name entry.
  - `input.textEvents` (typed and pasted text, editing keys with repeat) and `input.keyboardCaptured`: while a field is editing, actions and `axis()` ignore the keyboard, so typing a name never moves the player or opens the pause menu.
  - The Menu & HUD template gets a SETTINGS screen with all four widgets; Ember Garden's settings use toggles and a new volume slider.
- **User value**: settings and name-entry screens without custom code, completing the F012 menu toolkit; controller and keyboard players get the same settings screens as mouse players.
- **Areas**: engine (`ui.ts`, new pure `uitext.ts`, `input.ts` capture, Ember Garden settings), frontend (template, docs subsection), backend and desktop (verification only). No migration, endpoints or messages.
- **Depends on**: F012, F009, F016 (all shipped). Resized from S to M: text input and keyboard capture are most of the work. Follow-up: F023 (on-screen keyboard).

### F021: Collection activity: feed items and notifications (M, shipped → [spec](features/F021-collection-activity.md))
- **Pitch**:
  - A F002 feed kind `collectionUpdated`: "Mia added 3 games to *Cozy games*", with up to 4 of the added games and the curator's notes. One item per collection per UTC day, for followers of the curator, plus a **Collections** tab on `/feed`.
  - A F007 notification kind `addedToCollection` for creators: "Mia added Space Dodge to *Cozy games*", linking to `/c/{id}`. Once per collection and game (F018 group dedupe), withdrawn if the game is removed while unread, with a `collections` setting; F018 game mutes apply.
  - Private collections never produce activity: adds to them write nothing, and making a collection private hides its items and notifications at read time. Events store the announced game ids, so games added while private never surface later.
  - Migration `0019_f021.sql` rebuilds `activity_events` once without the `kind` CHECK (nullable `game_id`, new `collection_id`/`game_ids`), so F015 and later feed kinds need no rebuild; `notifications` gains `collection_id`.
- **User value**: curators reach their followers, creators learn when players champion their games, and the feed gets people-driven discovery.
- **Areas**: backend (migration, `record_collection_added`, a third feed branch, notification kind, read-time collection filter, hooks in the add/remove endpoints), frontend (feed item and tab, notification text, OS text without the title, setting), desktop (verification only). No engine changes.
- **Depends on**: F002, F007, F008, F018 (all shipped).

### F020: Game comment settings: comments on / replies only / off, slow mode (S, shipped → [spec](features/F020-game-comment-settings.md))
- **Pitch**:
  - Per-game "Who can comment": everyone (default), replies only (no new threads; F017 locks still apply) or off. Existing comments always stay visible; hearts, delete, report, pin and lock keep working.
  - Optional slow mode: one comment or reply per user per game every 30 s, 1 min, 5 min, 15 min or 1 h. A rejected post never uses the slot, deleting a comment never resets it, and concurrent posts can't both get through.
  - The game owner and admins are exempt from both, like the F017 lock bypass, and can change the settings on the edit page ("Comments" panel) or from a ⚙ Settings dialog in the game page's Comments header.
  - Players see "Comments off", "Replies only" or "Slow mode · 5 min" badges, a closed note instead of the form, and a slow-mode countdown on their forms.
  - `PUT /api/games/{id}/comment-settings` (shares `Limit::ThreadTools`), `Game.commentSettings`, `CommentListPage.settings` (`canManage`, `waitSecs`), and a new 429 error code `slow_mode` with `Retry-After`.
- **User value**: creators of small or controversial games can pause discussion without deleting it, jam entries can close comments after the jam, admins can stop a pile-on, and busy games get calmer threads.
- **Areas**: backend (migration `0021_f020.sql`: two `games` columns without CHECK and `comment_post_times` with a backfill; mode and slow-mode steps in `create_comment` inside one transaction; the settings endpoint; `AppError::SlowMode`), frontend (`CommentSettingsForm`, `CommentSettingsDialog`, edit page panel, comment form states and countdown), desktop (verification only). No engine changes.
- **Depends on**: F006 and F017 (shipped).

### F022: Announce a collection when it goes public (S, proposed; after F021)
- **Pitch**: when a collection changes from private to public with at least one published game, followers get one `collectionShared` feed item ("Mia shared *Cozy games*: 8 games") instead of nothing, and creators of the games in it get the F021 `addedToCollection` notification (deduped per collection and game, so re-toggling never re-notifies).
- **User value**: the common "curate privately, then publish" flow reaches followers, which F021 deliberately skips.
- **Areas**: backend (one more activity kind, no rebuild; hook in `PATCH /api/collections/{id}`; a once-per-collection guard), frontend (feed item). No engine or desktop changes.

### F023: Engine on-screen keyboard for `ui.textField` (S, proposed; after F019)
- **Pitch**: an engine-drawn, gamepad- and touch-navigable keyboard panel (`ui.keyboard` or an automatic one when a field starts editing with `lastDevice` `"touch"`/`"gamepad"`), feeding the F019 `textEvents` path, with A–Z, 0–9, space, backspace and done keys, respecting the field's `allow` filter.
- **User value**: controller and phone players can enter names too, which F019 leaves to each game.
- **Areas**: engine (+ the Menu & HUD template). No backend or desktop changes.

### F024: "Screenshot of your game" notifications for creators (S, proposed; after F015)
- **Pitch**: a F007 kind `screenshotPosted` for the game owner ("Mia posted 2 screenshots of Space Dodge"), coalesced per game while unread (F018 group), withdrawn when all of them are deleted while unread, with a `screenshots` setting (default on). F018 game mutes apply, and the author never notifies themself.
- **User value**: creators notice community shots quickly, can thank players, set a good one as the thumbnail, or remove an inappropriate one.
- **Areas**: backend (notification kind, setting column in a small migration, hook in `create_screenshot`/`remove_screenshot`), frontend (summary text, setting switch, icon). No engine changes; desktop verification of OS notification text.

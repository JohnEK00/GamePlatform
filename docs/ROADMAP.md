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
| F006 | Comment replies and reactions | M | specced |
| F007 | In-app notifications | M | proposed |
| F012 | Engine bitmap fonts and 9-slice UI widgets | M | proposed |
| F015 | Screenshots in the feed and on profiles | S | proposed |
| F008 | Collections (curated game lists) | M | proposed |
| F014 | Desktop Studio: save to local folder and watch for changes | S | proposed |
| F011 | Studio sprite tools (sheet slicer and pixel editor) | M | proposed |
| F010 | Desktop offline library | M | proposed |
| F016 | Gamepad remapping and synced control bindings | M | proposed |
| F017 | Creator comment tools: pin, lock and "top" sort | S | proposed |

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

### F006: Comment replies and reactions (M, specced → [spec](features/F006-comment-replies-and-reactions.md))
- **Pitch**:
  - One level of replies under each top-level comment, oldest first, with a 3-reply preview and "Show N more replies". Replying to a reply stays in the thread and records "Replying to @name".
  - A heart on any comment or reply (not your own), with a public count and a "♥ Creator" mark when the game owner hearts it. A "Creator" badge on the owner's comments.
  - Permalinks `/games/{id}?comment={commentId}` (thread shown, scrolled and focused), which F007 notifications will link to.
  - Moderation: admins can delete any comment; deleting a thread removes its replies and resolves open reports on everything removed; "View in context" from `/admin`.
- **User value**: real conversations between players and creators, "+1" without noise, and creator answers that stand out.
- **Areas**: backend (migration `0012_f006.sql`: `comments.parent_id`, `comments.reply_to_user_id`, `comment_hearts`; replies/heart/context endpoints; `Limit::Heart`; delete cascade + report resolution), frontend (threaded `Comments` split into `CommentItem`/`CommentForm`/`HeartButton`, permalinks, admin link, accessibility), desktop (verification only). No engine changes.
- **Depends on**: nothing unshipped. Writes no F002 activity events; F007 consumes its hook points.

### F007: In-app notifications (M, proposed; after F006; can reuse F002's `activity_events` and F006's hook points and `?comment=` permalinks)
- **Pitch**: a bell menu listing new comments on your games, replies, new followers, and games from creators you follow. Desktop shows native OS notifications.
- **User value**: creators notice feedback quickly, and players notice new content.
- **Areas**: backend (notifications table, unread count), frontend (bell, list), desktop (native notifications via a Rust plugin).

### F015: Screenshots in the feed and on profiles (S, proposed; after F005)
- **Pitch**: a new F002 feed kind `screenshotPosted` (coalesced per author, game and UTC day), and a "Screenshots" tab on profiles (`GET /api/users/{username}/screenshots`), with published games only.
- **User value**: followers see what their friends play, and players get a personal gallery.
- **Areas**: backend (activity kind and CHECK rebuild, profile endpoint), frontend (feed item, profile tab). No engine changes.

### F008: Collections (M, proposed)
- **Pitch**: users create public, ordered lists of games ("Best platformers"), shown on profiles and shareable at `/c/{id}`.
- **User value**: curation as a discovery channel, and a social signal.
- **Areas**: backend, frontend.

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

### F012: Engine bitmap fonts and 9-slice UI widgets (M, proposed)
- **Pitch**: `assets.loadBitmapFont` (BMFont JSON), `renderer.drawNineSlice`, and a tiny immediate-mode `ui.button/label/panel` helper.
- **User value**: good-looking menus and HUDs without hand-rolled code.
- **Areas**: engine, examples, frontend (Studio template update).

### F014: Desktop Studio: save to local folder and watch for changes (S, proposed; after F013)
- **Pitch**: for a project opened from a local folder (F013 `localFolder`), "Save to folder" writes Studio edits back to disk through a Rust command limited to the registered folder, and an optional file watcher auto-reloads on external changes.
- **User value**: desktop creators can mix Studio edits and their own editor without exporting zips or losing edits on reload.
- **Areas**: desktop (write command scoped to the F013 folder registry, `notify` watcher), frontend (Save button, auto-reload toggle). No backend changes.

### F016: Gamepad remapping and synced control bindings (M, proposed; after F009)
- **Pitch**: remap gamepad buttons in the F009 controls panel (capture via the parent's Gamepad API), and an opt-in "Sync my controls" that stores overrides per user per game on the server, falling back to the device copy.
- **User value**: controller players get the same accessibility as keyboard players, and bindings follow the account to the desktop app.
- **Areas**: engine (accept `gamepad` overrides), backend (small per-user bindings table and endpoints), frontend (gamepad capture, sync toggle).

### F017: Creator comment tools: pin, lock and "top" sort (S, proposed; after F006)
- **Pitch**: the game owner can pin one thread to the top of the comments and lock a thread against new replies, and players can sort threads by "Top" (hearts, then newest) instead of "Newest".
- **User value**: creators can keep an FAQ or known-issues answer visible and stop a thread that has gone off the rails, and the most useful tips surface first.
- **Areas**: backend (`games.pinned_comment_id`, `comments.locked`, `sort=top` on the list), frontend (owner menu on threads, sort toggle). No engine changes.

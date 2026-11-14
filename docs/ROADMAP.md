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
| F001 | Leaderboards 2.0: daily/weekly boards, time/ascending scores, in-game leaderboard API | M | in progress |
| F002 | Follow creators and an activity feed | M | specced |
| F003 | Trending and "More like this" discovery | S | proposed |
| F004 | Version changelogs and an "Updated" badge | S | proposed |
| F005 | Screenshot capture and share | S | proposed |
| F006 | Comment replies and reactions | M | proposed |
| F007 | In-app notifications | M | proposed |
| F008 | Collections (curated game lists) | M | proposed |
| F009 | Controls overlay and key remapping | M | proposed |
| F010 | Desktop offline library | M | proposed |
| F011 | Studio sprite tools (sheet slicer and pixel editor) | M | proposed |
| F012 | Engine bitmap fonts and 9-slice UI widgets | M | proposed |

### F001: Leaderboards 2.0 (M, in progress → [spec](features/F001-leaderboards-2.md))
- **Pitch**: daily and weekly boards next to all-time ones, ascending/time-based scoring for speedruns, and an API so games can show leaderboards and "new personal best!" in-game.
- **User value**: players get a fresh, winnable board every day and week, and see their rank without leaving the game. Creators can build time trials and in-game high-score screens, which drives replays.
- **Areas**: engine (+ examples), backend, frontend (player, Leaderboard panel, Studio), desktop (verification only).

### F002: Follow creators and an activity feed (M, specced → [spec](features/F002-follow-and-feed.md))
- **Pitch**: follow any user, then see their new games, bundle updates, personal bests (F001) and achievement unlocks in a `/feed` page, plus updates to games you favorited. Follower counts and lists on profiles, and creator suggestions for an empty feed.
- **User value**: a reason to come back, and creators build an audience.
- **Areas**: backend (follows, activity events, feed and suggestions), frontend (follow button, feed page, profile counts and lists), desktop (View → Feed). No engine changes.
- **Depends on**: F001 backend (`personalBest`) for the personal-best events only.

### F003: Trending and "More like this" (S, proposed)
- **Pitch**: a `sort=trending` option (plays in the last 7 days, using `play_events`) and a related-games shelf on each game page, ranked by tag overlap.
- **User value**: it surfaces active games beyond the all-time "popular" list, and keeps players browsing after a session.
- **Areas**: backend, frontend.

### F004: Version changelogs and an "Updated" badge (S, proposed)
- **Pitch**: bundle replacements take an optional "what's new" note. The game page shows a version history, and cards show an "Updated" badge for 7 days.
- **User value**: players see why to replay, and creators can talk to their players.
- **Areas**: backend (game_versions table, endpoint), frontend (upload/edit form, history panel, badge).

### F005: Screenshot capture and share (S, proposed)
- **Pitch**: a camera button in the player, plus `engine.platform.captureScreenshot()`, grabs the canvas as PNG. Players can download it (desktop: native save) and owners can set it as the thumbnail.
- **User value**: easy thumbnails for creators, and shareable moments for players.
- **Areas**: engine (canvas readback via postMessage), frontend (player button, set-thumbnail), desktop (native save path).

### F006: Comment replies and reactions (M, proposed)
- **Pitch**: one level of threaded replies, a heart reaction on comments, and a "creator" tag on the owner's comments.
- **User value**: real conversations between players and creators.
- **Areas**: backend, frontend.

### F007: In-app notifications (M, proposed; best after F002/F006; can reuse F002's `activity_events`)
- **Pitch**: a bell menu listing new comments on your games, replies, new followers, and games from creators you follow. Desktop shows native OS notifications.
- **User value**: creators notice feedback quickly, and players notice new content.
- **Areas**: backend (notifications table, unread count), frontend (bell, list), desktop (native notifications via a Rust plugin).

### F008: Collections (M, proposed)
- **Pitch**: users create public, ordered lists of games ("Best platformers"), shown on profiles and shareable at `/c/{id}`.
- **User value**: curation as a discovery channel, and a social signal.
- **Areas**: backend, frontend.

### F009: Controls overlay and key remapping (M, proposed)
- **Pitch**: game.json declares named actions with default keys. The engine exposes `input.action(name)`, and the player has a controls panel where users remap keys, saved per game.
- **User value**: accessibility, non-QWERTY layouts, and controls players can discover.
- **Areas**: engine, backend (game.json validation), frontend (controls panel), examples.

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

# F020: Game comment settings: comments on / replies only / off, and slow mode

Status: **shipped**. Size: **S** (backend small; frontend small to medium; desktop verification only; one round). Areas: backend, frontend, desktop (verification only). No engine changes.
Contracts: `docs/API.md` § F020 additions (types, one new endpoint, changed `POST …/comments` validation order, the new `slow_mode` error code, rate limit), `docs/ARCHITECTURE.md` § F020 additions (migration `0021_f020.sql`, the slow-mode claim transaction, read shapes, ownership). `docs/GAME_FORMAT.md`: no changes.
Depends on: F006 (threads, replies), F017 (locks, `canModerate`, `Limit::ThreadTools`), all shipped. The migration is **`0021_f020.sql`** and runs after `0020_f016.sql`. **No new Rust or JS dependencies.**

## 0. Decisions on ambiguities (read first)
These are settled here. API § F020 is normative for the server; § 2 below is normative for the UI texts. Tests assert every quoted text verbatim.
1. **Three modes.** `"on"` (default, today's behaviour), `"repliesOnly"` (no new top-level comments; replies to existing threads still allowed, F017 locks still apply), `"off"` (no new top-level comments and no replies). Existing comments always stay visible, and hearts, delete and report keep working in every mode.
2. **Who is exempt.** The game's current owner and admins (the F017 `canModerate` people) are exempt from **both** the mode and slow mode, exactly like the F017 lock bypass. The API exposes this as `CommentSettingsView.canManage`.
3. **Slow mode** is one post (top-level comment **or** reply, one shared counter) per user per game per interval. Allowed intervals are exactly `0` (off), `30`, `60`, `300`, `900`, `3600` seconds. Nothing else is accepted.
4. **What counts as "your last post".** The server records the time of **every** successful post per (game, user) in `comment_post_times`, whether slow mode is on or not, and whether the poster is exempt or not. So:
   - turning slow mode on applies at once to people who just posted;
   - deleting your own comment does **not** reset your wait (no post-delete-repost bypass);
   - a rejected post (validation, lock, cap, slow mode) never consumes the slot (one transaction).
   The migration backfills the table from existing comments.
5. **Slow-mode rejection is a 429 with a new error code `slow_mode`** (not `rate_limited` and not 422), with `Retry-After` = whole seconds left (at least 1, at most the interval). Message: `Slow mode is on: you can post again in {n} seconds` (`{n}` = the `Retry-After` value, always the plural "seconds", also for 1). Clients that don't know the code still see a 429 with `Retry-After`.
6. **Mode rejection texts** (422 `validation`):
   - mode `off`, any post: `Comments are turned off for this game`
   - mode `repliesOnly`, top-level post: `New comments are turned off for this game`
7. **Validation order** on `POST /api/games/{id}/comments` (F006 + F017 + F020): 401 auth → 404 game → 429 `Limit::Comment` → 422 `parentId` type → 422 body length → **422 mode (new, 5b)** → 404 parent → 422 lock (F017 6b) → **429 `slow_mode` (new, 6c)** → 422 reply cap. The mode is checked before the parent lookup, so `off` with an unknown `parentId` is a 422 mode error.
8. **The setting endpoint** is `PUT /api/games/{id}/comment-settings` with **both** fields required (`{ mode, slowModeSecs }`), owner or admin, sharing `Limit::ThreadTools` with pin/lock. It does not change `updatedAt` or `lastUpdatedAt`, and writes no activity or notifications.
9. **Setting texts** (422 `validation`), checked in this order: `Body must be a JSON object`, `mode must be one of: on, repliesOnly, off`, `slowModeSecs must be one of: 0, 30, 60, 300, 900, 3600`. A missing field, a wrong type (`"60"`, `60.5`, `true`) and an unknown value all give the same message. Unknown extra fields are ignored.
10. **Races.** A post racing a mode change is not guarded (it may land just after the owner saves `off`); slow mode **is** guarded (two concurrent posts by the same user: exactly one succeeds). Documented, accepted.
11. **No notifications, no feed items** for settings changes. A creator turning comments off does not notify anyone.
12. **No new `games` CHECK constraints.** `comment_mode` and `comment_slow_mode_secs` are validated in Rust, so a later mode (for example "followers only") needs no `games` rebuild. A stored value the server doesn't know reads as `"on"` / `0` and logs a warning.

## 1. Goal and user stories
F017 gave creators per-thread tools (pin, lock). They still can't pause the discussion on a whole game: a small game that attracts a pile-on, a game being reworked, or a jam entry after the jam all need "comments closed" without deleting what's there. Busy games also need a way to calm fast back-and-forth arguments without locking every thread.

F020 adds two per-game settings, stored on the game:
- **Who can comment**: everyone (default), replies only (no new threads), or off.
- **Slow mode**: each player may post once per 30 s, 1 min, 5 min, 15 min or 1 h on that game.

User stories:
1. As a creator whose jam game is over, I open **Edit game → Comments**, choose "Off: no new comments or replies" and save. Players still read every comment, but the form is replaced by "Comments are turned off for this game." and Reply buttons are gone.
2. As a creator, I choose "Replies only" so the existing FAQ and bug threads keep going but nobody starts new threads while I rework the game.
3. As a creator of a busy game, I set slow mode to 5 minutes. A player who just posted sees "Slow mode: you can post once every 5 minutes. You can post again in 4:58." and their Post button does nothing until the countdown ends.
4. As a creator, I'm exempt: I can still post an announcement while comments are off, and my form tells me "Comments are turned off for players. Only you and moderators can post."
5. As an admin reviewing a pile-on, I open the game page, click **⚙ Settings** next to the comment sort, turn comments off, and review the reports in peace.
6. As a player, I see a "Comments off", "Replies only" or "Slow mode · 5 min" badge in the Comments header, so the state is clear before I type.
7. As a keyboard or screen-reader user, the settings are a labelled radio group and a labelled select; the countdown is readable text, and I hear "You can post again." once when it ends.

Non-goals (later items): followers-only comments, per-user bans/timeouts, word filters, scheduled re-opening, notifying players about setting changes, slow mode for hearts, a different interval for replies, settings in the Studio.

## 2. UX notes

### 2.1 `CommentSettingsForm` (new, shared by the edit page and the game-page dialog)
- Props: `gameId`, `value: CommentSettings`, `onSaved(next: CommentSettings)`, optional `onCancel` (dialog only), `headingId` (for `aria-labelledby` on the dialog).
- **Who can comment**: `<fieldset>` with `<legend>Who can comment</legend>` and three native radios (`name="pf-comment-mode"`), in this order and with these labels:
  - `on`: "Everyone can comment"
  - `repliesOnly`: "Replies only: no new threads"
  - `off`: "Off: no new comments or replies"
  - Hint under the group (`aria-describedby` on the fieldset): "Existing comments stay visible. You and moderators can always post."
- **Slow mode**: `<label for="pf-slow-mode">Slow mode</label>` + native `<select id="pf-slow-mode">` with options (value → label): `0` "Off", `30` "30 seconds", `60` "1 minute", `300` "5 minutes", `900` "15 minutes", `3600` "1 hour". Hint (`aria-describedby`): "Each player can post one comment or reply on this game per interval."
- Buttons: dialog: **Cancel** + **Save**; edit page: one **Save comment settings** button. The save button is `aria-disabled` (not `disabled`, so focus stays on it) while nothing has changed and while saving (spinner inside); activations are ignored. While saving, the other controls are `aria-disabled` too and ignore input. Errors show in a `role="alert"` message (review 8, L3).
- Success: `toast.success("Comment settings saved")`, `onSaved(response)`. Errors: an inline `Alert` with the server message (429 → the existing `rateLimitMessage(retryAfter)`); values are kept.

### 2.2 Edit page (`EditGamePage.tsx`)
- A new panel **between "Details" and "Files"**: `<section className="pf-form pf-panel" id="comment-settings" aria-labelledby="comment-settings-title">` with `<h2 id="comment-settings-title" className="pf-panel__title">Comments</h2>` and the `CommentSettingsForm` for `game.commentSettings`.
- `onSaved` merges the result into the loaded game (`setData({ ...game, commentSettings })`). The Details form's dirty values are untouched.
- When `game.commentSettings` is missing (pre-F020 server), the panel is not rendered.

### 2.3 Game page: Comments header
- Next to the F017 sort toggle (in `.pf-comments__head`), in this order:
  - **State badges** (everyone, when the server is F020-aware), plain text, never colour-only:
    - mode `off` → `<span class="pf-badge pf-badge--comments-off">Comments off</span>`
    - mode `repliesOnly` → `<span class="pf-badge">Replies only</span>`
    - `slowModeSecs > 0` → `<span class="pf-badge">Slow mode · {short}</span>` where `{short}` is `30 s`, `1 min`, `5 min`, `15 min`, `1 h`.
  - **⚙ Settings** button, only when `settings.canManage`: `<button type="button" id="comment-settings-btn" className="pf-btn pf-btn--sm pf-btn--ghost" aria-haspopup="dialog">`, visible text "⚙ Settings" (emoji `aria-hidden`), `aria-label="Comment settings"`. It opens `CommentSettingsDialog`.
- **`CommentSettingsDialog`** (new): `role="dialog"`, `aria-modal="true"`, `aria-labelledby` → its `<h2>` "Comment settings"; uses `useModal` (Escape closes unless saving; focus returns to `#comment-settings-btn`). It renders `CommentSettingsForm`. On save: close, update the Comments component's settings in place (no list reload), announce "Comment settings saved" in the existing polite live region.

### 2.4 Comment forms by state
Definitions: `manager` = `settings.canManage`; `slow` = `settings.slowModeSecs > 0`; `mode` = `settings.mode`.

Top-level form slot (where `CommentForm` or the "Log in" line is today):

| Viewer | `on` | `repliesOnly` | `off` |
|---|---|---|---|
| Anonymous | "Log in to join the conversation." (unchanged) | closed note A + " " + `<Link>Log in</Link>` + " to reply to existing threads." | closed note B |
| Signed in, not manager | form (+ slow-mode notice if `slow`) | closed note A + " You can still reply to existing threads." | closed note B |
| Manager | form | form with notice M-A | form with notice M-B |

- Closed notes render as `<p id="pf-comments-closed" className="pf-comments__closed pf-muted" tabIndex={-1}>`:
  - A: "New comments are turned off for this game."
  - B: "Comments are turned off for this game."
- Manager notices (via the existing `CommentForm` `notice` prop):
  - M-A: "New comments are turned off for players. Only you and moderators can start threads."
  - M-B: "Comments are turned off for players. Only you and moderators can post."
- **Reply buttons**: hidden for non-managers when `mode === "off"` (same mechanism as F017 `repliesLocked`; no per-thread note, the game-level note explains it). An open reply form of a non-manager is closed when the mode becomes `off` (draft kept in memory). In `repliesOnly`, replies work as in F017 (locks still apply).
- Manager reply forms in mode `off` show notice M-B. The F017 locked-thread moderator hint wins when the thread is locked (only one notice).

### 2.5 Slow mode in forms (signed-in non-managers, `slow`)
- Every form (top-level and reply) shows the notice: "Slow mode: you can post once every {interval}." with `{interval}`: `30` → "30 seconds", `60` → "minute", `300` → "5 minutes", `900` → "15 minutes", `3600` → "hour".
- While waiting, the notice continues: " You can post again in {m:ss}." (`m:ss`: whole minutes, unpadded, then two-digit seconds; `3600` s → "60:00"; `5` s → "0:05"). It updates every second; the ticking text is **not** in a live region.
- While waiting, the submit button gets `aria-disabled="true"` (not `disabled`, so focus stays) and submitting (click or Ctrl/Cmd+Enter) does nothing. The draft is never cleared.
- When the wait reaches 0, the notice drops the second sentence and the live region announces "You can post again." once.
- Wait sources:
  - Page 1 of the list: `settings.waitSecs` (server-relative, so client clock skew doesn't matter).
  - After a successful post: `slowModeSecs`.
  - After a `429` with code `slow_mode`: `retryAfter` (fallback `slowModeSecs`). No toast and no form error for this case; the countdown starts and the live region announces "Slow mode is on. You can post again in {m:ss}."
- The countdown is kept as a monotonic deadline (`performance.now()` + ms), one shared timer for the whole Comments component, cleared on unmount.

### 2.6 Server rejections while the page is open
- 422 `Comments are turned off for this game` → local `mode = "off"`; 422 `New comments are turned off for this game` → local `mode = "repliesOnly"`. The draft stays in memory, open non-manager reply forms close per § 2.4, and focus moves to `#pf-comments-closed`. No toast.
- Generic 429 (`rate_limited`) keeps the existing F006 text.

### 2.7 Accessibility (normative)
- Radio group with `<fieldset>`/`<legend>`, native radios and select, hints linked with `aria-describedby`.
- Badges and notes are visible text with the 4.5:1 contrast of the existing badges; emoji are `aria-hidden`.
- Countdown text is in reading order inside the form notice (which already describes the textarea, F017). One announcement at the end, none per tick.
- `aria-disabled` submit keeps focus; the reason is in the described-by notice.
- The dialog traps focus (`useModal`) and returns it to `#comment-settings-btn`.

## 3. Contract changes (summary; normative text lives in docs/)
- `docs/API.md` § F020 additions:
  - Types `CommentMode`, `SlowModeSecs`, `CommentSettings`, `CommentSettingsView`; `Game.commentSettings`; `CommentListPage.settings`.
  - New `PUT /api/games/{id}/comment-settings` → `CommentSettings` (owner/admin, `Limit::ThreadTools`, exact validation texts and order).
  - `POST /api/games/{id}/comments`: steps 5b (mode, 422) and 6c (slow mode, 429 `slow_mode` + `Retry-After`).
  - New error code `slow_mode` (429).
- `docs/ARCHITECTURE.md` § F020 additions: migration `0021_f020.sql` (two `games` columns without CHECK, `comment_post_times` + backfill), the claim transaction in `create_comment`, read shapes, ownership.
- `docs/GAME_FORMAT.md`: no changes.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration `backend/migrations/0021_f020.sql`** exactly as in ARCHITECTURE § F020 (`games.comment_mode`, `games.comment_slow_mode_secs`, `comment_post_times` with its index and backfill).
2. **`src/error.rs`**: new variant `AppError::SlowMode { retry_after: u64 }` → status 429, code `"slow_mode"`, `Display` = `Slow mode is on: you can post again in {retry_after} seconds`. `IntoResponse` sets `Retry-After` for it exactly like `RateLimited` (`max(1)`).
3. **`src/models.rs`**:
   - `GAME_SELECT` adds `g.comment_mode, g.comment_slow_mode_secs`; `GameRow` gains `comment_mode: CommentMode` and `comment_slow_mode_secs: i64` (parsed leniently: unknown mode → `On`, a value not in the allowed set → `0`, each with `tracing::warn!`).
   - `enum CommentMode { On, RepliesOnly, Off }` serialised as `"on" | "repliesOnly" | "off"`, with `as_db()`/`from_db()` (DB strings are the same as the JSON strings).
   - `pub const SLOW_MODE_SECS: [i64; 6] = [0, 30, 60, 300, 900, 3600];`
   - `CommentSettings { mode, slow_mode_secs }`, `CommentSettingsView { #[serde(flatten)] settings, can_manage: bool, wait_secs: i64 }` (camelCase).
   - `Game` gains `comment_settings: CommentSettings` (set in `GameRow::game`). `CommentListPage` gains `settings: CommentSettingsView`.
4. **`src/routes/comments.rs`**:
   - `create_comment`: after the body check, the mode check (5b): poster exempt = `user.id == game.owner_id || is_admin(...)`; load `is_admin` lazily, at most once per request, and reuse it for the F017 `moderator` flag. `Off` and not exempt → 422 `Comments are turned off for this game`; `RepliesOnly`, top-level and not exempt → 422 `New comments are turned off for this game`.
   - Replace the single-statement inserts with **one transaction**: the slow-mode claim upsert first (ARCHITECTURE § F020; `?4` = 1 when the check is skipped: slow mode 0 or poster exempt), then the existing insert (top-level, or the F017 guarded reply insert). Claim affected 0 rows → roll back, read `last_posted_at`, return `AppError::SlowMode { retry_after }` with `retry_after = clamp(ceil(last + secs − now), 1, secs)`. Insert affected 0 rows → roll back and run the existing F017 re-read (404 / lock 422 / cap 422). Commit, then the existing F007 notification call (after the commit, unchanged).
   - The `now` string bound to `comments.created_at` and `comment_post_times.last_posted_at` is the same value.
   - `list_comments`: build `settings` from the already loaded game row: `can_manage` = viewer is owner or admin (`Viewer.admin` is already loaded); `wait_secs` = 0 unless signed in, not managing and `slow_mode_secs > 0`, else `clamp(ceil(last + secs − now), 0, secs)` from `comment_post_times` (missing row → 0). Same value on every page.
   - New handler `put_comment_settings` (it may live in `routes/comments.rs`), in this order: `AuthUser` (401); body as `ApiJson<serde_json::Value>` (malformed → 400 via the extractor); `fetch_visible_game` (404); owner or admin, else 403 `forbidden()`; `limit_user(Limit::ThreadTools)` (429); body not an object → 422 `Body must be a JSON object`; `mode` not one of the three strings → 422 `mode must be one of: on, repliesOnly, off`; `slowModeSecs` not a JSON integer in `SLOW_MODE_SECS` → 422 `slowModeSecs must be one of: 0, 30, 60, 300, 900, 3600` (`60.0` and `"60"` are rejected). Then `UPDATE games SET comment_mode = ?, comment_slow_mode_secs = ? WHERE id = ?` (0 rows → 404 Game; `updated_at` untouched) and return `CommentSettings`.
5. **`src/routes/mod.rs`**: `.route("/games/{id}/comment-settings", put(comments::put_comment_settings))`.
6. **`src/ratelimit.rs`**: no new limit. Update `Limit::ThreadTools`' doc comment to say it is shared with `PUT …/comment-settings`.
7. **Tests** (`tests/f020.rs`, `common::setup()`; slow mode is tested by backdating `comment_post_times.last_posted_at` with SQL, like `tests/f017.rs` backdates `comments.created_at`; `t.clock` for `Limit::ThreadTools`):
   - Defaults: a new game has `commentSettings: { mode: "on", slowModeSecs: 0 }` on `GET /api/games/{id}`; list `settings` = `{ mode: "on", slowModeSecs: 0, canManage: false, waitSecs: 0 }` for anonymous and strangers, `canManage: true` for the owner and an admin.
   - `PUT` permissions: anonymous 401, stranger 403, owner 200, admin 200 on someone else's published game, unknown id 404, stranger on an unpublished game 404. The response and later `GET` game/list reflect the change; `updatedAt` is unchanged.
   - `PUT` validation, each message verbatim: malformed JSON 400; `[]` and `"x"` → `Body must be a JSON object`; mode missing, `"closed"`, `1`, `null` → mode message; slowModeSecs missing, `45`, `"60"`, `60.5`, `-1`, `true` → slowModeSecs message; both wrong → the mode message (order); an extra `"foo": 1` is ignored.
   - Rate limit (`RATE_LIMIT` on): 60 mixed `PUT …/comment-settings` and `PUT …/pin` calls → the 61st (either) is 429 with `Retry-After`; `t.clock.advance(Duration::from_secs(10))` → allowed.
   - Mode `off`: stranger top-level and reply → 422 `Comments are turned off for this game`; owner and admin top-level and reply → 201; hearts, delete and report still work; the list still returns every comment; `off` + unknown `parentId` → 422 mode message (mode before parent lookup); `off` + empty body → the F006 body-length message (body before mode).
   - Mode `repliesOnly`: stranger top-level → 422 `New comments are turned off for this game`; stranger reply → 201; stranger reply to a locked thread → 422 `This thread is locked`; owner top-level → 201.
   - Slow mode 60: stranger posts → 201; a reply right after → 429, code `slow_mode`, `Retry-After` in 1..=60, message `Slow mode is on: you can post again in {Retry-After} seconds`; list `waitSecs` in 1..=60 for that user and 0 for another user, the owner and anonymous; backdate the row by 61 s → 201. Owner and admin post twice in a row → 201 both.
   - Slow-mode edge rules: post → delete own comment → post → 429 (no reset); a post rejected by the reply cap or a lock does not consume the slot (a later top-level post → 201); a user who posted before slow mode was turned on to `3600` gets 429 with `Retry-After` ≤ 3600; setting slow mode back to 0 → the next post 201.
   - Concurrency: slow mode 60, two simultaneous posts by the same user (`tokio::join!`) → exactly one 201 and one 429 `slow_mode`; one comment row.
   - Validation order: `off` + slow mode active + locked thread for a stranger reply → the mode message; `repliesOnly` + locked + slow-mode-waiting reply → lock message; `on` + slow-mode-waiting reply to a thread at 200 replies → 429 `slow_mode`.
   - Migration upgrade: a DB at `0020` with comments → every game reads `on`/`0`; `comment_post_times` has one row per (game, user) with `MAX(created_at)`.
   - Deleting the game removes its `comment_post_times` rows (no FK error).
   - Existing suites (`f006.rs`, `f007.rs`, `f017.rs`, `f018.rs`) stay green unchanged.

**Acceptance:** `cd backend && cargo test` (all suites green) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`): `CommentMode`, `SlowModeSecs = 0 | 30 | 60 | 300 | 900 | 3600`, `CommentSettings`, `CommentSettingsView`; `Game.commentSettings?: CommentSettings` (optional: older servers); `CommentListPage.settings: CommentSettingsView`; add `"slow_mode"` to `ApiErrorCode`.
2. **Normalisation** (`src/api/comments.ts`): `normalizeCommentSettingsView(raw)`: missing → `{ mode: "on", slowModeSecs: 0, canManage: false, waitSecs: 0 }`; an unknown mode → `"on"`; a `slowModeSecs` outside the set → `0`; `waitSecs` non-finite or negative → `0`, else `Math.ceil`. `isF020CommentPage(raw)` = `"settings" in raw` (hides badges and the ⚙ button on older servers). Helpers `slowModeInterval(secs)` (§ 2.5 long text), `slowModeShort(secs)` (§ 2.3 badge text), `formatWait(secs)` (`m:ss`).
3. **Client** (`src/api/client.ts`): `updateCommentSettings(gameId, settings: CommentSettings): Promise<CommentSettings>` (`PUT /api/games/{id}/comment-settings`). The existing `ApiError.retryAfter` already carries `Retry-After`.
4. **`CommentSettingsForm.tsx`** (new, § 2.1) and **`CommentSettingsDialog.tsx`** (new, § 2.3, `useModal`).
5. **`EditGamePage.tsx`**: the "Comments" panel (§ 2.2).
6. **`Comments.tsx`**:
   - `settings` state from page 1 (`normalizeCommentSettingsView`), `f020` flag; badges and the ⚙ button in the header (§ 2.3); the dialog.
   - The top-level slot per the § 2.4 table; `repliesLocked` also true for non-managers in mode `off`; closing open reply forms; manager notices.
   - Slow mode: one deadline + one 1 s interval; `waitSecs` from page 1, after a successful post, and from a `slow_mode` 429; `aria-disabled` submit; the end announcement (§ 2.5).
   - `postErrorMessage` and the post handlers: handle `code === "slow_mode"` **before** the generic 429 branch; map the two mode 422 messages per § 2.6.
7. **`CommentForm.tsx`**: a `blocked?: boolean` prop (submit `aria-disabled`, submit ignored); `notice` may now carry the slow-mode text (still one notice).
8. **Styles** (`styles.css`): `.pf-comments__closed`, `.pf-badge--comments-off`, settings fieldset spacing (existing tokens only).
9. **Tests**:
   - `ApiClient.f020.test.ts`: `updateCommentSettings` method, path, body; `slow_mode` 429 parsed with `retryAfter`.
   - `comments.f020.test.ts` (helpers): normalisation defaults and clamping, `slowModeInterval`, `slowModeShort`, `formatWait` (`0:05`, `4:58`, `60:00`).
   - `CommentSettingsForm.test.tsx`: labels, legend, hint wiring, option values/labels in order, Save `aria-disabled` until changed, success toast + `onSaved`, 422/429 inline errors.
   - `Comments.f020.test.tsx`: every cell of the § 2.4 table (exact texts); badges; ⚙ only for `canManage`; dialog open → save → settings applied in place, focus back to the button, announcement; Reply hidden for non-managers in `off`, visible in `repliesOnly`; slow-mode notice and countdown with fake timers (`aria-disabled`, submit ignored, draft kept, single "You can post again." announcement); `waitSecs` from page 1; a `slow_mode` 429 starts the countdown with no toast; mode 422s switch the UI and focus `#pf-comments-closed`; nothing F020 rendered when the page has no `settings`.
   - `EditGamePage.f020.test.tsx`: the panel renders between Details and Files, saves, merges into the game; hidden when `commentSettings` is missing.
   - `Comments.f006.test.tsx`, `Comments.f017.test.tsx` and `CommentItem.*` stay green (update fixtures only by adding `settings` where a test needs it).

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
No code changes. **Verify** in the Tauri app (HashRouter, WebView2): the ⚙ Settings dialog traps and returns focus; the edit page panel saves; the slow-mode countdown keeps counting while the window is in the background and is right after a minimise/restore (deadline-based, not tick-counted).

**Acceptance:** `npm run build -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo check`.

### engine-dev
None.

### Sequencing
- Backend and frontend run in parallel; frontend mocks the API § F020 shapes.
- Desktop verification runs last.

## 5. Edge cases and security
- **Exemption is server-side.** `canManage` is computed from the game's current owner and the admin role at request time; the client never decides who may post. A forced API post by a player gets the 422/429 regardless of the UI.
- **Visibility.** The settings endpoint uses `fetch_visible_game`: an admin can't change settings of an unpublished game they can't see (consistent with F017).
- **Hiding nothing.** Modes never hide existing content; moderation of existing comments (delete, report, admin resolve, pin, lock) is unaffected.
- **Slow mode abuse.** Slow mode can't be used against the owner or admins. It doesn't apply to hearts, reports or deletes. `Limit::Comment` (30 per 10 min) still applies on top of slow mode, and is consumed by a slow-mode rejection like by any other validation failure (unchanged rule).
- **Slot accounting.** The claim and the insert are one transaction, so a rejected post never consumes the slot and a successful post always does. The first statement of the transaction writes, so SQLite takes the write lock at once and concurrent posts serialise.
- **Clock.** `Retry-After` and `waitSecs` are clamped to `[1, secs]` / `[0, secs]`, so a server clock step backwards never produces a wait longer than the interval. The client counts down relative to `waitSecs`/`Retry-After`, never to absolute timestamps.
- **Privacy.** `comment_post_times` is never exposed except as the viewer's own `waitSecs`. Other users' post times are not derivable (comments already carry `createdAt`, so nothing new leaks).
- **Growth.** One row per (game, user) who ever commented; small, no pruning needed. Rows go with the game or user (FK cascade).
- **Settings races.** A post that passed the mode check just before an owner saves `off` may land; accepted (it is visible and deletable). Slow mode is guarded (§ 0.10).
- **Older clients.** Stale desktop builds ignore `settings`: they show the form, and the server's 422/429 messages explain the refusal (the generic 429 text in old clients reads "You're commenting too fast, try again in Ns.", which is acceptable).

## 6. Test expectations
- **Backend**: `tests/f020.rs` as listed (defaults, endpoint permissions/validation/limit, both modes with exemptions, slow mode with backdating, no-reset-on-delete, no slot on rejection, concurrency, validation order, migration upgrade and backfill, game delete cascade). All existing suites green, clippy clean.
- **UI**: client, helpers, form, every § 2.4 state with exact texts, dialog focus, slow-mode countdown with fake timers, error mapping, legacy-server fallback, edit page panel.
- **Desktop**: green build; manual dialog-focus and background-countdown checks.
- **Manual end to end**: owner + player + admin on one game. Owner sets "Replies only": the player sees note A and can reply but not post. Owner sets "Off": Reply buttons disappear for the player, the owner still posts with notice M-B. Owner sets slow mode 1 minute and "Everyone": the player posts, sees the countdown, waits, posts again; a forced second `curl` post gets 429 `slow_mode`. Admin opens ⚙ Settings on the game page and turns comments off. Repeat the owner flow with keyboard only and a screen reader (NVDA or VoiceOver).

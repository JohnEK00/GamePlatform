# F006: Comment replies and reactions

Status: **specced**. Size: **M** (backend medium, frontend medium; desktop verification only; one round). Areas: backend, frontend, desktop (verification only). No engine changes.
Contracts: `docs/API.md` § F006 additions (types, endpoints, validation, rate limits), `docs/ARCHITECTURE.md` § F006 additions (migration `0012_f006.sql`, queries, delete cascade, F007 hook points), `docs/GAME_FORMAT.md` § F006 additions (no changes; noted for completeness).
Depends on: nothing unshipped. It extends the v1 comments endpoints, the v2 moderation flow (reports on comments, admin resolve) and the v2 `Limit::Comment` bucket. The migration is **`0012_f006.sql`** and runs after `0011_review3.sql`. **No new Rust or JS dependencies.**

## 1. Goal and user stories
Comments today are a flat, newest-first list. A player who asks "how do I get past level 3?" gets no threaded answer, a creator can't reply to a bug report so that the answer sits next to it, and nobody can say "me too" without posting a new comment. Players can't tell the creator's comments from anyone else's.

F006 adds:
- **One level of replies.** Every top-level comment can have replies, shown under it in conversation order (oldest first). Replying to a reply attaches to the same thread and records whom you answered ("Replying to @mia"). There is no deeper nesting.
- **Hearts.** Any signed-in user can heart someone else's comment or reply. The count is public. When the game's owner hearts a comment, it shows a "♥ Creator" mark.
- **Creator tag.** Comments and replies by the game's current owner carry a visible "Creator" badge.
- **Permalinks.** Every comment has a link (`/games/{id}?comment={commentId}`) that opens the game page with that comment's thread shown, scrolled into view and focused. F007 notifications will link here.
- **Moderation, extended.** Replies are reportable like comments. Admins can delete any comment directly (as they can screenshots). Deleting a top-level comment removes its replies, and any delete resolves the open reports on everything it removed.

User stories:
1. As a player, I see "Is there a way to skip the intro?" under Pixel Peaks. I click **Reply** under it, type "Press Esc twice", and press Ctrl+Enter. My reply appears under the question and the asker can see it in context.
2. As a creator, I reply to a bug report with "Fixed in v4, thanks!". My reply shows a **Creator** badge. I also heart the report so the reporter sees "♥ Creator".
3. As a player, I heart a helpful tip instead of posting "+1". The count goes up immediately.
4. As a player, I open a long thread ("Show 14 more replies") and read it oldest first. I reply to the 9th reply; my reply goes to the end of the thread with "Replying to @noah".
5. As a moderator, I see a reported reply in `/admin`, click **View in context**, which opens the game page with the reply highlighted, and delete it. Deleting an abusive top-level comment also removes the replies quoting it, and clears their reports.
6. As a keyboard or screen-reader user, the thread structure is announced as nested lists, the Reply and Heart buttons say what they do and whether they are on, and focus goes somewhere sensible after every action.

Non-goals (later items): editing comments, deeper nesting, more reaction types, pinning or locking threads, sorting by "top", @mention parsing in bodies, notifications (F007), comment activity in the F002 feed.

## 2. UX notes

### 2.1 Thread layout (`Comments` on `GamePage`)
- The heading shows `totalAll` (comments + replies), e.g. "Comments 42".
- Top-level comments stay newest first, 20 per page, with the existing "Load more comments" button (`items.length < total`).
- Each top-level comment shows, after its body, an action row: **Reply** (signed in only), **♥ n** (§ 2.3), **Delete** (`canDelete`), **Report** (signed in, not the author). The timestamp is a link to the permalink (§ 2.5).
- Replies render indented under their thread in a nested list, oldest first. The server sends up to 3 per thread (`replies`). If `replyCount > replies.length`, a button **Show {replyCount − shown} more replies** loads the rest through `GET /api/comments/{id}/replies` (50 per page, deduped by id). When everything is shown the button disappears; there is no "collapse".
- A reply's head shows the author, the Creator badge when `isCreator`, the time link, and "Replying to @{username}" (a profile link) when `replyTo` is non-null. Replies have the same action row; their **Reply** opens the thread's reply form with `parentId` set to that reply (§ 2.2).
- **Creator badge**: a small `pf-badge` with the visible text "Creator" next to the author name. It is not colour-only.

### 2.2 Reply form
- One inline reply form per page at most. Clicking **Reply** under thread T (or any of T's replies) opens the form at the end of T's replies. Opening another closes the previous one; its draft is kept in memory per thread until the page unmounts.
- The form is the same component as the top-level form (`CommentForm`): textarea (`maxLength 2000`, counter), **Post reply** and **Cancel**. When it was opened from a reply, a line above the textarea says "Replying to @{username}" with a ✕ button that clears it (the client then sends `parentId` = T's id, so the reply has `replyTo: null` but stays in thread T).
- Focus moves to the textarea when the form opens. **Escape** in the textarea or **Cancel** closes the form and returns focus to the Reply button that opened it. **Ctrl+Enter** / **Cmd+Enter** submits (also for the top-level form).
- On success: the reply is appended to thread T (all of T's replies are loaded first if some were hidden, so the new one is never out of order), `replyCount` and `totalAll` go up, the form closes, focus moves to the new reply (`tabIndex=-1`), and a polite live region says "Reply posted".
- Errors use the existing inline `Alert`: 422 messages as returned (e.g. "This thread has reached 200 replies"), 429 "You're commenting too fast, try again in {Retry-After}s", 404 "This comment was deleted" (the thread is then removed from the list).

### 2.3 Hearts (`HeartButton`)
- Signed in and not the author: a toggle button `♥ {hearts}` (count hidden when 0, so it reads "♥"). `aria-pressed={myHeart}`, `aria-label="Heart comment by {name}"`; the visible count has `aria-hidden` and the label appends ", {n} hearts" when n > 0.
- The author, or anonymous visitors: a plain `<span>` "♥ {n}" with `aria-label="{n} hearts"`, shown only when n > 0.
- Optimistic: toggling updates `myHeart`/`hearts` at once, then reconciles with the response. While a request is in flight further clicks are ignored (the button is **not** disabled, so focus stays). On error the change is reverted and a toast shows the message (429: "Slow down, try again in {Retry-After}s").
- When `creatorHeart` is true, a small mark "♥ Creator" (`aria-label="Hearted by the creator"`) sits in the action row. For the owner, toggling their own heart updates it from the response.
- The heart "pop" animation is skipped under `prefers-reduced-motion`.

### 2.4 Delete
- **Delete** shows for `canDelete` (author, game owner or admin; computed by the server).
- A reply, or a top-level comment with `replyCount === 0`: deleted at once, as today, with the toast "Comment deleted".
- A top-level comment with replies: `ConfirmDialog` "Delete this comment and its {n} replies?" (body: "Replies by other people are removed too. This cannot be undone."). After delete, focus moves to the next thread's article, or the comments heading if none.
- Counts: a reply delete lowers `replyCount` and `totalAll` by 1; a thread delete lowers `total` by 1 and `totalAll` by 1 + `replyCount`.

### 2.5 Permalinks
- The timestamp of every comment and reply is a `<Link to="/games/{gameId}?comment={id}">` (a query, not a `#hash`, so it works under the desktop HashRouter, like F004's `?section=versions`).
- When `GamePage` has `?comment={id}`, `Comments` calls `GET /api/comments/{id}`:
  - The returned `thread` is shown first, above page 1, with a "Linked comment" label, unless it is already in page 1 (then it stays in place). It is not repeated when later pages load.
  - If the target is a reply that is not among `thread.replies`, the thread's replies are loaded until it is found (at most 2 pages of 100; the thread cap is 200).
  - The target's article gets `pf-comment--highlight` (background fade over 2 s; static outline under reduced motion), is scrolled to the center and focused (`tabIndex=-1`).
  - 404 → an info `Alert` "That comment is no longer available." above the list; the page works normally.
- Admin: comment reports in `/admin` get a **View in context** link to `/games/{targetGameId}?comment={targetId}`. The admin delete confirmation says "The comment is removed permanently, together with any replies to it."

### 2.6 Accessibility (normative for frontend-dev)
- Markup: `<ul class="pf-comments" aria-label="Comments">` → `<li>` → `<article id="comment-{id}" aria-labelledby="comment-{id}-author">`. Replies: inside the thread's `<li>`, after the article, `<ul class="pf-replies" aria-label="Replies to {author name}">` → `<li><article …>`. Screen readers announce the nested list level and item count. Do **not** use `role="tree"` (it requires arrow-key navigation we don't provide).
- Every control is a native `<button>` or link, reachable with Tab in visual order. No keyboard traps; the reply form is not a modal.
- Reply buttons: `aria-expanded` (true while their thread's form is open from that button) and `aria-controls="reply-form-{threadId}"`.
- "Show more replies": after loading, focus moves to the first newly shown reply.
- Live region (one per `Comments`, polite): "Reply posted", "Comment posted", "Comment deleted", "{n} more replies loaded".
- Indentation is not the only cue: replies also carry "Replying to …" when relevant and sit in a labelled list. Contrast of badge text meets 4.5:1 on the panel surface.

## 3. Contract changes (summary; normative text lives in docs/)
- `docs/API.md` § F006 additions:
  - `Comment` gains `parentId`, `replyTo`, `isCreator`, `hearts`, `myHeart`, `creatorHeart`, `canDelete`. New `CommentThread`, `CommentListPage`, `CommentContext`, `HeartResponse`.
  - `GET /api/games/{id}/comments` returns `CommentListPage` (top-level threads with up to 3 replies; `total` = threads, `totalAll` = everything).
  - `POST /api/games/{id}/comments` accepts `parentId`.
  - New: `GET /api/comments/{id}`, `GET /api/comments/{id}/replies`, `PUT`/`DELETE /api/comments/{id}/heart`.
  - `DELETE /api/comments/{id}`: admins allowed; cascade to replies; resolves open reports on deleted comments. Admin resolve `delete` on a comment does the same.
  - New `Limit::Heart` (120 per 10 min per user). Replies share `Limit::Comment`.
- `docs/ARCHITECTURE.md` § F006 additions: migration `0012_f006.sql`, list/preview queries, delete flow, F007 hook points, ownership.
- `docs/GAME_FORMAT.md` § F006 additions: none (games can't read or write comments).

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration `backend/migrations/0012_f006.sql`** exactly as in ARCHITECTURE § F006 (two nullable columns on `comments`, two partial indexes, `comment_hearts`).
2. **`src/models.rs`**: extend `Comment` with `parent_id: Option<String>`, `reply_to: Option<UserRef>`, `is_creator`, `hearts: i64`, `my_heart`, `creator_heart`, `can_delete` (all serialised camelCase). Add `CommentThread` (`#[serde(flatten)] comment` + `reply_count`, `replies`), `CommentListPage` (`Page` fields + `total_all`), `CommentContext`, `HeartResponse`.
3. **`src/routes/comments.rs`**:
   - `COMMENT_SELECT` becomes a function of the viewer id and admin flag (ARCHITECTURE § F006 query shape): joins the game for `owner_id`, left-joins the `replyTo` user, and computes `hearts`, `my_heart`, `creator_heart`, `is_creator` and `can_delete` in SQL. Anonymous viewers bind `NULL`, giving `myHeart: false`, `canDelete: false`.
   - `list_comments`: top-level page (`parent_id IS NULL`, `created_at DESC, rowid DESC`), `total`, `total_all`, then **one** query for the reply previews of the page's threads (window function, ≤ 3 per thread, oldest first) and one grouped `reply_count` query. Paging rules unchanged (`perPage` default 20, max 100, non-integer → 400).
   - `create_comment`: optional `parentId` (`Option<String>`; JSON `null` = absent; non-string → 422 via `ApiJson`). Validation order in API § F006. Normalise to the root; set `reply_to_user_id` per the API rule; guarded insert for the 200-replies cap (`INSERT … SELECT … WHERE (SELECT COUNT(*) …) < 200`, 0 rows → 422). Returns 201 `Comment`.
   - `get_comment` (`GET /api/comments/{id}`) → `CommentContext`; `list_replies` (`GET /api/comments/{id}/replies`) → `Page<Comment>`, oldest first, `perPage` default 50 (1–100).
   - `delete_comment`: allow author, game owner or admin (`is_admin` from `routes/screenshots.rs`, move it to a shared place if needed). In one transaction: collect the ids being removed (the comment plus its replies when it is top-level), resolve open reports on all of them (`resolution 'delete'`), delete the comment (replies and hearts cascade).
4. **`src/routes/reports.rs`**: `("delete", "comment")` calls the same delete helper as `delete_comment` (so replies cascade and their open reports are resolved too). Creating a report on a reply works unchanged (`SELECT game_id, body FROM comments`).
5. **Hearts** (new handlers, `routes/comments.rs` or `routes/hearts.rs`): `PUT`/`DELETE /api/comments/{id}/heart`. Order: auth → comment exists (404) → game visible to the viewer (404) → `Limit::Heart` → own comment (422, PUT only) → `INSERT OR IGNORE` / `DELETE` → `HeartResponse` read back. Both idempotent.
6. **`src/ratelimit.rs`**: `Limit::Heart` = (120, 600 s), doc comment like the others.
7. **`src/routes/mod.rs`**: `/comments/{id}` → `get(get_comment).delete(delete_comment)`; `/comments/{id}/replies` → `get(list_replies)`; `/comments/{id}/heart` → `put(heart).delete(unheart)`.
8. **No activity events and no notifications** are written (ARCHITECTURE § F006, F007 hook points). Leave a one-line `// F007:` comment at the post-insert point in `create_comment` and after a heart insert.
9. **Stats**: `CreatorStats.totals.comments` and `GameStats.comments` keep counting all rows (replies included). No code change; add a test assertion.
10. **Seed** (`seed.rs`): if it creates comments, add one reply by the game owner and one heart, so the demo shows the feature. Otherwise skip.
11. **Tests** (`tests/f006.rs`, using `common::setup()` and its `ManualClock` for rate limits):
    - Reply create: to a top-level comment → `parentId` = root, `replyTo: null`; to a reply by someone else → `parentId` = root, `replyTo` = that author; to your own reply → `replyTo: null`; `parentId` on another game → 404; unknown → 404; `parentId: 42` → 422; on an unpublished game by a stranger → 404.
    - List: `total` counts threads only, `totalAll` counts all; `replies` ≤ 3, oldest first; `replyCount`; threads newest first; existing `api.rs::comments_crud_permissions` stays green.
    - `/replies`: paging, oldest first, `total` = `replyCount`; reply id → 422; unknown → 404.
    - `GET /api/comments/{id}`: top-level (`thread.id == comment.id`) and reply; unpublished game → 404 for strangers, 200 for the owner.
    - Hearts: PUT twice → `hearts: 1`; DELETE twice → 0; own comment → 422; anon → 401; `myHeart` only for that viewer; owner heart → `creatorHeart: true` on list and `HeartResponse`; deleting the comment removes its hearts.
    - `isCreator` true for the owner's comments and replies; `canDelete` for author, owner, admin, false for others and anonymous.
    - Delete: stranger 403; admin 204 on someone else's comment; top-level delete removes replies and hearts; open reports on the comment **and** on its replies are resolved with `delete`; reply delete leaves the thread.
    - Admin resolve `delete` on a top-level comment report cascades the same way; on a reply report removes only the reply.
    - 200-reply cap → the 201st is 422 (insert rows directly to save time, then one API call).
    - Rate limits (with `RATE_LIMIT` on and `t.clock`): 30 mixed comments/replies → the 31st (a reply) → 429 with `Retry-After`; `t.clock.advance(20 s)` → allowed. 120 heart PUT/DELETE → the 121st → 429; `advance(5 s)` → allowed. Hearts don't consume the comment bucket.
    - Migration upgrade: a DB at `0011` with comments and comment reports migrates; old comments list as threads with `replyCount: 0`.
    - User deletion (if an endpoint or test helper exists): their replies vanish; replies by others that had `replyTo` them get `replyTo: null`.

**Acceptance:** `cd backend && cargo test` (all suites green, including `api.rs`, `v2.rs`, `review*.rs`, F001–F013) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`): `Comment` new fields; `CommentThread`, `CommentListPage`, `CommentContext`, `HeartResponse` (API § F006). Treat missing new fields as defaults when reading (older servers): `parentId ?? null`, `hearts ?? 0`, `replies ?? []`, `replyCount ?? 0`, `totalAll ?? total`.
2. **Client** (`src/api/client.ts`): `listComments` → `CommentListPage`; `postComment(gameId, body, parentId?)`; `getComment(id)`; `listReplies(id, { page, perPage })`; `heartComment(id)` / `unheartComment(id)`.
3. **Components** (split `Comments.tsx`, keeping the export name):
   - `Comments.tsx`: list state (threads, counts, pagination, linked thread, live region, single open reply form). New prop `focusCommentId?: string | null`. `isGameOwner` stays; the server's `canDelete` replaces the client check.
   - `CommentItem.tsx`: one article (author, Creator badge, "Replying to", time permalink, body, action row).
   - `CommentForm.tsx`: shared top-level/reply form (§ 2.2: counter, Ctrl/Cmd+Enter, Escape/Cancel for replies, "Replying to" chip).
   - `HeartButton.tsx`: § 2.3.
4. **`GamePage.tsx`**: read `?comment=` (same pattern as `?section=`) and pass it as `focusCommentId`.
5. **`AdminPage.tsx`**: "View in context" link for comment reports; updated delete confirmation text (§ 2.5).
6. **Styles** (`styles.css`): `.pf-replies` indentation (with a left rule), `.pf-badge--creator`, `.pf-heart` (pressed state, pop animation under `prefers-reduced-motion: no-preference` only), `.pf-comment--highlight`, using existing tokens.
7. **Tests**:
   - `Comments.f006.test.tsx`: threads and nested lists render with the labels in § 2.6; "Show N more replies" loads, dedupes and moves focus; reply form open/Escape/focus return, Ctrl+Enter submit, "Replying to" chip sends the reply's id as `parentId`, and after its ✕ the thread's id; new reply appended after loading hidden replies; counts update on post and delete; confirm only for threads with replies; 404 on reply removes the thread.
   - `HeartButton.test.tsx`: `aria-pressed`, optimistic toggle and revert on error, in-flight clicks ignored, non-interactive for the author and anonymous, creator mark.
   - Permalink: linked thread shown first and not duplicated on later pages; a hidden reply is found by loading replies; focus and highlight; 404 shows the info alert.
   - `ApiClient` tests for the new methods (paths, methods, bodies).
   - `AdminPage` test: "View in context" href for comment reports.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
No code changes. **Verify** in the Tauri app (HashRouter): a permalink `#/games/{id}?comment={commentId}` opens with the thread focused; Ctrl+Enter posts a reply in WebView2 and is not swallowed by a menu accelerator.

**Acceptance:** `npm run build -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo check`.

### engine-dev
None.

### Sequencing
- Backend and frontend can start in parallel; frontend works against mocked responses from API § F006.
- A frontend review-fix round is in progress in `packages/ui` (including `AdminPage.tsx` and `styles.css`). frontend-dev should start F006 after that round is merged, or rebase onto it, to avoid conflicts.
- Desktop verification runs last, against the built UI and backend.

## 5. Edge cases and security
- **One level only**: the server always stores `parent_id` as a top-level id; a client can't create deeper nesting by passing a reply id. A reply to a reply in another thread is impossible because the parent must be on the same game and is normalised to its root.
- **Cross-game parents**: `parentId` must belong to the game in the path; otherwise 404 (not 422, to avoid confirming that a comment exists on a game the viewer may not see).
- **Visibility**: every read and write checks the comment's game with the same rules as `GET /api/games/{id}`. Comments on unpublished games are visible only to the owner (and reachable by id only for them).
- **Delete cascade**: deleting a top-level comment removes other people's replies. This is deliberate: replies to removed content often quote it, and moderation must be able to clear a thread in one action. The UI confirms with the reply count. Reports on the removed rows are resolved in the same transaction so the admin queue doesn't keep dangling items.
- **Concurrent writes**: a reply posted while its root is being deleted either fails the parent lookup (404) or is removed by the cascade; the FK guarantees no orphan. The 200-reply cap is enforced in the insert statement, so concurrent posts can't exceed it.
- **Self-hearts**: refused (422) so counts reflect other people. The owner may heart comments on their own game (that is the `creatorHeart` signal) but not their own comments.
- **Abuse**: replies share the comments bucket (30 per 10 min), so threads don't add a new spam channel. Hearts have their own bucket (120 per 10 min); toggling a heart writes at most one row per (comment, user), so heart spam can't inflate counts.
- **Privacy**: `myHeart` is only ever about the viewer. Who hearted a comment is not exposed (no list endpoint), except the boolean `creatorHeart`, which is public by design.
- **Rendering**: bodies stay plain text (React text nodes, `white-space: pre-wrap`); "Replying to @name" is built from `replyTo`, never parsed from the body.
- **Deleted users**: their comments and replies cascade away (v1 FK); `reply_to_user_id` is `ON DELETE SET NULL`, so replies that answered them show no "Replying to" line.
- **Ownership transfer**: there is none today. `isCreator` and `creatorHeart` are computed against the game's **current** owner at read time.
- **Older clients**: v1 clients still work. They see only top-level comments in `items`, and `total` now counts threads only (it counted everything before). Replies are invisible to them, which is acceptable.

## 6. Test expectations
- **Backend**: `tests/f006.rs` as listed (replies, normalisation, list shape and counts, hearts, permissions, cascade and report resolution, cap, rate limits with `ManualClock`, migration upgrade). All existing suites stay green unchanged.
- **UI**: the thread markup and accessibility attributes, focus management after open/close/post/load/delete, optimistic hearts, permalinks, admin link, client methods.
- **Desktop**: green build; manual permalink and Ctrl+Enter check.
- **Manual end to end**: two accounts and the owner on one game: comment, reply, reply-to-reply ("Replying to"), hearts from both, creator heart and badge, report a reply and delete it from `/admin` via "View in context", delete a thread with replies as the owner, and walk the whole flow with keyboard only and a screen reader (NVDA or VoiceOver).

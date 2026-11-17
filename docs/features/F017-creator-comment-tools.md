# F017: Creator comment tools: pin, lock and "Top" sort

Status: **shipped**. Size: **S** (backend small, frontend small to medium; desktop verification only; one round). Areas: backend, frontend, desktop (verification only). No engine changes.
Contracts: `docs/API.md` § F017 additions (type fields, `sort`, four endpoints, validation order, rate limit), `docs/ARCHITECTURE.md` § F017 additions (migration `0015_f017.sql`, query changes, notification decision), `docs/GAME_FORMAT.md` § F017 additions (no changes; noted for completeness).
Depends on: F006 (threads, hearts, permalinks, `remove_comment`) and F007 (notification hooks), both shipped. The migration is **`0015_f017.sql`** and runs after `0014_review4.sql`. **No new Rust or JS dependencies.**

## 1. Goal and user stories
F006 gave games real conversations, and F007 makes creators notice them. Busy games now have a new problem: the answer to the most common question ("how do I double jump?") sinks under newer comments, a heated thread keeps growing, and the most useful tips are buried because the list is always newest first.

F017 adds three small tools:
- **Pin.** The game's owner can pin **one** top-level comment (theirs or anyone's). It is shown above all other threads, in every sort, with a visible "Pinned" label. Pinning another comment replaces the pin.
- **Lock.** The owner can lock a thread. A locked thread keeps its comment, replies, hearts and reports, but nobody except the owner (and admins) can add replies. The thread shows "Locked" and a note that replies are off.
- **Top sort.** Anyone can sort threads by **Top** (most hearts on the top-level comment, then newest) instead of **Newest**. The choice is remembered on the device.
- Admins get the same pin and lock tools on every game, for moderation (for example, unpinning an abusive pin, or locking a pile-on before reviewing reports).

User stories:
1. As a creator, I write "FAQ: press Shift to dash, saves are automatic" as a comment on my game and click **Pin**. Every visitor now sees it first, labelled "Pinned".
2. As a creator, I pin a player's excellent speedrun tip instead of my own comment. Pinning it unpins my FAQ after I confirm "Replace the pinned comment?".
3. As a creator, a bug-report thread has turned into an argument. I post a final reply ("Fixed in v6, locking this"), then click **Lock**. The Reply buttons in that thread disappear for everyone else and a note says "Replies are turned off for this thread."
4. As a player, I switch the comments to **Top** and read the most-hearted tips first. Next time I open any game, comments are still sorted by Top.
5. As a moderator, I open a reported pinned comment via "View in context" and click **Unpin**, or I delete it, which also removes the pin.
6. As a keyboard or screen-reader user, the sort control tells me which order is active, Pin and Lock say what they act on and whether they are on, and the pinned thread is announced as a separate labelled list.

Non-goals (later items): notifying the author when their comment is pinned (deferred, see § 5 "Notifications"), turning comments off for a whole game, slow mode, pinning more than one comment, pinning replies, sorting replies, editing comments, a "Top" sort that counts replies.

## 2. UX notes

### 2.1 Sort control (`CommentSortToggle`, in the `Comments` header)
- Next to the "Comments {totalAll}" heading: a group of two buttons, **Newest** and **Top**, in `<div role="group" aria-label="Sort comments">`. Each is a native `<button type="button">` with `aria-pressed` (exactly one is pressed). Visual style: the existing segmented/pill look (reuse `pf-tabs`-like tokens, not the `Tabs` component, which is for tab panels).
- Default **Newest**. The choice is stored per device in `localStorage["webgame.comments.sort"]` (`"new"` or `"top"`; anything else reads as `"new"`; storage errors are ignored).
- Changing the sort: clears the loaded threads, loads page 1 with the new `sort`, keeps focus on the pressed button, sets `aria-busy="true"` on the threads list while loading, and announces "Comments sorted by top" / "Comments sorted by newest" in the existing polite live region.
- The pinned thread (§ 2.2) and the permalink thread (F006 § 2.5, "Linked comment") stay above the list in both sorts. Replies inside threads are always oldest first.
- The new-comment form still prepends the posted comment to the loaded list in both sorts (the author expects to see it; it takes its sorted place on the next load).
- Hearts toggled while sorted by Top don't reorder the loaded list.
- Pre-F017 servers ignore `sort`. The toggle is shown only when the response has a `pinned` key (see § 3, `legacy17`), so older servers keep the F006 UI.

### 2.2 Pinned thread
- When `CommentListPage.pinned` is non-null, it renders **above** the linked thread and the list, as its own list: `<ul class="pf-comments pf-comments--pinned" aria-label="Pinned comment"><li>…thread…</li></ul>`. It is a normal thread (replies preview, "Show N more replies", reply form, hearts, delete, report).
- Its article head shows a badge `<span class="pf-badge pf-badge--pinned"><span aria-hidden="true">📌</span> Pinned</span>`. The text "Pinned" is always visible; the badge is not colour-only.
- The page-1 value of `pinned` is used. Later pages return the same field and are ignored for it.
- If the permalink target is in the pinned thread, the pinned thread is highlighted and focused in place; no "Linked comment" copy is added.
- Paging: `total` excludes the pinned thread, so "Load more comments" (`loadedCount < total`) keeps working. `loadedCount` counts list threads only (not pinned, not the linked copy).

### 2.3 Pin, Unpin, Lock, Unlock (action row of top-level comments, `canModerate` only)
- Shown on **top-level** comments when `comment.canModerate` is true, after **Delete** and before **Report**: **Pin** / **Unpin** and **Lock** / **Unlock**. Plain link-style buttons like Reply and Delete. No menu (an ARIA menu would need arrow-key handling we don't otherwise use, and two buttons are clearer).
- Labels: `aria-label="Pin comment by {name}"` / `"Unpin comment by {name}"`, `"Lock replies to comment by {name}"` / `"Unlock replies to comment by {name}"`. Ids: `pin-btn-{id}`, `lock-btn-{id}`. They are not toggle buttons (`aria-pressed` would be confusing next to a label that changes), so the visible text and label change instead.
- While a request is in flight the button ignores clicks (not disabled, so focus stays), as with hearts.
- **Pin**:
  - If another comment is pinned, `ConfirmDialog` "Replace the pinned comment?" with body "Only one comment can be pinned. The comment by {pinned author} will be unpinned." Confirm label "Pin this one". Cancel returns focus to the Pin button.
  - On success: the thread moves from the list (or the linked slot) into the pinned slot; the replaced thread (`unpinnedId`), if any, goes back into the list (§ 2.4). Focus moves to the new pinned thread's **Unpin** button (`pin-btn-{id}`), so the action is easy to undo. Live region: "Comment pinned".
- **Unpin**: no confirmation. The thread goes back into the list (§ 2.4). Focus moves to its **Pin** button. Live region: "Comment unpinned".
- **Lock** / **Unlock**: no confirmation. The thread's `locked` updates in place. Focus stays on the button (its text changes). Live region: "Thread locked" / "Thread unlocked".
- Errors: a toast with the server message (403, 404 "This comment was deleted" and the thread is removed, 422 as returned, 429 "Slow down, try again in {Retry-After}s"). State is not changed optimistically.

### 2.4 Where an unpinned thread goes
The client can't know the thread's exact position in unloaded pages, so:
- `total` += 1 (and −= 1 on pin).
- If the thread sorts **before or among** the loaded list threads under the current sort (Newest: `createdAt` desc; Top: `hearts` desc then `createdAt` desc), insert it at that position.
- Otherwise, if more pages remain, leave it out; it arrives with a later page (pages are already deduped by id). If no pages remain, append it.

### 2.5 Locked threads
- Head badge on the top-level article: `<span class="pf-badge pf-badge--locked"><span aria-hidden="true">🔒</span> Locked</span>`.
- After the thread's replies (and after "Show more replies"): `<p class="pf-thread-note pf-muted pf-small" id="thread-note-{id}">Replies are turned off for this thread.</p>`.
- For viewers without `canModerate` on the thread: **Reply** buttons are not rendered on the thread or its replies, and an open reply form for that thread is closed (its draft is kept in memory, as in F006).
- Viewers with `canModerate` keep their Reply buttons. Their reply form shows the hint "This thread is locked. Only you and moderators can reply." above the textarea.
- If a reply is rejected with 422 "This thread is locked" (locked while the form was open), the form shows the error inline, the thread is marked `locked` locally, and the Reply buttons disappear; focus moves to the thread note.
- Hearts, Delete and Report still work in locked threads.

### 2.6 Accessibility (normative for frontend-dev)
- Sort: `role="group"` + `aria-label`, `aria-pressed` buttons, focus never moves on sort change, `aria-busy` on the list during the reload, live announcement.
- The pinned thread is a separately labelled list ("Pinned comment") before the main list ("Comments"), so screen-reader list navigation finds it first.
- Pinned and Locked are visible text badges with sufficient contrast (4.5:1 on the panel surface, like F006's Creator badge); emoji are `aria-hidden`.
- In a locked thread, the note is real text in reading order after the replies, so the absence of Reply buttons is explained.
- Focus after every action is defined above (§ 2.3); no focus is lost when a thread moves between slots (the target button exists in the new slot before focus moves; use the existing `requestFocus` mechanism).
- Under `prefers-reduced-motion`, threads moving between slots are not animated (no animation is planned anyway).

## 3. Contract changes (summary; normative text lives in docs/)
- `docs/API.md` § F017 additions:
  - `Comment` gains `pinned`, `locked`, `canModerate`. `CommentListPage` gains `pinned: CommentThread | null`. New `ThreadState`.
  - `GET /api/games/{id}/comments` accepts `sort=new|top` (unknown → 400) and excludes the pinned thread from `items` and `total`.
  - `POST /api/games/{id}/comments`: replies to a locked thread → 422 "This thread is locked" unless the poster is the game owner or an admin.
  - New: `PUT`/`DELETE /api/comments/{id}/pin`, `PUT`/`DELETE /api/comments/{id}/lock` → `ThreadState`.
  - New `Limit::ThreadTools` (60 per 10 min per user), shared by the four endpoints.
- `docs/ARCHITECTURE.md` § F017 additions: migration `0015_f017.sql` (two nullable columns, one partial unique index), read-shape additions, top order, pin transaction, guarded reply insert, the notification decision.
- `docs/GAME_FORMAT.md` § F017 additions: none.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration `backend/migrations/0015_f017.sql`** exactly as in ARCHITECTURE § F017 (`comments.pinned_at`, `comments.locked_at`, `idx_comments_game_pinned`).
2. **`src/models.rs`**: `Comment` gains `pinned: bool`, `locked: bool`, `can_moderate: bool`. `CommentListPage` gains `pinned: Option<CommentThread>` (serialised as `null` when absent; **not** skipped). New `ThreadState { id, pinned, locked, unpinned_id: Option<String> }`. All camelCase.
3. **`src/routes/comments.rs`**:
   - `comment_select()` adds the three columns from ARCHITECTURE § F017; `comment_from_row` reads them.
   - `list_comments`: a new query struct (`ListCommentsQuery { page, per_page, sort }`; keep `PageQuery` for `/replies`). `sort`: absent, `""` or `"new"` → newest; `"top"` → top; else 400 `bad_request` "Unknown sort '…' (expected new or top)". Validate `sort` before paging. The page query adds `AND c.pinned_at IS NULL` and the order from ARCHITECTURE § F017. `total` excludes the pinned thread. Load the pinned row (`WHERE c.game_id = ?3 AND c.pinned_at IS NOT NULL`) and pass it through `into_threads` **together with** the page's roots (one preview query, one count query), then split it off into `pinned`.
   - `create_comment`: after the parent lookup, when the root is locked and the poster is neither the game owner nor an admin → 422 `validation` "This thread is locked". Extend the guarded reply insert with the lock condition (ARCHITECTURE § F017) and, on zero rows, re-read the root: missing → 404, locked (and not a moderator) → 422 locked, else 422 cap. Load `is_admin` only when needed (reply, poster not the owner).
   - New handlers `pin`, `unpin`, `lock`, `unlock`, order: auth → 401; comment exists and its game is visible to the caller → 404 (`ensure_visible`); caller is the game owner or an admin → else 403; `Limit::ThreadTools` → 429; the comment is a reply → 422 `validation` "Only top-level comments can be pinned" / "… locked". Then the writes in ARCHITECTURE § F017; a write that matches no row (deleted meanwhile) → 404. All four are idempotent and return `ThreadState`.
   - `remove_comment` and the report flow are unchanged (deleting a pinned or locked comment removes its state with the row).
4. **`src/ratelimit.rs`**: `Limit::ThreadTools` = (60, 600 s), with a doc comment like the others.
5. **`src/routes/mod.rs`**: `/comments/{id}/pin` → `put(pin).delete(unpin)`; `/comments/{id}/lock` → `put(lock).delete(unlock)`.
6. **Notifications**: none written or retracted by the four new endpoints (ARCHITECTURE § F017). Leave a `// F018: pinned notification` comment at the point after a pin changes a row. Existing F007 hooks in `create_comment` are unchanged (moderator replies in locked threads notify as usual).
7. **Seed** (`seed.rs`): no comments are seeded today; skip.
8. **Tests** (`tests/f017.rs`, `common::setup()`, `t.clock` (`ManualClock`) for the rate limit):
   - Pin: owner pins a stranger's top-level comment → 200 `{ pinned: true, unpinnedId: null }`; list has `pinned.id` = it, `items` and `total` exclude it, `totalAll` unchanged; `pinned.replies`/`replyCount` filled. Pin again → 200, `unpinnedId: null` (idempotent). Pin a second comment → `unpinnedId` = the first; the first is back in `items`. Unpin → `pinned: null`; unpin again → 200.
   - The partial unique index: a direct second `UPDATE … SET pinned_at` on the same game fails (asserts the DB guarantee).
   - Permissions: stranger 403, anonymous 401, admin 200 on someone else's game, unknown id 404, comment on an unpublished game by a stranger 404, reply id → 422 for both pin and lock.
   - `canModerate`: true for owner and admin on top-level comments, false on replies, false for others and anonymous. `pinned`/`locked` appear on list items, `pinned`, `/replies` items, `CommentContext` and the `POST` response; replies always have `pinned: false`, `locked: false`.
   - Lock: stranger reply → 422 "This thread is locked"; reply to a reply in a locked thread → 422; owner reply → 201 and the thread author gets the F007 `reply` notification; admin reply → 201; top-level comments on the game still 201; hearts, delete and report on a locked thread work. Unlock → stranger reply 201. Lock/unlock idempotent.
   - Validation order: a locked thread that also has 200 replies → stranger gets the lock message (lock is checked first); unknown `parentId` still 404.
   - Sort: three threads with 0/2/2 hearts and different times → `sort=top` orders by hearts desc, then newest; `sort=new` and no sort as before; `sort=bogus` → 400; the pinned thread is excluded in both sorts; paging with `perPage=1` covers every non-pinned thread exactly once while nothing changes.
   - Delete a pinned comment → list `pinned: null`; admin resolve `delete` on a pinned comment's report → same. Deleting the game removes everything (no FK error).
   - Rate limit (`RATE_LIMIT` on): 60 mixed pin/unpin/lock/unlock → the 61st → 429 with `Retry-After`; `t.clock.advance(Duration::from_secs(10))` → allowed. These calls don't consume `Limit::Comment` or `Limit::Heart`.
   - Migration upgrade: a DB at `0014` with comments migrates; every comment lists with `pinned: false`, `locked: false`.
   - Existing `f006.rs` and `f007.rs` stay green unchanged.

**Acceptance:** `cd backend && cargo test` (all suites green) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`): `Comment` + `pinned`, `locked`, `canModerate`; `CommentListPage` + `pinned: CommentThread | null`; `ThreadState`; `CommentSort = "new" | "top"`; a `CommentListQuery = PageQuery & { sort?: CommentSort }`.
2. **Normalisation** (`src/api/comments.ts`): missing `pinned`/`locked`/`canModerate` → `false`; missing page `pinned` → `null`. Expose whether the server is F017-aware (`"pinned" in raw`) so `Comments` can hide the sort toggle and the tools on older servers.
3. **Client** (`src/api/client.ts`): `listComments(id, query: CommentListQuery)` (sends `sort` only when given); `pinComment(id)` / `unpinComment(id)` / `lockComment(id)` / `unlockComment(id)` → `ThreadState` (`PUT`/`DELETE` on `/api/comments/{id}/pin|lock`).
4. **`Comments.tsx`**:
   - Rename the internal permalink flag `ThreadView.pinned` to `linked` (and `seenInPages` stays) so it can't be confused with the new server `pinned`. Behaviour of the linked thread is unchanged.
   - Sort state (from `localStorage["webgame.comments.sort"]`), passed to `listComments`; changing it resets `page` to 1 and the list (§ 2.1).
   - `pinnedThread` state from page 1; render order: pinned list → linked thread → list (§ 2.2). Exclude the pinned id from the list and from the linked slot.
   - Handlers for pin (with the replace `ConfirmDialog`), unpin, lock, unlock (§ 2.3, § 2.4), live-region messages and focus targets.
   - Locked threads: hide Reply for non-moderators, close an open form for that thread, handle the 422 lock error (§ 2.5).
5. **`CommentItem.tsx`**: Pinned and Locked badges; Pin/Unpin and Lock/Unlock buttons for `canModerate` top-level comments (ids and labels from § 2.3); new props `onPin`, `onLock`, `pinBusy`, `lockBusy`, and `repliesLocked` (hides Reply).
6. **`CommentSortToggle.tsx`** (new): the § 2.1 group.
7. **`CommentForm.tsx`**: optional `notice` prop for the locked-thread hint (§ 2.5).
8. **Styles** (`styles.css`): `.pf-badge--pinned`, `.pf-badge--locked`, `.pf-comments--pinned` (a subtle top border or tinted panel, using existing tokens), `.pf-thread-note`, the sort group (`.pf-segmented`, pressed state with a non-colour cue such as weight or underline).
9. **Tests**:
   - `Comments.f017.test.tsx`: sort toggle (`aria-pressed`, `sort=top` sent, list reset, focus stays, announcement, localStorage persisted and restored, invalid stored value → newest); pinned thread rendered first in its labelled list with the badge, excluded from load-more math; pin → confirm when replacing, thread moves, `unpinnedId` thread returns per § 2.4, focus on Unpin; unpin; lock hides Reply for a non-moderator and shows the note, moderator keeps Reply and sees the hint; 422 lock on post marks the thread locked and moves focus to the note; permalink into the pinned thread highlights in place with no linked copy; tools hidden when the server omits `pinned`.
   - `CommentItem` tests: tools shown only for `canModerate` top-level comments; labels and ids.
   - `ApiClient` tests for the four methods and the `sort` query.
   - `Comments.f006.test.tsx` stays green (update only for the `linked` rename if it reaches into internals).

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
No code changes. **Verify** in the Tauri app (HashRouter): the sort choice persists across app restarts (WebView2 localStorage); a permalink `#/games/{id}?comment={pinnedId}` focuses the pinned thread; the Replace confirmation dialog traps and returns focus correctly in WebView2.

**Acceptance:** `npm run build -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo check`.

### engine-dev
None.

### Sequencing
- Backend and frontend can run in parallel; frontend mocks API § F017 responses.
- The project-reviewer's round 5 writes only `docs/reviews/`; if it produces review fixes in `routes/comments.rs` or `Comments.tsx`, apply them before or rebase onto them.
- Desktop verification runs last.

## 5. Edge cases and security
- **One pin per game** is guaranteed by the partial unique index, and the pin endpoint clears any other pin in the same transaction, so concurrent pins end with exactly one (the last committed).
- **Only top-level comments** can be pinned or locked. Replies → 422. Replies never carry `pinned`/`locked` true.
- **Permissions** are checked against the game's **current** owner and the admin role at request time. `canModerate` is computed server-side; the client never decides it.
- **Visibility**: pin/lock use the same `ensure_visible` rule as hearts. On an unpublished game only the owner (and admins) can reach the comment at all.
- **Deletes**: pin and lock live on the comment row, so deleting the comment (author, owner, admin, or admin resolve `delete`) removes them. Deleting a game cascades its comments. No dangling pin id is possible (that is why the pin is a column on `comments`, not `games.pinned_comment_id`, which would add a `games` ↔ `comments` FK cycle).
- **Locked threads and moderation**: reports on locked or pinned comments work unchanged. A pinned abusive comment can be unpinned or deleted by an admin. Locking never hides content.
- **Lock bypass**: the lock check is inside the guarded insert, so a reply racing a lock either commits before the lock or is refused. Owners and admins bypass the lock by design (a final answer, a moderation note). The 200-reply cap still applies to them.
- **Notifications** (decision):
  - **Lock/unlock never notify.** Locking is a moderation action; notifying every participant invites argument elsewhere and adds noise. The thread itself explains the state. Existing unread `reply` notifications for the thread stay and still link to the permalink.
  - **Pin/unpin don't notify in F017.** "The creator pinned your comment" is a good signal, but `notifications.kind` has a CHECK that can't be widened without rebuilding both notification tables (`DROP TABLE` with foreign keys on would cascade `notification_events` away, and the `0014` trigger fires on it). That one-time rebuild, plus a `pinned` kind with a `pins` setting, is moved to F018, which already changes the notification write path. The author still sees "Pinned" on their comment.
  - Replies by the owner or an admin in a locked thread notify exactly as in F007.
- **Abuse**: the four endpoints share `Limit::ThreadTools` (60 per 10 min per user). They write no notifications or activity, so toggling can't spam anyone. Only owners and admins can call them.
- **Top sort cost**: hearts are counted per read (F006 has no counters), so `sort=top` computes a count for every top-level comment of the game before paging. Each count is a primary-key prefix probe on `comment_hearts`; at 10k threads that is a few milliseconds. If a game ever exceeds ~50k threads, add a maintained `hearts_count` column (not needed now).
- **Paging drift**: with offset paging, a thread whose hearts change between page loads can appear twice (the client dedupes by id) or be skipped until reload. This matches existing list behaviour and is acceptable.
- **Older clients**: a pre-F017 client ignores `pinned`, so the pinned thread is missing from its list (still reachable by permalink). Web and desktop ship from the same UI package in this round, so this only affects stale desktop builds.
- **Rendering**: badges and notes are fixed UI strings; comment bodies stay plain text.

## 6. Test expectations
- **Backend**: `tests/f017.rs` as listed (pin/replace/unpin, unique index, permissions and `canModerate`, lock rules and bypass, validation order, sort orders and 400, pinned exclusion from `items`/`total`, delete cascades, rate limit with `ManualClock`, migration upgrade). All existing suites green.
- **UI**: sort group semantics and persistence, pinned slot and paging math, pin/replace/unpin/lock flows with focus and announcements, locked-thread behaviour, permalink into the pinned thread, legacy-server fallback, client methods.
- **Desktop**: green build; manual persistence, permalink and dialog-focus checks.
- **Manual end to end**: owner + two players on one game: pin a player's comment, replace it with the owner's FAQ, lock a thread, check a player can't reply (no button; a forced API call gets 422) while the owner can, switch to Top and back, reload and see the sort kept, delete the pinned comment as admin from `/admin` via "View in context". Repeat the owner flow with keyboard only and a screen reader (NVDA or VoiceOver).

# F031: Post replies and hearts, with notifications

Status: **specced**. Size: **M**. One round. Areas: backend, frontend, desktop (verification only). Engine: none.

Size breakdown:
- **backend:** migration `0026_f031.sql` (two tables, three `posts` columns with counter triggers, two notification columns, one dedupe index swap, two settings columns, one `reports` column; no table rebuild), seven endpoints in a new `routes/post_replies.rs` plus heart and lock handlers in `routes/posts.rs`, `Limit::PostReply`, two notification kinds, a `postReply` report target, and the `remove_post` cascade.
- **frontend:** the `Post` fields, a generalised `HeartButton`, hearts and a replies link on every `PostCard`, a reply thread (`PostThread`, `PostReplyItem`, `PostReplyForm`) on the permalink page with `?reply=` deep links and a "Turn off replies" toggle, two notification texts and switches, and admin rows.
- **desktop:** one verification test, no source changes.

Contracts: `docs/API.md` § F031 additions, `docs/ARCHITECTURE.md` § F031 additions (normative migration SQL, write and read paths), `docs/GAME_FORMAT.md` § F031 additions (no changes).

Depends on: F006 (heart and reply patterns), F007/F018/F024 (notification write path, dedupe, the `0014` trigger, settings), F017 (lock semantics), F030 (posts, `PostCard`, `PostPage`, `validate_post_body`, `linkifyPost`). All shipped. Migrations exist up to `0025_f030.sql`; this round's is **`0026_f031.sql`**.

No new Rust or JS dependencies. No engine or example changes.

## 0. Decisions on ambiguities (read first)
API § F031 is normative. Tests assert the texts below verbatim. `{name}` means display name, falling back to username.

1. **Scope.** In this round:
   - **hearts on posts** (not on replies), with a public count and the viewer's own state;
   - **one flat thread of replies per post**, oldest first, at most **200** per post. A reply can answer another reply, which records "Replying to @name" (the F006 rule), but nesting never goes deeper;
   - **the thread lives on the permalink page `/p/{id}` only.** Every other place a post appears (profile Posts section and shelf, feed) shows the heart and a replies link to the permalink. There are no inline threads in lists;
   - **"Turn off replies"** for the post author and admins (the F017 lock: they can still reply, nobody else can);
   - **two notification kinds**: `postReply` (to the post author and to the `replyTo` user) and `postHeart` (to the post author), with two settings switches;
   - **reports on replies** (`targetType: "postReply"`) and an admin "View in context" link;
   - deleting a post deletes its replies, hearts and notifications.

   **Not in this round** (follow-up **F040**): muting a post's notifications and hearts on replies. Post mutes need a new mute target, because `notification_mutes.game_id` is `NOT NULL` and `NotificationMute.game` is non-null, and that would change the F018 Muted list. Coalescing (one unread notification per post and kind), the two switches and "Turn off replies" cover the noisy cases for now.

   **F029 is not folded in.** This round already fills one frontend round (a thread UI, a generalised heart, notifications, settings and admin). F029 stays a clean S and runs next.
2. **Reply body rules.** Exactly the F030 post body rules and messages (`validate_post_body`): CRLF/CR → LF, trim, 1–500 code points, at most 12 lines, no F028 forbidden character except `\n`. The 422 messages are the F030 ones (`body must be 1–500 characters`, `body must be at most 12 lines`, `body must be plain text`). The client's line message for replies is `Replies can have at most 12 lines.`; the character message is the F030 one.
3. **Rendering.** Reply bodies render with the F030 `PostBody` (plain text, `linkifyPost`, the same anchor attributes and sr-only text).
4. **Reply targets.** `POST /api/posts/{id}/replies` takes `{ body, replyToId?: string | null }`.
   - `replyToId` absent or `null`: the reply answers the post. `replyTo` is `null`.
   - `replyToId` names a reply R of **the same post**: `replyTo` = R's author, unless R's author is the poster (then `null`). An unknown id, or a reply of another post → 404 `Reply not found`.
   - The stored row keeps only `reply_to_user_id` (not R's id). If that user is deleted, `replyTo` becomes `null`.
5. **Caps and limits.**
   - **200 replies per post** → 422 `This post has reached 200 replies`. Guarded insert, so concurrent replies can't exceed it. Deleting a reply frees a slot.
   - `Limit::PostReply`: **30 per 10 min** per user, checked after the post lookup and before body validation (the F006 `Limit::Comment` position), so a 422 uses a token.
   - Hearts share F006 `Limit::Heart` (120 per 10 min). Lock and unlock share F017 `Limit::ThreadTools` (60 per 10 min).
6. **Lock ("Turn off replies").** `PUT`/`DELETE /api/posts/{id}/lock`, author or admin. While locked, a reply by anyone else → 422 `Replies are turned off for this post`. The author and admins can still reply. Existing replies stay, and hearts, deletes and reports keep working. Locking never notifies. `Post.locked` reports the state.
7. **Who can delete a reply.** The reply's author, **the post's author**, or an admin (`PostReply.canDelete`). This is the F006 "game owner" rule applied to posts.
8. **Hearts.** A user can't heart their own post (422 `You can't heart your own post`; `DELETE` on your own post returns `{ hearted: false }`). Who hearted a post is never listed; only the count, the viewer's own state and the author's notification actors reveal it (the F006/F007 privacy rule).
9. **Notifications.**
   - **`postReply`**: one group per (recipient, post). Recipients: the post's author and the reply's `replyTo` user, each at most once, never the poster. Each reply is one event. `ownsThread` is true when the recipient wrote the post. `excerpt` = the newest live reply's first 140 code points. `path` = `/p/{postId}?reply={newestReplyId}`.
   - **`postHeart`**: one group per post, for the post's author. One event per hearting user (actor dedupe), retracted on un-heart while unread (the F007 heart rules, including the review 4 toggle rule). `excerpt` = the post's first 140 code points. `path` = `/p/{postId}`.
   - Both have `game: null`, `commentId: null`, `threadId: null`, `collection: null`, `screenshot: null` and a new `postId`.
   - **Deletes:** deleting a reply removes its event from the `postReply` notification, read or unread (the F024 cascade rule); a notification left empty is deleted by the `0014` trigger. Deleting the post deletes both kinds' notifications for it.
   - **Settings:** `postReplies` and `postHearts`, default on. F018 game and thread mutes never apply to these kinds (they have no game).
   - **Summaries** (exact; `{who}` is the F007 actor phrase: "A", "A and B", "A and {k} other(s)"):

     | Kind | Condition | Text |
     |---|---|---|
     | `postReply` | `ownsThread`, one actor, `eventCount > 1` | `{A} replied {n} times to your post` |
     | `postReply` | `ownsThread`, otherwise | `{who} replied to your post` |
     | `postReply` | not `ownsThread`, one actor, `eventCount > 1` | `{A} replied {n} times to you on a post` |
     | `postReply` | not `ownsThread`, otherwise | `{who} replied to you on a post` |
     | `postHeart` | – | `{who} hearted your post` |

     There are no title parts. OS notifications use these texts unchanged (they contain no post or reply text). The panel and page show `excerpt` as for comments.
   - **Glyphs** in `NotificationItem`'s meta row: `💬` (`pf-notif__kind pf-notif__kind--post-reply`) for `postReply`, `♥` (`pf-notif__kind pf-notif__kind--post-heart`) for `postHeart`, both `aria-hidden`.
   - **Mute action:** `muteActionFor` returns `null` for both kinds (no Mute button on `/notifications`).
10. **Settings switches** (`NOTIFICATION_SETTING_FIELDS`), inserted right **after `pins`**, each shown only when the server sends the field:
    - `{ key: "postReplies", label: "Replies to my posts", hint: "Someone replies to a post you wrote, or answers your reply on a post." }`
    - `{ key: "postHearts", label: "Hearts on my posts", hint: "Someone hearts a post you wrote." }`
11. **Post card** (`PostCard`, every context). When the server sends the F031 fields (`typeof post.hearts === "number"`), the actions row is always rendered, in this order:
    1. **Heart:** `HeartButton` with `subject="post"`. It is interactive when signed in and not the author; otherwise it shows the static count when > 0. The aria-label is `Heart post by {name}` plus `, {n} heart(s)` when n > 0 (the F006 format with "post").
    2. **Replies link** (not on the permalink page, see `inThread`): `<Link className="pf-linkbtn pf-post__replies" to="/p/{id}">` with `<span aria-hidden="true">💬</span>` and the text:
       - 0 replies: `Reply`, aria-label `Reply to the post by {name}`;
       - 1 reply: `1 reply`, aria-label `1 reply to the post by {name}`;
       - n replies: `{n} replies`, aria-label `{n} replies to the post by {name}`.

       It is omitted when `post.locked && post.replyCount === 0`.
    3. **Delete** or **Report** as in F030.

    Without the F031 fields (older server), the card is exactly the F030 card.

    New prop: `inThread?: boolean` (default false). `PostPage` passes `true`, which hides the replies link (the thread is right below).
12. **Thread** (`PostThread({ post, onPostChange })`, below the card on `/p/{id}`, only when `typeof post.replyCount === "number"`):
    - **Section:** `<section className="pf-post-thread" aria-labelledby="pf-post-replies-title">`.
    - **Head** `.pf-post-thread__head`: `<h2 id="pf-post-replies-title" className="pf-section-title" tabIndex={-1}>` with the text `Replies`, or `Replies ({n})` when `replyCount > 0`. Then, when `post.canDelete`, the lock toggle `<button type="button" className="pf-btn pf-btn--ghost pf-btn--sm">` with the text `🔒 Turn off replies` (glyph `aria-hidden`) or `Turn on replies`.
      - Success: toast `Replies turned off` / `Replies turned on`, `onPostChange(returnedPost)`, focus stays on the button.
      - Failure: `toast.error("Couldn't change replies", errorMessage(err))`.
      - While in flight the button has `aria-busy="true"` and ignores clicks (it is not disabled, so focus stays).
    - **Load:** `api.listPostReplies(post.id, { page: 1, perPage: 200 })`, the whole thread in one request (the cap equals the page maximum, so there is no "Show more").
      - Loading: `<Spinner size={18} label="Loading replies" />`.
      - Error: `<LoadError message="Couldn't load replies." onRetry={…} />`.
      - Empty: `<p className="pf-muted pf-post-thread__empty">No replies yet.</p>`.
    - **List:** `<ol className="pf-post-thread__list">` of `<li>` each holding a `PostReplyItem`, oldest first.
    - **Locked notice** (when `post.locked`), after the list: `<p className="pf-post-thread__locked pf-small"><span aria-hidden="true">🔒</span> Replies are turned off for this post.</p>`.
    - **Form slot**, after the notice:
      - anonymous and not locked: `<p className="pf-post-thread__login pf-small"><Link to={loginHref}>Log in</Link> to reply.</p>`, with `loginHref = /login?next={encodeURIComponent(pathname + search)}`;
      - anonymous and locked: nothing (the notice says it);
      - signed in and (not locked, or `post.canDelete`): `PostReplyForm`; when locked it gets the notice `Replies are turned off. You can still reply.`;
      - signed in, locked and not `canDelete`: nothing.
13. **Reply item** (`PostReplyItem({ reply, highlighted, canReply, onReply, onDeleted })`): `<article id="reply-{id}" className="pf-post-reply" tabIndex={-1} aria-labelledby="reply-{id}-author">` (plus `pf-post-reply--highlight` when highlighted). It contains:
    1. an avatar link (`Avatar size={28}`, `tabIndex={-1}`, `aria-hidden`, to `/u/{u}`);
    2. the head `.pf-post-reply__head`:
       - `<Link id="reply-{id}-author" to="/u/{u}" className="pf-post-reply__author">{name}</Link>`;
       - when `reply.byPostAuthor`: `<span className="pf-badge pf-badge--creator">Author</span>`;
       - `<Link to={reply.path} className="pf-post-reply__time pf-muted pf-small" title="{formatDate} · link to this reply"><time dateTime={createdAt}>{timeAgo(createdAt)}</time></Link>`;
       - when `reply.replyTo`: `<span className="pf-post-reply__replyto pf-muted pf-small">Replying to <Link to="/u/{u}">@{username}</Link></span>`;
    3. the body: `PostBody`;
    4. the actions `.pf-post-reply__actions`:
       - `Reply` (`pf-linkbtn`, `aria-label="Reply to {name}"`, `aria-controls="pf-post-reply-form"`), shown when `canReply` (the form slot shows a form);
       - `Delete` (`pf-linkbtn pf-linkbtn--danger`, `aria-haspopup="dialog"`), shown when `reply.canDelete`;
       - `<ReportButton targetType="postReply" targetId={reply.id} className="pf-linkbtn">Report</ReportButton>`, shown when the viewer isn't the reply's author (anonymous included; `ReportButton` prompts login). No `targetLabel`, so the dialog heading is `Report reply`.

    **Delete:** `ConfirmDialog` titled `Delete this reply?`, body `This can't be undone.`, `confirmLabel="Delete"`, `danger`.
    - Success: toast `Reply deleted`, the reply is removed, `replyCount` − 1 through `onPostChange`.
    - Failure: `toast.error("Couldn't delete the reply", errorMessage(err))`, the dialog closes, the reply stays.
    - **Focus after a delete:** the reply now at the deleted one's index, else the previous reply, else the form's textarea, else the thread heading.
14. **Reply form** (`PostReplyForm`), `<form id="pf-post-reply-form" className="pf-post-reply-form" aria-label="Reply to the post">`:
    - **Replying to:** when replying to a reply, `<p className="pf-post-reply-form__replyto pf-small">Replying to <strong>@{username}</strong></p>` with a `✕` button `aria-label="Stop replying to @{username}"`, which clears it and focuses the textarea. Replying to your own reply shows nothing (the server would store `replyTo: null`).
    - **Notice:** the § 0.12 locked notice, when given; it also describes the textarea.
    - **Textarea:** `<textarea className="pf-input" rows={2}>`, sr-only label `Reply text`, `placeholder="Write a reply…"`, no `maxLength`, `aria-describedby` = the notice id (if any) plus the counter id.
    - **Counter:** `{n} / 500`, and `{n} / 500 · {n − 500} too many` with `is-over` above 500 (the F030 composer rule and classes: `pf-post-composer__count`).
    - **Error:** an `Alert` slot.
    - **Submit:** `Reply` (`pf-btn pf-btn--primary pf-btn--sm`), disabled while `n === 0`, `n > 500` or busy, with a `Spinner` while busy. Ctrl+Enter / Cmd+Enter in the textarea submits.
    - **Client checks on submit**, in order, shown in the Alert with no request sent: more than 12 lines → `Replies can have at most 12 lines.`; a forbidden character → `Remove tabs, control characters and invisible formatting characters.`
    - **Server errors** show `errorMessage(err)` in the Alert (for example `Replies are turned off for this post` or `This post has reached 200 replies`). On that lock message the thread also calls `onPostChange({ ...post, locked: true })`.
    - **Success:** the reply is appended, the text and "Replying to" are cleared, `replyCount` + 1 through `onPostChange`, toast `Reply posted`, focus on the textarea.
    - **Reply on a reply:** pressing `Reply` on a reply sets "Replying to" (sending that reply's id as `replyToId`), scrolls the form into view (`block: "nearest"`) and focuses the textarea. The text already typed is kept.
15. **Deep links** `/p/{id}?reply={replyId}`:
    - After the thread loads, the matching reply gets `pf-post-reply--highlight`, is scrolled into view (`block: "center"`) and focused (`preventScroll: true`), once per (load, replyId).
    - When the `reply` query changes while the page is mounted and the id isn't in the loaded list, the thread reloads once.
    - Not found after loading: `<p className="pf-muted pf-small pf-post-thread__gone" role="status">That reply is no longer available.</p>` above the list. The post and the other replies show normally.
    - The highlight is the F006 comment highlight style.
16. **Permalink page** (`PostPage`). It keeps a local `post` state (initialised from the fetch) that `PostThread` updates through `onPostChange` (lock state, `replyCount`). The card gets `inThread`. Order: sr-only h1, `PostCard`, `.pf-post-page__actions` (Copy link, More posts), then `PostThread`.
17. **Admin.**
    - `KNOWN_TARGET_TYPES` += `"postReply"`, so `reportActions("postReply")` is `["dismiss", "delete"]`.
    - A `postReply` row shows `<blockquote className="pf-report-row__quote">{targetPreview}</blockquote>` and, when `report.targetPostId` is a string, `<Link to={postReplyPath(targetPostId, targetId)} className="pf-small">View in context →</Link>`.
    - `ACTION_COPY.delete` for `postReply`: title `Delete this reply?`, body `The reply is removed permanently.`
    - The F030 post row's `View post →` link is unchanged.
    - `.pf-badge--postReply` is styled like `.pf-badge--post`.
    - `Report.tsx` `what` gives `"reply"` for `"postReply"`.
18. **Responsive.**
    - The thread is a single column at every width inside the 640 px permalink column. Replies are separated by a 1 px `var(--pf-border)` line with 12 px vertical padding; no cards.
    - Reply avatars are 28 px at every width. At ≤ 640 px the reply head wraps; "Replying to" goes to its own line.
    - Reply form: at ≤ 640 px the counter and the Reply button wrap under the textarea and the button is full width (the composer rule).
    - The post card's actions row wraps at narrow widths (`flex-wrap: wrap; gap: 8px`).
19. **Desktop.** No menu item. `/p/{id}?reply=…` works under the hash router. Links in replies use `target="_blank"`, so `external.rs` opens them in the system browser. OS notifications for both kinds use the § 0.9 texts and never contain post or reply text.

Non-goals (later items): muting a post's notifications and hearts on replies (F040); inline threads in the feed or on profiles; editing replies; live updates of an open thread; reply notifications for other participants; `@mentions`; images in replies (F038 covers posts only).

## 1. Goal and user stories
F030 made posts one-way: an author talks, followers read. F031 lets readers answer and react, and tells the author.

User stories:
1. As a player, I heart Mia's dev-log post from my feed. The count goes up at once, and Mia gets "Leo hearted your post".
2. As a player, I open the post and reply "Can't wait for world 3!". Mia gets "Leo replied to your post" with my text as the excerpt, and the notification opens the post with my reply highlighted.
3. As the author, I answer a reply. The replier gets "Mia replied to you on a post", and my reply carries an "Author" badge.
4. As the author, my post attracts a pile-on. I press **Turn off replies**; nobody else can reply, and I delete the worst replies.
5. As a player, I report an abusive reply. An admin opens **View in context →**, deletes it from the queue, and it disappears from the thread.
6. As a player who doesn't want these notifications, I turn off "Replies to my posts" or "Hearts on my posts" in Settings.
7. As a keyboard or screen-reader user, every heart and reply control has a name, the form has a label and counter, and focus lands somewhere sensible after posting and deleting.

## 2. UX notes
See § 0 items 9–18 for texts, order, focus and layout. Additional notes:
- **Heart styling.** The existing `.pf-heart` classes (F006). No new animation.
- **Thread styling.** `.pf-post-thread` has `margin-top: 24px`. `.pf-post-thread__head` is a flex row (`justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px`). `.pf-post-reply` is a grid (`28px 1fr`, gap 10 px). `.pf-post-reply__head` is a wrapping flex row with an 8 px gap. `.pf-post-reply__actions` uses the `.pf-comment__actions` spacing. `.pf-post-reply-form` is a `pf-panel` with `margin-top: 12px`.
- **Highlight.** `.pf-post-reply--highlight` uses the same background and left border as `.pf-comment--highlight`.
- **Focus.** `.pf-post-reply:focus-visible` gets the standard focus ring; programmatic focus shows no ring for mouse users.
- **Contrast and motion.** Existing tokens only.

## 3. Contract changes (summary; normative text lives in docs/)
- **API.md § F031 additions**:
  - **Types:** `Post` gains `hearts`, `myHeart`, `replyCount`, `locked`; new `PostReply`, `CreatePostReplyRequest`, `PostHeartResponse`; `NotificationKind` += `"postReply" | "postHeart"`; `Notification.postId`; `NotificationSettings` += `postReplies`, `postHearts`; `ReportTargetType` += `"postReply"`; `Report.targetPostId`.
  - **Endpoints:** `GET`/`POST /api/posts/{id}/replies`, `DELETE /api/post-replies/{id}`, `PUT`/`DELETE /api/posts/{id}/heart`, `PUT`/`DELETE /api/posts/{id}/lock`.
  - **Rules:** reply rules, the cap, lock rules, hearts, notification triggers and fields, deletion, reports, `Limit::PostReply`.
  - **Web routes:** `/p/{id}?reply={replyId}`.
- **ARCHITECTURE.md § F031 additions**: migration `0026_f031.sql` (normative SQL), the reply select and guarded insert, `posts_for` changes, notification write and read changes, `remove_post` / `remove_post_reply`, reports, UI files and ownership.
- **GAME_FORMAT.md § F031 additions**: none.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0026_f031.sql`: copy ARCHITECTURE § F031 "Data" **verbatim**. Never edit `0001`–`0025`.
2. **`src/ratelimit.rs`**: `Limit::PostReply` with the doc `/// F031 post replies (`POST /api/posts/{id}/replies`): 30 per 10 min, per user` and the quota `(30, Duration::from_secs(600))`. Extend the `Heart` doc ("and (F031) `…/posts/{id}/heart`") and the `ThreadTools` doc ("and (F031) `…/posts/{id}/lock`").
3. **`src/notifications.rs`**:
   - `Kind::PostReply` (`"postReply"`, column `post_replies`) and `Kind::PostHeart` (`"postHeart"`, column `post_hearts`), appended to `ALL` (`[Kind; 10]`); update the unit test (`ALL.len() == 10`, both strings and columns).
   - `pub fn post_group(post_id: &str) -> String` → `"post:{post_id}"` (both kinds use it; groups are per kind).
   - `NewNotification` gains `pub post_id: Option<String>` (notifications.post_id; both post kinds) and `pub event_post_reply_id: Option<String>` (`postReply`: the new reply).
   - `try_notify`: the notifications insert writes `post_id` (bind `?11`), and the event insert writes `post_reply_id` (ARCHITECTURE § F031 "Write path"). Settings, mutes (`?5`/`?9` NULL → no mute matches) and dedupe are unchanged.
   - `Notification` gains `pub post_id: Option<String>` (doc: "F031: postReply/postHeart only; null otherwise").
   - `NotificationSettings` / `SettingsPatch` / `load_settings` / `update_settings` gain `post_replies` and `post_hearts` (`?11`, `?12`).
   - `list_page`: select `n.post_id`; the two batched queries and per-kind fields in ARCHITECTURE § F031 "Read path". Every `match b.kind` gains the two kinds.
4. **Every `NewNotification { … }` literal** (`routes/comments.rs` ×4, `routes/follows.rs`, `routes/collections.rs`, `routes/screenshots.rs`, `tests/review4.rs`) gains `post_id: None, event_post_reply_id: None`.
5. **`src/routes/notifications.rs`**: `postReplies: field("postReplies")?` and `postHearts: field("postHearts")?` (messages `postReplies must be a boolean`, `postHearts must be a boolean`).
6. **`src/routes/posts.rs`**:
   - `POST_SELECT` gains `p.hearts, p.reply_count, p.locked_at`.
   - `Post` gains `hearts: i64`, `my_heart: bool`, `reply_count: i64`, `locked: bool` (doc comments per API § F031).
   - `posts_for`: one extra query for `my_heart` when the viewer is signed in (ARCHITECTURE § F031 "Post assembly"). Still a fixed number of queries per call.
   - `remove_post`: the extended report resolution (ARCHITECTURE § F031 "Delete").
   - `pub(crate) async fn post_meta(state, id) -> AppResult<PostMeta { author_id, locked }>` (404 `Post not found`), used by the new handlers.
   - **`heart_post` / `unheart_post`** (🔒): auth → `post_meta` (404) → `limit_user(Limit::Heart)` (429) → `PUT` on own post → 422 `You can't heart your own post`. `PUT`: `INSERT OR IGNORE INTO post_hearts … WHERE EXISTS (post)`; when a row was inserted, `notify_pool` a `postHeart` (`Dedupe::Actor`, `post_id`, `event_post_reply_id: None`, `game_id: None`, `comment_id: None`, `thread_id: None`, `collection_id: None`). `DELETE`: delete the row; when removed, `retract_pool(author, Kind::PostHeart, post_group(id), user)`. Both return `PostHeartResponse { hearted, hearts }` with `hearts` re-read from `posts.hearts` (404 if the post vanished).
   - **`lock_post` / `unlock_post`** (🔒): auth → `post_meta` (404) → author or `is_admin` else 403 → `limit_user(Limit::ThreadTools)` (429) → `UPDATE posts SET locked_at = COALESCE(locked_at, ?2) WHERE id = ?1` (lock) or `SET locked_at = NULL` (unlock) → 200 `load_post` for the caller. No notifications.
7. **`src/routes/post_replies.rs`** (new; the module doc names API § F031):
   - **Constants:** `POST_REPLY_CAP: i64 = 200`, `POST_REPLIES_PER_PAGE_DEFAULT: i64 = 50`, `POST_REPLIES_PER_PAGE_MAX: i64 = 200`; `const REPLIES_OFF: &str = "Replies are turned off for this post";`.
   - **Serde:** `PostReply` (camelCase; `id`, `post_id`, `author: UserRef`, `reply_to: Option<UserRef>`, `body`, `created_at`, `by_post_author: bool`, `can_delete: bool`, `path`), `CreatePostReplyBody { body: String, #[serde(default)] reply_to_id: Option<String> }`.
   - **`REPLY_SELECT`** and `replies_from_rows(rows, viewer, admin)` per ARCHITECTURE § F031.
   - **`list_post_replies`** (🔓): `post_meta` (404) → `parse_paging(page, perPage, 50)` with `perPage` clamped to 1–200 (non-integer → 400) → `total` = `posts.reply_count` → the page → `Page<PostReply>`. No rate limit.
   - **`create_post_reply`** (🔒), in this order: auth; JSON extractor; `post_meta` (404); `limit_user(Limit::PostReply)`; `validate_post_body`; `replyToId` lookup (`SELECT post_id, author_id FROM post_replies WHERE id = ?`, a miss or another post → 404 `Reply not found`); moderator = author of the post or `is_admin` (loaded only when the post is locked); locked and not moderator → 422 `REPLIES_OFF`; `BEGIN IMMEDIATE`, the guarded insert (0 rows → roll back, re-read: post gone → 404 `Post not found`, locked and not moderator → 422 `REPLIES_OFF`, else 422 `This post has reached 200 replies`); commit; notify (below); 201 with the reply as the caller sees it.
   - **Notify** (after the commit, best effort): recipients = the post's author and the `replyTo` user, deduplicated, never the poster. Each gets `Kind::PostReply`, `group_key: post_group(post_id)`, `post_id: Some`, `event_post_reply_id: Some(reply id)`, `Dedupe::None`, everything else `None`.
   - **`pub async fn remove_post_reply(state, id) -> AppResult<()>`**: one transaction: resolve open `postReply` reports on it with `delete`, then delete the row (notification events cascade). An unknown id is a no-op.
   - **`delete_post_reply`** (🔒): unknown → 404 `Reply not found`; not the reply author, the post author or an admin → 403; `remove_post_reply`; 204. No rate limit.
8. **`src/routes/reports.rs`**:
   - `TARGET_TYPES` += `"postReply"`; `unknown_target_type` → `targetType must be "game", "comment", "screenshot", "collection", "user", "post" or "postReply"`.
   - The create match returns a third value, `target_post_id: Option<String>`: `Some(post id)` for `"post"`, `Some(reply.post_id)` for `"postReply"`, `None` otherwise. The insert writes `target_post_id`.
   - `"postReply"` branch: `SELECT post_id, author_id, body FROM post_replies WHERE id = ?` (miss → 404 `Reply not found`; own → 422 `You can't report your own reply`); preview = the first 140 code points; `target_game_id` NULL.
   - `Report` gains `target_post_id: Option<String>` (doc: "F031: the post of a `post` or `postReply` report; null otherwise and for older rows of other types"), read in `report_from_row`.
   - Resolve: `("delete", "postReply") => remove_post_reply(&state, &report.target_id).await?`. The validity table is otherwise unchanged (`postReply` behaves like the "comment / screenshot / collection / post" column).
9. **`src/routes/mod.rs`**: `pub mod post_replies;` and the routes:
   - `.route("/posts/{id}/replies", get(post_replies::list_post_replies).post(post_replies::create_post_reply))`;
   - `.route("/post-replies/{id}", delete(post_replies::delete_post_reply))`;
   - `.route("/posts/{id}/heart", put(posts::heart_post).delete(posts::unheart_post))`;
   - `.route("/posts/{id}/lock", put(posts::lock_post).delete(posts::unlock_post))`.
10. **Existing tests** (only these assertions change):
    - `tests/f007.rs` lines ~485 and ~502: the full settings objects gain `"postReplies": true, "postHearts": true`;
    - `tests/f008.rs` (~1403), `tests/f028.rs` (~863) and `tests/f030.rs` (~1308): the new `targetType` message;
    - `tests/f018.rs` `SCHEMA_OF`: add `idx_notifications_post` and `idx_notification_events_post_reply` to the excluded names. Its dedupe normalisation still works, because the new definition still contains `IFNULL(screenshot_id, '')`;
    - `tests/review4.rs`: the two new `NewNotification` fields.
11. **`tests/f031.rs`** (§ 6).

**Acceptance:** `cd backend && cargo test` (every suite green, including `f006`, `f007`, `f018`, `f024`, `f030` and `review4`) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`; export new ones from `src/index.ts`):
   - `Post` gains optional `hearts?: number`, `myHeart?: boolean`, `replyCount?: number`, `locked?: boolean` (doc: "F031. Older servers omit them: hide hearts and replies.");
   - `PostReply`, `CreatePostReplyRequest`, `PostHeartResponse` per API § F031;
   - `NotificationKind` += `"postReply" | "postHeart"`; `Notification.postId?: string | null`;
   - `NotificationSettings.postReplies?: boolean`, `postHearts?: boolean` (hide the switch when missing);
   - `ReportTargetType` += `"postReply"`; `Report.targetPostId?: string | null`.
2. **Client** (`src/api/client.ts`):
   - `listPostReplies(postId: string, query: PageQuery = {}, signal?: AbortSignal): Promise<Page<PostReply>>`;
   - `createPostReply(postId: string, body: CreatePostReplyRequest): Promise<PostReply>`;
   - `deletePostReply(id: string): Promise<void>` (`DELETE /api/post-replies/{id}`);
   - `heartPost(id)`, `unheartPost(id)`, `setPostHeart(id: string, heart: boolean): Promise<PostHeartResponse>`;
   - `lockPost(id: string): Promise<Post>`, `unlockPost(id: string): Promise<Post>`.
3. **Pure helpers** (`src/posts.ts`):
   - `POST_REPLY_CAP = 200`; `REPLY_LINES_MESSAGE = "Replies can have at most 12 lines."`;
   - `validatePostBody(raw, linesMessage = POST_LINES_MESSAGE)` (existing callers unchanged);
   - `postReplyPath(postId, replyId)` = `/p/{encodeURIComponent(postId)}?reply={encodeURIComponent(replyId)}`;
   - `repliesLinkText(n): string` and `repliesLinkLabel(n, name): string` (§ 0.11);
   - `hasPostSocial(post): boolean` = `typeof post.hearts === "number" && typeof post.replyCount === "number"`;
   - `isValidPostReply(x)` (object with string `id`, `postId`, `body`, `createdAt`, `path` and an `author` with a string `username`); the thread drops invalid items.
4. **`src/notifications.ts`**: `NOTIFICATION_KINDS` += both kinds; `notificationParts` for both (§ 0.9 table); `muteActionFor` returns null for them (explicit cases); `osNotificationText` unchanged.
5. **Components**:
   - **`HeartButton`**: new optional props `subject?: "comment" | "post"` (default `"comment"`, used in the aria-label) and `onToggle?: (on: boolean) => Promise<HeartState>` (replaces `api.setCommentHeart` when given). Existing behaviour and tests unchanged.
   - **`PostCard`**: § 0.11, including `inThread`. The heart uses `onToggle = (on) => api.setPostHeart(post.id, on).then(r => ({ hearts: r.hearts, myHeart: r.hearted, creatorHeart: false }))`.
   - **`components/PostThread.tsx`** (new): `PostThread`, `PostReplyItem`, `PostReplyForm` (§ 0.12–0.15).
   - **`NotificationItem`**: the two glyphs.
   - **`NotificationSettings`**: the two fields (§ 0.10).
   - **`Report.tsx`**: `"postReply"` → `"reply"`.
6. **Pages**:
   - **`PostPage`**: § 0.16 (local post state, `inThread`, `PostThread`, reads `?reply` with `useSearchParams`).
   - **`AdminPage`**: § 0.17.
7. **Styles** (`styles.css`): `.pf-post__replies`, the actions-row wrap, `.pf-post-thread` (`__head`, `__list`, `__empty`, `__locked`, `__login`, `__gone`), `.pf-post-reply` (`__head`, `__author`, `__time`, `__replyto`, `__actions`, `--highlight`), `.pf-post-reply-form` (`__replyto`), `.pf-notif__kind--post-reply`, `.pf-notif__kind--post-heart`, `.pf-badge--postReply`, and the 640 px rules (§ 0.18). Existing tokens only.
8. **Exports** (`src/index.ts`): `PostThread`, `PostReplyItem`, `PostReplyForm`, `postReplyPath`, `repliesLinkText`, `hasPostSocial` and the new types.
9. **Tests** (§ 6). Existing suites stay green. In particular:
   - the F030 `postFixtures.ts` posts have no F031 fields, so the F030 `PostCard` tests keep passing unchanged; add F031 fixtures next to them;
   - any NotificationSettings test that counts switches is updated for the two new fields when the fixture sends them.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`, `npm test -w @webgame/desktop`.

### desktop-dev (`apps/desktop/**`)
1. **`src/__tests__/f031.desktop.test.tsx`**, using the `f030.desktop.test.tsx` pattern (the real `App` under the hash router, `SERVER_STORAGE_KEY` = `http://192.168.1.5:8080`, mocked `fetch` and Tauri modules, signed in as `mia`). Post `p1` by `mia` has `hearts: 2`, `myHeart: false`, `replyCount: 2`, `locked: false`. Replies: `r1` by `leo` with the body `Nice! https://example.com/x`, and `r2` by `mia` answering `r1` (`replyTo` = leo). Assert:
   - on `#/p/p1?reply=r1`: the heading reads `Replies (2)`; `#reply-r1` has `pf-post-reply--highlight` and is `document.activeElement`; its link `https://example.com/x` has `target="_blank"` and a `rel` containing `noopener` and `noreferrer`; `r2` shows the `Author` badge and `Replying to @leo`;
   - `Turn off replies` is shown (mia is the author), and pressing it sends `PUT http://192.168.1.5:8080/api/posts/p1/lock`;
   - a mocked `postReply` notification (`path: "/p/p1?reply=r1"`) renders on `#/notifications` as a link whose `href` is `#/p/p1?reply=r1`, with the text `Leo replied to your post`;
   - `osNotificationsFor([that item])[0].body` is `Leo replied to your post` (no reply text).
2. No source changes: no menu item.

**Acceptance:** `npm run build -w @webgame/desktop`, `npm test -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test` and `cargo check`.

### engine-dev
None.

### Docs (project-manager, after the round)
- README "Features": extend the **Posts** bullet with "hearts and replies (with notifications), and the author can turn replies off".
- ROADMAP: F031 → shipped.

### Sequencing
backend-dev and frontend-dev work in parallel against API § F031 (the frontend mocks responses). desktop-dev's test needs the built `@webgame/ui`, so it runs after frontend-dev lands.

## 5. Edge cases and security
- **XSS and link abuse.** Reply bodies use the F030 rules and `PostBody`: React text, links only for `isSafeProfileUrl` URLs, `noopener noreferrer nofollow ugc`. Bidi and zero-width characters are rejected server-side.
- **Spam.** `Limit::PostReply` (30 per 10 min), the 200-reply cap, author lock, author and admin delete, reports. Hearts are idempotent, rate-limited, and notify once per hearting user (actor dedupe; review 4 toggle rule).
- **Harassment.** The post author can delete any reply on their post and turn replies off. Reply notifications reach only the post author and the `replyTo` user, never other participants.
- **Races.**
  - Two replies at reply 199: the guarded insert under `BEGIN IMMEDIATE` lets one through; the other gets 422 cap.
  - A reply racing a lock: the guarded insert re-checks `locked_at`, so it is either accepted before the lock or rejected with 422.
  - A reply racing a post delete: the guarded insert's `EXISTS` fails → 404 `Post not found`. A notification write for a reply deleted in between fails its FK, rolls back and is logged.
  - Heart racing a post delete: `INSERT … WHERE EXISTS` writes nothing; the re-read gives 404.
- **Counters.** `posts.hearts` and `posts.reply_count` are maintained by triggers (the review 6 `comments.hearts` pattern), so cascades (user delete, post delete) keep them right. `INSERT OR REPLACE` is never used on `post_hearts` (its implicit delete would skip the trigger).
- **Deletion cascade.** Deleting a post deletes its replies, hearts, `postCreated` event and both kinds' notifications (FKs), and resolves open reports on the post and its replies (in `remove_post`'s transaction). `PRAGMA foreign_key_check` stays empty.
- **Older servers.** Without the F031 fields, cards are F030 cards and the permalink has no thread. The settings switches hide themselves.
- **Older clients.** They ignore unknown notification kinds (F007 rule) and unknown `Post` fields. The `postReply` report target shows with Dismiss only (`reportActions` default).
- **Privacy.** Replies are public like posts. Who hearted a post is visible only to its author, through notifications. `excerpt` is read at request time, so deletes apply at once. OS notifications carry no post or reply text.

## 6. Test expectations

### Backend (`tests/f031.rs`)
- **Upgrade.** Migrate a file database to version ≤ 25 (the `tests/f024.rs` pattern with `filter(|x| x.version <= 25)`). Insert a user, a post, a notification with one event, a settings row and an open `post` report. Run `AppState::new`, then assert: the post has `hearts = 0`, `reply_count = 0`, `locked_at` NULL; the settings row has `post_replies = 1`, `post_hearts = 1`; the report's `target_post_id` equals its `target_id`; the dedupe index SQL contains `IFNULL(post_reply_id, '')` and `IFNULL(screenshot_id, '')`; the four new triggers exist; `PRAGMA foreign_key_check` is empty and `integrity_check` is `ok`.
- **Post fields.** A new post → `hearts: 0`, `myHeart: false`, `replyCount: 0`, `locked: false` in the `POST` response, `GET /api/posts/{id}`, the profile list and the feed item.
- **Hearts.**
  - Leo `PUT` → `{ hearted: true, hearts: 1 }`; again → still 1; Leo's `GET` → `myHeart: true`; anonymous → `myHeart: false`, `hearts: 1`.
  - Mia (author) `PUT` → 422 `You can't heart your own post`; her `DELETE` → `{ hearted: false, hearts: 1 }`.
  - `DELETE` by Leo → `hearts: 0`. Unknown post → 404 `Post not found`. Anonymous → 401. With a `ManualClock`, 120 heart requests → the 121st → 429.
  - Deleting Leo's account → the count drops (trigger).
- **Replies.**
  - Leo replies `{ body: "  hi\r\nthere " }` → 201: `body == "hi\nthere"`, `replyTo: null`, `byPostAuthor: false`, `canDelete: true`, `path == "/p/{postId}?reply={id}"`; the post's `replyCount` is 1.
  - Every F030 body message, via the reply endpoint.
  - `replyToId` = Leo's reply, by Mia → `replyTo` = Leo, `byPostAuthor: true`. Leo answering his own reply → `replyTo: null`. A reply of another post → 404 `Reply not found`. `replyToId: 3` → 422. Unknown post → 404 `Post not found`. Anonymous → 401.
  - List: oldest first (`createdAt`, then insertion order), `total` = `replyCount`, `perPage` default 50, clamp 1–200, `page=x` → 400, unknown post → 404 even with a bad `page`. The page plan uses `idx_post_replies_post_created` without `USE TEMP B-TREE`.
  - `canDelete`: true for the reply author, the post author and an admin; false for others and anonymous.
  - Cap: with `RATE_LIMIT=off`, 200 replies → the 201st → 422 `This post has reached 200 replies`; deleting one allows one more.
  - `Limit::PostReply`: with a `ManualClock`, 30 → the 31st → 429.
- **Lock.**
  - Leo `PUT /lock` → 403. Mia → 200 `locked: true`; again → 200, `locked_at` unchanged. An admin → 200.
  - While locked: Leo's reply → 422 `Replies are turned off for this post`; Mia's and the admin's replies → 201. Hearts, deletes and reports still work.
  - `DELETE /lock` → `locked: false`, and Leo can reply again. No notification is written by lock or unlock.
- **Delete.**
  - Kai (neither) → 403. The reply author → 204. The post author → 204. An admin → 204. Again → 404 `Reply not found`. Anonymous → 401.
  - Deleting the post removes its replies, hearts and notifications, and resolves open `post` and `postReply` reports on it and its replies.
- **Notifications.**
  - Leo replies to Mia's post → Mia has one unread `postReply`: `actors` = [Leo], `eventCount: 1`, `ownsThread: true`, `postId`, `excerpt` = Leo's body, `path` = `/p/{postId}?reply={leoReplyId}`, `game: null`, `commentId: null`, `threadId: null`.
  - Leo replies again → the same notification, `eventCount: 2`, path points at the newer reply. Kai replies → `actorCount: 2`.
  - Mia answers Leo's reply → Leo gets `postReply` with `ownsThread: false`; Mia gets nothing (never the actor). Leo answering Mia's reply on Mia's post → Mia gets one event, not two.
  - Deleting Leo's newest reply → `eventCount` drops and `path` points at the remaining newest one; deleting every reply in the group deletes the notification (read or unread).
  - Leo hearts → Mia gets `postHeart` (`excerpt` = the post body, `path` = `/p/{postId}`). Un-heart while unread → it is no longer listed; heart again → restored without moving (review 4 rule). Kai hearts → `actorCount: 2`.
  - `postReplies: false` → no `postReply` for that user; `postHearts: false` → no `postHeart`. A game mute or thread mute never suppresses them.
  - Deleting the post deletes both notifications. `unread-count` reflects every change.
  - `GET /api/notifications/settings` includes both fields (default true); `PUT { "postHearts": 1 }` → 422 `postHearts must be a boolean`.
- **Reports.**
  - Kai reports Leo's reply → 201: `targetType: "postReply"`, `targetPreview` = the first 140 code points, `targetGameId: null`, `targetPostId` = the post. A `post` report gets `targetPostId` = the post id. Other types → `targetPostId: null`.
  - Again → 409. Own reply → 422 `You can't report your own reply`. Unknown → 404 `Reply not found`.
  - Admin `delete` → the reply is gone and a second open report on it is resolved. `unpublish` → 422 `unpublish is only valid for game reports`. `clearProfile` → 422 `clearProfile is only valid for user reports`.
  - An unknown `targetType` → the new message.

### Frontend (vitest)
- **`posts.f031.test.ts`**: `postReplyPath` encodes; `repliesLinkText(0/1/5)` = `Reply` / `1 reply` / `5 replies`; `repliesLinkLabel`; `validatePostBody(x, REPLY_LINES_MESSAGE)` on 13 lines; `hasPostSocial`; `isValidPostReply`.
- **`notifications.f031.test.ts`**: every row of the § 0.9 table (including `A and B`, `A and 2 others`, `replied 3 times`); `muteActionFor` → null for both; `osNotificationText` equals `notificationText` for both; `isKnownNotification` accepts both.
- **`HeartButton.f031.test.tsx`**: `subject="post"` → `Heart post by Mia, 2 hearts`; `onToggle` is called instead of `setCommentHeart`, with optimistic update and rollback on failure.
- **`PostCard.f031.test.tsx`**: the heart (interactive for others, static for the author and anonymous), the replies link texts, labels and `href`, the link hidden when `locked && replyCount === 0` and when `inThread`; an F030 fixture without the fields renders no heart and no link.
- **`PostThread.test.tsx`**:
  - loads with `{ page: 1, perPage: 200 }`; heading `Replies` / `Replies (2)`; loading, error (`Couldn't load replies.` + Retry) and `No replies yet.`;
  - reply item: author link, `Author` badge, `Replying to @leo`, time link to `reply.path`, linkified body;
  - form: counter and `is-over`, disabled states, Ctrl+Enter, the 12-line message `Replies can have at most 12 lines.`, the request body `{ body, replyToId }`, success (append, clear, toast `Reply posted`, focus textarea, `onPostChange` with `replyCount + 1`), a 422 in the Alert, the lock 422 calls `onPostChange` with `locked: true`;
  - `Reply` on a reply sets `Replying to @leo` and focuses the textarea; `✕` clears it; replying to your own reply shows no "Replying to";
  - delete: dialog texts, toast `Reply deleted`, focus next / previous / textarea / heading, failure toast;
  - lock toggle: shown only with `canDelete`, texts, toasts, `aria-busy`, `onPostChange`;
  - locked: the notice; others get no form; the author gets the form with `Replies are turned off. You can still reply.`; anonymous gets `Log in to reply.` only when not locked, with `next` = the current path and search;
  - Report on replies: shown for non-authors (anonymous too), heading `Report reply`.
- **`PostPage.f031.test.tsx`**: the thread renders below the actions; `?reply=r1` highlights and focuses `#reply-r1`; a missing id shows `That reply is no longer available.`; changing `?reply` to an unloaded id reloads once; an older-server post (no fields) renders no thread.
- **`NotificationSettings.f031.test.tsx`**: both switches after `pins` with the exact labels and hints, hidden when the fields are missing, partial `PUT`.
- **`NotificationItem.f031.test.tsx`**: glyphs, excerpt, link to `path`.
- **`AdminPage.f031.test.tsx`**: a `postReply` row with the quote, `View in context →` → `/p/{targetPostId}?reply={targetId}` (absent when `targetPostId` is null), Dismiss and Delete, the confirm title `Delete this reply?`.
- **`ApiClient.f031.test.ts`**: methods, paths and verbs for the nine calls.

### Desktop (vitest + cargo)
As listed in § 4 desktop-dev.

### Manual end to end
1. Leo hearts Mia's post in his feed; the count changes at once. Mia's bell shows "Leo hearted your post".
2. Leo opens the post, replies with a link, and the link opens in a new tab (the system browser on desktop). Mia gets "Leo replied to your post"; clicking it scrolls to and highlights the reply.
3. Mia answers Leo's reply; it shows "Author" and "Replying to @leo". Leo gets "Mia replied to you on a post".
4. Mia turns replies off. Leo sees "Replies are turned off for this post." and no form; Mia still has the form.
5. Kai reports Leo's reply; the admin opens "View in context →" and deletes it. The thread count drops and Mia's notification updates.
6. At 360 px the reply form's button is full width and reply heads wrap cleanly.

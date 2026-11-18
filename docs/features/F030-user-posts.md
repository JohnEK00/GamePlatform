# F030: User posts: short text posts on profiles and in followers' feeds

Status: **specced**. Size: **M**. One round. Areas: backend, frontend, desktop (verification only). Engine: none.

Size breakdown:
- **backend:** migration `0025_f030.sql` (a `posts` table and one `activity_events` rebuild that follows the F021 template), `routes/posts.rs` with four endpoints, `Limit::Post`, a fourth `FEED_SQL` branch with batched assembly, a `post` report target, and `ProfileStats.posts`.
- **frontend:** `posts.ts` helpers, `PostCard`, `PostComposer`, `ProfilePosts`, a Posts section in the F028 shell, a permalink page `/p/{id}`, a Posts feed tab, "Post about this" entry points, and admin rows.
- **desktop:** one verification test, no source changes.

Contracts: `docs/API.md` § F030 additions, `docs/ARCHITECTURE.md` § F030 additions (normative migration SQL, feed branch, assembly), `docs/GAME_FORMAT.md` § F030 additions (no changes).

Depends on: F002 (follows, feed), F008 (collections, report flow without a `target_type` CHECK), F015/F021 (feed branches and batched assembly), F028 (profile shell, `isSafeProfileUrl`, forbidden-character set, `CopyLinkButton`, `appShareUrl`). All shipped. Migrations exist up to `0024_f028.sql`; this round's is **`0025_f030.sql`**.

No new Rust or JS dependencies. No engine or example changes. **No notifications.**

## 0. Decisions on ambiguities (read first)
API § F030 is normative. Tests assert the texts below verbatim. `{name}` means display name, falling back to username.

1. **Scope.** In this round:
   - text posts with an optional attachment of one game or one collection;
   - a Posts section in the F028 profile shell and a Posts shelf on the Overview;
   - a permalink page;
   - a `postCreated` feed kind and a Posts feed tab;
   - delete by the author or an admin;
   - reports with a `delete` action;
   - "Post about this" entry points on game and collection pages.

   **Replies and hearts wait for F031.** They need two more tables, two notification kinds with settings, F018 thread mutes and a thread UI. Together that is a second M. F030 writes **no** notifications of any kind.

   **F029 (featured games) stays separate.** It is a clean S, but adding it would push the frontend past one round (picker dialog plus Overview row on top of everything here). It should run next (see the ROADMAP).

   F022 ("announce a collection") is covered by a post with a collection attachment, reached through "Post about this" on the collection page.
2. **No attachment picker in the composer.** Attachments come only from the **✎ Post about this** entry points (§ 0.12). They open the composer with the attachment prefilled through `?attach=`. Under the composer, the hint reads `To attach a game or collection, use “Post about this” on its page.`. A search-based picker is the follow-up F039.
3. **Body rules** (server, API § F030 "Body rules", in this order; the client mirrors them):
   1. `\r\n` and `\r` become `\n`.
   2. The text is trimmed (Rust `str::trim`; client `String.prototype.trim`).
   3. **Length:** **1–500 code points** (Unicode scalar values; the client counts `[...s].length`).
   4. **Lines:** at most **12 lines** (at most 11 `\n`).
   5. **Characters:** none of the F028 forbidden characters except `\n`. The forbidden characters are C0 controls, including `\t`, U+007F–U+009F, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069 and U+FEFF.

   The stored body is the normalised, trimmed text. Interior blank lines are kept as typed (the 12-line cap bounds them).
4. **Rendering: plain text with linkified URLs.** Bodies are never HTML or Markdown. `@mentions`, `#tags` and bare domains (`example.com`) stay text. The pure helper `linkifyPost(body)` returns segments by this exact algorithm:
   1. **Find candidates:** every match of `/https?:\/\/\S+/gi` that is at the start of the body, or right after a whitespace character, or right after one of `( [ { < " '`.
   2. **Trim the end of each candidate:** while its last character is one of `. , : ; ! ? ' " ] } >`, remove it. Also remove a final `)` while the candidate has more `)` than `(`.
   3. **Link or text:** if the trimmed candidate passes `isSafeProfileUrl` (F028: printable ASCII, http(s), plain host with a dot, at most 200 characters), it becomes a link segment. Removed trailing characters go back into the following text segment. Otherwise the whole match stays text.

   A link renders as `<a href={url} target="_blank" rel="noopener noreferrer nofollow ugc">{url}<span className="pf-sr-only"> (opens in a new tab)</span></a>`, with the text exactly as written. The body paragraph uses `white-space: pre-wrap; overflow-wrap: anywhere`, so long URLs wrap. A post is never truncated or collapsed: 500 characters fit.
5. **Attachments** (API § F030 "Attachments"):
   - **At most one.** Sending both `gameId` and `collectionId` as strings → 422 `A post can have at most one attachment`.
   - **Game:** unknown or not visible to the author → 404 `Game not found`. Visible but unpublished (the author's own draft) → 422 `Only published games can be attached`.
   - **Collection:** unknown or not visible to the author → 404 `Collection not found`. The author's own private collection (or, for an admin, anyone's) → 422 `Only public collections can be attached`. Anyone's public collection may be attached, and empty ones are allowed.
   - **At read time** the attachment is resolved for the viewer: a game the viewer can see (published, or owned by the viewer), or a collection the viewer can see (F008: public, or the viewer is its owner or an admin). Otherwise it is `null` inside a non-null `attachment`, and the card reads `This game is no longer available.` or `This collection is no longer available.`.
   - When the target is deleted, `ON DELETE SET NULL` keeps the attachment type, so the same placeholder shows. The post itself is never hidden because of its attachment.
6. **Caps.**
   - `Limit::Post`: **10 per 10 min** per user. Like `Limit::Comment`, it is checked before validation, so a 422 uses a token.
   - At most **25 posts in any rolling 24 hours** per user → 422 `You can post at most 25 times in 24 hours`. This is enforced by a guarded insert, so concurrent posts can't exceed it.
   - Deleting a post doesn't free a slot in either.
   - There is no lifetime cap.
7. **Who sees what.**
   - Posts are public: anyone, including anonymous visitors, can read `GET /api/posts/{id}` and `GET /api/users/{u}/posts`. There is no private post.
   - The feed shows `postCreated` only to **followers** of the author. The favorites clause never applies, and your own posts never appear in your own feed (the F002 rule 2).
   - Admin `clearProfile` (F028) leaves posts in place. Deleting a user deletes their posts.
8. **Profile shell** (`ProfilePage`):
   - The strip gains `Posts` + count = `stats.posts`, as the **second** link (after Overview). Its URL is `/u/{u}/posts`, with no paging query.
   - The link is **hidden** while `typeof profile.stats?.posts !== "number"` (older server).
   - `ProfileSection` gains `"posts"`.
9. **Overview** (`ProfileOverview`), new order:
   1. `RecentAchievements`;
   2. **Posts shelf** `<ProfilePosts key={"posts:" + username} username isMe preview={3} />`;
   3. Games;
   4. Screenshots;
   5. Collections.

   The shelf heading is `<h2 className="pf-section-title">Posts</h2>`. When `total > 3`, the shelf head has `<Link className="pf-shelf__more" to="/u/{u}/posts">See all {total} posts →</Link>`. Neither the shelf nor the Posts section renders a composer.

   Empty and error states of the shelf:
   - On another user's profile, it is omitted while loading, when empty, on an error, and on a 404 (the ProfileScreenshots rules).
   - On your own profile with 0 posts, it shows `<EmptyState icon="✎" title="No posts yet" action={<Link className="pf-btn pf-btn--primary" to="/u/{me}/posts">Write a post</Link>}>Share an update with your followers.</EmptyState>`.

   **Empty overview:** the F028 all-zero rule also requires `(stats.posts ?? 0) === 0`.
10. **Posts section** (`ProfilePostsTab`, `/u/{u}/posts`):
    - **Title:** `useDocumentTitle("Posts · {name}")`.
    - **Heading:** `<h2 className="pf-section-title" tabIndex={-1}>Posts</h2>` (`tabIndex={-1}` so focus can land on it).
    - **Own profile:** the `PostComposer` comes next, then the list.
    - **List:** `<ProfilePosts username isMe />`, 20 per page, newest first, with **Load more** (offset paging through the existing `pagesForOffset`, as ProfileScreenshots does, so a local delete never skips a post).

    Empty states:
    - Own profile: `<EmptyState icon="✎" title="No posts yet">Posts appear here and in your followers' feeds.</EmptyState>` below the composer.
    - Others, when `stats.posts === 0`: `<EmptyState icon="✎" title="No posts yet">{name} hasn't posted anything yet.</EmptyState>`.

    Errors:
    - The first load: `LoadError` `Couldn't load posts.` with Retry.
    - Load more: `Couldn't load more: {message}` with Retry.
11. **Composer** (`PostComposer({ onPosted, initialAttach })`), a `<form className="pf-post-composer" aria-label="New post">`:
    - **Text field:** a `<textarea className="pf-input" rows={3}>` labelled by a sr-only `<label>` `Post text`, with `placeholder="Share an update with your followers…"` and `aria-describedby` = the counter id plus the hint id. It has **no `maxLength`**, because that counts UTF-16 units.
    - **Counter:** `<span className="pf-post-composer__count" id=…>{n} / 500</span>`, where `n` = code points of the normalised, trimmed text. Over 500 it reads `{n} / 500 · {n − 500} too many` and gets `is-over` (danger colour).
    - **Attachment preview:** when an attachment is set, the § 0.13 card for it plus a button `<button className="pf-btn pf-btn--ghost pf-btn--sm" aria-label="Remove attachment">✕ Remove</button>`.
    - **Hint:** `<p className="pf-field__hint" id=…>` with the § 0.2 text. It is hidden while an attachment is set.
    - **Error:** an `Alert` slot.
    - **Submit:** a `Post` button (`pf-btn pf-btn--primary`). It is disabled while `n === 0`, `n > 500` or busy, and shows a `Spinner` while busy. **Ctrl+Enter / Cmd+Enter** in the textarea submits.

    On submit, the client checks run in this order and the first failure shows in the Alert, with no request sent:
    - more than 12 lines → `Posts can have at most 12 lines.`;
    - a forbidden character → `Remove tabs, control characters and invisible formatting characters.`

    A server error shows `errorMessage(err)` in the Alert (for example the 24-hour cap message).

    **Success:**
    - the text and the attachment are cleared;
    - `?attach` is removed from the URL (`replace`);
    - `onPosted(post)` prepends the post to the list and calls the shell's `reload()`, so the tab count updates without remounting;
    - the toast `Post published` shows;
    - focus is on the **textarea**.

    **Remove attachment** clears it, removes `?attach` (`replace`) and focuses the textarea.
12. **"✎ Post about this" entry points** (`<Link className="pf-btn pf-btn--ghost pf-btn--sm">`, shown only when signed in):
    - **GamePage**, in `.pf-gamepage__actions` right after `AddToCollectionButton`, only when `game.published`: links to `postComposePath(me.username, { type: "game", id: game.id })`.
    - **CollectionPage**, in `.pf-collection-head__actions` right after Copy link, only when the collection is public: links to `postComposePath(me.username, { type: "collection", id: c.id })`.

    `postComposePath(u, a)` = `/u/{encodeURIComponent(u)}/posts?attach={a.type}:{encodeURIComponent(a.id)}`.

    On the Posts section of **your own** profile, a valid `?attach=` is parsed by `parseAttachParam` (`game:{id}` or `collection:{id}`; anything else → null, ignored silently). The composer then:
    - loads the target (`api.getGame(id)` / `api.getCollection(id)`);
    - shows the attachment preview;
    - focuses the textarea and scrolls the composer into view (`block: "nearest"`).

    Load failures show in the composer's Alert, the attachment isn't set and `?attach` is removed:
    - a 404 → `That game isn't available.` / `That collection isn't available.`;
    - a game with `published: false` → `Only published games can be attached.`;
    - a collection with `visibility: "private"` → `Only public collections can be attached.`;
    - any other error → `errorMessage(err)`.

    On another user's profile `?attach` is ignored.
13. **Post card** (`PostCard({ post, onDeleted?, feedId? })`): `<article className="pf-post" tabIndex={-1} aria-labelledby={whoId}>` (plus `data-kind="postCreated" data-feed-id={feedId}` when `feedId` is set). It contains:
    1. **Head** `.pf-post__head`:
       - an avatar link (`Avatar size={40}`, `tabIndex={-1}`, `aria-hidden`, to `/u/{u}`);
       - then `<div id={whoId} className="pf-post__who">` with:
         - `<Link to="/u/{u}" className="pf-post__author"><strong>{name}</strong></Link>`;
         - `<span className="pf-muted">@{username}</span>`;
         - `<span aria-hidden="true"> · </span>`;
         - `<Link to="/p/{id}" className="pf-post__time pf-muted"><time dateTime={createdAt} title={formatDate(createdAt)}>{timeAgo(createdAt)}</time></Link>`.
    2. **Body** `<p className="pf-post__body">` with the § 0.4 segments.
    3. **Attachment**, when `post.attachment` is non-null:
       - **game visible:** `<Link className="pf-post-attachment" to="/games/{id}">` containing a `Thumbnail` (`alt=""`, 120 px wide, 16:9), then `<strong>{title}</strong>` and `<span className="pf-muted pf-small">by {owner name}</span>`;
       - **collection visible:** `<Link className="pf-post-attachment" to={collection.path}>` containing a `CollectionCover` (120 px), then `<strong>{title}</strong>` and `<span className="pf-muted pf-small">{gameCount} game(s) · by {owner name}</span>`;
       - **target null:** `<p className="pf-post-attachment pf-post-attachment--gone pf-muted pf-small">` with the § 0.5 text;
       - **unknown `type`:** nothing.
    4. **Actions** `.pf-post__actions`:
       - `Delete` (`pf-btn pf-btn--ghost pf-btn--sm pf-btn--danger-text`, `aria-haspopup="dialog"`), shown when `post.canDelete`;
       - otherwise, when the viewer isn't the author (anonymous included; `ReportButton` prompts login), `<ReportButton targetType="post" targetId={post.id} className="pf-btn pf-btn--ghost pf-btn--sm">⚑ Report</ReportButton>`, with no `targetLabel`, so the dialog heading is `Report post`;
       - the row is omitted when both are absent.
14. **Delete.** A `ConfirmDialog` titled `Delete this post?`, with the body `It's removed from the profile and from followers' feeds. This can't be undone.`, `confirmLabel="Delete"` and `danger`.
    - **Success:** the toast `Post deleted`, then `onDeleted(post)`.
    - **Failure:** the toast `toast.error("Couldn't delete the post", errorMessage(err))`, the dialog closes and the post stays.

    **Focus after a delete:**
    - **In a list (profile section or shelf):** the post card now at the deleted one's index, else the previous card, else (own Posts section) the composer textarea, else the section heading.
    - **In the feed:** the F015 `focusAfter` rule, through the existing `onRemoved` + `onEmptied` props (the item stops counting).
    - **On the permalink page:** `navigate("/u/{u}/posts", { replace: true, state: { focusPostsHeading: true } })`. `ProfilePostsTab` focuses its `h2` on mount when that state is present.
15. **Permalink** `/p/:id` (`PostPage`, inside `Layout`, no auth):
    - **Layout:** `<div className="pf-container pf-page pf-post-page">`, max-width **640 px**, centred.
    - **Content:** `<h1 className="pf-sr-only">Post by {name}</h1>`, the `PostCard`, then `.pf-post-page__actions` with `<CopyLinkButton url={postShareUrl(config, id)} />` and `<Link to="/u/{u}/posts" className="pf-small">More posts by {name} →</Link>`.
    - **Title:** `Post by {name}`.
    - **Loading:** a `PostCardSkeleton` (a 40 px circle, a 160×14 bar, then 90% and 60% × 16 bars).
    - **404:** `NotFoundPage what="post"`, which gains the text `The post you're looking for doesn't exist or was deleted.` for `what === "post"`.
    - **Other errors:** `ErrorState` with Retry.
16. **Feed.**
    - **Tab:** `FeedTab` gains `"posts"`, label `Posts`, `kinds=["postCreated"]`, placed **second** (Everything, Posts, New games, Collections, Screenshots). `readTab` accepts `"posts"`.
    - **Write-a-post link:** on the Posts tab, above the list and above the empty state (not while loading or on error), `<p className="pf-feed__compose"><Link to="/u/{me}/posts">✎ Write a post</Link></p>`.
    - **Empty Posts tab:** `<EmptyState icon="✎" title="No posts yet.">Posts from people you follow appear here.</EmptyState>`, then `SuggestedCreators`.
    - **Item:** a `postCreated` item renders `PostCard` with `post = item.post` and `feedId = item.id`.
    - **Validation:** `isKnownFeedItem` accepts `postCreated` only with a valid `post` (`isValidPost`: an object with string `id`, `body` and `createdAt` and an `author` with a string `username`). It rejects items of any other kind whose `game` isn't an object.
17. **Admin.**
    - `KNOWN_TARGET_TYPES` += `"post"`, so `reportActions("post")` is `["dismiss", "delete"]` unchanged.
    - A post row shows `<blockquote className="pf-report-row__quote">{targetPreview}</blockquote>` and `<Link to="/p/{targetId}" className="pf-small">View post →</Link>`, with the badge `.pf-badge--post`.
    - `ACTION_COPY.delete` for posts has the title `Delete this post?` and the body `The post is removed permanently.`
18. **Responsive.**
    - **List:** posts are a single column at every width, `gap: 12px`, max-width 720 px inside the profile section.
    - **Attachment card:** a row (thumbnail left, text right) above 640 px. At ≤ 640 px the thumbnail stacks on top at full width.
    - **Composer:** at ≤ 640 px the counter and the Post button wrap under the textarea, with the button full width.
    - **Permalink:** at ≤ 640 px it uses the container's normal padding.
19. **Desktop.** There is no menu item. `/p/{id}` works under the hash router. Links in posts use `target="_blank"`, so `external.rs` opens them in the system browser. Copy link gives `{serverBase}/p/{id}`.

Non-goals (later items): replies and hearts (F031); images (F038); an attachment picker, drafts and editing (F039); notifications for followers; `@mentions`; editing posts; pinned posts; post view counts; link previews or Open Graph.

## 1. Goal and user stories
Today a user can talk to other people only through a game: comments, screenshots and collections. A creator can't say "new level next week", a curator can't say why a list exists, and a player can't share a recommendation with their followers. F030 adds short, plain-text posts that live on the profile and reach followers' feeds.

User stories:
1. As a creator, I write "Working on world 3, here's the new boss: https://youtu.be/…" on my profile. My followers see it in their feed, and the link works.
2. As a curator, I press **✎ Post about this** on my public collection and write why I made it. My followers see the post with the collection card (this replaces F022).
3. As a player, I press **✎ Post about this** on a game I love, and my post shows the game card.
4. As a visitor, I open `/u/mia/posts` and read Mia's posts, newest first, then open one at `/p/{id}` and copy its link.
5. As an author, I delete a post I regret. It disappears from my profile and from my followers' feeds at once.
6. As a player, I report an abusive post. An admin deletes it from the queue.
7. As a keyboard or screen-reader user, the composer has a label and a counter, every link says it opens a new tab, and focus lands somewhere sensible after posting and deleting.

## 2. UX notes
See § 0 items 8–18 for texts, order, focus and layout. Additional notes:
- **Card styling.** `.pf-post` is a card (`var(--pf-surface)`, `1px solid var(--pf-border)`, `var(--pf-radius)`, padding 16 px; 12 px at ≤ 640 px). `.pf-post__head` is a flex row with a 10 px gap. `.pf-post__who` wraps. `.pf-post__body` has `margin: 8px 0 0` and the text colour. `.pf-post-attachment` is a bordered, rounded block (`margin-top: 12px`), and hover/focus-visible uses the existing card hover outline.
- **Focus outline.** `.pf-post:focus-visible` gets the standard focus ring. Programmatic focus (`tabIndex={-1}`) shows no ring for mouse users, which is the existing `:focus-visible` behaviour.
- **Composer styling.** `.pf-post-composer` is a `pf-panel`. The textarea is full width with `resize: vertical` and min-height 84 px. The footer row (counter, Post button) is `justify-content: space-between`. `.pf-post-composer__count.is-over` uses `var(--pf-danger)`.
- **Feed.** A post item uses `PostCard` rather than the sentence layout. The list gap is unchanged, and the card replaces the `.pf-feeditem` row styles for this kind only.
- **Skeletons.** `ProfilePosts` shows 3 `PostCardSkeleton`s while first loading (only on your own profile; other profiles stay hidden until loaded, the ProfileScreenshots rule).
- **Contrast and motion.** Existing tokens only, and no animations.
- **Admin.** `.pf-badge--post` is styled like `.pf-badge--collection`.

## 3. Contract changes (summary; normative text lives in docs/)
- **API.md § F030 additions**:
  - **Types:** `Post`, `PostAttachment`, `PostAttachmentType` and `CreatePostRequest`; `FeedItemKind` += `"postCreated"`; `FeedItem.post`; `FeedItem.game` becomes nullable (null only for `postCreated`); `ProfileStats.posts`; `ReportTargetType` += `"post"`.
  - **Endpoints:** `POST /api/posts`, `GET /api/posts/{id}`, `DELETE /api/posts/{id}` and `GET /api/users/{username}/posts`.
  - **Rules:** body rules, attachment rules, the 24-hour cap, the feed event and its sources, the report changes and `Limit::Post`.
  - **Web routes:** `/u/{u}/posts`, `/p/{id}`, `?attach=`.
- **ARCHITECTURE.md § F030 additions**: migration `0025_f030.sql` (normative SQL), `routes/posts.rs`, the guarded insert, the writer, `FEED_SQL` branch (d), feed assembly, `remove_post`, the frontend files and ownership.
- **GAME_FORMAT.md § F030 additions**: none.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0025_f030.sql`: copy ARCHITECTURE § F030 "Data" **verbatim**. Never edit `0001`–`0024`.
2. **`src/ratelimit.rs`**: `Limit::Post` with the doc `/// F030 post creation (`POST /api/posts`): 10 per 10 min, per user` and the quota `(10, Duration::from_secs(600))`.
3. **`src/activity.rs`**:
   - `pub const KIND_POST_CREATED: &str = "postCreated";` with a doc comment;
   - `KINDS` becomes `[&str; 7]` with it appended;
   - `pub async fn record_post_created(conn: &mut SqliteConnection, actor_id: &str, post_id: &str, now: &str)`, with a nested transaction and `log_failure(KIND_POST_CREATED, post_id, res)`, running the ARCHITECTURE § F030 "Writer" SQL;
   - update the unit test's `KINDS.len()` to 7 and assert that it contains `KIND_POST_CREATED`.
4. **`src/routes/users.rs`**:
   - `is_forbidden_label_char` becomes `pub(crate)`;
   - `ProfileStats` gains `pub posts: i64` (doc: "F030: the user's posts (all public)."), filled by `SELECT COUNT(*) FROM posts WHERE author_id = ?1` in `profile_stats`.
5. **`src/routes/collections.rs`**: `COLLECTION_SELECT`, `collection_from_row` and `collections_from_rows` become `pub(crate)`. Nothing else changes.
6. **`src/routes/posts.rs`** (new; the module doc names API § F030):
   - **Constants:** `POST_BODY_MAX: usize = 500`, `POST_LINES_MAX: usize = 12`, `POSTS_PER_DAY_MAX: i64 = 25`, `POSTS_PER_PAGE_DEFAULT: i64 = 20`, `POSTS_PER_PAGE_MAX: i64 = 50`.
   - **`pub fn validate_post_body(raw: &str) -> AppResult<String>`**: § 0.3 in order, with the API messages. A pure function with unit tests.
   - **Serde structs:** `Post`, `PostAttachment` (`type` via `#[serde(rename = "type")] pub kind: &'static str`, `game: Option<GameSummary>`, `collection: Option<CollectionSummary>`) and `CreatePostBody { body: String, #[serde(default)] game_id: Option<String>, #[serde(default)] collection_id: Option<String> }` (camelCase).
   - **`POST_SELECT`** per ARCHITECTURE § F030.
   - **`pub(crate) async fn posts_for(state, rows: &[SqliteRow], viewer: Option<&str>) -> AppResult<Vec<Post>>`**: the batched assembly in ARCHITECTURE § F030 "Read assembly" (one game query, one collection query plus `summaries_for`, and `is_admin` once). The list, the get and the feed all use it.
   - **`create_post`** (🔒), checked in this order:
     1. auth (401);
     2. the JSON extractor (400 malformed, 422 wrong types, for example `body` missing or not a string);
     3. `limit_user(&state, Limit::Post, &user.id)?`;
     4. `validate_post_body`;
     5. both attachments → 422;
     6. resolve the attachment (`fetch_visible_game(&state, id, Some(&user.id))` → 404, then `!published` → 422; `load_collection(&state, id, Some(&user.id), is_admin)` → 404, then `visibility != "public"` → 422);
     7. in **one transaction**: the guarded insert (0 rows → 422 cap message), then `activity::record_post_created(&mut tx, …)` with the same `now`;
     8. commit;
     9. return 201 with the post built by `posts_for` for the author.
   - **`get_post`** (🔓): 404 `Post not found`.
   - **`list_user_posts`** (🔓): the user is looked up first (404 `User not found`), then `parse_paging(page, perPage, 20)` with `perPage` clamped to 1–50 (F015 rules: a non-integer → 400). Then `total` and the page per ARCHITECTURE § F030.
   - **`pub async fn remove_post(state: &AppState, id: &str) -> AppResult<()>`**: one transaction that resolves open `post` reports with `delete` and deletes the row (the feed event cascades). An unknown id is a no-op.
   - **`delete_post`** (🔒): 404 when unknown; 403 `forbidden` unless the author or an admin (`is_admin`); then `remove_post`; returns 204. No rate limit.
7. **`src/routes/feed.rs`**:
   - **`FEED_SQL`:** add branch (d) and `e.post_id` to the outer select, verbatim from ARCHITECTURE § F030, and extend the doc comment.
   - **`FeedItem`:** `game` becomes `Option<GameSummary>` (every existing kind still sets `Some`), and it gains `pub post: Option<Post>` with the doc "F030: non-null for `postCreated` only."
   - **`get_feed`:** collect the page's `post_id`s, run one `POST_SELECT … WHERE p.id IN (SELECT value FROM json_each(?))` query, call `posts_for` with the viewer, and skip a `postCreated` row whose post is missing (a race with a delete). `nextCursor` is unchanged (the last *row*).
8. **`src/routes/reports.rs`**:
   - `TARGET_TYPES` += `"post"`;
   - `unknown_target_type` → `targetType must be "game", "comment", "screenshot", "collection", "user" or "post"`;
   - a `"post"` branch: `SELECT author_id, body FROM posts WHERE id = ?` (a miss → 404 `Post not found`; `author_id == user.id` → 422 `You can't report your own post`), then `(None, body.chars().take(PREVIEW_MAX).collect())`;
   - the apply match gains `("delete", "post") => remove_post(&state, &report.target_id).await?`;
   - the validity table is unchanged (`dismiss` and `delete` pass through the existing `("dismiss" | "delete", _)` arm; `unpublish` and `clearProfile` already give their 422s);
   - the `Report.target_game_id` doc gains "and (F030) `post`".
9. **`src/routes/mod.rs`**:
   - `pub mod posts;`;
   - `.route("/posts", post(posts::create_post))`;
   - `.route("/posts/{id}", get(posts::get_post).delete(posts::delete_post))`;
   - `.route("/users/{username}/posts", get(posts::list_user_posts))`.

   The default JSON body limit applies.
10. **Existing tests:**
    - `tests/f008.rs` (line ~1403) and `tests/f028.rs` (line ~863) get the new `targetType` message;
    - `tests/review2.rs` `n1_feed_plan_is_index_driven` adds `"postCreated"` to `kinds` and keeps every assertion;
    - `tests/f015.rs` stays unchanged (its replay stops at 0022).

    No other existing assertion changes.
11. **`tests/f030.rs`** (§ 6).

**Acceptance:** `cd backend && cargo test` (every suite green, including `f002`, `f008`, `f015`, `f021`, `f028` and `review2`) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`; export the new ones from `src/index.ts`):
   - `PostAttachmentType = "game" | "collection"`;
   - `PostAttachment`, `Post` and `CreatePostRequest` per API § F030, with doc comments;
   - `FeedItemKind` += `"postCreated"`;
   - `FeedItem.game: GameSummary | null` (doc: "null only for postCreated");
   - `FeedItem.post?: Post | null`;
   - `ProfileStats.posts?: number` (doc: "F030. Older servers omit it: hide the Posts section.");
   - `ReportTargetType` += `"post"`.

   Add and export `type GameFeedItem = FeedItem & { game: GameSummary }`. The existing feed renderers take `GameFeedItem`, so they compile unchanged apart from the parameter type.
2. **Client** (`src/api/client.ts`):
   - `createPost(body: CreatePostRequest): Promise<Post>` (`POST /api/posts`);
   - `getPost(id: string, signal?: AbortSignal): Promise<Post>`;
   - `deletePost(id: string): Promise<void>`;
   - `listUserPosts(username: string, query: PageQuery = {}, signal?: AbortSignal): Promise<Page<Post>>`.
3. **Pure helpers**:
   - **`src/posts.ts`**:
     - constants `POST_BODY_MAX = 500`, `POST_LINES_MAX = 12`, `POSTS_PER_PAGE = 20`, `PROFILE_POSTS_PREVIEW = 3`;
     - `normalizePostBody(raw)` (CRLF/CR → LF, then trim);
     - `postLength(raw)` (code points of the normalised text);
     - `validatePostBody(raw): string | null` (§ 0.11 client messages, in order: lines, characters; uses `isForbiddenLabelCodePoint` from `profile.ts` and allows `0x0A`);
     - `linkifyPost(body): PostSegment[]` with `type PostSegment = { type: "text"; text: string } | { type: "link"; text: string; href: string }` (§ 0.4);
     - `postPath(id)` = `/p/{encodeURIComponent(id)}`;
     - `parseAttachParam(v: string | null): { type: PostAttachmentType; id: string } | null`;
     - `postComposePath(username, attach)`;
     - `isValidPost(x)`.
   - **`src/share.ts`**: `postShareUrl(config, id)` = `appShareUrl(config, postPath(id))`.
   - **`src/profile.ts`**: `ProfileSection` += `"posts"`.
4. **Components**:
   - **`components/PostCard.tsx`**: `PostCard` (§ 0.13–0.14, with `ConfirmDialog` and `useToast`), `PostBody` (segments) and `PostCardSkeleton`.
   - **`components/PostAttachmentCard.tsx`**: § 0.13 item 3. It is reused by the composer preview.
   - **`components/PostComposer.tsx`**: § 0.11–0.12. The `initialAttach` prop is `{ type, id } | null`, and the component loads the target itself.
   - **`components/ProfilePosts.tsx`**: `ProfilePosts({ username, isMe, preview?, onChanged? })`. It is modelled on `ProfileScreenshots` (generation counter, `pagesForOffset`, hidden-until-loaded for others, 404 hides). It also exposes `prepend(post)` through a ref (`useImperativeHandle`) for the composer. `onChanged` is called after a delete, and the section passes the shell's `reload`.
5. **Pages and routes**:
   - **`pages/ProfilePage.tsx`**: the `Posts` link (§ 0.8).
   - **`pages/ProfileSections.tsx`**: `ProfilePostsTab` (§ 0.10, including `?attach` and `focusPostsHeading`) and the Overview shelf and empty rule (§ 0.9).
   - **`pages/PostPage.tsx`**: § 0.15.
   - **`pages/NotFoundPage.tsx`**: the `post` text.
   - **`WebGameApp.tsx`**: `<Route path="posts" element={<ProfilePostsTab />} />` inside the `u/:username` route (after the index), and `<Route path="p/:id" element={<PostPage />} />` next to `c/:id`.
   - **`pages/FeedPage.tsx`**: the Posts tab, the compose link and the empty state (§ 0.16).
   - **`components/FeedItem.tsx`**: the `postCreated` branch (before any `item.game` access), `FEED_ITEM_KINDS` += `"postCreated"`, and the `isKnownFeedItem` rules.
   - **`pages/GamePage.tsx`** and **`pages/CollectionPage.tsx`**: the § 0.12 links.
   - **`components/Report.tsx`**: `what` gives `"post"` for `"post"`.
   - **`pages/AdminPage.tsx`**: § 0.17.
6. **Styles** (`styles.css`):
   - add `.pf-post`, `.pf-post__head`, `.pf-post__who`, `.pf-post__author`, `.pf-post__time`, `.pf-post__body`, `.pf-post__actions`, `.pf-post-attachment` (`--gone`), `.pf-post-composer` (`__count`, `.is-over`), `.pf-posts` (the list), `.pf-post-page` (`__actions`), `.pf-feed__compose` and `.pf-badge--post`;
   - add the 640 px rules (§ 0.18);
   - existing tokens only.
7. **Exports** (`src/index.ts`): `PostCard`, `PostComposer`, `ProfilePosts`, `PostPage`, `ProfilePostsTab`, `linkifyPost`, `validatePostBody`, `postPath`, `postShareUrl`, `postComposePath` and the new types.
8. **Tests** (§ 6). Existing suites stay green. In particular:
   - `ProfilePage.f028.test.tsx`: the nav now has a Posts link when `stats.posts` is present. Assertions about link counts or order that this breaks are updated to the § 0.8 order, and nothing else changes.
   - `FeedPage*.test.tsx`: the tab list gains Posts.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`, `npm test -w @webgame/desktop`.

### desktop-dev (`apps/desktop/**`)
1. **`src/__tests__/f030.desktop.test.tsx`**. Use the `f028.desktop.test.tsx` pattern: the real `App` under the hash router, `SERVER_STORAGE_KEY` = `http://192.168.1.5:8080`, mocked `fetch` and Tauri modules, and a signed-in user `mia` whose profile has `stats.posts: 1`. A post `p1` by `mia` has the body `New level! https://example.com/devlog.` and a game attachment. Assert:
   - on `#/p/p1`:
     - the body renders a link with the text `https://example.com/devlog`, `target="_blank"`, and a `rel` containing `noopener` and `noreferrer`;
     - the trailing `.` is plain text;
     - the attachment thumbnail `src` is absolute on `http://192.168.1.5:8080`, and the `tauri.conf.json` CSP `img-src` allows it (the `imgAllowed` approach);
   - Copy link (with a mocked `navigator.clipboard.writeText`) writes `http://192.168.1.5:8080/p/p1`;
   - on `#/u/mia`, the `Posts` section link `href` is `#/u/mia/posts`;
   - on `#/u/mia/posts`, the textarea labelled `Post text` is present (own profile).
2. No source changes: no menu item. The external-link handling is the existing `external.rs`.

**Acceptance:** `npm run build -w @webgame/desktop`, `npm test -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test` and `cargo check`.

### engine-dev
None.

### Docs (project-manager, after the round)
- README "Features": a **Posts** bullet covering text posts with a game or collection attachment, profile Posts section, permalinks, the feed tab and reports.
- ROADMAP: F030 → shipped.

### Sequencing
backend-dev and frontend-dev work in parallel against API § F030 (the frontend mocks responses). desktop-dev's test needs the built `@webgame/ui`, so it runs after frontend-dev lands.

## 5. Edge cases and security
- **XSS and link abuse.** Bodies are rendered as React text. Only `linkifyPost` creates anchors, and only for URLs that pass `isSafeProfileUrl`, so `javascript:`, `data:`, credentials and non-ASCII hosts never become links. `nofollow ugc` removes any SEO value from spam, and `noopener noreferrer` blocks `window.opener` and referrer leaks.
- **Spoofing with invisible characters.** Bidi overrides, isolates, zero-width characters and the BOM are rejected server-side (the F028 set), so a post can't visually reorder a URL or hide text. `\t` is rejected too, which keeps the render predictable.
- **Spam.** `Limit::Post` (10 per 10 min), the 25-per-24-hours cap (atomic guarded insert), reports, and admin delete. Each post is its own feed item (no coalescing), so the cap also bounds what one author adds to a follower's feed.
- **Attachment races.** A game unpublished or a collection made private after posting: the attachment resolves to `null` for viewers who can't see it, and the post stays. A deleted target: `SET NULL` keeps the type, and the placeholder shows. Posting an attachment that is unpublished or made private between the check and the insert is accepted; the read-time rule then hides it.
- **Delete races.** Deleting a post while a feed page is assembled: the event cascades, and the assembly skips a row whose post is missing. Deleting twice: the second gets 404.
- **Feed cost.** Branch (d) is one more `follows` PK → `idx_activity_actor_id` walk with `LIMIT ?3`. It joins nothing, because the FK cascade guarantees the post exists, and the assembly is one batched query. `tests/review2.rs` asserts the plan.
- **Migration safety.** The `activity_events` rebuild copies every row with its id and carries the `sqlite_sequence` high-water mark (the F021 template), so feed cursors stay valid. Nothing references `activity_events` and it has no triggers (checked against `0001`–`0024`). After the migration, `PRAGMA foreign_key_check` must be empty and `PRAGMA integrity_check` must be `ok`.
- **Older servers.** Without `stats.posts` the Posts link and shelf are hidden. `kinds=postCreated` on an older server → 400 `Unknown feed kind 'postCreated'`, shown as the tab's `ErrorState`. The entry points still render, and the composer's `createPost` then fails with the generic 404, which the Alert shows.
- **Older clients.** They ignore unknown feed kinds (F002 rule), so `game: null` on `postCreated` never reaches them.
- **Privacy.** Posts are public by design, and the composer placeholder says they go to followers. Nothing about followers or readers is exposed. A report preview is the first 140 characters of the body.

## 6. Test expectations

### Backend (`tests/f030.rs`)
- **Upgrade.** Migrate a file database to version ≤ 24 (the `tests/f018.rs` pattern with `filter(|x| x.version <= 24)`). Insert a user, a game, a public collection, a `gamePublished` and a `collectionUpdated` event, and delete an earlier event so `sqlite_sequence` is above `MAX(id)`. Run `AppState::new`, then assert:
  - every event keeps its id and columns;
  - `post_id` is NULL;
  - the sequence is unchanged (the next insert gets `seq + 1`);
  - `PRAGMA foreign_key_check` is empty and `integrity_check` is `ok`;
  - an insert with `game_id`, `collection_id` and `post_id` all NULL fails the CHECK.
- **Create.**
  - `{ body: "  hi\r\nthere  " }` → 201: `body == "hi\nthere"`, `attachment: null`, `canDelete: true`, `path == "/p/{id}"`, and `author` is the caller.
  - Each body message: `""`, `"   "`, 501 code points (`"é"` × 501 → length; `"😀"` × 500 → ok), 13 lines, `"a\tb"`, `"a\u{202E}b"`, `"a\u{200B}b"`, `"a\u{7}b"`.
  - `body` missing → 422; `body: 5` → 422; malformed JSON → 400; anonymous → 401.
- **Attachments.**
  - A published game → `attachment.type == "game"` and `game.id` set.
  - Own unpublished game → 422 `Only published games can be attached`. Another user's unpublished game → 404 `Game not found`. An unknown game → 404.
  - Another user's public collection → ok. Own private collection → 422 `Only public collections can be attached`. Another user's private collection → 404 `Collection not found`.
  - Both ids → 422 `A post can have at most one attachment`. `gameId: null, collectionId: null` → no attachment.
  - Read-time rules:
    - after the game is unpublished, the anonymous `GET` gives `attachment: { type: "game", game: null, collection: null }` and the owner's `GET` gives the game;
    - after the game is deleted, `type` stays `"game"` and `game` is null;
    - after the collection is made private, `collection` is null for others and set for its owner.
- **Caps.**
  - With a `ManualClock`: 10 posts → the 11th → 429; advancing 10 min allows more.
  - With `RATE_LIMIT=off`: 25 posts → the 26th → 422 `You can post at most 25 times in 24 hours`. Backdate 1 post to 24 h + 1 s ago → one more is allowed.
  - Deleting a post doesn't free a slot.
- **Read.**
  - `GET /api/posts/{id}` anonymous → 200 with `canDelete: false`; unknown → 404 `Post not found`.
  - `GET /api/users/{u}/posts`: newest first (`createdAt` desc, then `id` asc); `total`; `perPage` default 20, clamp 1–50; `page=x` → 400; unknown user → 404 `User not found`, even with a bad `page`.
  - `canDelete` is true for the author and for an admin.
  - The page plan uses `idx_posts_author_created` without `USE TEMP B-TREE`.
- **Delete.**
  - Another user → 403. The author → 204. An admin → 204. Again → 404. Anonymous → 401.
  - After a delete, its `activity_events` row is gone and open `post` reports on it are `resolved`/`delete`.
- **Stats.** `GET /api/users/{u}` `stats.posts` equals the list `total` for anonymous viewers and for the user.
- **Feed.**
  - F follows A, and A posts → F's feed has `postCreated` with `post.id`, `game: null`, `reason: "following"`, `actor` = A and `createdAt` = the post's `createdAt`.
  - A's own feed doesn't have it. A non-follower who favorited A's game doesn't get it.
  - `kinds=postCreated` returns only posts. The "everything" view interleaves them by id with other kinds.
  - After A deletes the post, it is gone from F's feed.
  - Cursor paging over 25 posts with `limit=10` returns each post exactly once.
  - The F021/F015 kinds are unaffected (spot-check one `collectionUpdated` and one `screenshotPosted`).
- **Reports.**
  - P reports A's post → 201: `targetType: "post"`, `targetPreview` = the first 140 code points, `targetGameId: null`.
  - Again → 409. Own post → 422 `You can't report your own post`. Unknown → 404 `Post not found`.
  - Admin `delete` → 200, the post is gone, and a second open report is resolved too.
  - `unpublish` → 422 `unpublish is only valid for game reports`. `clearProfile` → 422 `clearProfile is only valid for user reports`.
  - An unknown `targetType` → the new message.
- **Unit.** `validate_post_body` covers every rule and message, including CRLF handling and the 12-line boundary (12 lines ok, 13 not).

### Frontend (vitest)
- **`posts.test.ts`**:
  - **`linkifyPost` cases** (exact segments):
    - `"see https://a.com."` → text `see `, link `https://a.com`, text `.`;
    - `"(https://a.com/x_(y))"` → the link keeps the balanced `)`, and the final `)` is text;
    - `"x https://a.com/?q=1#h, y"` → the link stops before `,`;
    - `"http://localhost"` → text (no dot);
    - `"javascript:alert(1)"` → text;
    - `"https://exämple.com"` → text;
    - a 201-character URL → text;
    - `"ahttps://a.com"` → text (not after a boundary);
    - `"\"https://a.com\""` → a link without the quotes;
    - `"HTTPS://A.com"` → a link.
  - `validatePostBody`: lines and characters (tab, U+202E), `"\n"` allowed, order of messages.
  - `postLength("😀😀")` = 2.
  - `parseAttachParam`: `game:abc` → `{ type: "game", id: "abc" }`; `collection:x` ok; `foo:1`, `game:`, `null` → null.
  - `postComposePath` encodes; `postShareUrl` in browser and hash mode.
- **`PostCard.test.tsx`**:
  - The head: name link, `@mia`, and the time link to `/p/{id}` with `dateTime`.
  - The body segments render with the anchor attributes and sr-only text; newlines are preserved (`pre-wrap` class).
  - Each attachment variant, including both placeholder texts and an unknown type rendering nothing.
  - Delete is shown only with `canDelete`. The confirm has the exact title and body; success toasts `Post deleted` and calls `onDeleted`; failure toasts the error and keeps the post.
  - Report is shown for non-authors (anonymous too) and not when `canDelete`; the dialog heading is `Report post`.
- **`PostComposer.test.tsx`**:
  - The counter reads `0 / 500`, then `501 / 500 · 1 too many` with `is-over`, and Post is disabled at 0 and over 500.
  - 13 lines → the lines message and no request. A tab → the characters message.
  - Ctrl+Enter submits. The request body is `{ body, gameId?, collectionId? }`. On success, the toast `Post published` shows, the field clears, `onPosted` is called, and focus is on the textarea.
  - A 422 shows the server message in the Alert.
  - `initialAttach` game: the preview shows; `✕ Remove` clears it and focuses the textarea. An unpublished game gives `Only published games can be attached.`; a 404 collection gives `That collection isn't available.`.
- **`ProfilePosts.test.tsx`** / **`ProfilePage.f030.test.tsx`** (`MemoryRouter` with the real nested routes):
  - The nav order is Overview, Posts (count), Games, Screenshots, Collections. Posts is hidden without `stats.posts`.
  - `/u/mia/posts` calls `listUserPosts("mia", { page: 1, perPage: 20 })`; Load more requests the next offset; the title is `Posts · Mia`.
  - The own profile has a composer, and posting prepends the post and calls the shell's `reload` (one extra `getUser`, header not remounted).
  - The empty-state texts for own and other profiles.
  - Delete focus moves to the next card, else the previous, else the textarea (own), else the heading.
  - `?attach=game:g1` on own profile loads `getGame("g1")`, shows the preview and focuses the textarea; on another profile it is ignored.
  - `state.focusPostsHeading` focuses the `h2`.
  - The Overview shelf shows 3 posts and `See all 5 posts →`. For your own profile with 0 posts, it shows `Write a post`; for another profile with 0 posts, it is absent. The all-zero overview needs `posts: 0`.
- **`PostPage.test.tsx`**: the title `Post by Mia`; the sr-only h1; Copy link with `postShareUrl`; `More posts by Mia →`; 404 → `post not found` and the post text; deleting navigates to `/u/mia/posts` with replace.
- **`FeedPage.f030.test.tsx`** / **`FeedItem.f030.test.tsx`**:
  - The tab order includes `Posts` second, requests `kinds: ["postCreated"]` and is remembered in `FEED_TAB_KEY`.
  - `✎ Write a post` links to `/u/{me}/posts`, and the empty-state text.
  - A `postCreated` item renders a `PostCard` with `data-feed-id`; an item with `post: null` renders nothing; a non-post item with `game: null` is dropped.
  - An admin delete in the feed removes the item and moves focus by the F015 rule.
- **`GamePage.f030.test.tsx`** / **`CollectionPage.f030.test.tsx`**: `✎ Post about this` links to `/u/{me}/posts?attach=game:{id}` (published games, signed in only) and `…?attach=collection:{id}` (public collections, signed in only).
- **`AdminPage.f030.test.tsx`**: a post row shows the quote, `View post →` → `/p/{id}`, Dismiss and Delete, and the confirm title `Delete this post?`.
- **`ApiClient.f030.test.ts`**: methods, paths and verbs for the four calls.

### Desktop (vitest + cargo)
As listed in § 4 desktop-dev.

### Manual end to end
1. Mia writes a three-line post with a YouTube link on `/u/mia/posts`. It appears at the top, the link opens in a new tab (the system browser on desktop), and the tab count goes from 0 to 1.
2. Leo follows Mia. His feed's Posts tab shows the post. Mia's own feed doesn't.
3. Mia opens her public collection *Cozy games*, presses **✎ Post about this**, writes "My comfort list", and posts. Leo's feed shows the post with the collection card.
4. Mia makes the collection private. Leo now sees `This collection is no longer available.`, and Mia still sees the card.
5. Leo reports a post. The admin opens `View post →`, deletes it from the queue, and it disappears from Mia's profile and Leo's feed.
6. On a phone width, the composer button is full width, attachment thumbnails stack on top, and the permalink reads well at 360 px.

# F015: Screenshots in the feed and on profiles

Status: **shipped**. Size: **S** (backend small: one index-only migration, one activity writer, one feed sub-query and one batched page query, one public list endpoint; frontend small to medium: a lightbox extraction, one feed item kind, one feed tab, one profile section; desktop verification only; one round). Areas: backend, frontend, desktop (verification only). No engine changes.
Contracts: `docs/API.md` § F015 additions (feed kind and types, event production, feed source rule, the new `GET /api/users/{username}/screenshots`), `docs/ARCHITECTURE.md` § F015 additions (migration `0022_f015.sql` with the exact SQL, the writer, the feed branch (a) predicate, the feed assembly query, the profile query, ownership). `docs/GAME_FORMAT.md` § F015 additions: no changes.
Depends on: F002 (feed), F005 (screenshots), F021 (`activity_events` without the `kind` CHECK), all shipped. The migration is **`0022_f015.sql`** and runs after `0021_f020.sql`. **No new Rust or JS dependencies. No `activity_events` rebuild.**

## 0. Decisions on ambiguities (read first)
These are settled here. API § F015 is normative for the server and § 2 below is normative for the UI texts. Tests assert every quoted text verbatim.

1. **Feed kind.** The new kind is `screenshotPosted`. There is **one row per (actor, game, UTC day)**. Each new post deletes that day's row and inserts a new one, so the item gets a new, higher `id` and moves to the top of the feed. This is the `personalBest` pattern, and it uses the existing `idx_activity_coalesce (actor_id, game_id, kind, day)`.
2. **What writes an event.** Every successful `POST /api/games/{id}/screenshots` (a 201) writes one, but only when the game was **published** at the visibility check (step 2 of the F005 validation order).
   - Posts to an unpublished game write nothing. Only the owner can post to an unpublished game.
   - The author **may be the game owner**. Unlike `personalBest` and `achievementUnlocked`, creators posting shots of their own game are announced to their followers, because that is the most useful content for those followers.
   - Rejected posts (any 4xx or 5xx) write nothing.
   - The write is best effort, after the insert: a failure is logged with `tracing::warn!` and the response is still 201.
3. **Timing and the UTC day.**
   - `create_screenshot` computes `now = now_rfc3339()` **once**. It binds that string as `screenshots.created_at` and passes the same string to the writer. The writer's `day` is `now[..10]` and its `created_at` is `now`.
   - The UTC day is therefore exactly the first 10 characters of the screenshot's `createdAt`. Two posts at `23:59:59.900Z` and `00:00:00.100Z` give **two** items on different days. This is intended.
   - At read time, an item covers **every** screenshot whose author is the actor, whose game is the item's game, and where `substr(created_at, 1, 10) = day`. That is evaluated live; the row stores no screenshot ids.
4. **Read-time rules** (no stored list, so nothing goes stale):
   - Deleted screenshots (by the author, the owner, an admin, or a report resolve) disappear from the item at once.
   - An item with no screenshots left is not returned.
   - An unpublished game hides the item (the existing branch (a) rule), and republishing shows it again.
   - Edge case: if the owner posted shots on the same UTC day while the game was still unpublished, and then posts again after publishing, those earlier shots are included in the item. This is accepted and documented, because they are the owner's own shots of their own game.
5. **Item shape.**
   - `FeedItem.screenshots = { count, items }`.
   - `items` holds 1–4 `Screenshot` objects, newest first, ordered by `created_at DESC, id ASC` (the F005 gallery order).
   - `count` is all of that day's screenshots for the pair: `count >= items.length >= 1`, and at most 20 (the F005 per-user, per-game cap).
   - `canDelete` is computed for the viewer exactly as in F005: true when the viewer is the author, the game owner, or an admin.
   - `game` is the game and `version` is `null`. `reason` is always `"following"`, because the favorites branch never carries this kind. `createdAt` is the row's `created_at`, which is the latest post that day.
   - Every other kind has `screenshots: null`.
6. **Who sees it.** Only followers of the actor see the item (branch (a) of `FEED_SQL`). The viewer's own items are never shown (the F002 rule). Favoriting a game does **not** show other players' screenshots of it.
7. **Profile list.** The new endpoint is `GET /api/users/{username}/screenshots?page=&perPage=`, a public read 🔓.
   - The response is `Page<UserScreenshot>` (a `Screenshot` plus `game: { id, title }`), newest first (`created_at DESC, id ASC`).
   - `perPage` defaults to 12 and is clamped to 1–50. `page` defaults to 1, and values below 1 count as 1.
   - It lists only screenshots whose game is **published or owned by the viewer** (`GameRow::visible_to`, the F005 game page rule). This applies to the author too: a shot on someone else's game that was later unpublished is hidden from the author's own profile as well.
   - Errors:
     - unknown user → 404 `not_found` `User not found`
     - non-integer `page` → 400 `bad_request` `page must be an integer`
     - non-integer `perPage` → 400 `bad_request` `perPage must be an integer`
   - No rate limit, like the game gallery and `/users/{username}/collections`.
   - No static `/users/me/screenshots` route is added.
8. **No notifications** in this round. "Someone posted a screenshot of your game" for creators is proposed as F024 and needs a mute and settings design.
9. **No changes to F005 posting.** Validation order, limits, the 20-per-game cap, captions and `Limit::Screenshot` (10/hour) all stay as they are. Feed volume is therefore bounded: at most one item per actor, game and day, with at most 20 shots in it.
10. **Profile placement.** The profile shows a stacked **Screenshots section** (profiles have no tabs) between the Games grid with its pagination and the Collections section. Visibility rules:
    - On your own profile the section is always shown, with an empty state.
    - On other profiles it is hidden while loading, when empty, and on any error.
    - On a 404 from the list endpoint it is hidden on every profile. The profile itself loaded, so a 404 means an older server or a user deleted mid-request.
11. **Lightbox.** The F005 `Lightbox` (currently private to `ScreenshotGallery.tsx`) is extracted to `components/ScreenshotLightbox.tsx` and used in three places: the game page, the feed and the profile.
    - **"🖼 Set as thumbnail"** appears **only on the game page** (owner). Feed and profile never show it.
    - **"View on game page"** appears **only in the feed and the profile**. It links to `/games/{id}?section=screenshots`.
    - Delete, Report, Open image, the ←/→ buttons and the arrow keys behave exactly as in F005 in all three places.
12. **Focus rules** (normative, tested):
    - Opening a lightbox: `useModal` focuses the first focusable element (unchanged).
    - Closing it without a delete returns focus to the thumbnail button that opened it (the `useModal` opener rule, unchanged).
    - After a delete **in the feed**, focus goes to the thumbnail button now at the deleted one's position in that item, else the last remaining thumbnail of the item, else the game title link in the item's sentence (when the item disappears, focus goes to the next item's first link, else to the feed's `Load more` button, else to the tab panel).
    - After a delete **on the profile**, focus goes to the thumbnail now at that grid position, else the previous one, else the section heading (`tabIndex={-1}`). This is the F005 gallery rule.
    - "View on game page" is a router `Link`: navigation unmounts the dialog, and the page's normal focus handling applies.
13. **`?section=screenshots` on the game page.** It works like F004's `?section=versions`: a query parameter (so it also works under the desktop `HashRouter`) that scrolls to `#screenshots` (`SCREENSHOTS_SECTION_ID`) once the game has loaded. It only scrolls; it never moves focus. An unknown `section` value does nothing.
14. **Feed tab.** `/feed` gets a fourth tab, **Screenshots** (`kinds=screenshotPosted`), after Collections. The stored tab (`FEED_TAB_KEY`) accepts `"screenshots"`.
15. **Older servers and clients.** Older clients ignore the unknown kind (F002 rule). A newer client on an older server:
    - never receives the kind;
    - gets a 400 `Unknown feed kind 'screenshotPosted'` on the Screenshots tab, shown by the existing `ErrorState`, which is acceptable;
    - gets a 404 on the profile list, which hides the section (decision 10).

## 1. Goal and user stories
F005 made screenshots a community feature, but they only live on game pages. Your followers never see the shot you are proud of, and you have no gallery of your own. F015 puts them where people already look:
- a **feed item** "Mia posted 3 screenshots of Space Dodge" with up to four thumbnails and a lightbox;
- a **Screenshots** feed tab;
- a **Screenshots** section on every profile: a personal gallery across all games, with the game named under each shot.

User stories:
1. As a player following Mia, I open `/feed` and see "Mia posted 3 screenshots of Kiln Clash" with three thumbnails. I click one, browse them with ←/→ in a lightbox, and click "View on game page" to see the whole gallery.
2. As a creator, I post four promo shots of my new game. My followers see one item with all four, not four items.
3. As a player, my profile shows every screenshot I posted, newest first, each labelled with its game. I can delete an old one from there.
4. As a visitor to someone's profile, I see their screenshots on published games only. The section is absent if they have none.
5. As a game owner who follows a player, I can delete an inappropriate shot of my game straight from the feed lightbox, as I can on my game page.
6. As a keyboard or screen-reader user, every thumbnail is a labelled button that opens a modal dialog with the F005 keyboard behaviour, and focus lands somewhere sensible after a delete.

Non-goals (later items): notifying creators about screenshots of their games (proposed as F024), hearts or comments on screenshots, a platform-wide "recent screenshots" shelf, showing favorites-based screenshot items, editing captions after posting.

## 2. UX notes

### 2.1 Feed item `screenshotPosted` (`FeedItem.tsx`, new `ScreenshotFeedItem`)
- **Sentence** (normative):
  - `count === 1`: **"{actor} posted a screenshot of {game}"**
  - otherwise: **"{actor} posted {count} screenshots of {game}"**
  - The actor links to `/u/{username}` and the game title links to `/games/{id}` (the existing `pf-feeditem__actor` / `pf-feeditem__gamename` links). `{count}` is the plain integer (no `formatCount`; it is at most 20).
- **Caption:** when `count === 1` and the shot's caption is non-empty after trim, a muted line `“{caption}”` under the sentence (`pf-feed-shots__caption`, a text node, single line with an ellipsis, full text in `title`). There is no caption line when `count > 1`.
- **Thumbnails:** `<ul class="pf-feed-shots">` of `items` (at most 4). Each `<li>` holds a `<button type="button" class="pf-feed-shots__item" aria-haspopup="dialog">` with `<img src={api.url(s.thumbUrl)} alt="" loading="lazy">`. Thumbnails sit in fixed 16:9 boxes, 112 px wide on wide screens (`object-fit: cover`), and wrap to two per row below 480 px.
  - Button `aria-label` (normative): `Screenshot: {caption}` when the caption is non-empty, else `Screenshot {i} of {count}` (1-based `i`).
- **"+N more":** when `count > items.length`, a last `<li>` with a link **"+{count - items.length} more on the game page"** to `/games/{id}?section=screenshots` (`gameScreenshotsPath`).
- **Meta row:** a 📷 icon (`aria-hidden`), then the relative time (`createdAt`) as on other items. There is no "From your favorites" tag (it can't happen).
- **No `pf-feeditem__game` block** (the game thumbnail and title card) for this kind: the sentence links the game and the screenshots are the visual.
- **Lightbox:** a click opens `ScreenshotLightbox` over this item's `items`, starting at the clicked index, with `gameTitle = () => item.game.title`, no thumbnail action, and the "View on game page" link.
- **Local delete:** a successful delete removes the shot from this item's local list and decrements the local count. When the list becomes empty the item renders nothing. Focus follows § 0.12.
- **Defensive rendering:** an item with `screenshots` null, a non-array `items`, or no valid entries (an entry needs a string `id` and a string `thumbUrl`) renders nothing. `count` is `max(validItems.length, floor(Number(count)) || 0)`.
- `FEED_ITEM_KINDS` gains `"screenshotPosted"`.

### 2.2 Feed tab
- Tabs become **Everything**, **New games**, **Collections**, **Screenshots**. Screenshots → `kinds: ["screenshotPosted"]`. `FeedTab` gains `"screenshots"` and `readTab` accepts it; unknown stored values still fall back to "Everything".
- Empty state for the Screenshots tab (normative): icon 📷, title **"No screenshots yet."**, body **"Screenshots posted by people you follow appear here."**, followed by `SuggestedCreators` (as on the Collections tab).

### 2.3 Profile section (`components/ProfileScreenshots.tsx`)
- A `<section class="pf-shelf pf-profile-shots" aria-labelledby=…>` with an `<h2 class="pf-section-title" tabIndex={-1}>` **"Screenshots"**, plus a `pf-tab__count` badge with `total` when `total > 0`.
- **Grid:** `<ul class="pf-shots__grid">` (the existing F005 grid class). Each `<li>` holds:
  - the thumbnail button (`pf-shots__item`, `aria-haspopup="dialog"`), with `aria-label` (normative) `Screenshot of {game title}: {caption}` when the caption is non-empty, else `Screenshot of {game title}`;
  - under it, a link with the game title (`pf-small`, single line, ellipsis) to `/games/{id}?section=screenshots`.
- **Paging:** 12 per page (`PROFILE_SCREENSHOTS_PER_PAGE = 12`). A **"Load more"** button appears while `items.length < total`. Load more uses the exported F005 `pagesForOffset` with id de-duplication, exactly like `ScreenshotGallery`, because local deletes shift the OFFSET pages.
- **Own profile, empty** (normative): `EmptyState` icon 📷, title **"No screenshots yet"**, body **"Press 📷 while playing a game and post the shot to its page. Your screenshots appear here."**
- **Own profile, error:** `LoadError` **"Couldn't load your screenshots."** with Retry.
- **Loading:** three `Skeleton`s in the grid on your own profile; nothing on other profiles (§ 0.10).
- **Reload:** the list reloads from page 1 when `username` or the signed-in user changes (`canDelete` depends on the session), after auth has resolved (`useAuth().loading` false), as the gallery does.
- **Lightbox:** `gameTitle = (s) => s.game.title`, no thumbnail action, the "View on game page" link, and local delete (remove the item, `total - 1`). Focus follows § 0.12.

### 2.4 Lightbox (`components/ScreenshotLightbox.tsx`, extracted)
- Move the F005 `Lightbox` component **unchanged in behaviour** and export it as `ScreenshotLightbox` with these props:
  ```ts
  export type ScreenshotLightboxProps = {
    items: Screenshot[];
    index: number;
    onIndex: (i: number) => void;
    onClose: () => void;
    onDeleted: (s: Screenshot) => void;
    returnFocus: () => HTMLElement | null;
    /** Title of the screenshot's game (alt text, view link). */
    gameTitle: (s: Screenshot) => string;
    /** Game page only, owner only: shows "🖼 Set as thumbnail" for this game. */
    thumbnailGame?: { id: string; title: string; onGameUpdated?: (g: Game) => void };
    /** Feed and profile: shows a "View on game page" link to `/games/{s.gameId}?section=screenshots`. */
    showGameLink?: boolean;
  };
  ```
- `ScreenshotGallery` passes `gameTitle = () => game.title`, `thumbnailGame` only when `game.isOwner`, and `showGameLink` false. Its rendered output and its tests must stay unchanged.
- The image `alt` stays `caption || "Screenshot of {gameTitle(s)} by {who}"`.
- "View on game page" is a `Link` styled `pf-btn pf-btn--sm` and placed before "Open image".
- The delete confirmation body changes from "It is removed from the game page permanently." to **"It is removed from the game page and everywhere else permanently."** in all three places. Update the F005 test that asserts the old text.

### 2.5 Game page
- `?section=screenshots` scrolls to `#screenshots` once the game is loaded (§ 0.13). Implement it by generalising the F004 `wantsVersions` effect to a `section` value mapped to an element id (`versions` → `"versions"`, `screenshots` → `SCREENSHOTS_SECTION_ID`).

### 2.6 Accessibility (normative)
- Every thumbnail is a `<button>` with an accessible name (§ 2.1, § 2.3), and the images are decorative (`alt=""`). Captions and game titles are text nodes, never HTML.
- The feed item stays one `<article>`. The "+N more" link and "View on game page" have visible text.
- Colours use existing tokens with 4.5:1 contrast, and focus rings stay visible on the thumbnails (`:focus-visible` outline, as `.pf-shots__item`).

## 3. Contract changes (summary; normative text lives in docs/)
- **API.md § F015 additions**:
  - `FeedItemKind` += `"screenshotPosted"`; the new type `FeedScreenshots`; `FeedItem.screenshots`.
  - Event production and coalescing, the feed source rule, and the read-time rules.
  - The new types `ScreenshotGameRef` and `UserScreenshot`, and the new endpoint `GET /api/users/{username}/screenshots` with its visibility, ordering, paging and errors.
  - No new rate limits and no changed endpoints.
- **ARCHITECTURE.md § F015 additions**:
  - migration `0022_f015.sql` (one index);
  - the writer `activity::record_screenshot_posted`;
  - the branch (a) predicate in `FEED_SQL`;
  - the batched feed screenshot query;
  - the profile query;
  - the UI component map and ownership.
- **GAME_FORMAT.md § F015 additions**: none.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0022_f015.sql`: copy the SQL in ARCHITECTURE § F015 "Data" verbatim. Never edit `0001`–`0021`.
2. **`src/activity.rs`**:
   - `pub const KIND_SCREENSHOT_POSTED: &str = "screenshotPosted"`, appended to `KINDS` (which becomes `[&str; 6]`).
   - Update the unit test's `assert_eq!(KINDS.len(), 5)` to 6, and assert that the new kind is in `KINDS`.
   - `pub async fn record_screenshot_posted(conn: &mut SqliteConnection, actor_id: &str, game_id: &str, now: &str)`: the coalescing write in ARCHITECTURE § F015 "Writer", in a nested transaction like the others, logging failures with `log_failure(KIND_SCREENSHOT_POSTED, game_id, res)`. `day = now.get(..10).unwrap_or(now)`.
3. **`src/routes/screenshots.rs`**:
   - `create_screenshot`:
     - keep the step-2 game: `let game = fetch_visible_game(…).await?;`;
     - compute `let now = now_rfc3339();` once, before step 11, and bind it in the guarded insert in place of the inline `now_rfc3339()`;
     - after the insert reports `rows == 1` (before step 12), run `if game.published && let Some(mut conn) = crate::activity::acquire(&state.db).await { crate::activity::record_screenshot_posted(&mut conn, &user.id, &game_id, &now).await; }`.
     - Nothing else in the handler changes.
   - `SCREENSHOT_SELECT` additionally selects `g.title AS game_title`. Existing callers ignore the column.
   - Make `Viewer` (and its fields) and `screenshot_from_row` `pub(crate)`, so `feed.rs` reuses them.
   - New `pub const FEED_SCREENSHOTS_SQL` (ARCHITECTURE § F015 "Feed assembly").
   - New `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct ScreenshotGameRef { id, title }` and `pub struct UserScreenshot { #[serde(flatten)] shot: Screenshot, game: ScreenshotGameRef }`.
   - New handler `list_user_screenshots` (ARCHITECTURE § F015 "Profile query"): resolve the user via `username_lower` (`AppError::not_found("User")`), `parse_paging(page, perPage, 12)` then `.clamp(1, PER_PAGE_MAX)`, the count query and the page query with the viewer bind, and `canDelete` through `Viewer { id, admin: is_admin(…) }`.
4. **`src/routes/mod.rs`**: `.route("/users/{username}/screenshots", get(screenshots::list_user_screenshots))` next to the other `/users/{username}/…` routes. Add no `/users/me/screenshots` route.
5. **`src/routes/feed.rs`**:
   - `FEED_SQL` branch (a): add the `screenshotPosted` predicate exactly as in ARCHITECTURE § F015 "Feed query". Branches (b) and (c) are unchanged.
   - Update the `FEED_SQL` doc comment (branch (a) now also probes `idx_screenshots_author_game` for this kind).
   - `FeedItem.screenshots: Option<FeedScreenshots>` (serialised as `null` for other kinds). New `#[serde(rename_all = "camelCase")] pub struct FeedScreenshots { count: i64, items: Vec<Screenshot> }` and `pub const FEED_SCREENSHOTS_MAX: usize = 4`.
   - Assembly: collect the `[actorId, gameId, day]` triples of the page's `screenshotPosted` rows (`actor_id` comes from `u_id`, `day` from the selected `e.day`). When there are any, run **one** `FEED_SCREENSHOTS_SQL` query and `is_admin` once. Group the results by triple in query order. Per row: `count` = group length, `items` = the first 4 via `screenshot_from_row` with the viewer. Skip the row (`continue`, the cursor rule unchanged) when its group is empty.
   - `parse_kinds` accepts the kind automatically through `KINDS`.
6. **`tests/f015.rs`** (§ 6), plus the `tests/review2.rs` N1 extension. Use `common::setup()` and `setup_with(|c| c.rate_limit = true)` only for the rate-limit test. Copy the small `png`/`post`/`post_ok`/`delete` helpers from `tests/f005.rs` (test files don't share modules beyond `common`).

**Acceptance:** `cd backend && cargo test` (all suites green, including `f002`, `f005`, `f021`, `review2`) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`):
   - `FeedItemKind` += `"screenshotPosted"`.
   - `FeedScreenshots = { count: number; items: Screenshot[] }`, and `FeedItem.screenshots?: FeedScreenshots | null`.
   - `ScreenshotGameRef = { id: string; title: string }` and `UserScreenshot = Screenshot & { game: ScreenshotGameRef }`.
   - Export the new types from `src/index.ts`.
2. **Client** (`src/api/client.ts`): `listUserScreenshots(username: string, query: PageQuery = {}, signal?: AbortSignal): Promise<Page<UserScreenshot>>` → `GET /api/users/{username}/screenshots` with `page`/`perPage`, next to `listScreenshots`.
3. **`src/util.ts`**: `export const SCREENSHOTS_SECTION = "screenshots"` and `export function gameScreenshotsPath(gameId: string): string` → `/games/{encoded id}?section=screenshots`.
4. **`components/ScreenshotLightbox.tsx`** (new, § 2.4): moved from `ScreenshotGallery.tsx`. `ScreenshotGallery` imports it. Export `ScreenshotLightbox` and `ScreenshotLightboxProps` from `src/index.ts`.
5. **`components/FeedItem.tsx`**: `FEED_ITEM_KINDS` += `"screenshotPosted"`, plus the `ScreenshotFeedItem` subcomponent (§ 2.1) with local delete state and the § 0.12 focus rule.
6. **`pages/FeedPage.tsx`**: the Screenshots tab, `readTab`, and the empty state (§ 2.2). Pass a `returnFocus` fallback for an item that disappears after a delete (§ 0.12; for example, `FeedItem` accepts an optional `onEmptied` callback, and the page then focuses the next item's first link, else `Load more`, else the tab panel).
7. **`components/ProfileScreenshots.tsx`** (new, § 2.3), rendered in `pages/ProfilePage.tsx` between the Games grid with its pagination and `ProfileCollections`, keyed by username: `<ProfileScreenshots key={data.user.username} username={data.user.username} isMe={isMe} />`.
8. **`pages/GamePage.tsx`**: `?section=screenshots` (§ 2.5).
9. **Styles** (`styles.css`): `.pf-feed-shots` (row of 16:9 thumbs, 112 px, wrap to 2 columns below 480 px), `.pf-feed-shots__item`, `.pf-feed-shots__caption`, `.pf-profile-shots` (game link under each thumb with an ellipsis). Use existing tokens.
10. **Tests** (vitest):
    - `FeedItem.f015.test.tsx`:
      - sentence for 1 and for 3 screenshots (verbatim);
      - the caption line only when `count === 1`;
      - thumbnail `aria-label`s with and without a caption;
      - "+2 more on the game page" when `count` is 6 with 4 items, linking `/games/g1?section=screenshots`;
      - no game card block;
      - `screenshots: null`, empty `items` or invalid entries render nothing;
      - clicking a thumbnail opens the lightbox at that index with "View on game page" and without "Set as thumbnail";
      - deleting (mock `deleteScreenshot`) removes the thumb, updates the sentence count and moves focus per § 0.12, and the item disappears after its last shot is deleted.
    - `FeedPage.f015.test.tsx`: the Screenshots tab requests `kinds=screenshotPosted`, is remembered in `FEED_TAB_KEY`, and shows its empty state (verbatim).
    - `ProfileScreenshots.test.tsx`:
      - own profile: the empty state (verbatim), and the error state with Retry;
      - other profile: hidden when empty, hidden on error, hidden on 404 (also on your own profile);
      - grid labels and game links;
      - "Load more" uses `pagesForOffset` after a local delete (no duplicates, no gaps);
      - `total` badge;
      - reload on a sign-in change;
      - delete focus fallback to the heading.
    - `ScreenshotLightbox.test.tsx`: `thumbnailGame` shows "🖼 Set as thumbnail", its absence hides it; `showGameLink` renders the link; the arrow keys; the new delete confirmation text.
    - `GamePage` test: `?section=screenshots` calls `scrollIntoView` on `#screenshots` after load.
    - `ApiClient.f015.test.ts`: the URL and query of `listUserScreenshots`.
    - The existing `ScreenshotGallery.test.tsx` and `review3.test.tsx` stay green (update only the changed confirmation text).

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
No code changes. Verify on the desktop build:
- the feed's Screenshots tab works under the hash router;
- feed and profile thumbnails load from the configured server (CSP `img-src` already allows `http:`/`https:`);
- "View on game page" and "+N more on the game page" open `#/games/{id}?section=screenshots` and scroll to the gallery;
- "Open image" opens the system browser, as on the game page.

**Acceptance:** `npm run build -w @webgame/desktop`, `npm test -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo check`. Record the result in the round notes; no file changes are expected.

### engine-dev
None.

### Sequencing
backend-dev and frontend-dev work in parallel against API § F015 (the frontend mocks the responses). desktop-dev verifies after both land.

## 5. Edge cases and security
- **Privacy.**
  - Screenshots are already public on published game pages. F015 only shows them to the actor's followers and on the actor's profile.
  - Shots on unpublished games never reach the feed (the write-time and read-time published checks), and profiles hide them from everyone except the game's owner (the `visible_to` rule).
  - Image files keep the F005 media rules (unguessable ids, `CSP: sandbox`, `nosniff`).
- **Moderation.** The lightbox keeps Report for every signed-in non-author. A deleted screenshot (including an admin report resolve) vanishes from feed items and profiles at once (read-time). Deleting a game cascades its screenshots and its `activity_events` rows. Deleting a user cascades their screenshots and their events.
- **Spam bounds.** `Limit::Screenshot` (10/hour) plus the 20-per-game cap means at most one feed item per actor, game and UTC day, with at most 20 shots. A follower's feed can't be flooded beyond the existing per-kind coalescing.
- **Owner shots.** Owners are announced (§ 0.2). An owner bulk-posting promo shots is still one item per day.
- **Unpublish and republish.** Hidden while unpublished, shown again when republished (as for every branch (a) kind).
- **Captions.** These are F005-validated plain text (no control or bidi characters), rendered as text nodes, and never sent to OS notifications (there are none in this feature).
- **Race: delete during a feed read.** The page query sees the row; the assembly query finds no shots → the row is skipped and the cursor still advances (the existing rule).
- **Race: the game is unpublished between step 2 and the writer.** The row is written, and branch (a) hides it until republish. Accepted.
- **Performance.**
  - The branch (a) predicate is a correlated `EXISTS` evaluated only for candidate `screenshotPosted` rows, probing `idx_screenshots_author_game (author_id=? AND game_id=?)`, which holds at most 20 rows per pair.
  - The assembly is one query per page over at most 50 triples, using the same index.
  - The profile list uses the new `idx_screenshots_author_created`, so it never sorts the author's screenshots in a temp B-tree, and its count is an index range count.
- **Older clients and servers.** See § 0.15.

## 6. Test expectations

### Backend (`tests/f015.rs`)
- **Migration:** `idx_screenshots_author_created` exists on `screenshots` after migrate; `0022` leaves `activity_events` untouched (same `sql` as after `0019`).
- **Feed basics:**
  - Follower F of author A. A posts 1 screenshot on published game G → F's feed has one `screenshotPosted` item with `game.id == G`, `actor == A`, `reason: "following"`, `version: null`, `screenshots.count == 1`, `items.len() == 1`, `items[0].id` = the posted id, and `createdAt == items[0].createdAt`.
  - Two more posts the same day → still one item, with a higher `id`, `count == 3`, and items newest first.
  - 6 posts → `count == 6`, `items.len() == 4`.
  - `kinds=screenshotPosted` returns only these items; `kinds=gamePublished` excludes them.
  - A non-follower and A themself don't see the item.
- **Owner shots:** the owner O of G posts a shot → O's followers see the item.
- **Unpublished game:** O posts while G is unpublished → no `activity_events` row. Publish G and post again the same day → the item includes both shots (§ 0.4, documented). Unpublish → the item is hidden. Republish → it is shown again.
- **Day split:** insert a `screenshotPosted` row directly with yesterday's `day`, and `UPDATE` one screenshot's `created_at` to yesterday → yesterday's item shows exactly that shot, and today's item shows the others.
- **Read-time deletes:** delete 1 of 3 → `count == 2`. Delete all → the item is not returned, and paging with `limit=1` across the skipped row still reaches older items (cursor rule). An admin resolving a screenshot report with `delete` has the same effect.
- **`canDelete`:** false for a plain follower; true when the follower is G's owner; true for an admin follower.
- **Writer failure is best effort:** after `CREATE TRIGGER f015_fail BEFORE INSERT ON activity_events WHEN NEW.kind = 'screenshotPosted' BEGIN SELECT RAISE(ABORT, 'f015 test'); END`, a post still returns 201, the screenshot exists, and there is no `screenshotPosted` row.
- **Rejected posts:** 422 (bad caption), 422 (cap), 413 and 429 (`setup_with(|c| c.rate_limit = true)`) write no row.
- **Profile endpoint:**
  - Anonymous `GET /api/users/{a}/screenshots` lists A's shots on published games, newest first, each with `game { id, title }` and `canDelete: false`.
  - A shot on an unpublished game is hidden from anonymous users, from other users, and from A (when A isn't the owner), but visible to the game owner.
  - `perPage=1&page=2` paging and `total`; `perPage=500` is clamped to 50; `page=0` behaves as 1.
  - `page=x` → 400 `page must be an integer`; an unknown user → 404 `User not found`; username matching is case-insensitive.
  - `canDelete` is true for A, for the game owner and for an admin.
- **Plans (`tests/review2.rs`, extended):**
  - The N1 kinds list includes `screenshotPosted`.
  - The plan contains `idx_screenshots_author_game (author_id=? AND game_id=?)`, and no line starts with `scan s ` or contains `scan screenshots`. All existing assertions still hold.
  - A new test asserts that the profile query plan uses `idx_screenshots_author_created` and has no `USE TEMP B-TREE FOR ORDER BY`.

### Frontend (vitest)
As listed in § 4 frontend-dev task 10.

### Manual end to end
1. User B follows A. A plays Kiln Clash, presses 📷 and posts three shots, one with a caption.
2. B's feed shows "A posted 3 screenshots of Kiln Clash" with three thumbnails. The lightbox browses them, and "View on game page" scrolls the game page to Screenshots.
3. The Screenshots tab shows only this item.
4. A's profile shows the three shots, each labelled "Kiln Clash". A deletes one there, and B's feed item now says 2.
5. The owner of Kiln Clash, following A, deletes another from the feed lightbox.
6. A posts a fourth shot the next UTC day, which creates a new, separate item.
7. On desktop, the same flows work under the hash router.

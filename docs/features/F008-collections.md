# F008: Collections (curated game lists)

Status: **specced**. Size: **M** (backend medium, frontend medium, desktop small; one round). Areas: backend, frontend, desktop. No engine changes.
Contracts: `docs/API.md` § F008 additions (types, ten endpoints, report changes, validation order, limits, rate limit), `docs/ARCHITECTURE.md` § F008 additions (migration `0016_f008.sql` incl. the `reports` rebuild, query shapes, share URLs, decisions), `docs/GAME_FORMAT.md` § F008 additions (no changes; noted for completeness).
Depends on: nothing unshipped. Reuses `fetch_visible_game`/`GameRow::visible_to`, `GAME_SELECT`, `parse_paging`, `limit_user`, the v2 report flow (F005 rebuild pattern), `useModal`, `ConfirmDialog`, `GameCard`, `ReportButton`. The migration is **`0016_f008.sql`** and runs after `0015_f017.sql`. **No new Rust or JS dependencies.**

## 1. Goal and user stories
Discovery today is algorithmic (new, popular, top, trending, "More like this") or personal and private (favorites). Players who know the catalogue well have no way to say "these are the best short puzzle games" in a form others can find and share, and creators can't group their own games into a series.

F008 adds **collections**: a named, ordered list of up to 100 games with a title, a description and an optional one-line note per game. A collection is **public** (on the owner's profile, on the game pages of its games, shareable at `/c/{id}`) or **private** (only the owner sees it; a "play later" list).

User stories:
1. As a player, on a game page I click **+ Collection**, tick "Cozy games", and the game is added at the end of that list. I can also create a new collection from the same dialog, with this game already in it.
2. As a player, I open my collection, move games up and down to rank them, write a note under each ("Best soundtrack on the site"), and copy the link to share it in a chat.
3. As a visitor, I open a shared `/c/{id}` link and see the ordered list with the curator's notes, with each game one click from playing.
4. As a visitor on a profile, I see the user's public collections next to their games, with a 2×2 cover of the first thumbnails.
5. As a visitor on a game page, a "Featured in collections" shelf shows public collections that include this game, which leads me to similar games picked by people.
6. As a creator, I group my three games into a public "Ember series" collection and link it from my game descriptions.
7. As a player, I keep a private "Play later" collection. Nobody else can see it, list it or find it on game pages.
8. As a moderator, I get reports on abusive collection titles or descriptions in `/admin` and can dismiss them or delete the collection.
9. As a keyboard or screen-reader user, I can reorder without drag-and-drop (Move up / Move down buttons), and each move is announced with the new position.

Non-goals (later items): feed items or notifications for collections (needs F018's notification kind work; proposed as F021), following a collection, collaborative collections, a global "browse collections" page or home shelf, collection cover uploads, drag-and-drop reordering (optional polish only, never the only way), game owners removing their game from someone else's collection, unlisted visibility.

## 2. UX notes

### 2.1 Routes
| Route | Page | Auth |
|---|---|---|
| `/c/:id` | `CollectionPage` | public (private collections: owner/admin only, else the not-found page) |
| `/u/:username/collections` | `UserCollectionsPage` (all of a user's collections, paged 24) | public |
| `/collections` | redirects to `/u/{me}/collections`; anonymous → `/login?next=/collections` (wrapped in the existing `RequireAuth` from `Layout.tsx`) | auth |

The header user menu gains **Collections** (after Favorites), linking to `/collections`.

### 2.2 Collection card (`CollectionCard`, used on profiles, the user collections page and the game page shelf)
- A link card (`<article>` with one `<a>` covering title, like `GameCard`) to `collection.path`.
- Cover: a 2×2 grid of up to 4 `coverUrls` (resolved with the existing `useResolveUrl`), `alt=""` (decorative; the title is the accessible name). Missing tiles use the existing thumbnail placeholder style. 0 covers → a single placeholder with a 📚 glyph (`aria-hidden`).
- Title (one line, ellipsis), "by {displayName}" (omitted on the owner's own profile list), "{gameCount} games" ("1 game"), and a **Private** badge (`<span class="pf-badge pf-badge--private">🔒 Private</span>`, emoji `aria-hidden`) when `visibility === "private"`.
- `CollectionGrid` renders cards in the existing grid layout with skeletons while loading.

### 2.3 Profile (`ProfilePage`)
- A new **Collections** section after Games: `GET /api/users/{username}/collections?perPage=6`. Shows up to 6 cards and a "See all {total} collections" link to `/u/{username}/collections` when `total > 6`.
- On your own profile: a **New collection** button in the section header (opens `CollectionFormDialog`, then navigates to the new `/c/{id}`), and the empty state "Group games into lists to share or to play later." with that button. Other users' profiles with no visible collections hide the section entirely (no empty state).

### 2.4 Game page (`GamePage`)
- **+ Collection** button in `.pf-gamepage__actions`, after the favorite button (also shown to the game owner). Anonymous: it links to `/login?next=/games/{id}` like other auth-gated actions.
- **`AddToCollectionDialog`** (`useModal`, title "Add to collection", labelled by its heading):
  - Loads `GET /api/users/me/collections?gameId={id}`. While loading: a skeleton list; on error: `ErrorState` with retry.
  - A list of checkboxes, one per collection: label = title, plus "(private)" and "{itemCount}/100" in muted text. Checked = `containsGame`.
  - Toggling a checkbox calls `PUT` (add) or `DELETE` (remove) immediately; the checkbox is `aria-busy` and ignores clicks while in flight; on error it reverts and shows the error inline under the list (`role="alert"`) plus 429 text "Slow down, try again in {Retry-After}s". Live region: "Added to {title}" / "Removed from {title}".
  - A collection with `itemCount >= 100` that doesn't contain the game: checkbox disabled with the hint "Full (100 games)" (`aria-describedby`).
  - Bottom: **New collection…** expands an inline form (title, visibility radio Public/Private, default Public) with **Create and add**. It calls `POST /api/collections` with `gameId`, then shows the new collection checked at the top and moves focus to its checkbox. Hidden with the note "You have 50 collections, the maximum." at the cap.
  - Empty state (no collections): the inline form is expanded by default.
  - **Done** closes the dialog; focus returns to **+ Collection**.
- **"Featured in collections" shelf** (`GameCollections`), placed after the Screenshots gallery and before Comments: `GET /api/games/{id}/collections?limit=6`. Heading "Featured in {total} collections" ("1 collection"). Hidden when `total` is 0 or the request fails (it is non-essential; log the error). No "see all" page in this round.

### 2.5 Collection page (`CollectionPage`, `/c/:id`)
- **Header**: title (`h1`), "A collection by {UserLink}", "{gameCount} games · Updated {date}", the Private badge, and the description (`white-space: pre-line`, plain text). `useDocumentTitle(title)`.
- **Actions**:
  - Public: **Copy link** (`collectionShareUrl`, § 2.7). Success → button text "Link copied" for 2 s and a live-region message; if the Clipboard API is unavailable or rejects, a small inline read-only `<input>` with the URL is shown, selected and focused.
  - Private (owner): instead of Copy link, the note "Private: only you can see this collection."
  - Owner: **Edit** (opens `CollectionFormDialog` prefilled; saving updates the header in place) and **Delete** (`ConfirmDialog` "Delete this collection?", body "The games stay on the site; only this list is removed.", confirm "Delete collection"; then navigate to `/u/{me}/collections` with a toast "Collection deleted").
  - Admin who isn't the owner: **Delete** (same dialog). Non-owner signed-in users: **⚑ Report** (`ReportButton targetType="collection"`, label = title).
- **Items**: an ordered list `<ol class="pf-collection-items" aria-label="Games in this collection">`. Each `CollectionItemRow`:
  - The visible position number, the game thumbnail (link), title (link to `/games/{id}`), "by {owner}", plays and rating in muted text, a **Play** link (`/games/{id}`), and the curator's note (`<p class="pf-collection-note">`, plain text, omitted when empty).
  - Unavailable items (`game: null`, owner only): "Unavailable game" with the muted hint "This game was unpublished or removed by its creator." and only the **Remove** control. Non-owners never receive these.
  - **Owner controls** (per row, link-style buttons): **Move up**, **Move down** (each hidden at the boundary rather than disabled, so the tab order has no dead stops), **Edit note**, **Remove**.
    - Labels: `aria-label="Move {title} up"`, `"Move {title} down"`, `"Edit note for {title}"`, `"Remove {title} from collection"` (unavailable: "Unavailable game").
    - Move: compute the new full order client-side (`moveItem`) and `PUT …/order` with **all** item ids (unavailable ones included). The list updates from the response. Focus stays on the same button of the moved row (or the other move button if the one pressed disappeared at a boundary). Live region: "Moved {title} to position {n} of {count}". While a move is in flight, other move buttons ignore clicks.
    - 409 (the collection changed elsewhere): reload the collection, toast "This collection changed in another tab. Reloaded.", focus the list heading.
    - Edit note: replaces the note with an inline single-line input (maxLength 140, counter) with **Save** / **Cancel**; Enter saves, Escape cancels; focus returns to **Edit note**. Saves via `PUT …/games/{gameId}` with `{ note }`.
    - Remove: no confirmation (it is quick to re-add from the game page), but an **Undo** button appears in the toast for 5 s (Undo re-adds with the same note, appended at the end, then restores the order with one `PUT …/order`). Focus moves to the next row's Remove (or the previous row's, or the list heading when empty). Live region: "Removed {title}".
- **Empty**: owner → "No games yet. Use **+ Collection** on any game page to add one." with a link to Browse. Visitor → "This collection is empty."
- **Errors**: 404 → `NotFoundPage what="collection"`; other errors → `ErrorState` with retry.

### 2.6 Create/edit dialog (`CollectionFormDialog`)
- Fields: **Title** (required, maxLength 60, counter), **Description** (textarea, optional, maxLength 500, counter, hint "Up to 8 lines"), **Visibility** radio group (Public: "Shown on your profile and on game pages" / Private: "Only you can see it").
- Client-side checks mirror the server (§ API "Text rules"); the server's 422 message is shown inline on submit.
- Submit: "Create collection" or "Save changes". Busy state disables submit. Escape/cancel returns focus to the opener.

### 2.7 Share URL
`collectionShareUrl(config, id)` in `src/collections.ts`:
- `routerMode === "browser"`: `${window.location.origin}/c/${id}`.
- `routerMode === "hash"` (desktop): `${config.apiBaseUrl}/c/${id}` (an http(s) link that opens the web app served by the same server; see ARCHITECTURE § F008). If `apiBaseUrl` is empty, fall back to `window.location.origin`.
Links are never `tauri://` or `#/` URLs.

### 2.8 Admin (`AdminPage` report rows)
- `targetType === "collection"`: badge "collection", the preview (title at report time) as text, a **View collection** link to `/c/{targetId}` (admins can view private collections), actions **Dismiss** and **Delete** (confirm "Delete this collection?"). `targetGameId` is `null` for these rows; no game link.

### 2.9 Accessibility (normative for frontend-dev)
- Reordering never requires drag-and-drop. Move buttons are real `<button>`s with descriptive labels; every move is announced in the existing polite live region with the new position.
- Focus after every owner action is defined above; nothing leaves focus on `<body>`.
- The add dialog's checkboxes are native `<input type="checkbox">` with `<label>`; busy and full states are exposed with `aria-busy` and `aria-describedby`; the dialog traps focus and restores it (`useModal`).
- Cards: one link per card; covers are decorative; "Private" is visible text.
- The items list is an `<ol>` so position is announced natively; the visible number is `aria-hidden` to avoid double reading.

## 3. Contract changes (summary; normative text lives in docs/)
- `docs/API.md` § F008 additions:
  - New types `CollectionVisibility`, `CollectionSummary`, `CollectionItem`, `Collection`, `MyCollection`, `GameCollectionsPage`, `CollectionItemResponse`, `CollectionRemoveResponse`.
  - Endpoints: `POST /api/collections`, `GET`/`PATCH`/`DELETE /api/collections/{id}`, `PUT`/`DELETE /api/collections/{id}/games/{gameId}`, `PUT /api/collections/{id}/order`, `GET /api/users/{username}/collections`, `GET /api/users/me/collections`, `GET /api/games/{id}/collections`.
  - Reports: `targetType: "collection"`; `Report.targetGameId` becomes `string | null` (null for collections); resolve `delete` deletes the collection; `unpublish` → 422.
  - Caps: 50 collections per user, 100 games per collection. New `Limit::Collections` (120 per 10 min per user) shared by all collection writes.
- `docs/ARCHITECTURE.md` § F008 additions: migration `0016_f008.sql` (two tables, three indexes, `reports` rebuild without the `target_type` CHECK and with a nullable `target_game_id`), visibility rules, list/cover queries, guarded inserts, reorder statement, share URL decision, no feed/notifications.
- `docs/GAME_FORMAT.md` § F008 additions: none.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration `backend/migrations/0016_f008.sql`** exactly as in ARCHITECTURE § F008 (`collections`, `collection_games`, indexes, `reports` rebuild).
2. **`src/models.rs`**: `CollectionSummary`, `CollectionItem`, `Collection` (flattened summary + `items`, `is_owner`, `can_delete`), `MyCollection` (summary + `contains_game`, `item_count`), `GameCollectionsPage { items, total }`, `CollectionItemResponse`, `CollectionRemoveResponse`. All `#[serde(rename_all = "camelCase")]`; `CollectionItem.game` serialises `null` (not skipped).
3. **`src/routes/collections.rs`** (new):
   - Text validation: `validate_collection_title`, `validate_collection_description`, `validate_collection_note`, `parse_visibility` per API § F008 "Text rules" (reuse `versions::is_bidi_control`; note rules = `screenshots::validate_caption` semantics with the "note" wording).
   - `load_collection(state, id, viewer, is_admin) -> CollectionRow` applying the visibility rule (private → 404 unless owner or admin).
   - `summaries_for(state, rows, viewer)`: one batched query per page for `gameCount` and `coverUrls` (ARCHITECTURE § F008), never one query per collection.
   - Handlers: `create_collection`, `get_collection`, `update_collection`, `delete_collection`, `put_collection_game`, `delete_collection_game`, `put_collection_order`, `list_user_collections`, `list_my_collections`, `list_game_collections`, each with the check order from API § F008.
   - `pub async fn remove_collection(state, id)`: deletes the row (items cascade) and resolves open reports on it with resolution `delete`. Used by `DELETE` and by admin resolve.
   - Writes that check a cap use `BEGIN IMMEDIATE` and the guarded statements in ARCHITECTURE § F008; every successful change bumps `collections.updated_at`.
4. **`src/routes/reports.rs`**: `Report.target_game_id: Option<String>`; a `"collection"` branch in `create_report` (collection must be visible to the reporter, else 404 "Collection not found"; preview = title's first 140 chars; game id NULL); the unknown-type message becomes `targetType must be "game", "comment", "screenshot" or "collection"`; resolve `("delete", "collection") => remove_collection(...)`; `unpublish` on a collection report keeps the existing 422 "unpublish is only valid for game reports". A `TARGET_TYPES` const documents the Rust-side check that replaces the DB CHECK.
5. **`src/ratelimit.rs`**: `Limit::Collections` = (120, 600 s) with a doc comment listing the seven write endpoints.
6. **`src/routes/mod.rs`**: register the routes (API § F008). `/users/me/collections` must be registered as a static route next to `/users/me/favorites` (static segments win over `{username}`; "me" is not a valid username).
7. **`src/seed.rs`**: when seeding the demo account and example games, also create one public collection "Arcade starter pack" (description "Four short games to try first.") with the example games in this order: Space Dodge, Brick Breaker, Pixel Peaks, Ember Garden, each with a short note. Idempotent like the rest of the seed (skip if the demo user already has a collection with that title).
8. **Tests** (`tests/f008.rs`, `common::setup()`, `t.clock` (`ManualClock`) for rate limits):
   - CRUD: create (201, defaults `visibility: "public"`, `description: ""`), with `gameId` (item at position 0), get, patch each field, delete (204, then 404). `isOwner`/`canDelete` for owner, admin, stranger, anonymous.
   - Text rules: title empty/61 chars/with `\n`/with U+202E → 422; description 501 chars, 9 lines, `\t` → 422; `\r\n` normalised to `\n`; note 141 chars or with `\n` → 422; visibility "unlisted" → 422.
   - Visibility: private collection → 404 for stranger and anonymous on GET, PATCH, item and order endpoints and in reports; 200 for owner and admin. Private never in `/users/{u}/collections` for others or in `/games/{id}/collections`. Empty public collections are listed for the owner only.
   - Permissions: stranger PATCH/item/order on a public collection → 403; admin PATCH → 403; admin DELETE → 204.
   - Items: add appends (positions 0,1,2), re-PUT with a note updates the note only (`added: false`), re-PUT without `note` keeps it; add an unpublished game of another user → 404 "Game not found"; owner adds their own unpublished game → 200 and it is hidden from others; remove → `removed: true`, again → `removed: false`; remove works for a game that became invisible.
   - Unavailable: a listed game is unpublished by its creator → owner sees `{ gameId, game: null, note }`, others don't see it, `gameCount` drops for everyone; covers skip it. Deleting the game removes the item (cascade).
   - Order: valid permutation → 200 with the new order; missing/extra id → 409; duplicate id or non-string → 422; unavailable ids must be included (a permutation without them → 409).
   - Caps: 50th collection OK, 51st → 422; 100th game OK, 101st → 422 and re-PUT of an existing item at the cap still updates its note. Concurrency: 10 parallel adds at 95 items leave exactly 100.
   - Lists: `/users/{u}/collections` paging, order `updatedAt` desc (an add bumps a collection to the top), unknown user 404; `/users/me/collections?gameId=` returns `containsGame` and `itemCount` (unavailable included), unknown `gameId` → all false, no `gameId` → all false; `/games/{id}/collections` public-only, `limit` clamp, non-integer → 400, unpublished game for stranger → 404.
   - Covers: up to 4 thumbnail URLs in collection order, skipping games without thumbnails and invisible games.
   - Reports: create on a public collection → 201 with `targetGameId: null`, `targetImageUrl: null`; duplicate open report → 409; resolve `delete` → collection gone and all open reports on it resolved; `unpublish` → 422; existing game/comment/screenshot report tests stay green.
   - Migration upgrade: a DB at `0015` with reports of all three existing types migrates; reports keep ids, order and fields; inserting a report with an unknown `target_type` directly in SQL now succeeds (documents the Rust-side check).
   - Rate limit (`RATE_LIMIT` on): 120 mixed collection writes → the 121st → 429 with `Retry-After`; `t.clock.advance(Duration::from_secs(5))` → allowed again. Reads don't consume the bucket.
   - Existing suites (`v2.rs`, `f005.rs`, `f006.rs`, `review*.rs`) stay green.

**Acceptance:** `cd backend && cargo test` (all suites green) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`): the F008 types; `ReportTargetType` + `"collection"`; `Report.targetGameId: string | null`.
2. **Client** (`src/api/client.ts`): `createCollection(body)`, `getCollection(id)`, `updateCollection(id, patch)`, `deleteCollection(id)`, `putCollectionGame(id, gameId, body?)`, `deleteCollectionGame(id, gameId)`, `reorderCollection(id, gameIds)`, `listUserCollections(username, query)`, `listMyCollections(gameId?)`, `listGameCollections(gameId, limit?)`. Path segments are `encodeURIComponent`-ed.
3. **`src/collections.ts`** (new, pure): limits (`COLLECTION_TITLE_MAX = 60`, `COLLECTION_DESCRIPTION_MAX = 500`, `COLLECTION_DESCRIPTION_LINES_MAX = 8`, `COLLECTION_NOTE_MAX = 140`, `COLLECTIONS_PER_USER_MAX = 50`, `COLLECTION_GAMES_MAX = 100`), `validateCollectionTitle/Description/Note` (mirror API § F008, counting Unicode code points), `moveItem(ids, from, to)`, `collectionShareUrl(config, id)` (§ 2.7).
4. **Components** (new): `CollectionCard.tsx` (+ `CollectionGrid`), `CollectionFormDialog.tsx`, `AddToCollectionDialog.tsx` (+ `AddToCollectionButton`), `GameCollections.tsx`, `CollectionItemRow.tsx`.
5. **Pages**: `CollectionPage.tsx` (new), `UserCollectionsPage.tsx` (new, `Pagination` via `?page=`), `ProfilePage.tsx` (Collections section), `GamePage.tsx` (button + shelf), `AdminPage.tsx` (collection rows, § 2.8), `NotFoundPage` (`what="collection"`).
6. **Routing** (`WebGameApp.tsx`): `c/:id`, `u/:username/collections`, `collections` (auth redirect). Header user menu item **Collections** (`Layout.tsx`).
7. **`Report.tsx`**: `what` text "collection" for the new target type.
8. **Styles** (`styles.css`): `.pf-collection-card`, `.pf-collection-cover` (2×2), `.pf-collection-items`, `.pf-collection-item`, `.pf-collection-note`, `.pf-badge--private`, owner control row; use existing tokens; contrast 4.5:1.
9. **Tests**:
   - `ApiClient.f008.test.ts`: every method's method, path, body and encoding.
   - `collections.test.ts`: validators (code points, lines, control/bidi), `moveItem`, `collectionShareUrl` in both router modes and with an empty `apiBaseUrl`.
   - `CollectionPage.test.tsx`: header, notes, private note vs Copy link (clipboard success and fallback input), owner move up/down sends the full order (unavailable ids included), focus and announcement after a move, boundary buttons hidden, 409 reload path, edit note (Enter/Escape), remove + Undo, delete flow and navigation, unavailable row, visitor/admin/report controls, 404 page.
   - `AddToCollection.test.tsx`: checkbox state from `containsGame`, add/remove calls, revert on error, 429 text, full collection disabled with hint, create-and-add focus, cap note at 50, focus restored on Done, anonymous link.
   - `ProfileCollections.test.tsx` (section, "See all", own-profile New collection and empty state, hidden for others when empty) and `GameCollections.test.tsx` (shelf heading counts, hidden on 0 and on error).
   - Admin: a collection report row shows View collection and Dismiss/Delete only.
   - Existing suites stay green (update fixtures only where `targetGameId` typing needs it).

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
1. **`src-tauri/src/menu.rs`**: View → **Co&llections** (id `"collections"`, accelerator `CmdOrCtrl+Shift+L`), after Notifications. Update the module doc comment.
2. **`src/nativeMenu.ts`**: `ROUTES.collections = "/collections"`; update the doc comment.
3. **Test** (`src/__tests__`): the `"collections"` payload navigates to `#/collections`.
4. **Verify** in the Tauri app: Copy link on a public collection copies `{server}/c/{id}` (not a `tauri://` or `#/` URL) and the link opens the collection in a browser when the server serves `WEB_DIST`; the add dialog and Move buttons keep focus correctly in WebView2; `#/c/{id}` deep links work after a reload.

**Acceptance:** `npm run build -w @webgame/desktop`, `npm test -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo check`.

### engine-dev
None.

### Sequencing
- Backend and frontend run in parallel; frontend mocks API § F008 responses.
- Desktop's menu change is independent; its verification runs after the frontend lands.

## 5. Edge cases and security
- **Visibility of games inside collections** is evaluated per viewer at read time with the `GET /api/games/{id}` rule (published, or owned by the viewer). A collection can never reveal an unpublished game to someone who couldn't open it. The collection owner sees placeholders (`game: null`, `gameId` only) for items they can no longer see, so they can remove them; they added those ids themselves, so nothing new is disclosed.
- **Adding** requires the game to be visible to the collection owner at the time (404 otherwise), so you can't put someone's unpublished game into a public list.
- **Private collections** return 404 (not 403) to everyone except the owner and admins, so their existence can't be probed. They never appear in profile lists for others, in game shelves or in counts. Collection ids are UUID v4.
- **Admins** can view private collections (needed to review a report filed while the collection was public) and delete any collection, but can't edit them (no silent rewriting of users' text).
- **Text**: titles, descriptions and notes are plain text, rendered as React text nodes (no Markdown, no links), with control and bidi-control characters rejected (bidi spoofing in titles shown on other people's game pages). Description newlines are kept and rendered with `pre-line`.
- **Spam and abuse**: 50 collections per user, 100 games per collection, a shared write bucket of 120 per 10 min, reports with admin delete. Game page shelves show only 6 collections, ordered by recency, so one user can't flood a game page beyond that; if spam appears, the next step is ranking by the owner's follower count (not needed now).
- **Game owners** can't remove their game from others' public collections in this round (a collection is the curator's speech; the owner can report it). Unpublishing or deleting the game hides or removes it everywhere.
- **Concurrency**: cap checks and inserts run under `BEGIN IMMEDIATE`, so parallel adds can't exceed 100 and parallel creates can't exceed 50. Reorder replaces all positions in one statement and refuses (409) any request whose id set doesn't match the current items, so two tabs can't interleave into a corrupt order.
- **Deletes**: deleting a game cascades its `collection_games` rows; deleting a collection cascades its items and resolves its open reports; a user delete (if ever added) cascades their collections.
- **Reports rebuild**: `reports` is rebuilt (as in F005's `0009`) to drop the `target_type` CHECK and make `target_game_id` nullable. No table references `reports` and it has no triggers, so the rebuild is safe with foreign keys on. Report types are validated in Rust from now on, so later target types need no rebuild.
- **Share links on desktop** point at the configured server's web app. If that server doesn't serve `WEB_DIST`, the link 404s in a browser; this is documented for operators (ARCHITECTURE § F008) and checked in desktop verification.
- **Caching and compression (review 5)**: F008 serves no new files. `/api/*` stays uncompressed and uncached. `/c/{id}` and `/u/{name}/collections` are SPA routes that fall back to `index.html` with `no-cache` (review 5 M1), and the dev proxy doesn't intercept them. Cover images are existing thumbnail URLs with their existing caching.
- **Performance**: a profile or shelf page is at most 24 collections; their counts and covers come from one batched query over at most 2,400 item rows. A collection page is at most 100 games loaded with one joined query.

## 6. Test expectations
- **Backend**: `tests/f008.rs` as listed (CRUD, text rules, visibility, permissions, items and unavailable placeholders, order and 409, caps and concurrency, lists and covers, reports and rebuild upgrade, rate limit with `ManualClock`). All existing suites green.
- **UI**: client methods, pure helpers, collection page owner/visitor/admin flows with focus and announcements, add dialog, profile section and game shelf, admin rows.
- **Desktop**: green build and tests; manual share-link, focus and deep-link checks.
- **Manual end to end**: user A creates a public collection from a game page, adds three games, reorders with the keyboard only, writes notes and copies the link; user B (signed out) opens the link, sees the order and notes, sees the shelf on each game page and the collection on A's profile, then reports it; the creator of one game unpublishes it (A sees "Unavailable game", B doesn't see it); A makes the collection private (B gets the not-found page, the shelves drop it); an admin resolves the report with Delete. Repeat the owner flow with NVDA or VoiceOver.

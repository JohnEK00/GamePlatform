# F032: Home and discover 2 (with F029 featured games on profiles)

Status: **shipped**. Size: **M**. One round. Areas: backend, frontend, desktop. Engine: none.

Size breakdown:
- **backend:** migration `0027_f032.sql` (one table, two partial indexes); `sort=updated` on `GET /api/games`; `GET /api/collections` (public explore list); `GET /api/creators/spotlight`; F029 `PUT /api/users/me/featured` and `UserProfileResponse.featured`. No new rate-limit bucket, no new crates.
- **frontend:** a sectioned home page `/`, the full grid moved to a new `/browse` page (legacy `/?q=`, `?tag=`, `?sort=`, `?page=` redirect there), a creator spotlight, header/footer/tag links pointing at `/browse`, and F029: a Featured row on profile Overviews with a picker dialog.
- **desktop:** View → Home and View → Browse games.

Contracts: `docs/API.md` § F032 additions, `docs/ARCHITECTURE.md` § F032 additions, `docs/GAME_FORMAT.md` § F032 additions (none).

Depends on: F003 (trending), F004 (`lastUpdatedAt`), F008 (collections, `summaries_for`), F028 (profile shell, banners), F035 (`Creator`, `CreatorCard`, `routes/creators.rs`). All shipped.

**Folded in: F029** (featured games on profiles). It fits because the creator spotlight shows each creator's featured games first, so a creator controls what the home page shows of them. **Split out: admin-curated home picks** (the original pitch's `PUT /api/admin/featured`) become **F047**; the home "Featured" block keeps its current top-rated source this round.

Migration: the highest existing file is `0026_f031.sql`, so this round adds **`0027_f032.sql`**. The next free number after F032 is `0028`.

## 0. Decisions on ambiguities (read first)
API § F032 is normative. Tests assert the texts below verbatim. `{name}` means display name, falling back to username.

### Home page `/`
1. **Sections, in this order** (all on `/` with no query):

   | # | Section | Source | Size | Heading (h2) | Head link |
   |---|---|---|---|---|---|
   | 1 | Hero | static (existing) | – | existing h1 | – |
   | 2 | Featured | `listGames({ sort: "top", perPage: 4 })` (existing `Featured`, unchanged) | 4 | `Featured` | – |
   | 3 | Trending | `listGames({ sort: "trending", perPage: 8 })` (existing `TrendingShelf`) | 8 | `Trending this week` | `See all →` → `/browse?sort=trending` |
   | 4 | New releases | `listGames({ sort: "new", perPage: 4 })` | 4 | `New releases` | `See all →` → `/browse` |
   | 5 | Creator spotlight | `getCreatorSpotlight()` | 1 creator + ≤ 3 games | `Creator spotlight` | `See all creators →` → `/creators` |
   | 6 | Recently updated | `listGames({ sort: "updated", perPage: 4 })` | 4 | `Recently updated` | `See all →` → `/browse?sort=updated` |
   | 7 | Player collections | `listCollections({ perPage: 3 })` | 3 | `Player collections` | – |
   | 8 | Browse by tag | `listTags()` (first 12) + a button | ≤ 12 chips | `Browse by tag` | – |

   - Every section is a `<section aria-labelledby="{headingId}">`. Heading ids: `pf-featured-title` and `pf-trending-title` (existing), `pf-home-new-title`, `pf-home-spotlight-title`, `pf-home-updated-title`, `pf-home-collections-title`, `pf-home-tags-title`.
   - All requests start in parallel on mount.
2. **Section states.**
   - **Loading:** sections 3–7 show their heading and skeletons (4 `GameCardSkeleton`s; 3 `CollectionCardSkeleton`s; one `CreatorCardSkeleton` beside 3 game skeletons). Featured keeps its existing skeleton. Tags show 6 chip skeletons (existing pattern).
   - **Error:** sections 2–7 hide silently (the existing `TrendingShelf` rule). Section 8's chips hide, but its `Browse all games` button always shows, so a visitor is never stuck.
   - **Empty:** a section with no items is hidden. Trending keeps its F003 rule (only items with `playsWeek > 0`; hidden when none). The spotlight hides when `creator` is null.
   - **Empty platform:** when New releases resolves with `total === 0`, the page shows only the hero followed by `EmptyState` icon `🕹`, title `No games yet`, text `The arcade is empty. Be the first to ship a game!`, action `<Link className="pf-btn pf-btn--primary" to="/upload">Upload the first one</Link>`. Sections 2–8 are not rendered (requests already in flight are ignored).
3. **Hero.** Unchanged except the primary CTA: `Start playing` becomes `<Link className="pf-btn pf-btn--primary pf-btn--lg" to="/browse">Start playing</Link>` (it used to scroll to the grid, which moved). The secondary CTA is unchanged.
4. **Creator spotlight.**
   - One creator per UTC day, the same for every viewer (API § F032). The server returns up to 3 of their published games: their F029 featured games that **they own**, in their order, then their most-played other games.
   - Layout: the F035 `CreatorCard` (with `headingLevel={3}`) on the left and a `GameGrid` of the games on the right.
   - Under the h2: `<p className="pf-muted pf-small">A different creator every day.</p>`.
   - The card's Follow button and `Your profile` link behave as on `/creators`. The page seeds the F002 follow store from `creator` exactly as `CreatorsPage` does.
5. **Player collections.** Public collections with at least 3 published games, most recently updated first (API § F032). Rendered with the existing `CollectionGrid` (`showOwner`). No "See all" link this round (a collections directory belongs with F033 search).
6. **Browse by tag.** Up to the first 12 tags of `GET /api/tags`, as `TagChip`s with `to={browsePath({ tag })}`, then `<p><Link className="pf-btn pf-btn--primary" to="/browse">Browse all games</Link></p>`.
7. **Document title** of `/` stays the site name (`useDocumentTitle("")`, unchanged).
8. **Legacy URLs.** `/` with any of the keys `q`, `tag`, `sort` or `page` in its query renders `<Navigate replace to={"/browse" + search} />`, keeping the whole query string as is (`/?tag=arcade&page=2` → `/browse?tag=arcade&page=2`). Other keys alone (for example `/?utm=x`) show the home page. `replace` means Back never returns to the redirecting URL.

### Browse page `/browse`
9. **Content.** The grid section that used to live on `/`, moved as is: sort toggle group, tag chip row (top tags, filter in place), active-filter chips, grid, `Pagination`. Differences:
   - The heading becomes the page's **h1** (`<h1 id="pf-browse-title" className="pf-section-title">`), with the same texts: `Browse games`, `Results for “{q}”` or `#{tag}`, plus the existing muted total.
   - The section keeps `id="pf-browse"`; paging still scrolls to it.
   - Document title: `Search: {q}`, `#{tag}`, else `Browse games`.
   - A sixth sort, last in the group: key `updated`, label `Recently updated`. The URL omits `sort` for `new` (unchanged rule). An unknown `sort` shows New (unchanged).
   - Empty states:
     - unfiltered `sort=updated` with no items: icon `🕹`, title `No updated games yet`, text `Games show up here after their creators publish an update.`, action `<button className="pf-btn">Show all games</button>`, which removes `sort` (and `page`);
     - otherwise the existing texts (`No games match` / `Clear filters`, `No games yet` / `Upload the first one`).
   - The hero, Featured and Trending blocks are **not** on `/browse`.
10. **Header search** submits to `/browse?q={trimmed}` (or `/browse` when blank). Its input mirrors `?q` while the pathname is `/browse` (it used to mirror `/`). The label stays `Search games` (F033 owns a search page).

### Links that move
11. - Header nav: `Browse` → `<NavLink to="/browse">Browse</NavLink>` (no `end`; it is still the first nav link). The logo stays the link to `/`. No new "Home" nav link (F034 regroups the header).
    - Footer: `Browse` → `/browse`.
    - Game page tag chips: `/?tag=x` → `browsePath({ tag: x })` = `/browse?tag=x` (F036 will move them to tag pages).
    - `Browse games` buttons in the empty states of `FavoritesPage` and `CollectionPage`: `/` → `/browse`.
    - `NotFoundPage` keeps `/`.

### F029: featured games on profiles
12. **Rules.** Up to **4** games, published at save time, any owner's (your own or anyone else's). Order is the user's. Saving replaces the whole list. `[]` clears it.
13. **Read rule.** `UserProfileResponse.featured` lists only games that are **published now**, in the saved order, for every viewer, the owner included. Unpublished games are hidden but stay saved (they reappear if republished); deleted games and deleted users cascade away.
14. **Overview row.** On `/u/{u}` (Overview only), first in the section, before achievements:
    - With games: `<section className="pf-shelf pf-profile-featured" aria-labelledby="profile-featured-title">`, h2 `Featured`, then a `GameGrid` of the games.
    - The owner also gets `<button className="pf-btn pf-btn--ghost pf-btn--sm" aria-label="Edit featured games">Edit featured</button>` in the shelf head.
    - Owner with none: the same section with a `.pf-featured-empty` panel: `<p>Pick up to 4 games to show first on your profile: your own or ones you love.</p>` and `<button className="pf-btn pf-btn--sm">Feature games</button>`.
    - Visitors with none: nothing.
    - Older servers (no `featured` array in the response): nothing, for everyone.
    - The "Nothing here yet" empty-Overview rule (F028/F030) also requires `featured.length === 0`.
15. **Picker dialog** (`FeaturedGamesDialog`), opened by either button:
    - `role="dialog" aria-modal="true" aria-labelledby="featured-dialog-title"`, through `useModal` with `initialFocus: "#featured-dialog-title"` (the h2 has `tabIndex={-1}`) and `canClose: !saving`.
    - h2 `Featured games`; lead `Pick up to 4 games. They show first on your profile, in this order.`
    - **Selected list:** `<h3 id="featured-selected-title" tabIndex={-1}>Selected ({n}/4)</h3>`, then an `<ol>`. Each row: a 48 px `Thumbnail`, the title, `by {owner name}`, and three buttons: `↑` (`aria-label="Move {title} up"`), `↓` (`aria-label="Move {title} down"`), `Remove` (`aria-label="Remove {title}"`). With none: `<p className="pf-muted">No games selected. Your profile won't show a Featured row.</p>`.
    - **Candidates:** h3 `Your games` (your **published** games from `listGames({ owner: "me", sort: "new", perPage: 100 })`, unpublished filtered out on the client), then h3 `Your favorites` (`listMyFavorites({ perPage: 100 })`, published only, minus any game already under `Your games`). Each row: thumbnail, title, `by {owner name}` (favorites only), and `Add` (`aria-label="Add {title}"`). Empty texts: `You haven't published any games yet.` and `Games you favorite show up here.` Loading: `Spinner` with label `Loading your games`. Error: `LoadError` `Couldn't load your games.` with Retry. The candidate area scrolls (`max-height: 40vh`).
    - **Disabled states never use `disabled`** (so focus is never lost): boundary Move buttons, `Add` for an already selected game (its text becomes `Added`), and every other `Add` while 4 are selected carry `aria-disabled="true"` and do nothing when pressed. While 4 are selected the candidates block shows `<p className="pf-muted pf-small">You can feature up to 4 games. Remove one to add another.</p>` above the lists.
    - **Focus:** Move keeps focus on the same button of the moved row. Remove focuses `#featured-selected-title`. Add keeps focus on the pressed button.
    - **Footer:** `Cancel` (closes, discards) and primary `Save` (label `Saving…` while in flight; `aria-disabled` while saving). Save always sends the list, even unchanged.
    - **Save:** `setFeaturedGames(ids)` → toast success `Featured games saved.`, close (focus returns to the opener, or to the `Edit featured` button when the opener was the now-gone `Feature games` button: use `returnFocus`/`preferReturnFocus`), then `ctx.reload()` (background refresh keeps the profile on screen).
    - **Save error:** an `Alert` inside the dialog with the server message (`ApiError.message`); the dialog stays open with the selection intact.
16. **Responsive.**
    - Home shelves use `.pf-grid` (auto-fill 240 px; 160 px at ≤ 640 px). 4 cards fill one row on desktop and wrap to 2×2 or 2 columns on narrow screens.
    - `.pf-spotlight`: `display: grid; grid-template-columns: minmax(260px, 320px) 1fr; gap: 18px; align-items: start`. At ≤ 860 px (the header collapse width) a single column, card first.
    - The tag chips wrap (existing `.pf-chips`).
    - `FeaturedGamesDialog`: `max-width: 560px`; at ≤ 640 px it is full width with 12 px side margins; rows keep the buttons on one line and the title ellipsised.

Non-goals (later items):
- admin-curated home picks: **F047** (new);
- a "Continue playing" shelf: F043;
- a collections directory or search: F033; tag pages: F036;
- header regrouping, a mobile menu sheet and footer redesign: F034;
- notifying a creator when someone features their game;
- carousels or auto-rotating content (none anywhere: no motion, nothing to pause).

## 1. Goal and user stories
The home page is one Featured block, one shelf and a long grid. F032 turns `/` into a discover page with variety (new, updated, trending, people, lists, tags) and moves the full grid to its own `/browse` page. Folding in F029 lets every user decide what their profile leads with, and lets creators shape how the spotlight presents them.

1. As a visitor, I open the site and see trending games, new releases, a creator of the day with their games, recently updated games and player collections, without scrolling through a grid.
2. As a player, I click `See all →` on Recently updated and land on `/browse?sort=updated`.
3. As a returning user with an old bookmark `/?tag=puzzle`, I land on `/browse?tag=puzzle`.
4. As a creator, I feature my two best games on my profile; on the day I'm spotlighted, those two lead my spotlight.
5. As a player who doesn't make games, I feature 3 favourites so my profile has something to show.
6. As a keyboard or screen-reader user, the picker names every button by game, never drops focus, and announces the selected count.
7. As a desktop user, View → Home and View → Browse games open the two pages.

## 2. UX notes
- **Shelves** reuse `.pf-shelf`, `.pf-shelf__head` and `.pf-shelf__more` (F003). A new `GameShelf` component renders the head, the grid, loading and the hide rules, and the existing `TrendingShelf` becomes a `GameShelf` (same heading, `highlight="trending"`, the `playsWeek > 0` filter; only its `See all` target changes).
- **Spotlight** `.pf-spotlight` (see § 0.16). The `CreatorCard` keeps its F035 look; its bio still clamps to 2 lines.
- **Profile Featured row** `.pf-profile-featured` is a normal shelf. `.pf-featured-empty` is a dashed-border panel (`border: 1px dashed var(--pf-border)`, 16 px padding, `pf-panel` radius) with the text and button in a row that wraps at ≤ 640 px.
- **Picker rows** `.pf-featured-row`: `display: flex; align-items: center; gap: 10px`; the title `flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`. `aria-disabled="true"` buttons get `opacity: .5; cursor: not-allowed` (add the selector next to the existing disabled button styles).
- **Live count.** The `Selected ({n}/4)` heading is not live; screen-reader users hear the count when focus lands on it after Remove. No `aria-live` is added.
- **Contrast and motion.** Existing tokens only. No animation, no carousel.

## 3. Contract changes (summary; normative text lives in docs/)
- **API.md § F032 additions:**
  - `GameSort` gains `"updated"` (filter + order) and the unknown-sort message changes;
  - new `GET /api/collections`, `GET /api/creators/spotlight`, `PUT /api/users/me/featured`;
  - `UserProfileResponse.featured`;
  - types `CreatorSpotlight`, `FeaturedGamesRequest`, `FeaturedGamesResponse`;
  - web routes `/` (sections, legacy redirects) and `/browse`.
- **ARCHITECTURE.md § F032 additions:** migration `0027_f032.sql`, the SQL of each read, the spotlight pick, UI files and ownership.
- **GAME_FORMAT.md § F032 additions:** none.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **`migrations/0027_f032.sql`** (ARCHITECTURE § F032, verbatim): `profile_featured`, `idx_profile_featured_game`, `idx_games_pub_updated`, `idx_collections_public_updated`.
2. **`src/routes/games.rs`:**
   - `list_order`: `"updated" => "g.last_updated_at DESC, g.id"`. The unknown-sort message becomes `Unknown sort '{other}' (expected new, popular, top, favorites, trending or updated)`.
   - `list_filter`: when the trimmed `sort` is `updated`, push the condition `g.last_updated_at IS NOT NULL` (it combines with `q`, `tag` and `owner`; the count query uses the same `WHERE`, so `total` matches).
   - Update the message assertion in `tests/f003.rs` (line ~273) to the new text.
3. **`src/routes/collections.rs`:** `list_collections` (🔓 `MaybeAuthUser`, `ApiQuery<ExploreCollectionsQuery { page, per_page }>`):
   - constants `EXPLORE_MIN_GAMES: i64 = 3`, `EXPLORE_PER_PAGE_DEFAULT: i64 = 12`, `EXPLORE_PER_PAGE_MAX: i64 = 48`;
   - `parse_paging(page, perPage, 12)` then clamp `perPage` to 1–48;
   - count + page statements from ARCHITECTURE § F032; items through the existing `summaries_for(&state, &rows, viewer.id())`;
   - returns `Page<CollectionSummary>`. No rate limit.
4. **`src/routes/creators.rs`:**
   - Refactor `page_sql(order)` into `creator_sql(owner_filter: bool, order: &str)`: with `owner_filter`, the CTE's `WHERE` gains `AND owner_id = ?3`. `list_creators` behaviour is unchanged (its tests must pass untouched).
   - Extract the row → `Creator` mapping and the `isFollowing` batch into private helpers shared by both handlers.
   - `pub fn spotlight_index(day: i64, n: i64) -> i64` = `day.rem_euclid(n)` (`n > 0`), and `pub fn utc_day_number(now: DateTime<Utc>) -> i64` = days since 1970-01-01 (`now.date_naive().signed_duration_since(NaiveDate::from_ymd_opt(1970,1,1))`.num_days()).
   - `get_spotlight` (🔓 `MaybeAuthUser`), the three steps in ARCHITECTURE § F032. Serde `CreatorSpotlight { day: String /* "YYYY-MM-DD" */, creator: Option<Creator>, games: Vec<GameSummary> }`, camelCase. With no creators: `{ day, creator: null, games: [] }`.
5. **`src/routes/users.rs`** (F029):
   - `pub const FEATURED_GAMES_MAX: usize = 4;`
   - `UserProfile` gains `featured: Vec<GameSummary>`, filled in `get_user` with the read statement (ARCHITECTURE § F032).
   - `put_featured` (🔒 `AuthUser`, `ApiJson<FeaturedBody { game_ids: Vec<String> }>`, camelCase): the checks and the transaction in API § F032; responds `FeaturedGamesResponse { featured }` (read back with the same statement after commit).
   - `clear_profile` is **not** changed (featured games are published games, already moderated separately).
6. **`src/routes/mod.rs`:**
   - `.route("/collections", get(collections::list_collections).post(collections::create_collection))` (replacing the `post`-only route);
   - `.route("/creators/spotlight", get(creators::get_spotlight))` next to `/creators`;
   - `.route("/users/me/featured", put(users::put_featured))` next to the other `/users/me/*` routes.
7. **`tests/f032.rs`** (§ 6).

**Acceptance:** `cd backend && cargo test` (all suites) and `cargo clippy --all-targets -- -D warnings`. One migration (`0027`), no new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`, exported from `src/index.ts`):
   - `GameSort` gains `"updated"`;
   - `CreatorSpotlight = { day: string; creator: Creator | null; games: GameSummary[] }`;
   - `ListCollectionsQuery = { page?: number; perPage?: number }`;
   - `FeaturedGamesResponse = { featured: GameSummary[] }`;
   - `UserProfileResponse.featured?: GameSummary[]` (doc comment: F029; older servers omit it).
2. **Client** (`src/api/client.ts`):
   - `listCollections(query: ListCollectionsQuery = {}, signal?: AbortSignal): Promise<Page<CollectionSummary>>` → `GET /api/collections` (only present keys, order `page`, `perPage`);
   - `getCreatorSpotlight(signal?: AbortSignal): Promise<CreatorSpotlight>` → `GET /api/creators/spotlight`;
   - `setFeaturedGames(gameIds: string[]): Promise<FeaturedGamesResponse>` → `PUT /api/users/me/featured` with `{ gameIds }`.
3. **Pure helpers** (`src/home.ts`, new; no React):
   - `HOME_SHELF_SIZE = 4`, `HOME_COLLECTIONS_SIZE = 3`, `HOME_TAGS_MAX = 12`, `FEATURED_GAMES_MAX = 4`;
   - `BrowseParams = { q?: string; tag?: string; sort?: GameSort; page?: number }`;
   - `browsePath(p: BrowseParams = {}): string` → `/browse` plus, in this order, `q` (trimmed, when non-empty), `tag` (when non-empty), `sort` (unless `new` or absent), `page` (when > 1), encoded with `URLSearchParams`. For example `browsePath({ sort: "updated" })` = `/browse?sort=updated`, `browsePath({ tag: "puzzle", page: 2 })` = `/browse?tag=puzzle&page=2`;
   - `LEGACY_HOME_KEYS = ["q", "tag", "sort", "page"] as const`;
   - `legacyHomeRedirect(search: string): string | null` → `"/browse" + search` when the query has any `LEGACY_HOME_KEYS` key (even empty-valued), else `null`;
   - `isValidSpotlight(x: unknown): x is CreatorSpotlight` (an object with a string `day`, `creator` null or `isValidCreator`, and an array `games`);
   - `moveItem<T>(list: readonly T[], index: number, delta: -1 | 1): T[]` (a new array; out-of-range moves return a copy unchanged).
4. **`src/components/CreatorCard.tsx`:** `CreatorCard` gains an optional `headingLevel?: 2 | 3` (default 2) for the name heading. Nothing else changes.
5. **`src/components/HomeSections.tsx`** (new):
   - `GameShelf({ id, title, seeAll, query, size, highlight, filter })`: fetches `api.listGames(query)` through `useAsync`, applies `filter`, renders the § 0.2 states;
   - `CreatorSpotlightSection()` (§ 0.4; drops an invalid response, i.e. hides);
   - `CollectionsShelf()` (§ 0.5);
   - `TagsSection()` (§ 0.6).
6. **`src/pages/HomePage.tsx`** (rewrite): legacy redirect first (§ 0.8), then the hero, `Featured` (kept), `GameShelf` for Trending (replacing `TrendingShelf`; `seeAll="/browse?sort=trending"`), New releases (this one also drives the empty-platform rule, § 0.2), `CreatorSpotlightSection`, Recently updated, `CollectionsShelf`, `TagsSection`.
7. **`src/pages/BrowsePage.tsx`** (new): the old grid section (§ 0.9) with `SORTS` + `{ key: "updated", label: "Recently updated" }`.
8. **Routing** (`src/WebGameApp.tsx`): `<Route path="browse" element={<BrowsePage />} />`, public.
9. **Layout** (`src/components/Layout.tsx`): § 0.10–0.11 (nav `Browse` → `/browse`, search → `/browse`, footer `Browse` → `/browse`).
10. **Other links** (§ 0.11): `GamePage.tsx` tag chips, `FavoritesPage.tsx` and `CollectionPage.tsx` empty-state buttons.
11. **F029:**
    - `src/components/FeaturedGamesDialog.tsx` (new): `FeaturedGamesDialog({ open, initial, onClose, onSaved }: { open: boolean; initial: GameSummary[]; onClose: () => void; onSaved: (featured: GameSummary[]) => void })`, § 0.15.
    - `src/pages/ProfileSections.tsx` `ProfileOverview`: the Featured row and the empty-Overview rule (§ 0.14); `onSaved` calls `ctx.reload()`.
12. **Styles** (`styles.css`): `.pf-spotlight`, `.pf-profile-featured`, `.pf-featured-empty`, `.pf-featured-dialog`, `.pf-featured-row` (+ `__title`, `__actions`), `.pf-featured-candidates` (scroll area), `[aria-disabled="true"]` button style, and the 860 px / 640 px rules. Existing tokens only.
13. **Exports** (`src/index.ts`): `BrowsePage`, `GameShelf`, `CreatorSpotlightSection`, `CollectionsShelf`, `TagsSection`, `FeaturedGamesDialog`, every `home.ts` export, and the new types.
14. **README** (`packages/ui/README.md`): routes table (`/` sections, `/browse`), new exports.
15. **Tests** (§ 6). Update existing suites whose expectations move:
    - `HomePage.f003.test.tsx`: the grid and sort-toggle cases move to a new `BrowsePage.test.tsx` (as `/browse` cases); `See all →` now points at `/browse?sort=trending`; the `/?page=2`, `/?q=dodge`, `/?tag=arcade` cases now assert the redirect;
    - `Layout.f035.test.tsx`: the home link it anchors on is now `Browse` with `href="/browse"`;
    - `CollectionPage.test.tsx`: `Browse games` → `/browse`.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`, `npm test -w @webgame/desktop`.

### desktop-dev (`apps/desktop/**`)
1. **`src-tauri/src/menu.rs`:** two forwarded ids at the top of View, before `My &Profile`: `"home"` as `&Home` and `"browse"` as `&Browse games` (H and B are free in View), **no accelerators**. Add both to `FORWARDED`, update the module doc, and add a unit test (`home_and_browse_are_forwarded_without_accelerators`) following the F035 one.
2. **`src/nativeMenu.ts`:** `ROUTES.home = "/"`, `ROUTES.browse = "/browse"`; update the doc comment.
3. **`src/__tests__/nativeMenu.test.ts`:** `"home"` → `#/`, `"browse"` → `#/browse`.
4. **`src/__tests__/f032.desktop.test.tsx`** (the `f035.desktop.test.tsx` pattern: real `App`, hash router, `SERVER_STORAGE_KEY` = `http://192.168.1.5:8080`, mocked `fetch`). Assert:
   - `#/` requests `GET http://192.168.1.5:8080/api/creators/spotlight` and `GET http://192.168.1.5:8080/api/collections?perPage=3`, and a `/api/games` request with `sort=updated` and `perPage=4`;
   - the spotlight creator's banner `img` `src` is `http://192.168.1.5:8080/media/banners/u1.jpg?v=2` and passes the CSP `img-src` check (reuse `imgAllowed`);
   - `#/?tag=arcade` ends at `#/browse?tag=arcade` and requests `/api/games` with `tag=arcade`;
   - the header `Browse` link has `href="#/browse"`;
   - the `app-menu` event `"browse"` navigates to `#/browse`.
5. **`apps/desktop/README.md`:** the View menu list gains Home and Browse games.

**Acceptance:** `npm run build -w @webgame/desktop`, `npm test -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test` and `cargo check`.

### engine-dev
None.

### Docs (project-manager, after the round)
- README "Features": Discovery gains "a sectioned home page (trending, new, recently updated, a daily creator spotlight, player collections, tags) and a `/browse` page"; Profiles gains "up to 4 featured games".
- ROADMAP: F032 and F029 → shipped.

### Sequencing
- backend-dev and frontend-dev work in parallel against API § F032 (the frontend mocks responses).
- desktop-dev's Rust menu work can start at once; its vitest file needs the built `@webgame/ui` with `BrowsePage`, so it runs after frontend-dev lands.

## 5. Edge cases and security
- **Privacy.**
  - `GET /api/collections` lists public collections only; `gameCount`/`coverUrls` follow the F008 viewer rule (`summaries_for`), so a viewer never sees covers of unpublished games they don't own.
  - The spotlight only uses F035 data (already public). `featured` only returns published games.
  - Featuring someone's game reveals nothing new: it only references a public game.
- **Featured writes.**
  - The whole replace runs in one transaction (`DELETE` then `INSERT`s), so two concurrent saves end with one complete list, never a mix.
  - Every id is checked inside that transaction against `published = 1`. Unknown and unpublished ids get the **same** message, so the endpoint can't probe unpublished game ids.
  - Body size: at most 4 ids are accepted; the default JSON body limit applies before parsing.
  - No rate limit, like `PATCH /api/users/me` (cheap, owner-only, bounded rows).
- **Spotlight stability.** The pick is `day mod N` over creators ordered by user id. It changes when N changes (a new creator, an unpublish); that is acceptable for a daily feature and needs no state. Over N consecutive days with a stable N, every creator is spotlighted exactly once.
- **Spotlight games.** Featured games owned by **someone else** are skipped (the spotlight is about the creator's own work). Unpublished featured games are skipped by `g.published = 1`.
- **`sort=updated`.** Only games with a published bundle replace (`last_updated_at IS NOT NULL`, F004) are listed. A game updated and then unpublished drops out with every other published-only rule.
- **Legacy redirect.** It only reads the query string; values pass through untouched to `/browse`, which already treats them as untrusted (React text, `URLSearchParams`). No open redirect: the target pathname is the constant `/browse`.
- **Cost.**
  - Home makes 7 parallel requests (featured, trending, new, updated, spotlight, collections, tags), all small and index-backed; none is rate-limited.
  - The spotlight runs the F035 creator count, one ordered id lookup with an `OFFSET` over distinct owners (bounded by the creator count), one creator row and one 3-game query.
  - The collections count scans public collections with a correlated count over `idx_collection_games_order`; fine at today's sizes, and a snapshot can replace it without a contract change.
- **Older servers.** `sort=updated` → 400 (the shelf hides; `/browse` shows `ErrorState`); `/api/collections` GET and `/api/creators/spotlight` → 404/405 (sections hide); no `featured` → no Featured row or buttons.

## 6. Test expectations

### Backend (`tests/f032.rs`)
- **Migration.** `profile_featured` exists with PK `(user_id, game_id)`; `EXPLAIN QUERY PLAN` of the `sort=updated` page uses `idx_games_pub_updated`.
- **`sort=updated`.**
  - Only games with `lastUpdatedAt` are listed, newest update first; a bundle replace of a published game moves it to the top.
  - `total` counts only updated games; combines with `tag` and `q`.
  - `sort=bogus` → 400 with `(expected new, popular, top, favorites, trending or updated)`.
- **`GET /api/collections`.**
  - Lists public collections with ≥ 3 published games, `updatedAt` desc; a private one, one with 2 published games, and one with 3 games of which 1 is unpublished are absent.
  - Default `perPage` 12; `perPage=100` → 48; `perPage=0` → 1; `page=x` → 400 `page must be an integer`.
  - Pages 1 and 2 don't overlap; `total` is correct.
- **`GET /api/creators/spotlight`.**
  - No creators → `{ day, creator: null, games: [] }` with `day` = today's UTC date.
  - With creators A, B, C (ids sorted), the creator is the one at `spotlight_index(utc_day_number(now), 3)` (read `now` before and after the request; accept either if the day changed).
  - `games`: the creator's featured games **they own** first in featured order, then by plays desc; a featured game of another owner and an unpublished one are absent; at most 3.
  - `creator.isFollowing` true for a follower, false anonymous.
  - Unit tests: `spotlight_index(0, 3) == 0`, `(4, 3) == 1`, `(-1, 3) == 2`; `utc_day_number` of `1970-01-02T00:00:00Z` is 1.
- **`PUT /api/users/me/featured`.**
  - 401 signed out.
  - Saves 4 ids (own and others' games) in order; the response and `GET /api/users/{u}` `featured` match that order.
  - 5 ids → 422 `gameIds must have at most 4 items`; a repeated id at index 2 → 422 `gameIds[2] is a duplicate`; an unknown id and an unpublished id at index 1 → 422 `gameIds[1] is not a published game` (same text for both); a 422 leaves the previous list untouched.
  - `[]` clears; a missing `gameIds` → 422.
  - Read rule: unpublishing a featured game hides it from `featured` for everyone, the owner included; republishing brings it back in place; deleting it removes the row.
  - `GET /api/users/{u}` for a user with nothing featured → `featured: []`.

### Frontend (vitest)
- **`home.test.ts`:** `browsePath` cases (`{}` → `/browse`; `{ q: "  dodge " }` → `/browse?q=dodge`; `{ sort: "new", page: 1 }` → `/browse`; `{ tag: "puzzle", sort: "updated", page: 3 }` → `/browse?tag=puzzle&sort=updated&page=3`); `legacyHomeRedirect` (`""` → null; `"?utm=x"` → null; `"?q="` → `/browse?q=`; `"?tag=a&page=2"` → `/browse?tag=a&page=2`); `isValidSpotlight`; `moveItem` (up, down, boundaries, immutability).
- **`HomePage.f032.test.tsx`:**
  - the seven requests on `/` (spy arguments: `{ sort: "new", perPage: 4 }`, `{ sort: "updated", perPage: 4 }`, `listCollections({ perPage: 3 })`, `getCreatorSpotlight()`);
  - section headings in the § 0.1 order; each `See all →` href;
  - loading skeletons; a failing section hides while others render; an empty section hides;
  - empty platform: only hero + `No games yet` with `Upload the first one` → `/upload`;
  - spotlight: `CreatorCard` with an h3 name, up to 3 game cards, `A different creator every day.`, `See all creators →` → `/creators`; hidden for `creator: null` and for an invalid response; the follow store is seeded;
  - tags: up to 12 chips linking to `/browse?tag=…`; `Browse all games` → `/browse` also when tags fail;
  - `Start playing` → `/browse`;
  - redirects: `/?q=dodge`, `/?tag=arcade&page=2`, `/?sort=top` and `/?page=2` end at the same query on `/browse`; `/?utm=x` stays on home.
- **`BrowsePage.test.tsx`:** h1 texts (`Browse games`, `Results for “dodge”`, `#arcade`); document titles; the six sort buttons with `Recently updated` last and `aria-pressed`; selecting it writes `?sort=updated`; the `No updated games yet` state and `Show all games`; the moved F003 grid/toggle cases; pagination writes `?page=2`.
- **`Layout.f032.test.tsx`:** nav `Browse` href `/browse` (first nav link); logo href `/`; footer `Browse` → `/browse`; submitting `dodge` in the header search navigates to `/browse?q=dodge`, blank → `/browse`; the input mirrors `?q` on `/browse`.
- **`GamePage` tag chip** href `/browse?tag=arcade` (extend an existing GamePage test).
- **`ProfileFeatured.test.tsx`:**
  - visitor with featured games: section `Featured` first in the Overview, no edit button; visitor with none: no section; older server (no `featured`): nothing;
  - the empty-Overview rule counts featured games;
  - owner with none: the panel text and `Feature games`; owner with games: `Edit featured` (`aria-label` `Edit featured games`).
- **`FeaturedGamesDialog.test.tsx`:**
  - dialog semantics, initial focus on the title, Escape closes (not while saving);
  - candidates: own published only (an unpublished one is absent), favorites minus duplicates, empty texts, loading, `LoadError` with Retry;
  - Add/Remove/Move with the exact `aria-label`s; `aria-disabled` at boundaries, on `Added`, and on every `Add` at 4 selected with the limit note; pressing an `aria-disabled` button changes nothing;
  - focus after Move (same button, moved row), Remove (`Selected` heading), Add (same button);
  - Save sends `setFeaturedGames(["g2", "g1"])` in the shown order, toasts `Featured games saved.`, closes and calls `onSaved`; an error shows the server message and keeps the selection.
- **`ApiClient.f032.test.ts`:** `listCollections({ perPage: 3 })` → `GET /api/collections?perPage=3`; `getCreatorSpotlight()` → `GET /api/creators/spotlight`; `setFeaturedGames(["a"])` → `PUT /api/users/me/featured` body `{"gameIds":["a"]}`; `listGames({ sort: "updated" })` → `sort=updated`.
- **`CreatorCard`:** `headingLevel={3}` renders an h3 (extend `CreatorCard.test.tsx`).

### Desktop
As listed in § 4 desktop-dev, plus the `menu.rs` unit test.

### Manual end to end
1. Signed out, open `/`: Featured, Trending, New releases, Creator spotlight, Recently updated, Player collections and Browse by tag appear in that order; Follow on the spotlight sends you to login.
2. Open an old link `/?tag=arcade`: the URL becomes `/browse?tag=arcade`, and Back leaves the site's previous page, not the redirect.
3. Replace the bundle of a published game: it tops Recently updated on `/` and `/browse?sort=updated`.
4. On your profile, Feature games → add 2 own games and 1 favourite, reorder with ↑/↓ using only the keyboard, Save. The Overview shows them in order; a visitor sees the same.
5. At 360 px the home shelves wrap to two columns, the spotlight stacks, and the picker fits the screen with scrolling candidates.
6. On desktop, View → Home and View → Browse games open the pages; spotlight banners load from the configured server.

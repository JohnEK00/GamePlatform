# F035: Explore creators page

Status: **specced**. Size: **S**. One round, shipped alongside F031. Areas: backend, frontend, desktop. Engine: none.

Size breakdown:
- **backend:** one read endpoint `GET /api/creators` in a new `routes/creators.rs`. There is no migration, no new table and no rate-limit bucket.
- **frontend:** a `/creators` page with three sort tabs and pagination, a `CreatorCard`, a header and footer link, and an "Explore all creators" link under the feed's suggested creators.
- **desktop:** View → Creators.

Contracts: `docs/API.md` § F035 additions, `docs/ARCHITECTURE.md` § F035 additions, `docs/GAME_FORMAT.md` § F035 additions (no changes).

Depends on: F002 (follows, `FollowButton` and its store), F003/F004 (`plays`, `first_published_at`, `last_updated_at`), F028 (banners, `profilePath`). All shipped. **Independent of F031**: no shared tables, endpoints or components. It shares only the append-only files `routes/mod.rs`, `api/types.ts`, `api/client.ts`, `index.ts` and `styles.css`.

The migration number is untouched: F031 takes `0026`, and the next free number stays `0027`. No new Rust or JS dependencies.

## 0. Decisions on ambiguities (read first)
API § F035 is normative. Tests assert the texts below verbatim. `{name}` means display name, falling back to username.

1. **Who is a creator.** A user with at least one **published** game. Unpublished games never count, not even for their owner viewing the page. The list is the same for every viewer apart from `isFollowing`, and it includes the viewer's own card.
2. **Sorts** (`?sort=`; absent or empty = `popular`):

   | Sort | Tab label | Order |
   |---|---|---|
   | `popular` | `Popular` | `followers` desc, then `plays` desc, then username (case-insensitive) asc |
   | `active` | `Recently active` | `lastActiveAt` desc, then username asc |
   | `new` | `New creators` | `firstPublishedAt` desc, then username asc |

   - For each published game, `publishedAt = COALESCE(first_published_at, created_at)`. `firstPublishedAt` is the minimum of these.
   - `lastActiveAt` is the maximum, over published games, of the later of `publishedAt` and `last_updated_at`. So publishing a game, or replacing the bundle of a published game, makes a creator "active".
   - Comments, posts and screenshots don't count: this page is about making games.
3. **Card content.** Banner (or the F028 empty-banner gradient), avatar, name, `@username`, a bio excerpt (the first 160 code points; the server cuts it, and the client clamps it to 2 lines), stats, and a Follow button.
   - **Stats text**: `{g} game(s) · {p} play(s) · {f} follower(s)`, with `formatCount` for each number and singular at exactly 1. For example `1 game · 1.2k plays · 45 followers`.
   - No game thumbnails on the card in this round. The profile link is one click away.
4. **Follow.**
   - The existing `FollowButton` (`variant="compact"`). It is hidden on your own card: the component already does this, and the card shows a `Your profile` link to `/me` instead. Anonymous viewers are sent to login (existing behaviour).
   - The page seeds the follow store from each item (`following: isFollowing`, `followers`), so follow state and counts match the rest of the app. The stats line reads `followers` from the store when it has a value.
   - Following someone does not re-sort or reload the page.
5. **Paging.** Numbered pages with the existing `Pagination`, **24 per page**, `?page=n`.
   - Changing the sort drops `page`.
   - A page past the end shows `No more creators.` with a `Back to the first page` link.
6. **Unknown `?sort=` in the URL.** The client treats it as `popular` and never sends it. The `Popular` tab is the current one.
7. **Entry points.**
   - Header nav: `Creators`, right after the first (home/browse) link, for everyone.
   - Footer: `Creators`, right after `Browse`.
   - Feed: under the `Suggested creators` list, an `Explore all creators →` link.
   - Desktop: View → Creators.

   F034 will regroup the header later. This round only adds the one link.
8. **Copy** (exact):
   - document title and h1: `Creators`;
   - lead: `People who make games on Pixelforge Arcade.`;
   - tabs nav `aria-label`: `Sort creators`;
   - empty (page 1, `total === 0`): icon `🎨`, title `No creators yet.`, action `<Link className="pf-btn pf-btn--primary" to="/docs">Make a game</Link>`;
   - past the end: icon `🎨`, title `No more creators.`, action `<Link to="/creators{?sort}">Back to the first page</Link>`;
   - load error: the existing `ErrorState` with Retry;
   - own card: `Your profile`.

Non-goals (later items):
- searching creators: F033;
- a creator spotlight on home: F032;
- game thumbnails on cards;
- filtering by tag;
- "people you may know";
- hiding creators the viewer already follows (the feed suggestions do that).

## 1. Goal and user stories
Today the only way to find people is the feed's six suggestions, which are signed-in only and exclude people you follow. F035 gives everyone a browsable directory of the people who make games, with the F028 banners giving it visual weight.

1. As a new visitor, I click **Creators** in the header and see the most-followed creators with their banners and bios. I open one and follow them.
2. As a player, I switch to **Recently active** to find creators who just shipped or updated a game.
3. As a new creator, my first published game puts me in **New creators**, where players can find me.
4. As a desktop user, View → Creators opens the same page.
5. As a keyboard or screen-reader user, each card is an article named by the creator, the tabs report the current sort, and Follow buttons say who they follow.

## 2. UX notes
- **Layout.** `.pf-creator-grid` is a CSS grid: `grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; list-style: none; padding: 0`. At ≤ 640 px it is a single column.
- **Card** `.pf-creator-card` is a `pf-panel`-styled box with `padding: 0` and `overflow: hidden`. Inside it:
  - `.pf-creator-card__banner` has `aspect-ratio: 3 / 1` and holds an `<img alt="" loading="lazy">` with `object-fit: cover`. Without a banner it uses the `.pf-profile__banner` empty gradient.
  - The avatar (56 px) overlaps the banner's bottom edge by 28 px, with a 2 px `var(--pf-surface)` ring.
  - `.pf-creator-card__body` has 12 px padding.
  - The name (`h2.pf-creator-card__name`, the `pf-section-title` size) is followed by `@username` in muted small text.
  - The bio `.pf-creator-card__bio` uses `-webkit-line-clamp: 2` with `white-space: normal`, so newlines collapse.
  - The stats line is small and muted.
  - `.pf-creator-card__actions` sits at the bottom, holding the Follow button or `Your profile`.
- **Skeleton.** `CreatorCardSkeleton`: a banner block, a circle and two lines, built from `Skeleton`, 6 of them while loading.
- **Tabs.** The `pf-tabs` / `pf-tab` / `is-active` pattern of `FollowListPage`, as `<Link>`s with `aria-current="page"` on the current one.
- **Focus.** After a tab or page change, focus stays on the activated link (default router behaviour). No scroll jumps beyond the router's.
- **Contrast and motion.** Existing tokens only. No animation.

## 3. Contract changes (summary; normative text lives in docs/)
- **API.md § F035 additions**:
  - types `Creator`, `CreatorSort`;
  - endpoint `GET /api/creators`;
  - the sort, paging and error rules;
  - the web route `/creators`.
- **ARCHITECTURE.md § F035 additions**: the query, the `isFollowing` batch, the UI files and ownership.
- **GAME_FORMAT.md § F035 additions**: none.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **`src/routes/creators.rs`** (new; its module doc names API § F035):
   - **Constants:** `CREATORS_PER_PAGE_DEFAULT: i64 = 24`, `CREATORS_PER_PAGE_MAX: i64 = 48`, `BIO_EXCERPT_CHARS: i64 = 160`.
   - **Serde:** `Creator` with `#[serde(rename_all = "camelCase")]`. Fields: `user: UserRef`, `banner_url: Option<String>` (built with `models::banner_url`), `bio_excerpt: String`, `games: i64`, `plays: i64`, `followers: i64`, `is_following: bool`, `first_published_at: String`, `last_active_at: String`.
   - **`CreatorsQuery`:** `sort: Option<String>`, `page: Option<String>`, `per_page: Option<String>` (`perPage`).
   - **`list_creators`** (🔓, `MaybeAuthUser`), in this order:
     1. Parse `sort`. Unknown → 400 `bad_request` `Unknown sort '{s}' (expected popular, active or new)`.
     2. `parse_paging(page, perPage, 24)`, then clamp `perPage` to 1–48.
     3. Count: `total`.
     4. The page query (ARCHITECTURE § F035).
     5. When signed in and the page is non-empty, one `isFollowing` query.
     6. Return `Page<Creator>`.

     It always runs 2 or 3 queries. No rate limit.
2. **`src/routes/mod.rs`**: `pub mod creators;` and `.route("/creators", get(creators::list_creators))`.
3. **`tests/f035.rs`** (§ 6).

**Acceptance:** `cd backend && cargo test` (all suites) and `cargo clippy --all-targets -- -D warnings`. No migration, no new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`; export them from `src/index.ts`): `CreatorSort = "popular" | "active" | "new"`, `Creator` and `CreatorQuery = { sort?: CreatorSort; page?: number; perPage?: number }`, as in API § F035.
2. **Client** (`src/api/client.ts`): `listCreators(query: CreatorQuery = {}, signal?: AbortSignal): Promise<Page<Creator>>` → `GET /api/creators`, which sends only the keys that are present.
3. **Pure helpers** (`src/creators.ts`, new; no React):
   - `CREATOR_SORTS: readonly CreatorSort[] = ["popular", "active", "new"]`;
   - `CREATOR_SORT_LABELS: Record<CreatorSort, string>` (§ 0.2);
   - `CREATORS_PER_PAGE = 24`;
   - `parseCreatorSort(v: string | null | undefined): CreatorSort` (anything else → `"popular"`);
   - `creatorsPath(sort: CreatorSort, page = 1): string`: `/creators`, plus `?sort=` only when not `popular`, plus `page=` only when > 1. For example `/creators?sort=new&page=2`;
   - `creatorStatsText(games, plays, followers): string` (§ 0.3);
   - `isValidCreator(x: unknown): x is Creator` (an object with a `user` whose `username` is a string, number `games`, `plays` and `followers`, and a boolean `isFollowing`). The page drops invalid items.
4. **Components** (`src/components/CreatorCard.tsx`, new): `CreatorCard({ creator }: { creator: Creator })` and `CreatorCardSkeleton()`.
   - `<article className="pf-creator-card" aria-labelledby="creator-{user.id}-name">`.
   - The banner is resolved with `api.url(bannerUrl)`, as `ProfileHeader` does.
   - An avatar link to `profilePath(username)`, with `tabIndex={-1}` and `aria-hidden="true"`.
   - `<h2 id="creator-{user.id}-name" className="pf-creator-card__name"><Link to={profilePath(username)}>{name}</Link></h2>`.
   - `@username`; the bio `<p>`, only when `bioExcerpt` is not empty; the stats line (followers from `useFollows()?.peek(username)?.followers ?? creator.followers`).
   - Actions: `FollowButton` (`username`, `isFollowing`, `followers`, `displayName={name}`, `variant="compact"`), or `<Link className="pf-btn pf-btn--ghost pf-btn--sm" to="/me">Your profile</Link>` when the signed-in user is this creator (compare ids).
5. **Page** (`src/pages/CreatorsPage.tsx`, new), § 0.5–0.8:
   - Read `sort` and `page` from `useSearchParams`, and call `api.listCreators({ sort, page, perPage: 24 })` through `useAsync` keyed on both. Leave `sort` out when it is `popular` (the server default), so the URL is `/api/creators?page=1&perPage=24`.
   - The client sends keys in the order `sort`, `page`, `perPage`.
   - Seed the follow store for every loaded item in an effect.
   - Render: the header (`pf-pagehead`, h1, lead, tabs), then one of the skeleton, error, empty, past-end or grid states, then `Pagination` (which writes `?page`, and drops it for page 1).
   - `useDocumentTitle("Creators")`.
6. **Routing** (`src/WebGameApp.tsx`): `<Route path="creators" element={<CreatorsPage />} />`. It is public (no `RequireAuth`).
7. **Layout** (`src/components/Layout.tsx`):
   - header: `<NavLink to="/creators">Creators</NavLink>` right after the `/` NavLink;
   - footer: `<Link to="/creators">Creators</Link>` right after `Browse`.
8. **Feed** (`src/pages/FeedPage.tsx` `SuggestedCreators`): after the list, `<p className="pf-suggest__more pf-small"><Link to="/creators">Explore all creators →</Link></p>`. It renders in the loaded state, and also when there are no suggestions.
9. **Styles** (`styles.css`): `.pf-creator-grid`, `.pf-creator-card` (`__banner`, `__avatar`, `__body`, `__name`, `__bio`, `__stats`, `__actions`), `.pf-suggest__more`, and the 640 px rule. Existing tokens only.
10. **Exports** (`src/index.ts`): `CreatorsPage`, `CreatorCard`, `CreatorCardSkeleton`, every `creators.ts` export, and the types.
11. **README** (`packages/ui/README.md`): add `/creators` to the routes table and the new exports.
12. **Tests** (§ 6). Existing suites stay green. Any Layout test that counts header or footer links is updated for the new link.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`, `npm test -w @webgame/desktop`.

### desktop-dev (`apps/desktop/**`)
1. **`src-tauri/src/menu.rs`**:
   - a forwarded id `"creators"`, as View → `Crea&tors` (T, since R is taken by `&Reload`), right after `Co&llections`, with **no accelerator**;
   - add it to `FORWARDED` and update the module doc;
   - add a unit test that it is forwarded and has no accelerator, following the F028 `"profile"` test.
2. **`src/nativeMenu.ts`**: `ROUTES.creators = "/creators"`, and update the doc comment.
3. **`src/__tests__/nativeMenu.test.ts`**: `"creators"` navigates to `#/creators`.
4. **`src/__tests__/f035.desktop.test.tsx`**, following the `f030.desktop.test.tsx` pattern (the real `App` under the hash router, `SERVER_STORAGE_KEY` = `http://192.168.1.5:8080`, mocked `fetch`). Assert:
   - on `#/creators`, the request is `GET http://192.168.1.5:8080/api/creators?page=1&perPage=24`;
   - a creator with `bannerUrl: "/media/banners/u1.jpg?v=2"` renders an `<img>` whose `src` is `http://192.168.1.5:8080/media/banners/u1.jpg?v=2`;
   - the header contains a `Creators` link with `href="#/creators"`;
   - pressing the `Recently active` tab requests `sort=active`.
5. **`apps/desktop/README.md`**: the View menu list gains Creators.

**Acceptance:** `npm run build -w @webgame/desktop`, `npm test -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test` and `cargo check`.

### engine-dev
None.

### Docs (project-manager, after the round)
- README "Features": under social/discovery, add "an Explore creators page (popular, recently active, new)".
- ROADMAP: F035 → shipped.

### Sequencing
- backend-dev and frontend-dev work in parallel against API § F035 (the frontend mocks responses).
- desktop-dev's Rust menu work can start at once. Its vitest file needs the built `@webgame/ui` with `CreatorsPage`, so it runs after frontend-dev lands.
- Within the shared round, F031 and F035 can be done in either order. They only touch the same files by appending: `mod.rs`, `types.ts`, `client.ts`, `index.ts` and `styles.css`.

## 5. Edge cases and security
- **Privacy.** The page lists only what is already public: a user with a published game already appears on that game's page and in `/api/games`. Follower counts are already public on profiles. `isFollowing` is only about the viewer. Bios are public profile text, and the excerpt is rendered as React text, never as HTML.
- **Unpublished games** never count, so an unpublished-only user is not a creator and their unpublished game titles never leak (titles aren't returned anyway).
- **Deleted users and games** cascade, and the next read reflects them. A creator whose last published game is unpublished drops out at once.
- **Moderation.** A `clearProfile` user still appears, with the cleared name, bio and banner. Cards have no report action: report from the profile (F028).
- **Cost.**
  - The page query aggregates over published games, grouped by owner, plus a follower count per creator through `idx_follows_followee_created`. That is bounded by the catalogue size, like `GET /api/games?q=`, which is also an unlimited public read.
  - If it ever matters, a snapshot like F003 trending can replace it with no contract change.
  - `perPage` is capped at 48 and `page` is clamped (review 9 L7).
- **Ties and stability.** Every sort ends with the case-insensitive username (unique), so pages never overlap or skip under a stable dataset.
- **Timestamps.** `first_published_at` was backfilled from `created_at` in 0005, and both use the RFC3339 millis Z format, so comparing them as strings is correct. `COALESCE` covers any NULL.
- **Older servers.** `GET /api/creators` returns 404 there, which the page shows as an `ErrorState`. A web or desktop client is only paired with an older server in a mixed deployment; no capability probe is added.
- **Desktop.** Banner images load from the configured server and are already allowed by the CSP `img-src` (F028).

## 6. Test expectations

### Backend (`tests/f035.rs`)
- **Membership.**
  - Mia (2 published games, 1 unpublished), Leo (1 published) and Kai (only unpublished) → `total: 2`, with Mia and Leo. Kai is absent, and Mia's `games` is 2.
  - Unpublishing Leo's game → `total: 1`.
- **Fields.**
  - `user` is a `UserRef`. `bannerUrl` is null, or `/media/banners/{id}.jpg?v={n}` after an upload.
  - `bioExcerpt` is the first 160 code points (test with a 200-character bio containing non-ASCII).
  - `plays` is the sum over published games only.
  - `followers` is correct after follows.
  - `firstPublishedAt` and `lastActiveAt` are as defined. A bundle replace of a published game moves `lastActiveAt`.
- **Sorts.**
  - `popular` orders by followers, then plays, then username (case-insensitive).
  - `active` orders by `lastActiveAt` desc.
  - `new` orders by `firstPublishedAt` desc.
  - Absent or empty `sort` → `popular`. `sort=top` → 400 `Unknown sort 'top' (expected popular, active or new)`, also together with `page=x` (sort is checked first).
- **Paging.**
  - Default `perPage` is 24. `perPage=100` → 48. `perPage=0` → 1. `page=x` → 400 `page must be an integer`.
  - Pages 1 and 2 of 30 creators don't overlap and cover everyone.
- **`isFollowing`.**
  - Anonymous → all false.
  - Signed in → true exactly for followees.
  - The viewer's own card → false.
- **Plan.** `EXPLAIN QUERY PLAN` of the `isFollowing` statement shows a `SEARCH follows USING PRIMARY KEY`. That statement is one batched query (`json_each`), not one query per card.

### Frontend (vitest)
- **`creators.test.ts`**:
  - `parseCreatorSort` for `null`, `""`, `"new"` and `"bogus"`;
  - `creatorsPath` for `("popular")` → `/creators`, `("new", 2)` → `/creators?sort=new&page=2` and `("popular", 3)` → `/creators?page=3`;
  - `creatorStatsText(1, 1, 1)` = `1 game · 1 play · 1 follower` and `(3, 1200, 45)` = `3 games · 1.2k plays · 45 followers`;
  - `isValidCreator`.
- **`CreatorCard.test.tsx`**:
  - the article is named by the creator;
  - the name links to `/u/mia`, and the avatar link is `aria-hidden`;
  - the banner `img` has `alt=""`, or the empty-banner class without one;
  - the bio shows when present and is omitted when empty;
  - the stats text;
  - `Follow Mia` for others (anonymous too), and `Your profile` → `/me` on your own card;
  - the stats follow the follow store after a follow.
- **`CreatorsPage.test.tsx`**:
  - the request `{ page: 1, perPage: 24 }` (no `sort` for Popular), and `{ sort: "active", page: 1, perPage: 24 }` on that tab;
  - h1 `Creators` and the lead;
  - the tabs with `aria-current` on Popular, and clicking `Recently active` → URL `?sort=active` without `page`;
  - `?sort=bogus` → Popular is current;
  - the 6 skeletons;
  - `ErrorState` with a working Retry;
  - the empty state with `Make a game` → `/docs`;
  - past the end (`?page=5` with no items, `total` 30) → `No more creators.` with `Back to the first page`;
  - `Pagination` writes `?page=2`;
  - invalid items are dropped;
  - the follow store is seeded (a second `FollowButton` for the same user elsewhere reflects it).
- **`Layout.f035.test.tsx`**: the header `Creators` link comes right after the home link, and the footer `Creators` link comes right after `Browse`.
- **`FeedPage.f035.test.tsx`**: `Explore all creators →` → `/creators` under the suggestions, including when the list is empty.
- **`ApiClient.f035.test.ts`**: `listCreators()` → `GET /api/creators`, and `listCreators({ sort: "new", page: 2, perPage: 24 })` → `?sort=new&page=2&perPage=24`.

### Desktop
As listed in § 4 desktop-dev, plus the `menu.rs` unit test.

### Manual end to end
1. Signed out, click **Creators** in the header. Cards show banners, and Follow sends you to login and back.
2. Sign in, follow someone on Popular, and open their profile. The follower count matches.
3. Replace a bundle of one of your published games, then open **Recently active**. You are first.
4. At 360 px the cards are one column and the tabs scroll horizontally like the other `pf-tabs`.
5. On desktop, View → Creators opens the page, and banners load from the configured server.

# F028: Public profiles 2: banner, links, profile sections and sharing

Status: **shipped**. Size: **M** (backend: one migration adding three columns, two banner endpoints, link validation on `PATCH /api/users/me`, profile `stats`, a `user` report target with a `clearProfile` action; frontend: profile shell with section tabs and clean URLs, a new header with banner, links, stats, Copy link and Report, Settings for links and banner, admin rows; desktop: one menu item and one verification test; one round). Areas: backend, frontend, desktop. Engine: none.
Contracts: `docs/API.md` § F028 additions, `docs/ARCHITECTURE.md` § F028 additions (migration `0024_f028.sql` with the exact SQL, banner pipeline, stats queries, profile shell), `docs/GAME_FORMAT.md` § F028 additions (no changes).
Depends on: v1 profiles and Settings, F002 (follow counts), F005 (image pipeline, `image_slots`, media headers), F008 (collections, `reports` without a `target_type` CHECK), F015 (`ProfileScreenshots`, `GET /api/users/{username}/screenshots`). All shipped. F024 (migration `0023`) is in progress and is not touched: this round's migration is **`0024_f028.sql`**.

No new Rust or JS dependencies. No engine or example changes. No notification or feed changes.

Follow-ups (not in this round): F029 featured games on profiles, F030 user posts (adds a **Posts** section to the shell built here).

## 0. Decisions on ambiguities (read first)
API § F028 is normative. Tests assert the texts below verbatim. `{name}` means display name, falling back to username.

1. **Scope split.** This round is the profile *foundation*: banner, links, stats, the section shell with clean URLs, Copy link, `/me`, and profile reporting. Pinned or featured games are F029. Posts are F030. Avatar handling is unchanged (no re-encode, no remove button), except that the admin `clearProfile` action removes it.
2. **Web routes** (all inside the main `Layout`):

   | Path | Shows |
   |---|---|
   | `/u/{username}` | profile shell + **Overview** |
   | `/u/{username}/games` (`?page=n`) | shell + **Games** (all games, 24 per page) |
   | `/u/{username}/screenshots` | shell + **Screenshots** (the F015 gallery with Load more) |
   | `/u/{username}/collections` (`?page=n`) | shell + **Collections** (the F008 list page, now embedded) |
   | `/u/{username}/followers`, `/u/{username}/following` | unchanged standalone `FollowListPage`, outside the shell |
   | `/me` | `RequireAuth`, then `<Navigate replace>` to `/u/{me.username}` |

   - **Legacy paging link:** `/u/{username}?page=n` with `n ≥ 2` (the old in-profile games pager) is replaced (`<Navigate replace>`) by `/u/{username}/games?page=n`. `?page=1` or an invalid value is dropped silently (Overview renders).
   - **Canonical username:** after the profile loads, if `params.username !== data.user.username` (exact, case-sensitive compare), the shell navigates with `replace: true` to the same path with the canonical username, keeping the section suffix and the search string. Focus is not moved.
   - `/collections` (`MyCollectionsRedirect`) keeps redirecting to `/u/{me}/collections`, which now renders inside the shell.
3. **Section navigation is links, not ARIA tabs.** Each section is a URL, so the strip is `<nav className="pf-profile-tabs" aria-label="Profile sections">` with `NavLink`s (React Router sets `aria-current="page"` on the active one; Overview uses `end`). It is styled like the existing `.pf-tab`/`.is-active`. No roving tabindex: every link is a Tab stop. Labels and counts:
   - `Overview`
   - `Games` + count = `gamesTotal`
   - `Screenshots` + count = `stats.screenshots`
   - `Collections` + count = `stats.collections`; the whole link is hidden while `useCollectionsSupported()` is false.

   A count renders as `<span className="pf-profile-tabs__count">{formatCount(n)}</span>` after the label (accessible name e.g. "Games 12"). It is omitted when the number is unknown (an older server without `stats`).
4. **Shell persistence and focus.** `ProfilePage` is the shell. It loads `GET /api/users/{username}` (no paging query) keyed on `[api, username, me?.id]`, so switching sections never refetches the header or remounts it. The activated link keeps focus. The existing `Layout` scroll-to-top on a pathname change still applies. While the profile is loading, the shell shows the skeleton header and no section content. A 404 renders `NotFoundPage what="player"`. Other errors render `ErrorState` with Retry. Sections read the profile through `useOutletContext<ProfileOutletContext>()`.
5. **Header layout** (`ProfileHeader`, top to bottom):
   1. **Banner**: a block `.pf-profile__banner`, full width of the card, height **200 px** (≥ 861 px viewport), **140 px** (≤ 860 px), **112 px** (≤ 640 px). With `bannerUrl`: `<img src={api.url(bannerUrl)} alt="" />` with `object-fit: cover; object-position: center`. Without one: the existing `.pf-profile` gradient background (two radial gradients on `var(--pf-surface)`), no image. Decorative in both cases.
   2. **Avatar**: `Avatar size={112}` (≥ 641 px) or 88 (≤ 640 px; the size comes from `useMediaQuery("(max-width: 640px)")`). It overlaps the banner's bottom edge by half its size, keeping the existing ring style. It is left-aligned at 28 px (≥ 641 px) and centred (≤ 640 px).
   3. **Identity**: `<h1>{name}</h1>`, then `<p className="pf-muted">@{username} · Joined {Month YYYY}</p>`, where `Month YYYY` = new `formatMonthYear(createdAt)` = `toLocaleDateString(undefined, { year: "numeric", month: "long" })`, with `""` for an invalid date. The `· Joined …` part is dropped when that is empty.
   4. **Bio**: unchanged (`.pf-profile__bio`, `pre-wrap`). For your own empty bio: `You haven't written a bio yet.` (unchanged).
   5. **Links**: `<ul className="pf-profile__links" aria-label="Links">`, one `<li>` per link that passes `isSafeProfileUrl` (defence in depth). Each item is `<a href={url} target="_blank" rel="noopener noreferrer nofollow ugc">` containing `<span aria-hidden="true">🔗</span> {label || linkHost(url)}<span className="pf-sr-only"> (opens in a new tab)</span>`. `linkHost` = the URL's `hostname` with a leading `www.` removed. The list is omitted when there are no displayable links.
   6. **Stats** (`.pf-profile__stats`, in this order, each `<strong>{formatCount(n)}</strong> {noun}`):
      - `game`/`games` (`gamesTotal`);
      - `play`/`plays` (`stats.plays`);
      - `follower`/`followers`, linking to `/u/{u}/followers` (existing);
      - `following`, linking to `/u/{u}/following` (existing);
      - `achievement`/`achievements` (`stats.achievements`).

      Without `stats` (older server), plays and achievements are omitted. The old "plays only when every game is on this page" rule is removed.
   7. **Actions** (`.pf-profile__actions`, right of the identity block ≥ 641 px; centred below the stats ≤ 640 px; they wrap):
      - your own profile: `Edit profile` (link to `/settings`, existing class) then `CopyLinkButton`;
      - another user's profile: `FollowButton` (existing props), then `CopyLinkButton`, then `<ReportButton targetType="user" targetId={user.id} targetLabel={"@" + username} className="pf-btn pf-btn--ghost pf-btn--sm">⚑ Report</ReportButton>`.
6. **Copy link** (`CopyLinkButton`, new and reusable; `CollectionPage` keeps its own code this round):
   - It is a button `pf-btn pf-btn--ghost pf-btn--sm` with the text `<span aria-hidden="true">🔗</span> Copy link`.
   - The URL is `profileShareUrl(config, username)` = `appShareUrl(config, "/u/" + encodeURIComponent(username))`. `appShareUrl` is the body of today's `collectionShareUrl`, generalised to a path, and `collectionShareUrl` now delegates to it with identical output. On desktop (hash router) this gives `{serverBase}/u/{username}`, a link that works in any browser.
   - **Success**: `navigator.clipboard.writeText`, the text becomes `Link copied` for `LINK_COPIED_MS` (2000 ms, moved from `CollectionPage.tsx` to `share.ts` and re-exported from `CollectionPage.tsx` for compatibility), and a polite live region announces `Link copied`.
   - **Failure** (no clipboard API or a rejected write): a read-only `<input className="pf-input pf-input--sm">` with the label `Copy this link` and value = the URL appears right after the actions row. It is focused and its text selected.
7. **Overview** (`ProfileOverview`), sections in this order:
   1. `RecentAchievements` (existing, unchanged).
   2. **Games**: `<h2 className="pf-section-title">Games</h2>` and the first **8** of `profile.games` in `GameGrid` (`showStatus={isMe}`). When `gamesTotal > 8`, the shelf head has `<Link className="pf-shelf__more" to="/u/{u}/games">See all {gamesTotal} games →</Link>`. With 0 games: on your own profile the existing empty state (`🎮`, `No games yet`, `Your uploaded games will appear here.`, `Upload a game` button); on another profile the section is **omitted**.
   3. **Screenshots**: `<ProfileScreenshots key={"shots:" + username} username isMe preview={4} />` (see 9).
   4. **Collections**: `<ProfileCollections key={username} username isMe />` (existing; its "See all" link already targets `/u/{u}/collections`).

   **Empty overview:** on another user's profile, when `stats` is present and `gamesTotal`, `stats.achievements`, `stats.screenshots` and `stats.collections` are all 0, the Overview renders only `<EmptyState icon="🕹" title="Nothing here yet">{name} hasn't shared anything yet.</EmptyState>`.
8. **Games section** (`ProfileGamesTab`): `<h2 className="pf-section-title">Games</h2>` and `api.listGames({ owner: isMe ? "me" : username, sort: "new", page, perPage: 24 })`, with `GameGrid` (`showStatus={isMe}`, 24 skeletons while loading) and `Pagination` on `?page` (page 1 removes the param). Empty states are the ones `ProfilePage` uses today, verbatim: own → `🎮` / `No games yet` / `Your uploaded games will appear here.` + `Upload a game`; others → `🎮` / `Nothing here yet` / `This player hasn't published any games.`. Errors → `ErrorState` with Retry.
9. **Screenshots section** (`ProfileScreenshotsTab`): `<ProfileScreenshots key={"shots:" + username} username isMe />` (full gallery, unchanged). On another user's profile, when `stats.screenshots === 0`, it instead renders `<EmptyState icon="📷" title="No screenshots yet">{name} hasn't posted any screenshots.</EmptyState>`.
   - `ProfileScreenshots` gains an optional prop `preview?: number`. When set, it requests `perPage = preview`, never renders "Load more", and when `total > items.length` adds `<Link className="pf-shelf__more" to="/u/{u}/screenshots">See all {total} screenshots →</Link>` in `.pf-shelf__head`. Everything else (hidden-when-empty for others, lightbox, delete, focus) is unchanged. Without `preview` the behaviour is byte-for-byte today's.
10. **Collections section**: `UserCollectionsPage` renders inside the shell.
    - Its outer `pf-container pf-page` wrapper becomes a `<section className="pf-profile-section">`.
    - The `<header className="pf-pagehead pf-pagehead--row">` keeps its layout, but the `<h1>` becomes `<h2 className="pf-section-title">Collections</h2>` for everyone.
    - The own-profile hint `Public collections appear on your profile and on game pages; private ones only here.` stays. The `Curated by …` line is removed (the shell shows who).
    - Its 404 branch stays (unreachable through the shell).
11. **Document titles** (via `useDocumentTitle`): Overview `{name} (@{username})`; Games `Games · {name}`; Screenshots `Screenshots · {name}`; Collections `Collections · {name}`. The shell sets nothing itself; each section sets its own.
12. **Settings: links.** In the existing Profile form, after Bio and before the error `Alert`:
    - a `<fieldset className="pf-field pf-links-editor">` with the legend `Links` and the hint `Up to 3 links, shown on your profile.`;
    - one row per link: a label input (`aria-label="Link {i} label"`, `placeholder="Label (optional)"`, `maxLength={30}`), a URL input (`type="url"`, `inputMode="url"`, `aria-label="Link {i} URL"`, `placeholder="https://…"`, `maxLength={200}`) and a `Remove` button (`aria-label="Remove link {i}"`), with `{i}` 1-based;
    - a `+ Add link` button (`pf-btn pf-btn--ghost pf-btn--sm`), shown while there are fewer than 3 rows.

    Focus:
    - Add focuses the new row's label input.
    - Remove focuses the same index's label input, else the previous row's Remove, else `+ Add link`.

    On submit:
    - Rows whose label and URL are both empty after trim are dropped.
    - Every other row must pass `validateProfileLinkUrl`. Otherwise its inline error `<p className="pf-field__error" id=…>` reads `Enter a full link starting with https:// or http://`, the URL input gets `aria-invalid="true"` and `aria-describedby`, the first invalid URL input is focused, and no request is sent.
    - The body is `{ displayName, bio, links }`. The fieldset is hidden when `user.links` is `undefined` (older server), and then `links` is not sent.
13. **Settings: banner.** A new panel `<section className="pf-form pf-panel">` titled `Banner`, between Avatar and Notifications:
    - **Preview** `.pf-banner-preview` (3:1, `object-fit: cover`): the current banner as `<img alt="Your current banner">`, or the gradient with the muted text `No banner yet`.
    - `FileDrop`: `label="New banner"`, `hint="PNG, JPG or WebP · ≤ 2 MB · at least 600×200 · cropped to 3:1"`, `accept={IMAGE_ACCEPT}`, `icon="🖼"`, `preview`.
    - `ProgressBar label="Uploading banner"` while uploading.
    - An `Upload banner` button (disabled without a file or while uploading).
    - A `Remove banner` button (`pf-btn pf-btn--ghost`), only when `user.bannerUrl`.

    Behaviour:
    - Client check: a file over 2 MB → `Banners can be at most 2 MB.` (no request).
    - Toasts: `Banner updated` / `Banner removed`.
    - Server errors go in the panel's `Alert`.
    - After a removal, focus moves to `Upload banner`.
    - The panel is hidden when `user.bannerUrl` is `undefined` (older server).
14. **Server link rules** (API § F028 is normative). Up to **3** links. Each label is trimmed, 0–30 characters, no control characters. Each URL is trimmed, at most 200 characters, all printable ASCII (`0x21`–`0x7E`), with scheme `http` or `https` (any case), `://`, then a host of `[A-Za-z0-9.-]` that contains a dot and doesn't start or end with `.` or `-`, then an optional `:port` (1–5 digits), then nothing or a part starting with `/`, `?` or `#`. The server lowercases only the scheme. `links` omitted or `null` leaves links unchanged; `[]` clears them. **All `PATCH /api/users/me` fields are validated before anything is written**, so a 422 changes nothing (this fixes today's partial update when `displayName` is valid and `bio` isn't).
15. **Banner rules.** `PUT /api/users/me/banner`, multipart field `banner`, ≤ 2 MB, PNG/JPEG/WebP. The F005 decode rules and limits apply, then a centred crop to 3:1, a minimum of 600×200 after the crop, a downscale to exactly 1500×500 when wider than 1500, and a JPEG at quality 85 without metadata. It is stored at `data/banners/{userId}.jpg` and served at `/media/banners/{userId}.jpg?v={n}` with the F005 media headers. `DELETE /api/users/me/banner` removes it (idempotent). Both return the updated `User`.
16. **Stats** (`UserProfileResponse.stats`) are computed for the viewer, with the same visibility as the lists they summarise: `plays` sums `plays` over the games counted in `gamesTotal`; `achievements` counts the rows `GET /api/users/{u}/achievements` could return (no limit); `screenshots` and `collections` equal those endpoints' `total` for the same viewer.
17. **Reporting a profile.**
    - `targetType: "user"`, `targetId` = the user's id; `targetPreview` = `@{username}` (usernames never change); `targetGameId` = null.
    - Reporting yourself → 422 `You can't report yourself`.
    - The dialog heading reads `Report profile: @mia`.
    - Admin actions are `dismiss` and **`clearProfile`**. `clearProfile` sets the display name to the username, empties the bio and links, and removes the avatar and banner (files deleted, `*_ext` NULL, versions + 1). Games, comments, screenshots and collections stay.
    - The admin row shows the preview and `View profile →` (`/u/{username}`, taken from the preview minus `@`).
    - The confirm dialog: title `Clear @mia's profile?`, body `Their display name, bio, links, avatar and banner are reset. Their games, comments and other content stay up.`, danger.
18. **Desktop.** View → `My &Profile` (id `profile`, first item of View, no accelerator), forwarded like `feed`; `nativeMenu.ts` maps `profile` → `/me`. Profile links use `target="_blank"`, so the existing `external.rs` handler opens them in the system browser.

Non-goals (later items): featured or pinned games (F029); posts (F030); username changes; custom profile themes or colours; an avatar re-encode or remove button; follower/following lists inside the shell; profile view counts; verified badges; server-rendered link previews or Open Graph tags.

## 1. Goal and user stories
Today a profile is one long page: a small header (avatar, name, `@username`, join date, bio, four counts) followed by achievements, a paged games grid, screenshots and collections. There is no way to say who you are beyond a 1000-character bio: no banner, no links to your itch.io, YouTube or website. There is no clean URL for "this player's games", no Copy link, no `/me`, the "plays" stat disappears as soon as a creator has more than 24 games, and a profile with an abusive bio or avatar can't be reported. Players who don't make games get an empty "Nothing here yet" games grid as the main content of their page.

F028 turns the profile into a proper public page and the foundation for F029 (featured games) and F030 (posts).

User stories:
1. As a creator, I upload a banner and add links to my website and YouTube, so visitors see my identity and can find my other work.
2. As a visitor, I open `/u/mia` and see her banner, avatar, bio, links and totals (games, plays, followers, following, achievements), and an Overview of her latest games, achievements, screenshots and collections.
3. As a visitor, I open `/u/mia/games` and page through all her games. I can send that URL to a friend and it opens the same section.
4. As a player who doesn't make games, my Overview shows my achievements, screenshots and collections instead of an empty games grid.
5. As anyone, I press **Copy link** and get a link that works in any browser, including from the desktop app.
6. As a signed-in user, I type `/me` (or use View → My Profile on desktop) to reach my own profile.
7. As a player, I report a profile with an offensive banner or a scam link. An admin clears the profile in one action.
8. As a keyboard or screen-reader user, the sections are a labelled navigation landmark with the current page marked, every external link says it opens a new tab, and Copy link announces its result.

## 2. UX notes
See § 0 items 5–13 for texts, order and focus. Additional notes:
- **Card.** `.pf-profile` changes from a flex row to a block card with `overflow: hidden` and `padding: 0`. The banner sits at the top. Below it, `.pf-profile__body` (padding `0 28px 24px`; `0 16px 20px` ≤ 640 px) holds the avatar (negative top margin of half its size), the identity, bio, links, stats and actions. The banner has no border-radius of its own, because the card clips it.
- **Section strip.** `.pf-profile-tabs` sits directly under the card (`margin: 16px 0 20px`). It is one row that scrolls horizontally when it overflows (`overflow-x: auto; scrollbar-width: thin; white-space: nowrap`), at every width. The active link is scrolled into view (`scrollIntoView({ block: "nearest", inline: "nearest" })`) on mount and on change. Counts use the muted colour and `margin-left: 6px`.
- **Links row.** `display: flex; flex-wrap: wrap; gap: 6px 14px`, with list styles removed. Links use `var(--pf-text-2)` and an underline on hover and focus-visible. Long labels are truncated with `max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`, and the full text goes in `title`.
- **Responsive.** Covered in § 0.5. At ≤ 640 px everything in the body is centred, stats and links use `justify-content: center`, and the actions wrap and are centred.
- **Loading skeleton.** A banner-height `Skeleton` (`radius={0}`), a circle at the avatar size, then three text bars (200×28, 120×16, 80%×16), matching today's.
- **Contrast and motion.** Existing tokens only. The banner gets no overlay, because text never sits on top of it. There are no animations, so `prefers-reduced-motion` needs nothing.
- **Settings preview.** `.pf-banner-preview` is `aspect-ratio: 3 / 1; width: 100%; border-radius: var(--pf-radius); overflow: hidden; border: 1px solid var(--pf-border)`.
- **Admin.** A `user` report row uses `.pf-badge--user` (styled like `.pf-badge--collection`).

## 3. Contract changes (summary; normative text lives in docs/)
- **API.md § F028 additions**:
  - types `ProfileLink`, `ProfileStats`; `User.bannerUrl`, `User.links`; `UserProfileResponse.stats`; `UpdateMeRequest.links`;
  - `ReportTargetType` += `"user"`; `ReportAction` += `"clearProfile"`;
  - new `PUT`/`DELETE /api/users/me/banner`, the changed `PATCH /api/users/me`, `GET /api/users/{username}`, `POST /api/reports` and `POST /api/admin/reports/{id}/resolve`;
  - the media path `/media/banners/*`; web routes; error texts; rate limits.
- **ARCHITECTURE.md § F028 additions**: migration `0024_f028.sql`, storage and media, the banner pipeline (`decode_rgb` refactor, `process_banner`), link validation, stats SQL, `clear_profile`, the frontend profile shell and file ownership.
- **GAME_FORMAT.md § F028 additions**: none.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0024_f028.sql`: copy ARCHITECTURE § F028 "Data" **verbatim**. Never edit `0001`–`0023`.
2. **`src/storage.rs`**:
   - `pub fn banners_dir(&self) -> PathBuf` (`root/banners`), created in `ensure_dirs`;
   - the module doc gains `data/banners/{userId}.jpg   (F028)`.
3. **`src/models.rs`**:
   - `#[derive(Debug, Clone, Serialize, Deserialize)] #[serde(rename_all = "camelCase")] pub struct ProfileLink { pub label: String, pub url: String }`.
   - `User` gains `pub banner_url: Option<String>` and `pub links: Vec<ProfileLink>`.
   - `pub fn banner_url(user_id: &str, ext: Option<&str>, version: i64) -> Option<String>` → `/media/banners/{user_id}.{ext}?v={version}`.
   - `USER_COLUMNS` = `"id, username, display_name, avatar_ext, avatar_version, bio, created_at, role, banner_ext, banner_version, links_json"`.
   - `user_from_row` reads the three columns. `links` = `serde_json::from_str::<Vec<ProfileLink>>(&links_json).unwrap_or_default()` (lenient: corrupt JSON gives `[]`).
4. **`src/screenshots.rs`**:
   - Extract steps 1–3 of `process_screenshot` into `fn decode_rgb(bytes: &[u8]) -> Result<(RgbImage, ImageFormat), AppError>`, with **no behaviour change**; `process_screenshot` calls it. Existing unit tests must pass unchanged.
   - Add constants `BANNER_MIN_W: u32 = 600`, `BANNER_MIN_H: u32 = 200`, `BANNER_W: u32 = 1500`, `BANNER_H: u32 = 500`, `BANNER_JPEG_QUALITY: u8 = 85`.
   - Add `pub fn banner_crop(w: u32, h: u32) -> (u32, u32, u32, u32)` (x, y, cw, ch) per ARCHITECTURE § F028.
   - Add `pub fn process_banner(bytes: &[u8]) -> Result<Vec<u8>, AppError>`: `decode_rgb`, then crop (`image::imageops::crop_imm(...).to_image()`), then the minimum check with the error `banner must be at least 600×200 pixels after cropping to 3:1` (422), then, if `cw > BANNER_W`, `image::imageops::resize(&cropped, BANNER_W, BANNER_H, FilterType::Triangle)`, then `encode_jpeg(.., BANNER_JPEG_QUALITY)`.
   - Unit tests for `banner_crop` (formula in ARCHITECTURE § F028), with these four cases:
     - 3000×500 → (750, 0, 1500, 500);
     - 900×900 → (0, 300, 900, 300);
     - 600×200 → (0, 0, 600, 200);
     - 1000×301 → (48, 0, 903, 301), because 1000 ≥ 3·301, so the wide branch applies.
5. **`src/routes/users.rs`**:
   - **`UpdateMeBody`** gains `pub links: Option<Vec<LinkBody>>`, where `#[derive(Deserialize)] struct LinkBody { #[serde(default)] label: String, #[serde(default)] url: String }`.
   - **`update_me`** validates **all** fields first, in this order:
     - displayName (existing message);
     - bio (existing message);
     - links: count first (`links must have at most 3 items`), then per index `i` (0-based in messages): label control characters, label length, URL length, URL format.

     Then it writes everything in **one** transaction. The helper is `pub fn validate_links(input: Vec<LinkBody>) -> Result<Vec<ProfileLink>, AppError>`, a pure function with unit tests for every rule and message in API § F028.
   - **`upload_banner`**:
     1. `limit_user(&state, Limit::Image, &user.id)?`;
     2. read multipart field `banner` (missing → 422 `banner file is required`);
     3. `validate_image(&bytes, "banner")?` (413/422 as for avatars);
     4. `state.image_slots.clone().try_acquire_owned()`, else return `crate::routes::screenshots::busy()` (make it `pub(crate)`);
     5. `spawn_blocking(move || process_banner(&bytes))` (a join error → 500);
     6. `state.storage.replace_image(&state.storage.banners_dir(), &user.id, "jpg", &jpeg)`;
     7. `UPDATE users SET banner_ext = 'jpg', banner_version = banner_version + 1 WHERE id = ?`;
     8. return `load_user`.
   - **`delete_banner`**: `UPDATE users SET banner_ext = NULL, banner_version = banner_version + 1 WHERE id = ? AND banner_ext IS NOT NULL`, then `remove_images(banners_dir, id)`, then return `load_user`. It returns 200 even when there was nothing to delete (the version is only bumped when there was a banner). No rate limit.
   - **`ProfileStats`** struct (`plays`, `achievements`, `screenshots`, `collections`: `i64`, camelCase), and `UserProfile.stats: ProfileStats`, filled by the four queries in ARCHITECTURE § F028 "Stats". `screenshots` must reuse `crate::routes::screenshots::user_screenshots_count_sql()`. `collections` must reuse the filter string of `list_user_collections`: move it to `pub(crate) const USER_COLLECTIONS_FILTER: &str` in `routes/collections.rs` and use it in both places.
   - **`pub async fn clear_profile(state: &AppState, user_id: &str) -> AppResult<()>`**:
     - one `UPDATE users SET display_name = username, bio = '', links_json = '[]', avatar_ext = NULL, avatar_version = avatar_version + 1, banner_ext = NULL, banner_version = banner_version + 1 WHERE id = ?`;
     - then `remove_images` on `avatars_dir` and `banners_dir` for the id;
     - an unknown id is a no-op.
6. **`src/routes/mod.rs`**:
   - `.route("/users/me/banner", put(users::upload_banner).delete(users::delete_banner).layer(image_limit))`, next to the avatar route (static, so it wins over `/users/{username}`);
   - in `public_router`, `.nest_service("/media/banners", Router::new().fallback_service(ServeDir::new(state.storage.banners_dir())).layer(axum::middleware::map_response(screenshot_media_headers)))`.
7. **`src/routes/reports.rs`**:
   - `TARGET_TYPES` += `"user"`, and `unknown_target_type` → `targetType must be "game", "comment", "screenshot", "collection" or "user"`.
   - A `"user"` branch: `SELECT id, username FROM users WHERE id = ?`, where a miss gives 404 `User not found`; `id == user.id` gives 422 `You can't report yourself`; otherwise `(None, format!("@{username}"))`.
   - The resolve validation table in API § F028; `("clearProfile", "user") => clear_profile(&state, &report.target_id).await?`.
   - The `Report.target_game_id` doc gains "and `user`".
8. **`tests/f008.rs`**: update the one `targetType must be …` assertion (line ~1403) to the new text. No other existing assertion changes.
9. **`tests/f028.rs`** (§ 6). Copy the `rgb`/`encode` image helpers from `tests/f005.rs`. Use `setup_with` with `admin_usernames` for the admin cases, and `t.clock` for the rate limit.

**Acceptance:** `cd backend && cargo test` (every suite green, including `f005`, `f008`, `f015`, `f018`, `review2`, and `f024` once it lands) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types** (`src/api/types.ts`):
   - `ProfileLink`, `ProfileStats`;
   - `User.bannerUrl?: string | null` (doc: "F028. Older servers omit it: treat as unsupported (hide banner settings) and as no banner.");
   - `User.links?: ProfileLink[]` (doc: "F028. Older servers omit it: hide the links editor, show no links.");
   - `UserProfileResponse.stats?: ProfileStats`; `UpdateMeRequest.links?: ProfileLink[]`;
   - `ReportTargetType` += `"user"`, `ReportAction` += `"clearProfile"`, with their doc comments.

   Export the new types from `src/index.ts`.
2. **Client** (`src/api/client.ts`): `uploadBanner(banner: Blob, onProgress?: UploadProgress): Promise<User>` (form field `banner`, `PUT /api/users/me/banner`, via `this.upload`) and `deleteBanner(): Promise<User>` (`DELETE`).
3. **Pure helpers**:
   - **`src/share.ts`**: `LINK_COPIED_MS`; `appShareUrl(config, path)`, which is the body of `collectionShareUrl` with `path` as input (move `currentOrigin` with it); `profileShareUrl(config, username)`. `collections.ts` `collectionShareUrl` delegates to `appShareUrl` (same output; `CollectionPage.test.tsx` stays green). `CollectionPage.tsx` imports `LINK_COPIED_MS` from `share.ts` and re-exports it.
   - **`src/profile.ts`**:
     - `PROFILE_LINKS_MAX = 3`, `PROFILE_LINK_LABEL_MAX = 30`, `PROFILE_LINK_URL_MAX = 200`;
     - `isSafeProfileUrl(url: string): boolean`, the exact server rule from API § F028;
     - `validateProfileLinkUrl(url: string): string | null`, which returns `Enter a full link starting with https:// or http://` or null;
     - `linkHost(url)`;
     - `profilePath(username, section?: "games" | "screenshots" | "collections")`;
     - `PROFILE_OVERVIEW_GAMES = 8`, `PROFILE_GAMES_PER_PAGE = 24`, `PROFILE_SCREENSHOTS_PREVIEW = 4`.
   - **`src/util.ts`**: `formatMonthYear(iso)`.
4. **Components**:
   - **`components/CopyLinkButton.tsx`**: `CopyLinkButton({ url, label = "Copy link", className })`, with the § 0.6 behaviour, its own `useId`, a live region and the fallback input.
   - **`components/ProfileHeader.tsx`**: `ProfileHeader({ profile, isMe })` (§ 0.5) and `ProfileHeaderSkeleton()`. It owns the follow-cache seeding that `ProfilePage` does today.
   - **`components/ProfileLinksEditor.tsx`**: a controlled `ProfileLinksEditor({ value, onChange, errors })` plus a pure `linkRowErrors(rows): (string | null)[]` (§ 0.12).
   - **`components/BannerSettings.tsx`**: the § 0.13 panel.
   - **`components/ProfileScreenshots.tsx`**: the `preview` prop (§ 0.9).
5. **Pages and routes**:
   - **`pages/ProfilePage.tsx`** becomes the shell:
     - it loads the profile, shows the 404/error/skeleton states, `ProfileHeader`, the `.pf-profile-tabs` nav and `<Outlet context={{ profile, isMe, reload }} />`;
     - it does the canonical-username `navigate(..., { replace: true })` and the legacy `?page` redirect;
     - it exports `ProfilePage`, `ProfileOutletContext`, `useProfileOutlet()` and `MyProfileRedirect`.
   - **`pages/ProfileSections.tsx`**: `ProfileOverview`, `ProfileGamesTab`, `ProfileScreenshotsTab` (§ 0.7–0.9, with titles per § 0.11).
   - **`pages/UserCollectionsPage.tsx`**: the embedding changes in § 0.10. It reads `useProfileOutlet()` for the name used in the title.
   - **`WebGameApp.tsx`**:
     ```tsx
     <Route path="u/:username" element={<ProfilePage />}>
       <Route index element={<ProfileOverview />} />
       <Route path="games" element={<ProfileGamesTab />} />
       <Route path="screenshots" element={<ProfileScreenshotsTab />} />
       <Route path="collections" element={<UserCollectionsPage />} />
     </Route>
     <Route path="me" element={<RequireAuth><MyProfileRedirect /></RequireAuth>} />
     ```
     The followers/following routes stay as they are.
   - **`pages/SettingsPage.tsx`**: the links fieldset in the Profile form (§ 0.12), and `<BannerSettings />` between the Avatar panel and `NotificationSettingsSection`.
   - **`components/Report.tsx`**: `what` gives `"profile"` for `"user"`.
   - **`pages/AdminPage.tsx`**:
     - `ACTION_COPY.clearProfile` (§ 0.17);
     - `KNOWN_TARGET_TYPES` += `"user"`;
     - `reportActions("user")` → `["dismiss", "clearProfile"]`;
     - a `user` row branch with `View profile →`.
6. **Header nav and menu:** the user menu's `Profile` item now links to `/me`. No other nav changes (navigation polish is F034).
7. **Styles** (`styles.css`, Profile block):
   - rework `.pf-profile`; add `.pf-profile__banner`, `.pf-profile__body`, `.pf-profile__links`, `.pf-profile__actions`, `.pf-profile-tabs`, `.pf-profile-tabs__count`, `.pf-profile-section`, `.pf-banner-preview`, `.pf-links-editor`, `.pf-badge--user`;
   - add the 860 px and 640 px rules (§ 2), and remove the now-unused flex-row rules for `.pf-profile` at 640 px;
   - existing tokens only.
8. **Exports** (`src/index.ts`): `CopyLinkButton`, `ProfileHeader`, `appShareUrl`, `profileShareUrl`, `isSafeProfileUrl`, `validateProfileLinkUrl`, `linkHost`, `profilePath`, `formatMonthYear`, `MyProfileRedirect`, and the section components.
9. **Tests** (§ 6). Existing suites stay green. In particular, `Follow.test.tsx` renders `ProfilePage` at `/u/:username` without child routes and asserts the follower/following links. These links stay in the header, so the test must pass unchanged.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`, `npm test -w @webgame/desktop`.

### desktop-dev (`apps/desktop/**`)
1. **`src-tauri/src/menu.rs`**:
   - `"profile"` in `FORWARDED`; View gets `.item(&item(app, "profile", "My &Profile")?)` as its **first** item, followed by a separator;
   - no accelerator (not in `ACCELERATORS`);
   - unit test: `FORWARDED.contains(&"profile")` and `accelerator("profile") == None`;
   - the module doc lists `"profile"`.
2. **`src/nativeMenu.ts`**: `ROUTES.profile = "/me"`, and the doc comment says `"profile"` (View → My Profile, F028) navigates to `/me`, which the UI redirects to the user's profile (or to login when signed out).
3. **`src/__tests__/f028.desktop.test.tsx`**. Use the `f015.desktop.test.tsx` pattern: the real `App` under the hash router, `SERVER_STORAGE_KEY` = `http://192.168.1.5:8080`, mocked `fetch` and Tauri modules. A signed-in user `mia` whose profile has `bannerUrl: "/media/banners/u1.jpg?v=2"` and `links: [{ label: "", url: "https://www.example.com/me" }]`. Assert:
   - on `#/u/mia`, the banner `img` `src` is `http://192.168.1.5:8080/media/banners/u1.jpg?v=2`, and the `tauri.conf.json` CSP `img-src` allows it (reuse the `imgAllowed` approach);
   - the link's text includes `example.com`, `target="_blank"`, and `rel` contains `noopener` and `noreferrer`;
   - Copy link (with a mocked `navigator.clipboard.writeText`) writes `http://192.168.1.5:8080/u/mia`;
   - dispatching the `app-menu` event with `"profile"` (through the module's listener, as in `nativeMenu.test.ts`) sets `location.hash` to `#/me`, and the app then shows `#/u/mia`;
   - the `Games` section link `href` is `#/u/mia/games`.

**Acceptance:** `npm run build -w @webgame/desktop`, `npm test -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test` and `cargo check`.

### engine-dev
None.

### Docs (project-manager, after the round)
- README "Features": add a **Profiles** bullet: banners, links, Overview/Games/Screenshots/Collections sections with shareable URLs, Copy link, `/me`, and profile reports.
- ROADMAP: F028 → shipped.

### Sequencing
backend-dev and frontend-dev work in parallel against API § F028 (the frontend mocks responses). desktop-dev's menu change can start at once. Its test needs the built `@webgame/ui`, so it runs after frontend-dev lands.

## 5. Edge cases and security
- **Link injection.** URLs are restricted server-side to printable-ASCII `http(s)` with a plain host and no credentials, so `javascript:`, `data:`, `file:`, `user@host` and IDN homographs can't be stored. The client re-checks with `isSafeProfileUrl` before rendering, and drops (doesn't render) anything else, which covers corrupt rows. Links open with `noopener noreferrer`, and `nofollow ugc` keeps link spam from gaining search ranking. React renders labels as text.
- **Banner content.** Every banner is decoded and re-encoded (no EXIF, ICC or text chunks, alpha flattened on black), within the F005 decode budget and under the shared `image_slots` semaphore (503 + `Retry-After: 5` when busy). `/media/banners/*` has `nosniff`, `Content-Security-Policy: sandbox` and a 1-hour cache lifetime, so a `clearProfile` reaches caches within an hour. The `?v=` bump makes clients fetch the new banner at once.
- **Abuse.** Banner uploads share `Limit::Image` (20 per hour with avatars and thumbnails). Profile reports share `Limit::Report`, with one open report per reporter and target (409). `clearProfile` is admin-only and resolves all open reports on the user.
- **Races.**
  - Two concurrent banner uploads: each write is an atomic rename, and the DB version increments twice. The last rename wins, and the URL's version is at least as new as some valid file. This is acceptable, as for avatars.
  - `clearProfile` racing a new upload can leave the new banner in place. The admin can clear again.
  - `delete_banner` racing an upload can leave a file without `banner_ext` (an orphan, overwritten by the next upload).
- **Stats consistency.** Each stat reuses the list endpoint's own filter (shared SQL), so a tab count always equals the list total for the same viewer. Unpublished games and their screenshots count only for their owner, and private collections only for their owner.
- **Case and canonical URLs.** Lookups stay case-insensitive. The client replaces the URL with the canonical case, so shared links are consistent. The web route `/me` is a different path from `/u/me`, so it never shadows a profile. The API's static `/api/users/me/*` routes are unchanged.
- **Older servers.** Missing `bannerUrl`, `links` or `stats` hide the related UI (§ 0). An older server answers `targetType: "user"` with 422, and the dialog shows the message.
- **Privacy.** Nothing new is exposed: totals summarise content that is already public to the same viewer. Links are opt-in.
- **Performance.** The profile GET adds four indexed aggregate queries: plays via `idx_games_owner_pub_new`, achievements via the `user_achievements` primary key, screenshots via `idx_screenshots_author_created`, and collections via the owner index. Banner processing is bounded like screenshots.
- **Migration safety.** Three `ADD COLUMN`s with constant defaults. No rebuild, no new index. Existing rows get no banner and `[]`.

## 6. Test expectations

### Backend (`tests/f028.rs`)
- **Upgrade.** Migrate a file database to version ≤ 23 (the `tests/f018.rs` pattern with `filter(|x| x.version <= 23)`), insert a user, run `AppState::new`, then assert:
  - `banner_ext` is NULL, `banner_version` 0 and `links_json` `'[]'`;
  - `GET /api/auth/me` returns `bannerUrl: null` and `links: []`;
  - `PRAGMA integrity_check` is `ok`.
- **Links.**
  - `PATCH { links: [{ label: " Site ", url: "HTTPS://Example.com/a?b#c" }] }` → `links = [{ label: "Site", url: "https://Example.com/a?b#c" }]`.
  - Omitted keeps them; `null` keeps them; `[]` clears them.
  - 4 items → `links must have at most 3 items`.
  - Each URL message for: `javascript:alert(1)`, `ftp://x.com`, `https://user@x.com`, `https://localhost`, `https://-x.com`, `https://x.com/ a`, `https://exämple.com`, `https://x.com:123456`, `""`, and a 201-character URL (the length message).
  - A label of 31 characters; a label containing `\u0007`.
  - `{ displayName: "New", links: [bad] }` → 422, and the display name is unchanged.
  - `{ displayName: "New", bio: <1001 chars> }` → 422, and the display name is unchanged (the partial-update fix).
- **Banner.**
  - 3000×500 PNG → 200, `bannerUrl` = `/media/banners/{id}.jpg?v=1`, and the stored file decodes as a 1500×500 JPEG.
  - 900×900 JPEG → 900×300.
  - 600×200 → 200 and 600×200.
  - 500×500 → 422 `banner must be at least 600×200 pixels after cropping to 3:1`.
  - 50×50 → 422 (the F005 dimension message).
  - Garbage bytes → 422 `banner must be a PNG, JPEG or WebP image`.
  - Over 2 MB → 413.
  - No field → 422 `banner file is required`.
  - Anonymous → 401.
  - A PNG with a `tEXt` chunk: the stored file doesn't contain the text.
  - `GET /media/banners/{id}.jpg` → 200 with `x-content-type-options: nosniff`, `content-security-policy: sandbox` and `cache-control: public, max-age=3600`.
  - A second upload → `?v=2`.
  - `DELETE` → `bannerUrl: null`, the file is gone, and `banner_version` is 3; `DELETE` again → 200, with the version still 3.
  - With `ManualClock`: 20 avatar uploads, then a banner upload → 429.
- **Stats.** User U has 2 published games (`plays` set to 5 and 7 directly) and 1 unpublished game (plays 100), one screenshot on a published and one on the unpublished game, one public non-empty collection and one private collection, and 2 achievements on a published game plus 1 on the unpublished game.
  - Anonymous: `{ plays: 12, achievements: 2, screenshots: 1, collections: 1 }`, `gamesTotal` 2.
  - U themselves: `{ plays: 112, achievements: 3, screenshots: 2, collections: 2 }`, `gamesTotal` 3.
  - For each viewer, `stats.screenshots` equals `GET /api/users/U/screenshots` `total`, and `stats.collections` equals `GET /api/users/U/collections` `total`.
- **Reports.**
  - P reports U (`targetType: "user"`, `targetId` = U's id) → 201, `targetPreview` `@u`, `targetGameId` null.
  - Again → 409. Self → 422 `You can't report yourself`. An unknown id → 404 `User not found`.
  - The admin resolves with `delete` → 422 `action must be "dismiss" or "clearProfile" for user reports`; with `unpublish` → the same message.
  - `clearProfile` on a game report → 422 `clearProfile is only valid for user reports`; `bogus` → 422 `action must be "dismiss", "unpublish", "delete" or "clearProfile"`.
  - `clearProfile` on U's report (U has an avatar, banner, bio, links and display name) → 200 `resolved`, and a second open report on U by Q is resolved too. After it:
    - `displayName == username`, `bio == ""`, `links == []`;
    - `avatarUrl` and `bannerUrl` are null, and both files are gone;
    - U's games are untouched.
  - The F008 message assertion is updated.
- **Unit.** `validate_links` (every rule), `banner_crop` (four cases), and `process_banner` on small in-memory images (sizes; a JPEG comes out).

### Frontend (vitest)
- **`profile.test.ts`**:
  - `isSafeProfileUrl` and `validateProfileLinkUrl` agree with every backend URL case above;
  - `linkHost("https://www.example.com/x")` = `example.com`;
  - `profilePath("Mia", "games")` = `/u/Mia/games`;
  - `formatMonthYear` gives `""` for an invalid date;
  - `appShareUrl` and `profileShareUrl` in browser mode (with a `basename`) and hash mode (with `apiBaseUrl` trailing slashes trimmed);
  - `collectionShareUrl` output is unchanged.
- **`ProfilePage.f028.test.tsx`** (`MemoryRouter` with the real nested routes):
  - The header shows the banner `img` (`alt=""`) when `bannerUrl` is set, and none without it.
  - The text `@mia · Joined …` is present.
  - Links render with label or host, `target="_blank"` and the `rel` tokens, and the sr-only text. A stored `javascript:` link is not rendered.
  - The stats show plays and achievements from `stats` and hide them without `stats`.
  - The nav is labelled `Profile sections`, its links have counts, and Overview has `aria-current="page"` at `/u/mia`. Clicking Games changes the URL to `/u/mia/games`, the header is not refetched (one `getUser` call), and the clicked link keeps focus.
  - The Collections link is hidden when collections are unsupported.
  - The canonical redirect: `/u/MIA/games?page=2` → `/u/mia/games?page=2`.
  - The legacy redirect: `/u/mia?page=3` → `/u/mia/games?page=3`.
  - `/me` → `/u/{me}`; signed out → `/login?next=%2Fme`.
  - The Overview games shelf shows 8 and `See all 30 games →`. For another user with 0 games, the section is absent. The all-zero overview shows `{name} hasn't shared anything yet.`
  - The Games section calls `listGames` with `owner: "mia"` (another user) or `owner: "me"` (yourself), `sort: "new"`, `perPage: 24`, the page from the URL, and has the empty-state texts verbatim.
  - The Screenshots section's empty state for another user is shown when `stats.screenshots` is 0.
  - The titles follow § 0.11.
  - Own profile: `Edit profile` and `Copy link`, no Report. Another user: Follow, Copy link, `⚑ Report`, and the dialog heading is `Report profile: @mia`.
- **`CopyLinkButton.test.tsx`**: success → the text is `Link copied`, then back to `Copy link` after 2000 ms (fake timers), and the live region says `Link copied`. A rejected `writeText` → the input labelled `Copy this link` is focused and selected, with the URL as its value.
- **`ProfileScreenshots.f028.test.tsx`**: `preview={4}` requests `perPage: 4`, has no `Load more`, and shows `See all 9 screenshots →` linking to `/u/mia/screenshots` when `total` is 9. Without `preview`, the existing `ProfileScreenshots.test.tsx` stays green.
- **`SettingsPage.f028.test.tsx`**:
  - The links editor's add, remove and focus rules, and its max of 3 rows (the Add button is hidden at 3).
  - An invalid URL shows the inline error, `aria-invalid`, focus, and no request.
  - Empty rows are dropped. The PATCH body contains `links`.
  - It is hidden when `user.links` is undefined, and `links` is then not sent.
  - The banner panel: upload calls `uploadBanner` with progress, then the `Banner updated` toast. The 2 MB client check. Remove calls `deleteBanner`, then the `Banner removed` toast, and focus moves to `Upload banner`. It is hidden when `bannerUrl` is undefined.
- **`AdminPage.f028.test.tsx`**:
  - `reportActions("user")` gives `["dismiss", "clearProfile"]`.
  - A user row shows `@mia` and `View profile →` linking to `/u/mia`.
  - Clear profile opens the confirm with the exact title and body, and sends `clearProfile`.
- **`ApiClient.f028.test.ts`**: `uploadBanner` sends a PUT with multipart field `banner`; `deleteBanner` sends a DELETE; `updateMe` passes `links`.

### Desktop (vitest + cargo)
As listed in § 4 desktop-dev.

### Manual end to end
1. Mia uploads a 2400×1200 photo as her banner. Settings shows it cropped to 3:1, and her profile shows it at 200 px high on a laptop and 112 px on a phone, with her avatar overlapping it.
2. She adds `YouTube` → `https://youtube.com/@mia` and an unlabeled `https://www.mia.dev`. The profile shows "YouTube" and "mia.dev", and both open in a new tab (the system browser on desktop).
3. A visitor opens `/u/MIA`. The URL becomes `/u/mia`. They click Games, page 2, and copy the URL. It opens the same page in another browser.
4. Copy link on desktop gives `http://<server>/u/mia`, which opens in a browser.
5. A player reports Mia's profile. The admin sees `@mia` with View profile and chooses Clear profile. Her banner, avatar, bio and links are gone, and her games remain.

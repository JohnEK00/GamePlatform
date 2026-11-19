# F034: Navigation and UI polish (with F037 About and Help)

Status: **specced**. Size: **M**. One round. Areas: frontend, desktop. Backend: none. Engine: none.

Size breakdown:
- **frontend:** a regrouped header with no duplicate links, an accessible user menu, a mobile menu sheet below 860 px, a three-column footer, `PageHeader` with `Breadcrumbs`, two shared page states (`PageError`, `PageLoading`) and two small upgrades to `EmptyState`/`ErrorState`, migrations of the pages listed in § 0.8, and two static pages `/about` and `/help` (F037).
- **desktop:** Help → Help and FAQ, Help → About opens `/about` instead of the native dialog, and a "This app" block on `/about` (version and server).
- **backend:** nothing to build. `/about` and `/help` are client routes, which the existing SPA fallback (`routes/mod.rs`, `index.html` for every non-asset path) already serves.

Contracts: `docs/ARCHITECTURE.md` § F034 additions (UI modules, `PlatformConfig.aboutExtra`, desktop menu ids), `docs/API.md` § F034 additions (web routes only; no endpoints), `docs/GAME_FORMAT.md` § F034 additions (none).

Depends on: F032 (`/browse`, `BROWSE_PATH`, `browsePath`), F035 (`/creators`), F028 (`/me`, `profilePath`), F007/F018 (`NotificationBell`), F008 (`useCollectionsSupported`). All shipped.

**Folded in: F037** (About and Help pages). The new footer and the desktop Help menu link to `/about` and `/help`, so shipping the links without the pages would create dead ends.

**Migration: none.** The highest file stays `0027_f032.sql`; the next free number stays `0028`.

## 0. Decisions on ambiguities (read first)
Tests assert the texts, orders, ids and attributes below verbatim. `{name}` means display name, falling back to username. "Wide" means the viewport does **not** match `HEADER_COLLAPSE_QUERY` = `(max-width: 860px)` (unchanged constant in `Layout.tsx`); "narrow" means it matches. Where `window.matchMedia` is missing (jsdom), the layout is wide (existing `useMediaQuery` rule).

### 0.1 Where every link lives (the duplicate audit)
The F028 audit found that the header nav and the user menu both carried Studio, My games, Feed and Favorites; Admin/Moderation and Upload were also doubled (nav `Admin` + menu `Moderation`; `+ Upload` button + menu `Upload a game`). After F034 each destination has exactly one home per surface:

| Destination | Wide: main nav | Wide: user menu | Wide: other | Narrow: menu sheet | Footer |
|---|---|---|---|---|---|
| Browse `/browse` | ✓ | | | Explore | Play |
| Creators `/creators` | ✓ | | | Explore | Play |
| Feed `/feed` (signed in) | ✓ | – (removed) | | Explore | |
| Studio `/studio` | ✓ | – (removed) | | Create | Create |
| Make a game `/docs` | – (removed) | | | Create | Create (`Docs`) |
| Upload `/upload` (signed in) | | – (removed) | `+ Upload` button | Create | Create |
| Profile `/me` | | ✓ | | You | |
| My games `/dashboard` | – (removed) | ✓ | | You | |
| Favorites `/favorites` | – (removed) | ✓ | | You | |
| Collections `/collections` (when supported) | | ✓ | | You | |
| Notifications `/notifications` | | – (removed) | bell panel `See all` | – (bell stays in the header row) | |
| Settings `/settings` | | ✓ | | You | |
| Moderation `/admin` (admins) | – (`Admin` removed) | ✓ | | You | |
| About `/about` | | | | Pixelforge Arcade | Arcade |
| Help `/help` | | | | Pixelforge Arcade | Arcade |
| Report a problem `/help?topic=reporting` | | | | | Arcade |
| Log out | | ✓ | | bottom button | |
| Log in / Sign up (anonymous) | | | actions | bottom buttons (+ `Log in` in the row) | |

### 0.2 Wide header (> 860 px)
DOM order (= Tab order), unchanged skeleton so the F007/review-4 bell tests keep passing:

`Logo` → `<div id="pf-mainnav" className="pf-header__nav">` containing `<nav aria-label="Main">`, `SearchBox`, `NotificationBell` (when signed in and supported, unchanged), `<div className="pf-header__actions">`.

1. **Main nav links, in this order** (all `NavLink`, no `end`):
   - `Browse` → `/browse` (everyone);
   - `Creators` → `/creators` (everyone);
   - `Feed` → `/feed` (signed in only);
   - `Studio` → `/studio` (everyone).
   `Make a game`, `My games`, `Favorites` and `Admin` are removed from the nav.
2. **Actions:** loading → `Spinner` `Checking session` (unchanged); signed in → `+ Upload` (`/upload`, unchanged) then the user menu; anonymous → `Log in` and `Sign up` with `?next=` (unchanged rule, including the auth-page exception).
3. **No ☰ toggle and no menu sheet are rendered when wide.** The old `is-open` dropdown, its CSS (`.pf-header__nav.is-open`, the 860 px `.pf-header__nav` absolute-position block) and the `navOpen` state are deleted.
4. Between 861 and 1100 px the user-menu button hides its name visually: `.pf-usermenu__name` gets the `.pf-sr-only` clip pattern inside `@media (max-width: 1100px)` (it stays the button's accessible name).

### 0.3 User menu (wide only)
1. **Items, in this order:** `Profile` → `/me`; `My games` → `/dashboard`; `Favorites` → `/favorites`; `Collections` → `/collections` (only when `useCollectionsSupported()`); `Settings` → `/settings`; `Moderation` → `/admin` (only for `role === "admin"`); `<hr>` (`role="separator"`); `Log out` (button). `Feed`, `Notifications`, `Studio` and `Upload a game` are removed.
2. **Semantics** stay `role="menu"` / `role="menuitem"`, button `aria-haspopup="menu"` + `aria-expanded`, and now also `aria-controls="pf-usermenu"` (the menu's id) while open. Items get `tabIndex={-1}` (roving focus; the menu is not a Tab stop sequence).
3. **Keyboard** (the APG menu-button pattern; new):
   - On the button: `Enter`, `Space` or `ArrowDown` opens and focuses the first item; `ArrowUp` opens and focuses the last item. A mouse click opens without moving focus into the menu (as today).
   - In the menu: `ArrowDown`/`ArrowUp` move to the next/previous item and wrap; `Home`/`End` go to the first/last item; `Enter` activates (native link/button behaviour).
   - `Escape` closes and returns focus to the button.
   - `Tab`/`Shift+Tab` close the menu and let focus move on normally (no `preventDefault`).
   - Choosing an item closes the menu (route change, unchanged); `Log out` closes it and returns focus to the button if it still exists, otherwise to `#pf-main`.
   - A mousedown outside closes without moving focus (unchanged).
4. **`aria-current="page"`** on an item when `accountLinkCurrent(id, pathname, user.username)` is true (§ 0.7).

### 0.4 Narrow header (≤ 860 px)
1. **Header row, DOM order:** `Logo`; then signed in → `NotificationBell` (existing narrow slot); anonymous and not loading → `<Link className="pf-btn pf-btn--ghost pf-btn--sm">Log in</Link>` (same `next` rule); then the toggle.
2. **Toggle:** `<button type="button" className="pf-iconbtn pf-header__toggle" aria-label="Menu" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? "pf-menu-sheet" : undefined}>☰</button>`. It is rendered **only when narrow**; `#pf-mainnav` is rendered **only when wide**. CSS keeps a safety net: under 860 px `.pf-header__nav { display: none }` and `.pf-header__toggle { display: inline-grid }`; above it `.pf-header__toggle { display: none }`.
3. The search box is not in the narrow header row; it is the first control in the sheet.

### 0.5 Menu sheet (narrow only; new `components/MenuSheet.tsx`)
1. **Placement.** Rendered by `Header` as a **sibling after `<header>`** (not inside it: the header's `backdrop-filter` would become the containing block for `position: fixed`). Mounted only while open; unmounting is the close (no exit animation).
2. **Markup:**
   ```html
   <div class="pf-sheet-backdrop">                      <!-- fixed, inset 0, z-index 800, rgba(4,5,10,.6) -->
     <div id="pf-menu-sheet" class="pf-sheet" role="dialog" aria-modal="true" aria-labelledby="pf-menu-sheet-title">
       <div class="pf-sheet__head">
         <h2 id="pf-menu-sheet-title" class="pf-sheet__title">Menu</h2>
         <button type="button" class="pf-iconbtn" aria-label="Close menu" data-autofocus>✕</button>
       </div>
       … content (0.5.3) …
     </div>
   </div>
   ```
   z-index 800 sits above the header (40) and the bell panel (45), below modals (900) and toasts (1000).
3. **Content, in this order:**
   1. `SearchBox` (label `Search games`, same id `pf-search-input`: only one SearchBox is ever mounted). Submitting navigates (§ F032 rule) and closes the sheet.
   2. Signed in: an account link `<Link to="/me" className="pf-sheet__me">` with `Avatar` (size 40), `{name}` and `@{username}` (muted).
   3. `<nav aria-label="Main">` with two groups, each `<p className="pf-sheet__group" id="pf-sheet-{key}">{label}</p>` + `<ul aria-labelledby="pf-sheet-{key}">`:
      - key `explore`, label `Explore`: `Browse` → `/browse`, `Creators` → `/creators`, `Feed` → `/feed` (signed in);
      - key `create`, label `Create`: `Studio` → `/studio`, `Make a game` → `/docs`, `Upload a game` → `/upload` (signed in).
   4. Signed in: `<nav aria-label="Account">` with one group, key `you`, label `You`: the user-menu items of § 0.3.1 except `Log out`, same order, texts, conditions and `aria-current` rule.
   5. Group key `arcade`, label `Pixelforge Arcade` (inside a `<nav aria-label="Site">`): `About` → `/about`, `Help` → `/help`.
   6. Bottom (`.pf-sheet__foot`): signed in → `<button className="pf-btn pf-btn--ghost">Log out</button>`; anonymous → `Log in` (`pf-btn pf-btn--ghost`) and `Sign up` (`pf-btn pf-btn--primary`) with the `next` rule; loading → `Spinner` `Checking session`.
   Main-nav links in the sheet are `NavLink`s (same `aria-current` as wide). Every row is at least 44 px tall.
4. **Focus** (via the existing `useModal(open, close)` hook, unchanged):
   - On open, focus goes to `Close menu` (`data-autofocus`), **not** the search input, so phones don't pop the keyboard.
   - `Tab` from the last control wraps to the first and `Shift+Tab` from the first wraps to the last; focus that escapes (click on the page behind) is pulled back.
   - On close, focus returns to the ☰ toggle (useModal's opener rule). When the toggle is gone (closed by the breakpoint, § 0.5.5), focus is left to the browser; no special handling.
5. **Closing.** Any of:
   - `Escape` (useModal), `Close menu`, a mousedown on the backdrop itself (not on the sheet);
   - activating any link in the sheet, or submitting the search (the route change closes it: `location.pathname` or `location.search` changes);
   - `Log out` (closes, then signs out);
   - the viewport becoming wide (`collapsed` false → `setOpen(false)`).
6. **Scroll lock.** While open, `document.documentElement.style.overflow = "hidden"`; the previous inline value is restored on close and on unmount.
7. **Size.** `width: min(360px, 88vw)`, full height (`height: 100dvh` with a `100vh` fallback), docked right, its own vertical scroll (`overflow-y: auto`, `overscroll-behavior: contain`). At `(max-width: 480px)` the width is `100vw`.
8. **Motion.** Inside `@media (prefers-reduced-motion: no-preference)` only: the sheet slides in (`transform: translateX(100%)` → `0`, 180 ms ease-out) and the backdrop fades in (180 ms). With `reduce`, it appears at once (also covered by the existing global `.pf-app *` reduce rule, since the sheet renders inside `.pf-app`). The user menu's `pf-pop` animation moves into the same `no-preference` block.

### 0.6 Footer
1. **Markup** (replaces the one-line footer):
   ```html
   <footer class="pf-footer">
     <div class="pf-container pf-footer__inner">
       <div class="pf-footer__brand">
         <p><strong>Pixelforge Arcade</strong>{platform.name ? ` · ${platform.name}` : ""}</p>
         <p class="pf-muted">Forge games, play games.</p>
       </div>
       <nav aria-label="Footer" class="pf-footer__nav"> three columns </nav>
     </div>
   </footer>
   ```
   Each column: `<div className="pf-footer__col"><p className="pf-footer__heading" id="pf-footer-{key}">{label}</p><ul aria-labelledby="pf-footer-{key}">…</ul></div>`. Headings are not `h*` elements (the footer adds nothing to the page outline).
2. **Columns and links, in this order** (`FOOTER_COLUMNS` in `nav.ts`):
   | key | label | links |
   |---|---|---|
   | `play` | `Play` | `Browse` → `/browse`, `Creators` → `/creators` |
   | `create` | `Create` | `Studio` → `/studio`, `Docs` → `/docs`, `Upload` → `/upload` |
   | `arcade` | `Arcade` | `About` → `/about`, `Help` → `/help`, `Report a problem` → `/help?topic=reporting` |
   The F032/F035 tests keep passing: `Browse` is followed by `Creators` in the `Footer` nav.
3. Links are `NavLink end` (exact pathname → `aria-current="page"`), except `Report a problem`, which is a plain `Link` (a `NavLink` compares only the pathname and would be "current" on every `/help` URL).
4. **Layout.** Wide: a grid `minmax(200px, 1.4fr) repeat(3, minmax(0, 1fr))`. `(max-width: 860px)`: the brand takes the full first row and the three columns share the second. `(max-width: 480px)`: columns in `repeat(2, 1fr)`.

### 0.7 `aria-current` rules (all surfaces)
- Main nav (wide and sheet): React Router `NavLink` default (`aria-current="page"` when the pathname is the link's path or below it). So `Browse` is current on `/browse?sort=top`, `Studio` on `/studio`, nothing on `/`.
- User menu and sheet `You` group: `accountLinkCurrent(id, pathname, username)` (pure, `nav.ts`). Compare on `pathname.toLowerCase()` with `u = "/u/" + username.toLowerCase()`:
  - `profile`: equals `u`, or starts with `u + "/"` and is not `u + "/collections"`, or equals `/me`;
  - `collections`: equals `u + "/collections"` or `/collections`;
  - `dashboard`, `favorites`, `settings`, `admin`: equals `/dashboard`, `/favorites`, `/settings`, `/admin`.
  The pathname is compared as React Router gives it (`encodeURIComponent` is a no-op for valid usernames).
- Footer: § 0.6.3.
- Breadcrumbs: the last crumb (§ 0.9).
- Help table of contents: none (it is in-page navigation).

### 0.8 Shared states: what is new and which pages adopt them this round
New and changed components:
1. **`ErrorState`** (`common.tsx`): when `isApiError(error) && error.status === 0`, the title is `Can't reach the server` and the text `Check your connection and try again.`; otherwise unchanged (`Something went wrong` + `errorMessage(error)`). It gains an optional `headingLevel?: 2 | 3` passed to `EmptyState`.
2. **`EmptyState`** (`common.tsx`): optional `headingLevel?: 2 | 3`, default **3** (unchanged output when omitted).
3. **`PageError({ error, onRetry, what, className })`** (new, `components/PageStates.tsx`): `isApiError(error) && error.status === 404` → `<NotFoundPage what={what} />`; otherwise `<div className={"pf-container pf-page" + (className ? " " + className : "")}><ErrorState error={error} onRetry={onRetry} headingLevel={2} /></div>`. `what` is the existing `NotFoundPage` prop (`"game"`, `"player"`, `"post"`, `"collection"`, …).
4. **`PageLoading({ label = "Loading" })`** (new, `components/PageStates.tsx`): `<div className="pf-center pf-pad" aria-busy="true"><Spinner size={28} label={label} /></div>`.
5. **`PageHeader`** and **`Breadcrumbs`** (new, `components/PageHeader.tsx`, § 0.9).

Adoption in this round (exactly these; everything else stays as is and may migrate later):
| Page | `PageError` | `PageLoading` | `PageHeader` | `Breadcrumbs` | `EmptyState headingLevel={2}` |
|---|---|---|---|---|---|
| `GamePage` | ✓ (`what="game"`) | | | | |
| `GameStatsPage` | ✓ (`what="game"`) | | (keeps its custom `pf-statshead`) | ✓ above the header | |
| `EditGamePage` | ✓ (`what="game"`) | | ✓ | ✓ | |
| `PostPage` | ✓ (`what="post"`, `className="pf-post-page"`) | | | | |
| `CollectionPage` | ✓ (`what="collection"`) | | | | |
| `ProfilePage` | ✓ (`what="player"`, only in its `error && !current` branch) | | | | |
| `FollowListPage` | (keeps its 404 → `NotFoundPage` and its inline list `ErrorState`) | | ✓ | ✓ | ✓ |
| `FavoritesPage` | | | ✓ | | ✓ |
| `DashboardPage` | | | ✓ (with `actions`) | | |
| `SettingsPage` | | | ✓ | | |
| `UploadPage` | | | ✓ | | |
| `AdminPage` | | | ✓ | | |
| `NotificationsPage` | | ✓ (`Loading notifications`) | | | |
| `RequireAuth` (`Layout.tsx`) | | ✓ (`Loading`) | | | |
| `AboutPage`, `HelpPage` (new) | | | ✓ | | |

Not migrated this round (and why): `FeedPage`, `CreatorsPage`, `NotificationsPage` header (focus refs on the h1 and tabs in the header: risk with no visible gain), `DocsPage` (lead paragraph and TOC layout), `UserCollectionsPage` (an h2 inside the profile shell), `HomePage`/`BrowsePage` (F032 just settled them). Skeleton layouts stay page-specific by design: they mirror each page's content.

Markup equivalence: migrated pages must keep their visible texts, heading levels (h1 stays h1) and existing classes on the `<header>` (`pf-pagehead`, `pf-pagehead--row`), so existing tests and styles keep working. A migrated page's `EmptyState`/`ErrorState` directly under its h1 uses `headingLevel={2}` only where the table says so.

### 0.9 `PageHeader` and `Breadcrumbs`
1. **Types and signatures:**
   ```ts
   export type Crumb = { label: string; to?: string };
   export function Breadcrumbs({ items }: { items: Crumb[] }): JSX.Element | null;
   export type PageHeaderProps = {
     title: ReactNode;                 // the h1 content
     eyebrow?: ReactNode;              // <p className="pf-eyebrow">, above the h1
     description?: ReactNode;          // <p className="pf-muted">, below the h1
     breadcrumbs?: Crumb[];            // rendered first, above everything
     actions?: ReactNode;              // right side; adds pf-pagehead--row
     headingRef?: Ref<HTMLHeadingElement>; // h1 gets tabIndex={-1} when set
     headingId?: string;
     className?: string;               // extra classes on <header>
     children?: ReactNode;             // after the title block (tabs, notes)
   };
   export function PageHeader(props: PageHeaderProps): JSX.Element;
   ```
2. **`PageHeader` markup:** `<header className="pf-pagehead[ pf-pagehead--row][ className]">` → `Breadcrumbs` (if any) → when `actions`: `<div>` eyebrow, h1, description `</div>` + `<div className="pf-pagehead__actions">{actions}</div>`; otherwise eyebrow, h1, description directly → `children`. With breadcrumbs and actions both present, the breadcrumbs take a full row (`.pf-pagehead--row > .pf-breadcrumbs { flex-basis: 100% }`).
3. **`Breadcrumbs` markup:**
   ```html
   <nav aria-label="Breadcrumb" class="pf-breadcrumbs">
     <ol>
       <li><a href="/dashboard">My games</a><span class="pf-breadcrumbs__sep" aria-hidden="true">›</span></li>
       <li><a href="/games/g1" title="Space Dodge">Space Dodge</a><span class="pf-breadcrumbs__sep" aria-hidden="true">›</span></li>
       <li><span aria-current="page">Edit</span></li>
     </ol>
   </nav>
   ```
   - Returns `null` for fewer than 2 items. Every item but the last needs `to` (a missing `to` renders a plain span, never a link). The last item is never a link and carries `aria-current="page"`.
   - Non-last labels are truncated with CSS (`max-width: 28ch`, ellipsis) and carry `title={label}`; small muted text (`.pf-small`), wraps on narrow screens.
4. **Where** (§ 0.8):
   - `EditGamePage`: `[{ label: "My games", to: "/dashboard" }, { label: game.title, to: "/games/{id}" }, { label: "Edit" }]`; h1 `Edit game` unchanged. The old eyebrow link `← {title}` is removed.
   - `GameStatsPage`: `[{ label: "My games", to: "/dashboard" }, { label: g.title, to: "/games/{id}" }, { label: "Stats" }]`, rendered once the owner's game has loaded, directly above the existing `pf-statshead` header.
   - `FollowListPage`: `[{ label: name, to: profilePath }, { label: mode === "followers" ? "Followers" : "Following" }]`; the old `‹ Back to profile` line is removed. h1 texts and the tabs are unchanged (tabs become `children`).
   - Nowhere else this round. Breadcrumbs never start with `Home` (the logo is home).

### 0.10 About page `/about` (F037)
Public route `about`, `useDocumentTitle("About")`, `<div className="pf-container pf-page pf-narrow pf-about">`.
1. `PageHeader` with eyebrow `About`, title `Pixelforge Arcade`, description `A place to play, make and share small browser games. Every game runs on Pixelforge, our WebGL2 engine, in your browser or in the desktop app.`
2. Four sections, each `<section aria-labelledby="about-{id}" className="pf-panel">` with `<h2 id="about-{id}">` and the text below; then a row of links (`pf-btn` unless noted):
   | id | h2 | Text | Links |
   |---|---|---|---|
   | `play` | `Play` | `Browse the catalogue, see what's trending, keep favorites and collections, climb daily, weekly and all-time leaderboards and unlock achievements. When you're signed in, your saves and control bindings follow you between devices.` | `Browse games` → `/browse` (`pf-btn--primary`) |
   | `make` | `Make` | `Write a game in the Studio with a live preview, or zip a folder with a game.json and upload it. Publish updates with release notes and watch your plays on your dashboard.` | `Open the Studio` → `/studio`; `Read the creator docs` → `/docs` |
   | `share` | `Share` | `Follow creators, write posts, reply and heart, capture screenshots and curate public collections. Your profile collects all of it in one place.` | `Explore creators` → `/creators` |
   | `safety` | `Safety` | `Games run in sandboxed frames with no access to your account. Anyone signed in can report a game, comment, post, screenshot, collection or profile, and moderators review every report.` | `How reporting works` → `/help?topic=reporting` |
3. When `usePlatform().aboutExtra` is set: a fifth section `about-app` with h2 `This app` and `{aboutExtra}` as its body. Nothing is rendered otherwise.
4. Last: `<p className="pf-muted">Questions? Visit the <Link to="/help">Help page</Link>.</p>`.

### 0.11 Help page `/help` (F037)
Public route `help`, `useDocumentTitle("Help")`, `<div className="pf-container pf-page pf-narrow pf-help">`.
1. `PageHeader` title `Help`, description `Answers to common questions about playing, making and sharing games.`
2. A table of contents `<nav aria-label="Help topics" className="pf-help__toc pf-panel">` listing every topic as `<Link replace to={helpPath(id)}>{title}</Link>` in topic order.
3. **Topics** (`HELP_TOPICS`, in this order). Each is `<section aria-labelledby="help-{id}">` with `<h2 id="help-{id}" tabIndex={-1}>{title}</h2>`, then each entry as `<h3>{q}</h3><p>{a}</p>`. In the answers below, `[text](path)` is a router `<Link to="path">text</Link>`; everything else is plain text.
   | id | Title | Entries (question → answer) |
   |---|---|---|
   | `account` | `Accounts and profiles` | `Do I need an account to play?` → `No. Anyone can play. Sign up to rate, comment, post, follow creators, keep favorites and sync saves.` · `How do I change my name, bio, avatar or banner?` → `Open [Settings](/settings). [Your profile](/me) shows what other people see.` · `Can people see my profile?` → `Yes. Profiles are public: your name, bio, links, banner, games, public collections, screenshots and posts.` |
   | `playing` | `Playing games` | `How do I find games?` → `Use [Browse](/browse) to search, filter by tag and sort, or check the shelves on the home page. [Creators](/creators) lists the people who make them.` · `What are leaderboards?` → `Games can submit scores to daily, weekly and all-time boards, shown on the game page. Sign in so your scores count.` |
   | `controls` | `Controls and gamepads` | `How do I see or change a game's controls?` → `Press the ⌨ button under the player to open the controls panel. You can rebind keys and gamepad buttons; signed-in players keep their bindings on every device.` · `My gamepad doesn't work.` → `Press a button while the game has focus. Browsers only expose gamepads after a press, and some block them on plain http addresses.` |
   | `saves` | `Saves and progress` | `Are my saves kept?` → `Games that save progress keep it in your browser. When you're signed in, saves (up to 256 KB per game) sync to your account.` |
   | `uploading` | `Making and uploading games` | `How do I make a game?` → `Start in [the Studio](/studio) from a template, or read [the creator docs](/docs) to build one yourself.` · `What can I upload?` → `A .zip of up to 50 MB with a game.json at its root. [Upload it](/upload) as a draft, then publish it when it's ready.` · `How do I update a game?` → `Replace the bundle from the game's Edit page, or publish an update from the Studio, and add release notes so players know what changed.` |
   | `screenshots` | `Screenshots` | `How do I take a screenshot?` → `Press 📷 under the player (or Ctrl+Shift+S in the desktop app). You can download it, copy it or post it to the game page.` |
   | `collections` | `Collections` | `What are collections?` → `Ordered lists of up to 100 games with notes. Public ones appear on your profile and on the games' pages; private ones are only for you. Use + Collection on any game page.` |
   | `posts` | `Posts, comments and notifications` | `Who sees my posts?` → `Posts are public on your profile and appear in your followers' feeds.` · `How do I control notifications?` → `Turn kinds on or off in [Settings](/settings), and mute a game or a thread from its page.` |
   | `reporting` | `Reporting and safety` | `How do I report something?` → `Use Report on the game, comment, post, reply, screenshot, collection or profile. Reports are private: only moderators see them, and they review every one.` · `Is it safe to play games here?` → `Games run in sandboxed frames that can't reach your account, cookies or other pages.` |
   | `desktop` | `The desktop app` | `What does the desktop app add?` → `Native menus and shortcuts, fullscreen with F11, native file dialogs, opening local game folders in the Studio and optional system notifications.` · `How do I connect to a different server?` → `Open Settings in the desktop app and change the server address.` |
   Content tests assert topic ids, h2 texts, question texts, link texts and link targets. Answer wording may be copy-edited in review without a spec change, as long as no claim becomes untrue and link texts and targets stay.
4. **Deep links:** `helpPath(topic?: HelpTopicId): string` → `/help` or `/help?topic={id}`. On mount and whenever `?topic=` changes, if the value is a known id, the page jumps to `#help-{id}` in a `setTimeout(…, 0)` (so it runs after `Layout`'s scroll-to-top effect for the route change): `scrollIntoView({ block: "start", behavior })` with `behavior` `"auto"` under `prefers-reduced-motion: reduce` and `"smooth"` otherwise (the `DocsPage` `jumpTo` rule), then `focus({ preventScroll: true })`. Unknown or empty values are ignored (the page stays at the top). The timer is cleared on unmount. This works under both routers (the hash router keeps `?topic=` inside the hash).
5. Last: `<p className="pf-muted">Still stuck? <Link to="/help?topic=reporting">Report a problem</Link> from the page where it happens.</p>`.

### 0.12 Smaller links
- `NotFoundPage`: a second action after `Back to the arcade`: `<Link to="/help" className="pf-btn pf-btn--ghost">Get help</Link>`.
- `UploadPage` description gains a sentence: `New here? Read <Link to="/docs">Make a game</Link>, or see <Link to="/help?topic=uploading">upload help</Link>.` (replacing `New here? Read Make a game.`).

### 0.13 Desktop menu
- Help menu becomes, in order: `&Help and FAQ` (id `"help"`, forwarded → `/help`), `&Make a game` (id `"docs"`, unchanged), separator, `&About Pixelforge Arcade` (id `"about"`, now **forwarded** → `/about`). No accelerators (F1 would be a bare key; the `f11_is_the_only_bare_accelerator` test forbids it).
- The native About message dialog is removed; the version and server move to `/about`'s `This app` section through `PlatformConfig.aboutExtra` (§ 0.10.3). Its body, exactly:
  ```html
  <p>Pixelforge Arcade Desktop {version}</p>
  <p>Server: <code>{server}</code> · <a href="#/settings">Change in Settings</a></p>
  ```
  `{version}` is `tauri.conf.json`'s `version`; `{server}` is `useServer().server`. The link is a router `Link` to `/settings`.

## 1. Goal and user stories
Goal: every page is reachable in at most two clicks from any page on any screen size, each link has one obvious home, and new visitors can find out what the site is and get answers without leaving it.

- As a phone visitor, I open ☰ and see every section grouped (Explore, Create, You, Pixelforge Arcade), with search at the top, and I can close it with ✕, Escape or by tapping outside.
- As a keyboard or screen-reader user, the menu sheet traps focus while open and returns me to the ☰ button; the account menu works with arrow keys; the current page is announced in navs and breadcrumbs.
- As a signed-in player, the header shows the four destinations I use (Browse, Creators, Feed, Studio) and my personal pages live in my account menu, without duplicates.
- As a creator on an Edit or Stats page, breadcrumbs take me back to My games or the game in one click.
- As a new visitor, the footer leads me to About and Help; the Help page answers how to play, make, upload, share and report, and other pages can deep-link a topic.
- As a desktop user, Help → Help and FAQ and Help → About open those pages, and About shows the app version and the server I'm connected to.
- As anyone, a network failure says "Can't reach the server" instead of a raw error.

## 2. UX notes
- No new visual language: existing tokens, `pf-btn`, `pf-panel`, `pf-iconbtn`, `pf-muted`, `pf-small`. The sheet uses `--pf-bg-2` with `--pf-border` on its left edge and `--pf-shadow-lg`; group labels look like `.pf-eyebrow` (mono, uppercase, muted, not accent).
- The sheet's active link uses the same style as the wide nav's `.active` (surface-3 background).
- Footer: muted 0.88 rem text (existing), headings 0.76 rem uppercase mono; link rows 6 px apart; touch rows 32 px min height under 860 px.
- Breadcrumbs sit above the page title in small muted text, with `›` separators.
- About and Help are narrow (`pf-narrow`, 820 px) reading pages; Help's TOC is a panel with two columns of links above 640 px and one below.
- Nothing animates for users who ask for reduced motion.

## 3. Contract changes (summary; normative text lives in docs/)
- **API.md § F034 additions:** web routes `/about` and `/help?topic={id}` with the topic id list. No endpoints, no type changes, no status codes.
- **ARCHITECTURE.md § F034 additions:** `PlatformConfig.aboutExtra?: ReactNode`; new UI modules (`nav.ts`, `MenuSheet.tsx`, `PageHeader.tsx`, `PageStates.tsx`, `AboutPage.tsx`, `HelpPage.tsx`) and exports; header/footer structure; desktop menu ids `"help"` and `"about"` forwarded; the native About dialog removed.
- **GAME_FORMAT.md § F034 additions:** none.

## 4. Per-area tasks

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **`src/nav.ts`** (new, pure; no React):
   - `type NavItem = { id: string; label: string; to: string; when?: "signedIn" | "admin" | "collections" }`;
   - `MAIN_NAV: readonly NavItem[]` = `browse`, `creators`, `feed` (`signedIn`), `studio` (§ 0.2.1);
   - `SHEET_GROUPS` = `explore` (`browse`, `creators`, `feed`), `create` (`studio`, `docs` `Make a game`, `upload` `Upload a game` `signedIn`), `arcade` (`about`, `help`) with labels from § 0.5.3;
   - `ACCOUNT_ITEMS: readonly NavItem[]` = `profile` `/me`, `dashboard` `My games`, `favorites`, `collections` (`collections`), `settings`, `admin` `Moderation` (`admin`) (§ 0.3.1);
   - `visibleItems(items, { signedIn, admin, collections }): NavItem[]`;
   - `FOOTER_COLUMNS: readonly { key: "play" | "create" | "arcade"; label: string; links: readonly { label: string; to: string; exact: boolean }[] }[]` (§ 0.6.2; `exact: false` only for `Report a problem`, meaning a plain `Link`);
   - `accountLinkCurrent(id: string, pathname: string, username: string): boolean` (§ 0.7);
   - `HELP_TOPIC_IDS = ["account", "playing", "controls", "saves", "uploading", "screenshots", "collections", "posts", "reporting", "desktop"] as const`, `type HelpTopicId`, `isHelpTopicId(x: unknown): x is HelpTopicId`, `helpPath(topic?: HelpTopicId): string`.
2. **`src/components/Layout.tsx`:**
   - `Header`: § 0.2 and § 0.4 (render `#pf-mainnav` only when wide; toggle + sheet only when narrow; delete `navOpen`'s dropdown behaviour and the `is-open` class). The sheet's open state lives in `Header`; it closes on `location.pathname`/`location.search` change and when `collapsed` turns false.
   - `UserMenu`: § 0.3 (items from `ACCOUNT_ITEMS`, keyboard, `aria-controls`, focus return, `aria-current`).
   - `Footer`: § 0.6 (from `FOOTER_COLUMNS`).
   - `RequireAuth`: `PageLoading` (§ 0.8).
   - Keep `HEADER_COLLAPSE_QUERY`, `useMediaQuery`, `Logo`, `SearchBox` and the skip link as they are.
3. **`src/components/MenuSheet.tsx`** (new): `MenuSheet({ onClose }: { onClose: () => void })`, § 0.5, using `useModal<HTMLDivElement>(true, onClose)`, `useAuth`, `useCollectionsSupported`, `visibleItems`, `accountLinkCurrent`. It owns the scroll lock (§ 0.5.6). `Log out` calls `onClose()` then `logout()`.
4. **`src/components/PageHeader.tsx`** (new): `PageHeader`, `Breadcrumbs`, `Crumb`, `PageHeaderProps` (§ 0.9).
5. **`src/components/PageStates.tsx`** (new): `PageError`, `PageLoading` (§ 0.8.3–4).
6. **`src/components/common.tsx`:** `EmptyState` `headingLevel`; `ErrorState` network title and `headingLevel` (§ 0.8.1–2).
7. **Page migrations**, exactly the table in § 0.8, plus § 0.9.4 breadcrumbs and § 0.12 links: `GamePage.tsx`, `GameStatsPage.tsx`, `EditGamePage.tsx`, `PostPage.tsx`, `CollectionPage.tsx`, `ProfilePage.tsx`, `FollowListPage.tsx`, `FavoritesPage.tsx`, `DashboardPage.tsx`, `SettingsPage.tsx`, `UploadPage.tsx`, `AdminPage.tsx`, `NotificationsPage.tsx` (loading only), `NotFoundPage.tsx`.
8. **`src/pages/AboutPage.tsx`** (new, § 0.10) and **`src/pages/HelpPage.tsx`** (new, § 0.11; exports `HELP_TOPICS: readonly { id: HelpTopicId; title: string; entries: readonly { q: string; a: ReactNode }[] }[]`).
9. **`src/context/config.tsx`:** `PlatformConfig.aboutExtra?: ReactNode` with the doc comment `F034: extra content for /about's "This app" section (desktop: version and server).`
10. **Routing** (`src/WebGameApp.tsx`): `<Route path="about" element={<AboutPage />} />` and `<Route path="help" element={<HelpPage />} />`, public, next to `docs`.
11. **Styles** (`styles.css`): `.pf-sheet-backdrop`, `.pf-sheet` (+ `__head`, `__title`, `__me`, `__group`, `__foot`), `.pf-footer__brand`, `__nav`, `__col`, `__heading`, `.pf-breadcrumbs` (+ `__sep`), `.pf-pagehead__actions`, `.pf-about`, `.pf-help`, `.pf-help__toc`; the 1100/860/480 px rules and the `prefers-reduced-motion: no-preference` block of § 0.5.8; remove the dead `.pf-header__nav.is-open` and narrow dropdown rules. Existing tokens only.
12. **Exports** (`src/index.ts`): `PageHeader`, `Breadcrumbs`, `PageError`, `PageLoading`, `AboutPage`, `HelpPage`, `HELP_TOPICS`, every `nav.ts` export, and the types `Crumb`, `PageHeaderProps`, `NavItem`, `HelpTopicId`.
13. **README** (`packages/ui/README.md`): routes table rows for `/about` and `/help?topic=`; the header/footer description; the new exports; `PlatformConfig.aboutExtra`.
14. **Tests** (§ 6). Update suites whose expectations move: `NotificationBell.test.tsx` (narrow case: the anonymous `Log in` doesn't apply when signed in; the toggle is still the bell's next sibling), `ProfileCollections.test.tsx` (unchanged expectation, re-run), any test that relied on `Admin`, `My games`, `Favorites` or `Make a game` in the header nav, or on `← {title}` / `‹ Back to profile`.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`, `npm test -w @webgame/desktop`.

### desktop-dev (`apps/desktop/**`)
1. **`src-tauri/src/menu.rs`:**
   - Help submenu per § 0.13: `item(app, "help", "&Help and FAQ")`, the existing `docs` item, separator, `item(app, "about", "&About Pixelforge Arcade")`.
   - Add `"help"` and `"about"` to `FORWARDED`; remove the `"about"` arm of `handle` (the dialog) and the then-unused `tauri_plugin_dialog::DialogExt` import in this file; update the module doc.
   - Unit test `help_and_about_are_forwarded_without_accelerators` (both in `FORWARDED`, `accelerator(id) == None`, absent from `ACCELERATORS`), following the F032 one.
2. **`src/nativeMenu.ts`:** `ROUTES.help = "/help"`, `ROUTES.about = "/about"`; update the doc comment.
3. **`src/appInfo.ts`** (new): `APP_VERSION: string` parsed from `../src-tauri/tauri.conf.json?raw` (the `version` field; `"unknown"` if missing).
4. **`src/DesktopAbout.tsx`** (new): `DesktopAbout()` renders the § 0.13 body using `APP_VERSION` and `useServer()`.
5. **`src/App.tsx`:** `platform.aboutExtra: <DesktopAbout />` (always, also in a plain browser: it only shows text and a link).
6. **`src/__tests__/nativeMenu.test.ts`:** `"help"` → `#/help`, `"about"` → `#/about`.
7. **`src/__tests__/f034.desktop.test.tsx`** (the `f035.desktop.test.tsx` pattern: real `App`, hash router, `SERVER_STORAGE_KEY` = `http://192.168.1.5:8080`, mocked `fetch`). Assert:
   - `#/about` shows the h2 `This app`, `Pixelforge Arcade Desktop {version}` with the version from `tauri.conf.json`, and `http://192.168.1.5:8080` inside a `code` element; the `Change in Settings` link has `href="#/settings"`;
   - the footer's `About` and `Help` links have `href="#/about"` and `href="#/help"`, `Report a problem` has `href="#/help?topic=reporting"`;
   - `#/help?topic=controls` focuses the h2 `Controls and gamepads` (`id="help-controls"`);
   - the `app-menu` events `"help"` and `"about"` navigate to `#/help` and `#/about`.
8. **`apps/desktop/README.md`:** Help menu line → `Help → Help and FAQ (#/help), Make a game (#/docs), About (#/about: version and server)`.

**Acceptance:** `npm run build -w @webgame/desktop`, `npm test -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test` and `cargo clippy --all-targets -- -D warnings`.

### backend-dev
None. Not dispatched. (`/about` and `/help` are served by the existing SPA fallback when `WEB_DIST` is set.)

### engine-dev
None.

### Docs (project-manager, after the round)
- README "Features": a line for navigation ("a grouped header, a mobile menu, breadcrumbs on edit/stats/follow pages, and About and Help pages"); Desktop line: Help → Help and FAQ, About.
- ROADMAP: F034 and F037 → shipped.

### Sequencing
- frontend-dev first (or in parallel for the Rust part): desktop-dev's `menu.rs` and `nativeMenu.ts` changes can start at once; `DesktopAbout` and `f034.desktop.test.tsx` need the built `@webgame/ui` with `PlatformConfig.aboutExtra` and the new routes.

## 5. Edge cases and security
- **No new data or endpoints.** About and Help are static React content: no `dangerouslySetInnerHTML`, no markdown, no remote fetch. `aboutExtra` is a host-provided React node (trusted, like `extraSettings`).
- **`?topic=`** is matched against a fixed id list before use; it never reaches the DOM as a selector or HTML, so `?topic=<img onerror>` or `?topic=a"],[x` does nothing.
- **Focus trap leaks.** The sheet uses the shared `useModal` stack, so a `ConfirmDialog` opened from inside it (none today) would stack correctly; the bell panel can't open while the sheet traps focus.
- **Breakpoint flips while open** (rotate a tablet): the sheet closes, the scroll lock is released and the wide header renders; no orphaned `overflow: hidden`.
- **Route change from outside** (desktop menu event, browser Back): the sheet closes because `location` changed.
- **Signed out while the sheet is open** (logout in another tab): the sheet re-renders with the anonymous content.
- **Very long names and titles:** the user-menu name is ellipsised (existing), breadcrumb crumbs truncate at 28ch with the full text in `title`, the sheet's account row ellipsises both lines.
- **Old servers:** nothing changes server-side; `Collections` stays hidden when `useCollectionsSupported()` is false (both the menu and the sheet).
- **Desktop:** removing the native About dialog removes the only Rust use of the dialog plugin in `menu.rs`; the plugin stays registered for `save.rs`/pickers. No capability changes (the `?raw` import is bundled at build time; no `core:app:*` permission is needed).

## 6. Test expectations

### Frontend (vitest)
- **`nav.test.ts`:** `visibleItems(MAIN_NAV, …)` anonymous → `Browse, Creators, Studio`; signed in → `Browse, Creators, Feed, Studio`; `ACCOUNT_ITEMS` for a user without collections support → `Profile, My games, Favorites, Settings`; admin with support → `Profile, My games, Favorites, Collections, Settings, Moderation`; `FOOTER_COLUMNS` labels, links and hrefs in § 0.6.2 order; `accountLinkCurrent` (`profile` on `/u/Mia` for `mia`, `/u/mia/posts`, `/me`; not on `/u/mia/collections` or `/u/bob`; `collections` on `/u/mia/collections` and `/collections`; `settings` on `/settings` only); `helpPath()` → `/help`, `helpPath("controls")` → `/help?topic=controls`; `isHelpTopicId`.
- **`Layout.f034.test.tsx`** (wide = no `matchMedia`):
  - nav link texts and hrefs per auth state; no `Make a game`, `My games`, `Favorites` or `Admin` in `nav[aria-label=Main]`;
  - no href appears both in the main nav and in the open user menu;
  - user menu items and order (user and admin), `Log out` last after a separator;
  - keyboard: `ArrowDown` on the button opens and focuses `Profile`; `ArrowUp` opens and focuses `Log out`; `ArrowDown` from `Log out` wraps to `Profile`; `Home`/`End`; `Escape` closes and focuses the button; `Tab` closes;
  - `aria-current="page"` on `Settings` at `/settings` and on `Profile` at `/u/{me}`; on the nav `Browse` at `/browse?sort=top`;
  - no ☰ button and no `#pf-menu-sheet` when wide;
  - footer: the three column labels, links in order with hrefs, `Report a problem` without `aria-current` on `/help`, `Help` with `aria-current="page"` on `/help`; brand text with `platform.name`.
- **`MenuSheet.test.tsx`** (stub `matchMedia` so `(max-width: 860px)` matches):
  - ☰ has `aria-haspopup="dialog"`, `aria-expanded="false"` and no `aria-controls` closed; after a click, `aria-expanded="true"`, `aria-controls="pf-menu-sheet"`, a `dialog` named `Menu` with `aria-modal="true"`, focus on `Close menu`;
  - content order: search, account link (signed in), `Explore`, `Create`, `You`, `Pixelforge Arcade`, `Log out`; anonymous: no `You`, `Log in`/`Sign up` with `next`; admin sees `Moderation`;
  - Tab from the last control goes to `Close menu`; Shift+Tab from `Close menu` goes to the last control;
  - `Escape`, `Close menu` and a backdrop mousedown each close it and focus ☰; a mousedown inside the sheet doesn't close;
  - clicking `Creators` navigates to `/creators` and closes it; submitting `dodge` in its search goes to `/browse?q=dodge` and closes it;
  - flipping the media query to wide closes it and removes it from the DOM;
  - `document.documentElement.style.overflow` is `hidden` while open and restored after;
  - narrow header row: anonymous shows `Log in` before ☰; signed in shows the bell before ☰ (the existing `NotificationBell` narrow test still holds); `#pf-mainnav` is absent.
- **`PageHeader.test.tsx`:** `Breadcrumbs` renders `nav[aria-label=Breadcrumb] > ol`, links for all but the last, the last with `aria-current="page"` and no link, separators `aria-hidden`, `title` on truncatable crumbs, `null` for one item; `PageHeader` with `actions` has `pf-pagehead--row` and `.pf-pagehead__actions`; `headingRef` gives the h1 `tabIndex=-1`.
- **`PageStates.test.tsx`:** `PageError` with a 404 `ApiError` renders the `NotFoundPage` h1 for `what`; with a 500 renders `Something went wrong` (h2) and `Try again` calling `onRetry`; `ErrorState` with `new ApiError("network", "down", 0)` shows `Can't reach the server` and `Check your connection and try again.`; `EmptyState headingLevel={2}` renders an h2 and omitted renders an h3; `PageLoading` has `aria-busy="true"` and a `status` named by `label`.
- **Migrated pages:** extend an existing test per page: `EditGamePage` and `GameStatsPage` breadcrumbs (`My games` → `/dashboard`, title → `/games/{id}`, current `Edit`/`Stats`); `FollowListPage` breadcrumb (`{name}` → profile, current `Followers`/`Following`) and no `Back to profile`; `GamePage`/`PostPage`/`CollectionPage`/`ProfilePage` 404s still show the not-found page; `FavoritesPage` empty title is an h2.
- **`AboutPage.test.tsx`:** h1 `Pixelforge Arcade`, the four h2s in order, every link target in § 0.10.2; no `This app` without `aboutExtra`; with `aboutExtra` (`<p>v9</p>`) the section and text render; document title `About · Pixelforge Arcade`.
- **`HelpPage.test.tsx`:** h1 `Help`; ten h2s in `HELP_TOPICS` order with `id="help-{id}"`; the TOC links point at `/help?topic={id}`; every link target named in § 0.11.3; `/help?topic=reporting` focuses `#help-reporting` after the timer (fake timers or `waitFor`) and calls `scrollIntoView` with `behavior: "auto"` when `matchMedia("(prefers-reduced-motion: reduce)")` matches and `"smooth"` otherwise; `/help?topic=nope` focuses nothing; clicking a TOC link replaces the URL and moves focus.
- **`NotFoundPage`:** `Get help` → `/help`. **`UploadPage`:** `upload help` → `/help?topic=uploading`.
- The F032 and F035 Layout suites pass unchanged.

### Desktop
As listed in § 4 desktop-dev, plus the `menu.rs` unit test.

### Manual end to end
1. At 1280 px signed in: header shows Browse, Creators, Feed, Studio, search, bell, + Upload and the avatar menu; the menu has Profile … Log out with no item repeated from the nav. Arrow keys move through it, Escape returns to the avatar.
2. At 1000 px the name next to the avatar disappears; a screen reader still reads it.
3. At 375 px: the row shows logo, bell, ☰. Open ☰: focus is on ✕, Tab cycles inside, the page behind doesn't scroll, Escape closes and focus is back on ☰. Tap Creators: the page opens and the sheet is gone.
4. With "reduce motion" on, the sheet appears without sliding.
5. Footer at 375 px: brand on top, two columns of links. `Report a problem` opens Help scrolled to "Reporting and safety".
6. Edit a game: the breadcrumb reads `My games › {title} › Edit`; the title crumb opens the game.
7. Turn the server off and open a game: "Can't reach the server" with Try again.
8. Desktop: Help → Help and FAQ opens `/help`; Help → About opens `/about` with the version and the configured server.

# F004: Version changelogs and an "Updated" badge

Status: **specced**. Size: **S** (backend + frontend, one round). Areas: backend, frontend. Engine: no changes. Desktop: verification only.
Contracts: `docs/API.md` § F004 additions, `docs/GAME_FORMAT.md` § F004 additions, `docs/ARCHITECTURE.md` § F004 additions.
Depends on: F002 (shipped: `activity_events`, `gameUpdated`) and the review-fix bundle replace serialisation (REVIEW-2026-11-14-1 R1: per-game `bundle_locks` claim plus the `WHERE id = ? AND version = ?` check). Migration `0007_f004.sql` runs after F003's `0006_f003.sql`. See "Sequencing".

## 1. Goal and user stories
A bundle replace today is silent. The version number goes up, F002 tells followers "updated to v4", and nobody can tell what changed. Players have no reason to replay an updated game, and creators have no channel to say "new level added" except editing the description. F004 adds:
- **Release notes**: every bundle replace (and the first upload) can carry a short plain-text "What's new" note, stored per version. Owners can fix a note later.
- **Version history** on the game page: the latest note up front, and the full list of versions with dates and notes.
- **An "Updated" badge** on game cards for 7 days after a bundle replace of a published game.
- **Richer feed items**: F002's `gameUpdated` items carry the notes of the version(s) they cover, including versions merged by the 24h coalescing.
- **Safe concurrent edits**: the replace form sends the version it was based on (`expectedVersion`), so an owner with two tabs open gets a clear 409 instead of silently overwriting a newer upload.

User stories:
1. As a creator, I replace my bundle from the game page or the edit page, type "Added 3 new levels and fixed the jump bug" in a "What's new" box, and upload. The game page shows "v5 · Updated just now" with my note.
2. As a player browsing the home page, I see an "Updated" badge on Pixel Peaks, which I played last month, and replay it.
3. As a follower, my feed says "Ana updated Pixel Peaks to v5" with the note quoted underneath. If Ana pushed v4 and v5 the same evening, I see one item "updated Pixel Peaks to v5 (2 updates)" with both notes.
4. As a player on a game page, I open "Version history" and see every version since F004 shipped, newest first, with dates and notes.
5. As a creator who made a typo in a note, I edit it from the history list; the game page and my followers' feed show the corrected text, and nobody is notified again.
6. As a creator with the edit page open in two tabs, my second upload fails with "This game was updated to v6 since you opened this page. Reload and try again." instead of replacing v6 unseen.

Non-goals (later items): rolling back to an old bundle (old version files are deleted after a replace, as today), Markdown or links in notes, semantic version strings ("1.2.0"), per-version play stats, a `sort=updated` listing, notifications (F007), and Studio "publish as update" (new backlog item F013).

## 2. UX notes
- **Replace-bundle flows** (both existing flows gain the same fields):
  - **Edit page** (`EditGamePage.tsx`, the "Current bundle" section): below the `FileDrop`, a `<textarea>` labelled "What's new in this version (optional)", `maxLength=1000`, 4 rows, with a live counter "{n}/1000" shown from 900 chars. The upload button stays disabled until a bundle is chosen. The request sends `notes` and `expectedVersion = game.version` (the version the page loaded or last received).
  - **Game page owner panel** (`GamePage.tsx`, `OwnerPanel`): "⬆ Replace bundle" still opens the file picker (`platform.pickFile` on desktop). After a valid zip is picked, a small modal (`useModal`) shows the file name, the same "What's new" textarea and **Upload** / **Cancel**. Upload sends `notes` and `expectedVersion`.
  - On success: toast "Version {v} is live" and the panel/page shows the new `Game` (with its `latestVersion`). The textarea clears.
  - On **409** `conflict`: an inline error "This game was updated to a newer version since you opened this page. Reload and try again." with a **Reload** button that refetches the game (and keeps the chosen file and typed notes). The same copy covers both causes of a 409: a stale `expectedVersion` and a concurrent upload losing the R1 race.
  - On **422** with a notes message: show it under the textarea.
- **Upload page** (`UploadPage.tsx`, new games): an optional "Release notes (optional)" textarea (same limits), collapsed behind a "+ Add release notes" link to keep the form short. Sent as `notes`.
- **Game page "What's new"** (`GamePage.tsx`, new component `packages/ui/src/components/VersionHistory.tsx`):
  - Placed in the main column **between the header/description and `Comments`**, as a `pf-panel` `<section aria-labelledby>` with heading "What's new", `id="versions"` (so `/games/{id}#versions` scrolls to it; the feed links there).
  - Header line: "v{latestVersion.version} · {lastUpdatedAt ? "Updated " + timeAgo(lastUpdatedAt) : "Released " + formatDate(latestVersion.createdAt)}".
  - Body: `latestVersion.notes` rendered as plain text with `white-space: pre-wrap` (never as HTML, never auto-linked). Empty notes: muted "No release notes for this version."
  - Hide the whole panel when `version === 1` **and** `latestVersion.notes === ""` (nothing to say).
  - A "Version history" disclosure button (`aria-expanded`) lazily loads `GET /api/games/{id}/versions` (20 per page, "Show older" button while more pages exist). Each row: "v{version}", `formatDate(createdAt)` with `title` = full timestamp, notes (pre-wrap) or the muted empty text, and a "Current" chip on `current: true`.
  - When the last page is loaded and the oldest row's `version > 1` (history starts after v1 for games older than F004), the list ends with a muted line "Earlier versions were published before release notes existed."
  - **Owner editing**: each row has an "Edit" ghost button (owner only). It swaps the notes for a textarea (same limits) with Save / Cancel. Save calls `PATCH …/versions/{version}`, updates the row in place, and, when it is the current version, also updates `game.latestVersion` via the page's `onUpdated`. 429 → toast "Slow down — try again in {retryAfter}s".
- **"Updated" badge** (`GameCard.tsx`):
  - Helper `isRecentlyUpdated(game: Pick<GameSummary, "lastUpdatedAt">, now = Date.now()): boolean` in `packages/ui/src/util.ts`: true when `lastUpdatedAt` is a valid timestamp and `0 <= now − lastUpdatedAt < 7 days` (`UPDATED_BADGE_MS = 7 * 24 * 3600 * 1000`, exported). A timestamp slightly in the future (clock skew, up to 5 minutes) also counts as recent.
  - The card shows a `pf-badge pf-badge--updated pf-card__badge` "Updated" pill over the thumbnail, with `title="Updated {timeAgo(lastUpdatedAt)}"`. It sits next to the existing "Draft" badge position; when both would show (owner dashboards), show "Draft" only.
  - Older servers don't send `lastUpdatedAt`: treat `undefined` as `null` (no badge), like `playsWeek`.
  - The badge shows in every grid (home, trending shelf, related, profile, favorites, dashboard). It doesn't change the F003 `highlight` meta lines.
- **Game page header**: next to the existing `v{version}` text in the owner panel nothing changes. For everyone, the "Game info" side panel gains a row "Updated {formatDate(lastUpdatedAt)}" when `lastUpdatedAt` is non-null.
- **Feed item** (`FeedItem.tsx`), `gameUpdated` only:
  - Sentence: when `update.fromVersion < version`: "**{actor}** updated **{game}** to v{version} ({version − fromVersion + 1} updates)"; otherwise unchanged ("…to v{version}").
  - Under the sentence, for each entry of `update.changes` (newest first, at most 3 from the server): a muted "v{n}:" prefix and the notes clamped to 3 lines (`-webkit-line-clamp`), plain text. When the item has no changes with notes, render nothing extra.
  - A "What's new →" link to `/games/{id}#versions` when `changes` is non-empty.
  - `update` may be absent (older server): render exactly as F002 does today.
- **Docs page** (`DocsPage.tsx`): a short "Release notes" paragraph in the creator section: where to type them, the 1000-char plain-text limit, the 7-day "Updated" badge, and that followers and players who favorited the game see the note in their feed.

## 3. Contract changes (summary; normative text lives in docs/)
- **API**:
  - `PUT /api/games/{id}/bundle` multipart gains optional `notes` and `expectedVersion` fields. Mismatch → 409.
  - `POST /api/games` multipart gains optional `notes` (version 1's notes).
  - `GameSummary` gains `lastUpdatedAt: string | null`; `Game` gains `latestVersion: GameVersion`.
  - `GET /api/games/{id}/versions` → `Page<GameVersion>`; `PATCH /api/games/{id}/versions/{version}` (owner) → `GameVersion`.
  - `FeedItem` gains `update: FeedUpdate | null`.
  - New rate-limit bucket `VersionNotes` (30 per 10 min per user).
- **Game format**: no bundle, `game.json`, engine or message change. Documents release notes and the badge for creators.
- **Architecture**: migration `0007_f004.sql` (`game_versions`, `games.last_updated_at`, `activity_events.from_version`), the version row written in the same transaction as the R1-guarded version bump, and the feed's batched notes lookup.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Migration** `backend/migrations/0007_f004.sql` (exact SQL in ARCHITECTURE § F004):
   - `game_versions` table, primary key `(game_id, version)`, `ON DELETE CASCADE` from `games`.
   - `games.last_updated_at TEXT` (nullable).
   - `activity_events.from_version INTEGER` (nullable).
   - Backfill: one `game_versions` row per existing game for its **current** version (empty notes), and `last_updated_at` from the latest `gameUpdated` event, as specified.
2. **Notes parsing** (a helper in `routes/games.rs` or a new `backend/src/versions.rs`): `parse_notes(raw: &str) -> AppResult<String>`:
   - Normalise `\r\n` and lone `\r` to `\n`, then trim leading/trailing whitespace.
   - Reject (422 `validation`, message "notes must be at most 1000 characters") when longer than **1000 chars** (Unicode scalar values) after normalisation.
   - Reject (422, "notes contain invalid characters") any control character other than `\n` and `\t` (`char::is_control`), and any of the bidi override/isolate characters U+202A–U+202E, U+2066–U+2069.
   - Collapse runs of more than 2 consecutive blank lines to 2 (no error).
   - Missing field = `""`.
3. **`games.rs::create_game_record`** (and the `POST /api/games` multipart parser): accept an optional `notes` field (parsed as above, before any file is written). Insert `game_versions (game_id, 1, notes, created_at = game created_at)` in the **same transaction** as the game row. `last_updated_at` stays NULL. Seeded games go through this path and get an empty note.
4. **`games.rs::upload_bundle`** (keep the R1 structure exactly; additions only):
   - The multipart loop also reads `notes` (text, ≤ 8 KB raw before parsing, else 422) and `expectedVersion` (text). Unknown fields stay ignored. Field order is free.
   - `expectedVersion`: when present it must parse as a positive integer, else **400** `bad_request` "expectedVersion must be a positive integer". Validate notes and `expectedVersion` **before** claiming the lock and before extraction.
   - After `try_claim` and the current-version read: when `expectedVersion` is present and `!= current`, return the existing **409** `conflict` (message "The game is at v{current}; reload and retry"). Without `expectedVersion`, behaviour is unchanged (the existing `game.version` check still applies).
   - Inside the existing transaction, after the guarded `UPDATE games SET version = ? … WHERE id = ? AND version = ?` succeeds (`rows_affected == 1`) and after `sync_achievements`:
     - `INSERT INTO game_versions (game_id, version, notes, created_at) VALUES (?, new_version, notes, now)`. Use `INSERT OR REPLACE` (a leftover row for `new_version` can only come from a crashed attempt whose version bump never committed, which is impossible in one transaction, but be defensive). This insert is **not** best effort: a failure fails the request and rolls back, like the version bump.
     - When `game.published`: `UPDATE games SET last_updated_at = now WHERE id = ?` in the same transaction, then call `activity::record_game_updated` as today.
     - The `updated_at` bind and `now` for `game_versions.created_at` and `last_updated_at` must be the **same** timestamp value.
   - On the `Ok(false)` path (lost the race) nothing new is written (the transaction is dropped).
5. **`games.rs::update_game`** (PATCH metadata/publish): no change to `last_updated_at`. Publishing an unpublished game does **not** set it (a game updated while it was a draft is not "Updated" when it is first published, and re-publishing does not badge it).
6. **`activity.rs::record_game_updated`**: carry `from_version`.
   - Change the coalescing `DELETE` to `DELETE … RETURNING COALESCE(from_version, version)` and take the minimum of the returned values (if any).
   - Insert the new row with `from_version = min(returned..., new_version)`; when nothing was coalesced, `from_version = new_version`.
   - Keep everything else (24h window, best effort, nested transaction).
7. **Models** (`models.rs`):
   - `GAME_SELECT` adds `g.last_updated_at`; `GameRow`/`GameSummary` gain `last_updated_at: Option<String>` serialised as `lastUpdatedAt`. Every `GameSummary` (listings, profile, favorites, feed, related, `Game`) carries it.
   - `Game` gains `latest_version: GameVersion` (`latestVersion`), loaded in `build_game` by primary key `(id, version)`. If the row is missing (should not happen), synthesise `{ version, notes: "", createdAt: updated_at, current: true }`.
   - `GameVersion { version: i64, notes: String, created_at: String, current: bool }`.
8. **New handlers** (`backend/src/routes/versions.rs`, registered in `routes/mod.rs`):
   - `list_versions` 🔓 `GET /api/games/{id}/versions?page&perPage`: visibility via the same rule as `GET /api/games/{id}` (unknown → 404; unpublished → 404 unless owner). `parse_paging(page, perPage, 20)` (max 100). `ORDER BY version DESC`. `current = (version == games.version)`.
   - `update_version_notes` 🔒 owner `PATCH /api/games/{id}/versions/{version}` body `{ notes: string }`: `fetch_owned_game` (404/403 as other owner routes), `limit_user(Limit::VersionNotes)`, path `version` must be a positive integer (else 400), `notes` parsed per task 2 (a missing or non-string `notes` → 422). Unknown version row → 404 `not_found` "Version". Updates only `notes`; never touches `last_updated_at`, `updated_at` or activity events. Returns the updated `GameVersion`.
9. **`ratelimit.rs`**: `Limit::VersionNotes` = 30 per 10 min, per user. Bundle replaces keep `Limit::Upload`.
10. **`routes/feed.rs`**: `FeedItem.update` for `gameUpdated` rows:
    - `fromVersion = COALESCE(e.from_version, e.version)`.
    - `changes`: after loading the page, run **one** batched query: `SELECT game_id, version, notes FROM game_versions WHERE game_id IN (…page gameUpdated game ids…) AND notes <> ''`, then, per item, keep versions in `[fromVersion, version]`, newest first, at most **3**. Notes are read at feed time, so edits show up immediately.
    - `update` is `null` for the other kinds.
11. **Tests** `backend/tests/f004.rs`:
    - Create with `notes` → `latestVersion` v1 has the note; `lastUpdatedAt` null; `/versions` has one row, `current: true`.
    - Replace with notes → v2 row, `latestVersion.notes`, `lastUpdatedAt` set and equal to `latestVersion.createdAt`; `/versions` newest first with `current` flags; paging.
    - Notes validation: 1000 chars OK, 1001 → 422; CRLF normalised; trimmed; a NUL or U+202E → 422; 3+ blank lines collapsed; a missing field → `""`.
    - `expectedVersion`: equal → 200; stale → 409 and no version row, no files changed (`v{n}` dir unchanged), no feed event; `"abc"`/`"0"` → 400 before any extraction; absent → v1 behaviour.
    - The R1 race stays intact: two concurrent replaces (existing review-fix test pattern) → one 200, one 409, exactly one new `game_versions` row.
    - Replace of an **unpublished** game → version row written, `lastUpdatedAt` stays null, no `gameUpdated`; publishing afterwards does not set `lastUpdatedAt`.
    - Metadata PATCH (title) does not change `lastUpdatedAt`.
    - `PATCH …/versions/{v}`: owner → 200 and the change shows in `GET /api/games/{id}` and the feed; non-owner → 403/404 per existing owner rules; anonymous → 401; unknown version → 404; `version=abc` → 400; 31st edit in 10 min → 429 with `RATE_LIMIT` on.
    - `/versions` visibility: unpublished game → 404 for others, 200 for owner; unknown id → 404.
    - Feed: two replaces of a published game within 24h → one `gameUpdated` with `version = n+2`, `update.fromVersion = n+1`, `changes` newest first (only non-empty notes); 4 noted versions coalesced → 3 changes; a single replace → `fromVersion == version`; other kinds → `update: null`; backfilled events (`from_version` NULL) → `fromVersion == version`.
    - Migration backfill: every pre-existing game gets exactly one `game_versions` row for its current version (assert on the seeded DB or run the backfill SQL in the test, whichever `tests/common` supports, as in F002).
    - Deleting a game cascades its `game_versions`.

**Acceptance:** `cd backend && cargo test` (all green, including `api.rs`, `v2.rs`, `f001.rs`, `f002.rs`, `review_fixes.rs` and F003's suite) and `cargo clippy --all-targets -- -D warnings`.

### engine-dev (`packages/engine/**`, `examples/**`)
No tasks. No protocol, bundle or `game.json` change.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **`packages/ui/src/api/types.ts`**: `GameVersion`, `FeedUpdate`; `GameSummary.lastUpdatedAt?: string | null` (optional for old servers); `Game.latestVersion?: GameVersion`; `FeedItem.update?: FeedUpdate | null`; `CreateGameInput.notes?: string`.
2. **`packages/ui/src/api/client.ts`**:
   - `replaceBundle(id, bundle, onProgress?, opts?: { notes?: string; expectedVersion?: number })`: appends `notes` when non-empty after trim and `expectedVersion` (as a decimal string) when given. The existing 3-argument call sites keep working.
   - `createGame` appends `notes` when non-empty.
   - `listGameVersions(id, query?: PageQuery)` → `Page<GameVersion>`; `updateVersionNotes(id, version, notes)` → `GameVersion` (PATCH JSON `{ notes }`).
3. **`packages/ui/src/util.ts`**: `UPDATED_BADGE_MS`, `isRecentlyUpdated(...)` per §2. Export both from `index.ts`.
4. **`packages/ui/src/components/GameCard.tsx`**: the "Updated" badge per §2.
5. **`packages/ui/src/components/VersionHistory.tsx`** (new): "What's new" panel + lazy history + owner editing. Props `{ game: Game; onUpdated?(g: Game): void }`. Export it from `index.ts`.
6. **`packages/ui/src/components/ReleaseNotesField.tsx`** (new, small): the shared textarea with label, `maxLength`, counter and error slot, used by the edit page, the owner modal, the upload page and history editing.
7. **`packages/ui/src/pages/GamePage.tsx`**: mount `VersionHistory`; the owner-panel replace modal with notes and `expectedVersion`; 409 handling with Reload; "Updated" row in Game info.
8. **`packages/ui/src/pages/EditGamePage.tsx`** and **`UploadPage.tsx`**: notes fields per §2; `expectedVersion` on the edit page; 409 handling.
9. **`packages/ui/src/components/FeedItem.tsx`**: the `update` rendering per §2 (sentence variant, up to 3 quoted notes, "What's new →" link). Must keep rendering F002 items without `update`.
10. **`packages/ui/src/pages/DocsPage.tsx`**: the "Release notes" paragraph.
11. **CSS** (existing stylesheet, existing variables): `.pf-badge--updated` (accent colour distinct from draft/owner, AA contrast in both themes), `.pf-versions*` (rows, current chip, pre-wrap notes), `.pf-feed__notes` (3-line clamp).
12. **Tests**:
    - `ApiClient.f004.test.ts`: `replaceBundle` form fields (`notes` omitted when blank, `expectedVersion` stringified), `createGame` notes, `listGameVersions` paging query, `updateVersionNotes` method/path/body, id encoding.
    - `util.f004.test.ts`: `isRecentlyUpdated` for null, undefined, invalid strings, 6d23h (true), exactly 7d (false), 3 min in the future (true), 1 day in the future (false).
    - `GameCard.f004.test.tsx`: badge shown/hidden; Draft wins over Updated; no badge for missing `lastUpdatedAt`; F003 `highlight` lines unaffected.
    - `VersionHistory.test.tsx`: hidden for v1 with empty notes; latest notes rendered as text (a `<script>` string appears literally); lazy load on expand; "Show older" paging; the "earlier versions" line when the oldest row is > v1; owner edit saves and calls `onUpdated` for the current version; non-owners see no Edit.
    - `FeedItem.f004.test.tsx`: "(2 updates)" sentence; up to 3 notes; the link target `#versions`; F002 item without `update` renders as before.
    - `GamePage`/`EditGamePage` test(s): replace sends `expectedVersion = game.version` and notes; 409 shows the reload message and Reload refetches while keeping the typed notes.
    - Existing tests stay green (update fixtures with `lastUpdatedAt: null` / `latestVersion` where types require it).

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
No code changes. Verification only:
1. After `build:ui`, run the desktop app against a local backend. Replace a bundle from the game page via **the native file picker** (`platform.pickFile`): the notes modal must appear after the native dialog closes and the upload must carry the notes.
2. Check the "Updated" badge and the "What's new" panel render in the desktop webview (HashRouter: the feed's `/games/{id}#versions` link must still scroll to the panel; if the hash conflicts with HashRouter, report it to frontend-dev, who should then scroll via `useLocation`/a `?section=versions` query instead; see Edge cases).

**Acceptance:** `npm run build -w @webgame/desktop`, plus `cd apps/desktop/src-tauri && cargo check`.

### Sequencing
- **Backend**: the migration is `0007`. It must land after F003's `0006_f003.sql` (F003 is in progress). If F003 slips, do **not** renumber: hold F004's backend merge until `0006` exists. Everything in `upload_bundle` is additive to the R1 code; keep the claim → version read → extract → guarded UPDATE order.
- **Frontend** can start at once against the contracts (mocked API). `GameCard` is also touched by F003 (`highlight`); rebase on F003's UI before merging.
- **Desktop** last, verification only.

## 5. Edge cases and security
- **XSS / spoofing**: notes are untrusted plain text. The UI never renders them as HTML or Markdown and never auto-links URLs. Control and bidi-override characters are rejected server-side so a note can't visually reorder text in the feed. Length is bounded (1000 chars, 8 KB raw field).
- **Concurrency**: the version row is written inside the transaction whose guarded `UPDATE … WHERE version = ?` decides the winner, so a lost race writes no history row, no `last_updated_at` and no feed event. `expectedVersion` is checked **after** the per-game claim, against the DB, so it cannot pass on stale data. Notes edits (`PATCH …/versions/{v}`) don't take the bundle claim: they touch a different row and can't affect the version bump.
- **Unpublished games**: version rows are always written (the owner sees full history), but `last_updated_at` and the feed event only change for replaces of a published game. A draft that is updated 10 times and then published shows no "Updated" badge. Unpublishing hides the game, its history and its feed items as today.
- **Badge gaming**: a creator could replace the bundle daily to keep the badge. Replaces are rate-limited (`Limit::Upload`, 20/hour) and the badge only affects cards, not ranking. No sort uses `lastUpdatedAt` in F004. Acceptable; revisit if a "recently updated" sort is added.
- **Coalescing**: the 24h coalescing (F002) now remembers `from_version`, so a merged item still reports every version it covers. Notes are looked up at read time; versions without notes are omitted from `changes`, and at most 3 are shown.
- **History before F004**: only the current version of each existing game gets a row (with empty notes and an approximate date: the latest `gameUpdated` event, else `updated_at` for version > 1, else `created_at`). The UI says "Earlier versions were published before release notes existed."
- **Achievements removed by a replace** (v2 behaviour) are unaffected; notes are a good place for creators to say so, and DocsPage mentions it.
- **Deleted games** cascade their `game_versions`. Users who are deleted cascade their games as today.
- **HashRouter on desktop**: `/games/{id}#versions` uses a hash inside a hash route. If desktop verification shows it doesn't scroll, frontend-dev switches the link to `/games/{id}?section=versions` and scrolls on mount; both are UI-only.
- **Old clients**: all new fields are additive; old UIs ignore them, and an old client's replace (no `notes`, no `expectedVersion`) behaves exactly as before with an empty note.

## 6. Test expectations
- **Backend**: `tests/f004.rs` covers every bullet of backend task 11. Existing suites stay green, including the R1 race test.
- **UI**: the listed tests, with no network calls (mocked `ApiClient`).
- **Desktop**: build + `cargo check` green, plus the manual verification above.
- **QA end-to-end** (seeded examples, accounts A = owner of the seeded games, B follows A, C favorites Pixel Peaks only):
  1. A replaces Space Dodge with the note "Faster asteroids". The game page shows "v2 · Updated just now" and the note; the home page card shows "Updated"; B's feed shows the item with the note.
  2. Within the hour A replaces it again with "Fixed the pause bug". B sees one item: "updated Space Dodge to v3 (2 updates)" with both notes, newest first.
  3. A edits the v2 note to "Faster asteroids and a new ship". B's feed and the history list show the edit; B gets no new item.
  4. A opens the edit page in two tabs and uploads from both: the second gets the reload message; Reload keeps the chosen file and note, and the retry succeeds as v5.
  5. A creates a draft game, replaces it twice with notes, then publishes: the history shows v1–v3, the card has no "Updated" badge, and B's feed shows one "published" item (F002).
  6. C (not following A) sees the Pixel Peaks update with its note, tagged "From your favorites".
  7. A note containing `<img src=x onerror=alert(1)>` appears literally everywhere.
  8. Desktop: steps 1 and 4 via the native file picker.

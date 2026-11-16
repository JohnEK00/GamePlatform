# F013: Studio: publish updates to an existing game

Status: **specced**. Size: **M** (frontend main; small backend and desktop parts; one round). Areas: frontend, backend, desktop. Engine: no changes.
Contracts: `docs/API.md` § F013 additions, `docs/GAME_FORMAT.md` § F013 additions, `docs/ARCHITECTURE.md` § F013 additions.
Depends on: **F004** (in progress): `notes` and `expectedVersion` on `PUT /api/games/{id}/bundle`, `Game.latestVersion`, and the `ReleaseNotesField` component. No migration: F013 changes no tables (the `0008` slot stays unused by F013).

## 1. Goal and user stories
Today the Studio can only create a **new** game. To ship v2 of a game made in the Studio, a creator has to export a .zip, go to the game page and replace the bundle by hand. A creator whose game was uploaded as a zip can't open it in the Studio at all, because the platform has no way to get the current bundle back. F013 closes the edit → ship loop:
- **Open an existing game in the Studio** (owner only): "Open in Studio" on the game and edit pages, and "Open → My game…" inside the Studio. The current version's files are downloaded through a new owner-only endpoint and loaded as a Studio project.
- **Publish as an update**: the Publish dialog gains an "Update existing game" mode. It replaces the bundle of one of your games, with F004 release notes and `expectedVersion`.
- **A project remembers its game** (a "link"), so the next Publish defaults to updating the same game, and the Studio warns when the game changed outside this project.
- **Open a .zip** in the Studio (any bundle on disk), reusing the new zip reader.
- **Desktop "Reload folder"**: a project opened from a local folder can be re-read from disk in one click. Creators who edit in their own editor can then do edit → reload → run → publish update without leaving the app.
- **Download current bundle** on the edit page (owners recover their source).

User stories:
1. As a creator, I click **Open in Studio** on my game page. The Studio loads v4 of Space Dodge and shows "Linked to Space Dodge · v4". I change the asteroid speed, press Run, then Publish. The dialog is already on "Update Space Dodge", I type "Faster asteroids" and click **Publish update**. The toast says "Version 5 of Space Dodge is live", and the chip shows v5.
2. As a creator who uploaded a zip months ago and lost the source, I click **Download current bundle** on the edit page and get `space-dodge-v4.zip`.
3. As a desktop creator, I open my local folder `pixel-peaks/` in the Studio, edit `main.js` in VS Code, click **↻ Reload folder**, test, and publish an update to Pixel Peaks. The dialog preselects Pixel Peaks because its title matches `game.json` `name`, and asks me to confirm the full replace because this project wasn't opened from that game.
4. As a creator with the Studio open in two tabs (or who also replaced the bundle from the game page), my publish from the stale project says "Space Dodge was updated to v6 outside this project", and I must tick a checkbox to replace it anyway.
5. As a web user, I click **Open → .zip file** and load a bundle I downloaded earlier.

Non-goals (later items): remixing / forking other people's games (licensing questions), writing Studio edits back into the local folder or watching it for changes (proposed F014), a file-level diff before replacing, editing title/description/tags from the Studio, partial (per-file) uploads, and rollback (F004: old versions' files are not kept).

## 2. UX notes

### 2.1 Studio header
- The "📂 Open folder" button becomes a menu button **"📂 Open ▾"** (`aria-haspopup="menu"`, `aria-expanded`). Its popover is a `role="menu"` list of `role="menuitem"` buttons; Escape and outside clicks close it, and focus returns to the button:
  - **Local folder…**: the existing flow (`platform.openLocalProject`, else `<input webkitdirectory>`). `STUDIO_OPEN_FOLDER_EVENT` still runs this item directly.
  - **.zip file…**: `platform.pickFile(".zip,application/zip")` when present, else a hidden `<input type="file" accept=".zip,application/zip">`. The file is read with `projectFromZip` (§3). Skipped files are reported with the same toast as folders.
  - **My game…** (signed in only; shown disabled with the title "Log in to open your games" otherwise): opens the **Open game dialog** (§2.3).
- **Link chip** (shown when the project has a valid link, §2.5): next to the save state, a `pf-chip` with "Linked to <Link to=/games/{id}>{title}</Link> · v{version}" and a ✕ icon button (`aria-label="Unlink from {title}"`) that clears the link (no confirm; it only changes what Publish defaults to).
- **↻ Reload folder** button (desktop only, shown when the project has a `localFolder` from this session, §2.6): `title="Reload {name} from disk"`.
- **Replacing the project** (template, folder, .zip, my game, reload): when the project is **dirty** (edited since it was last loaded, created or published, §2.5), a `ConfirmDialog` first: "Replace the current project?" / "Your unpublished changes in the Studio will be lost. Export a .zip first to keep them." (Reload uses "Discard Studio edits and reload {name} from disk?"). A clean project is replaced without asking. This fixes today's silent replace on Open folder.

### 2.2 "Open in Studio" entry points
- **Game page owner panel** (`GamePage.tsx`, `OwnerPanel`): a new "✎ Open in Studio" button after "Edit", navigating to `/studio?open={id}`.
- **Edit page** (`EditGamePage.tsx`, "Current bundle" section): "✎ Open in Studio" (same link) and "⬇ Download current bundle". Download calls `api.downloadBundle(id)`, then `platform.saveFile(filename, blob)` when present (toast "Saved") or `downloadBlob`. The button shows a spinner while busy. Errors are toasts with the API message.
- **Studio `?open={id}`** (on mount and on change of the query):
  1. Remove the `open` param immediately with `navigate({ search: "" }, { replace: true })`, so a reload of the page doesn't re-download.
  2. Not signed in → redirect to `/login?next=%2Fstudio%3Fopen%3D{id}`.
  3. When dirty → the replace confirm. When the project is already linked to that game, is **not** dirty and `link.version` equals the server's version, skip the download and toast "Already open".
  4. Download (§2.4).

### 2.3 Open game dialog
- `useModal` dialog "Open one of your games". It lists `api.listGames({ owner: "me", sort: "new", perPage: 100 })`: thumbnail, title, a "Draft" chip for unpublished games, and `timeAgo(updatedAt)`. A search input filters by title client-side. Empty list: "You haven't published any games yet." Loading: spinner; error: `Alert` with Retry.
- Choosing a game closes the dialog and runs the same flow as `?open=` steps 3–4.

### 2.4 Downloading a game into the Studio
- A blocking overlay over the editor area (`role="status"`, Spinner, "Downloading {title}…"; there is no Cancel because the request is short). Then:
  1. `const { blob, version } = await api.downloadBundle(id)`.
  2. `projectFromZip(await blob.arrayBuffer())`.
  3. `loadProject(project, "“{title}” v{version}", { link: { gameId, title, version, apiBase } })`.
- The console logs "Opened “Space Dodge” v4." Any skipped files (should not happen for server bundles) use the usual toast.
- Errors: 404/403 → toast "Couldn't open the game" with "It may have been deleted, or it isn't yours."; 409 → retry once automatically, then a toast with the message; 429 → "Too many downloads; try again in {retryAfter}s"; 503 → "The server is busy; try again in a few seconds."; zip read errors → toast with the reader message. The current project is untouched on any error.

### 2.5 Link and dirty state
- `StudioLink = { gameId: string; title: string; version: number; apiBase: string }`:
  - `version` is the game version the project was last downloaded from or published as.
  - `apiBase` is `useConfig().apiBaseUrl` when the link was made. A link whose `apiBase` differs from the current one (the desktop server setting changed) is **ignored**: no chip, and Publish defaults to "New game". It is not deleted, so switching back restores it.
- Set by: downloading a game (§2.4), a successful update publish, and a successful **new** publish (`version: 1`). Cleared by: Unlink, a template, opening a folder or a .zip, and a 403/404 from an update publish to the linked game. **Reload folder keeps it.**
- `title` is refreshed from the server whenever the dialog or a download fetches the game.
- `dirty` turns true on any edit to the manifest or files (including rename, delete, asset import), and false after a load (template / folder / zip / game / reload) or a successful publish of either kind.
- Both `link` and `dirty` are saved with the autosave (§3 `serializeProject`), so they survive a page reload.

### 2.6 Desktop local folder
- When `platform.openLocalProject` resolves with `localFolder: { id, name }`, the Studio keeps it in component state (**not** in the autosave: ids are valid for the app session only). The project's link is cleared, as for any folder open.
- **↻ Reload folder** calls `platform.reloadLocalProject(localFolder.id)` (with the dirty confirm first). On success: replace manifest and files, keep the link and `localFolder`, set `dirty = false`, log "Reloaded {name} from disk.", and restart the preview. Keep the selected file when it still exists, else select the entry.
- Reload errors (folder moved, deleted or now invalid, or an unknown id after an app restart) → toast "Couldn't reload the folder" with the message. When the message says the folder is no longer available, drop `localFolder`, so the button hides.
- Studio edits are never written back into the folder. When a desktop folder project is dirty, a muted hint under the file list says "Edits made here aren't saved to {name}. Export a .zip, or edit the files on disk and reload." The web `webkitdirectory` path has no reload; users open the folder again.

### 2.7 Publish dialog
The dialog title becomes "Publish". At the top is a radio group (`role="radiogroup"`, label "Publish as"): **New game** / **Update an existing game**.
- **Default mode**: "Update" when the project has a valid link, otherwise "New game".
- **New game**: today's form (`GameFields`), plus F004's optional release notes (`ReleaseNotesField`, collapsed behind "+ Add release notes"), sent as `notes`. On success, set the link (`version: 1`), clear `dirty`, toast, and navigate to the game page as today.
- **Update an existing game**:
  1. **Game select** (`<select>`, label "Game"). Options come from `listGames({ owner: "me", sort: "new", perPage: 100 })`, shown as "{title}" plus " (draft)" when unpublished. While loading, a spinner and the submit is disabled. With no games, the text "You have no games to update yet." and the mode falls back to "New game".
     - Preselection: the linked game; otherwise the **only** game whose title equals `game.json` `name` (trimmed, case-insensitive); otherwise none ("Choose a game…").
  2. **Fetch the selected game** on every selection: `api.getGame(id)` for `version`, `published` and `latestVersion`. Show "Currently v{version} · {published ? "Published" : "Draft"} · updated {timeAgo(latestVersion.createdAt)}". The version shown is the `expectedVersion` the upload will send.
  3. **Safety confirmation**: a required checkbox "Replace all files of “{title}” (v{version}) with this project". It is shown when **either**:
     - the project isn't linked to the selected game, or
     - the link's `version` differs from the fetched `version`. Above the checkbox, a warning `Alert` reads "“{title}” was updated to v{version} outside this project (you last opened or published v{link.version}). Publishing replaces those changes."
     When the project is linked to this game at the current version, no checkbox is needed.
  4. `ReleaseNotesField` "What's new in this version (optional)" (F004 limits: 1000 chars, counter from 900).
  5. Muted note: "Title, description, tags and visibility don't change. Edit them on the game's page." (links to `/games/{id}/edit`). For a draft game add: "This game is a draft. Players won't see the update until you publish it."
  6. Submit button **"Publish update"**. It runs `validateProject` (as today), then `buildBundleZipAsync`, `checkBundleSize`, and `api.replaceBundle(id, file, onProgress, { notes, expectedVersion: fetched.version })`. The file name is `{slugify(title)}.zip`. A `ProgressBar` shows during the upload.
  7. On success: link = `{ gameId, title: game.title, version: game.version, apiBase }`, `dirty = false`, toast "Version {game.version} of {title} is live" (or "…saved (draft)" when unpublished), close the dialog. **Stay in the Studio.**
  8. Errors:
     - **409**: refetch the game, show `Alert` "“{title}” changed while you were publishing (now v{n}). Check and try again.", and require the checkbox again. Keep notes and selection.
     - **422**: a notes message goes under the notes field; anything else shows "The bundle was rejected: {message}".
     - **429**: "Upload limit reached. Try again in {retryAfter}s."
     - **403/404**: "You can't update this game. It may have been deleted." Unlink when it was the linked game, and reload the game list.
- The dialog can't close while uploading (as today).

### 2.8 Docs page
`DocsPage.tsx` Studio section gets a short "Updating a published game" paragraph covering: Open in Studio, the link chip, Publish → Update, release notes, the replace confirmation, Download current bundle, and (desktop) Reload folder with the reminder that Studio edits aren't written back to the folder.

## 3. Contract changes (summary; normative text lives in docs/)
- **API**: new `GET /api/games/{id}/bundle` 🔒 owner returns the current version as `application/zip`, with `X-Game-Version` (exposed via CORS), `Content-Disposition`, `Cache-Control: no-store`, a new `Limit::BundleDownload` (30/hour per user) and at most 2 concurrent builds (503 otherwise). No other endpoint changes. F013 uses F004's `notes` + `expectedVersion` on `PUT /api/games/{id}/bundle` as specified there.
- **Game format**: no bundle or `game.json` change. It documents that a downloaded bundle is the stored files (top-level folder stripped, `game.json` at the root, `game.json` first), and that it re-uploads unchanged.
- **Architecture**: the Studio link/dirty model and autosave format, the new `studio/unzip.ts` reader and `projectFromZip`, the platform contract additions (`localFolder` on `openLocalProject` results, `reloadLocalProject`), the desktop folder registry, and the backend export builder. No migration.

## 4. Per-area tasks

### backend-dev (`backend/**`)
1. **Export builder** `backend/src/export.rs` (new): `pub fn build_bundle_zip(dir: &Path, date: zip::DateTime) -> Result<Vec<u8>, ExportError>`, run in `spawn_blocking`.
   - Walk `dir` recursively. Use `symlink_metadata`: skip symlinks and anything that isn't a regular file or directory. Build relative paths with `/`, sort them byte-wise, and put `game.json` first.
   - Store entries with `CompressionMethod::Stored` when the extension is png/jpg/jpeg/webp/gif/mp3/ogg/woff2, else `Deflated` (default level). Stream each file into the writer through `std::io::copy` on a `File`; don't read whole files into memory first. Every entry's date is `date`.
   - Stop with `ExportError::TooLarge` as soon as the output buffer exceeds **64 MiB** (`EXPORT_MAX_BYTES`).
   - An `io::ErrorKind::NotFound` while walking or reading becomes `ExportError::Vanished` (a concurrent replace removed the version dir). Other IO errors are internal errors.
2. **Handler** `games::download_bundle` (or `routes/export.rs`), `GET /api/games/{id}/bundle`, added to the existing `/games/{id}/bundle` route next to `put(upload_bundle)` in `routes/mod.rs`:
   1. `AuthUser` (session tokens only; preview-scoped tokens are rejected by the existing extractor → 401).
   2. `fetch_owned_game` (unknown → 404, other user → same 403/404 as other owner routes).
   3. `limit_user(Limit::BundleDownload)`.
   4. `state.export_slots.try_acquire()` (a `tokio::sync::Semaphore` with **2** permits in `AppState`). If none is free → 503 `unavailable` "The server is busy preparing downloads; try again shortly" with `Retry-After: 5`.
   5. Read `version` V. Build from `storage.version_dir(id, V)`, with `date` = the `game_versions.created_at` for V (F004) or `updated_at` as a fallback, as a UTC `zip::DateTime` (clamped to 1980–2107).
   6. Re-read `games.version`. If it differs from V, or the build returned `Vanished` → 409 `conflict` "The game was updated while preparing the download; retry". `TooLarge` → 413 `payload_too_large` "The bundle is too large to download".
   7. Response 200 headers:
      - `Content-Type: application/zip`
      - `Content-Disposition: attachment; filename="{slug}-v{V}.zip"`. `slug` is the title lowercased, runs of anything other than `[a-z0-9]` become `-`, trimmed of `-`, at most 40 chars, and `game` when empty, so the value is ASCII only.
      - `X-Game-Version: {V}`
      - `Cache-Control: no-store`
      - `X-Content-Type-Options: nosniff`
      - `Content-Length`
   - Don't take the `bundle_locks` claim: a download must never make a concurrent replace fail.
3. **CORS** (`lib.rs`/`routes/mod.rs` CORS layer): add `expose_headers([X-Game-Version, Content-Disposition, Retry-After])` for `/api/*`. Check that the existing allowed methods already include GET for this path.
4. **`ratelimit.rs`**: `Limit::BundleDownload` = 30 per hour, per user.
5. **Tests** `backend/tests/f013.rs`:
   - **Round trip**: create a game from a zip whose files sit inside a single top-level folder, with nested `assets/` and a binary PNG. `GET …/bundle` as the owner → 200, `application/zip`, `X-Game-Version: 1`, a `Content-Disposition` filename matching `^[a-z0-9-]+-v1\.zip$`. The first entry is `game.json`; the paths are the stored (stripped) ones; the bytes are identical to the upload; png entries are stored and js entries deflated.
   - **Re-upload**: `PUT …/bundle` with the downloaded bytes and `expectedVersion=1` → 200, v2. Downloading again gives `X-Game-Version: 2` and the same file set.
   - After a replace with a different file set, the download contains only the new version's files.
   - Unpublished game: the owner gets 200.
   - Anonymous → 401; preview token → 401; another user → 403/404 (same as `PUT …/bundle`); unknown id → 404.
   - With `RATE_LIMIT` on, the 31st download in an hour → 429 with `Retry-After`.
   - A CORS preflight/GET from an allowed origin carries `Access-Control-Expose-Headers` including `x-game-version`.
   - **Unit tests in `export.rs`**: a symlink is skipped (unix-only `#[cfg]`); `NotFound` maps to `Vanished`; the 64 MiB cap triggers `TooLarge` (use a lowered cap through a `build_bundle_zip_with_cap` helper).
   - **Semaphore**: with both permits held by the test (expose a test hook or construct `AppState` with 0 permits through `tests/common`) → 503 + `Retry-After`.

**Acceptance:** `cd backend && cargo test` (all suites green, including F003's and F004's) and `cargo clippy --all-targets -- -D warnings`.

### engine-dev (`packages/engine/**`, `examples/**`)
No tasks.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **`api/client.ts`**: `downloadBundle(id: string, signal?: AbortSignal): Promise<{ blob: Blob; version: number; filename: string }>`.
   - Authenticated GET `/api/games/{encodeURIComponent(id)}/bundle`, reading the body as a Blob. Non-2xx bodies are parsed into `ApiError` exactly like `request()`, including `retryAfter`.
   - `version` comes from `X-Game-Version`. When it is missing or not a positive integer (old proxy stripping headers), fall back to `(await this.getGame(id)).version`.
   - `filename` comes from `Content-Disposition` (`filename="…"`), else `game-v{version}.zip`.
   - `replaceBundle`'s F004 `opts` are used as-is.
2. **`studio/unzip.ts`** (new): `readZip(data: ArrayBuffer | Uint8Array, limits?: { maxEntries?: number; maxTotalBytes?: number }): Promise<{ path: string; data: Uint8Array }[]>`.
   - Find the EOCD in the last 65 557 bytes and walk the **central directory**; use local headers only to locate the data.
   - Methods 0 (stored) and 8 (deflate, via `DecompressionStream("deflate-raw")`). Reject with a clear `Error` for anything else: other methods, encryption (flag bit 0), ZIP64 markers (`0xFFFFFFFF`/`0xFFFF`), multi-disk archives, and a missing `DecompressionStream` ("This browser can't open compressed .zip files.").
   - Skip directory entries (a name ending in `/`). Decode names as UTF-8 when flag bit 11 is set, else as latin1. Reject names that `normalizeProjectPath` refuses (absolute, `..`, empty).
   - Defaults: `maxEntries = MAX_PROJECT_FILES` (2000) and `maxTotalBytes = MAX_BUNDLE_UNCOMPRESSED_BYTES` (200 MB). Count **actual** inflated bytes while streaming and abort once over the limit, never trusting declared sizes. Verify each entry's CRC-32 with the existing `crc32`, and its inflated size against the declared size.
3. **`studio/project.ts`**:
   - Refactor `projectFromFileList` onto a shared `projectFromEntries(entries: { path: string; read(): Promise<Uint8Array | string> }[])`. The behaviour stays the same: strip a single common top-level folder **only when it contains `game.json`** (the backend rule), skip dotfiles and disallowed extensions, decode text files as UTF-8 strings, keep binaries as ArrayBuffers, cap files, and require `game.json`.
   - `projectFromZip(data): Promise<{ project; skipped }>` uses `readZip` and then `projectFromEntries`.
   - Types: `StudioLink`. The project state gains optional `link?: StudioLink` and `dirty?: boolean`. Keep them **outside** `StudioProject` (a `StudioSession = { project; link?; dirty }` or separate state) so `StudioProject` stays the host contract.
   - `serializeProject` / `deserializeProject` (`v: 1`) get optional top-level `link` and `dirty`, validated on read: drop a malformed `link`, and treat a missing `dirty` as `false`. Old autosaves still load.
   - `LocalProject = StudioProject & { localFolder?: { id: string; name: string } }` is exported.
4. **`context/config.tsx`** (`PlatformConfig`):
   - `openLocalProject?: () => Promise<LocalProject | null>` (the return type widens; old hosts still conform).
   - New `reloadLocalProject?: (folderId: string) => Promise<LocalProject | null>`.
5. **`pages/StudioPage.tsx`**: the Open menu, Open game dialog (`studio/OpenGameDialog.tsx`, new), `?open=` handling, download overlay, link chip, dirty tracking + replace confirm, Reload folder, and the Publish dialog modes, all per §2. Split `PublishDialog` into `studio/PublishDialog.tsx` (new) to keep the page manageable. Uses F004's `ReleaseNotesField`.
6. **`pages/GamePage.tsx`** (`OwnerPanel`) and **`pages/EditGamePage.tsx`**: "Open in Studio" and "Download current bundle" per §2.2.
7. **`pages/DocsPage.tsx`**: the paragraph per §2.8.
8. **`index.ts`**: export `StudioLink`, `LocalProject`, `readZip`, `projectFromZip`.
9. **CSS**: `.pf-studio__link` (the chip), `.pf-menu` / `.pf-menu__item` (Open popover; reuse existing variables and focus styles), `.pf-studio__overlay`.
10. **Tests** (mocked `ApiClient`, no network):
    - `unzip.test.ts`:
      - Round trip with `createZipAsync`, both stored and deflate.
      - UTF-8 names; directory entries skipped.
      - CRC mismatch, encrypted flag, method 12 and a ZIP64 marker each reject.
      - A crafted deflate bomb (small compressed, declared small, inflates past `maxTotalBytes`) rejects without inflating everything. More than `maxEntries` entries rejects.
      - `../x.js` and `/x.js` reject.
    - `project.f013.test.ts`:
      - `projectFromZip` strips a top-level folder only when it holds `game.json`, skips dotfiles and `.exe`, decodes text, and errors when `game.json` is missing.
      - `projectFromFileList` behaviour is unchanged (existing tests stay green).
      - The serializer round-trips `link` and `dirty`; an old autosave without them loads with `dirty: false`; a malformed link is dropped.
    - `ApiClient.f013.test.ts`:
      - `downloadBundle` sends auth and an encoded id, and parses version and filename.
      - It falls back to `getGame` when the header is missing.
      - An error JSON becomes `ApiError` with `retryAfter`.
    - `Studio.f013.test.tsx`:
      - `?open=id` downloads, loads, shows the chip, and removes the query. When dirty it confirms first. Anonymous → login redirect.
      - Publish defaults to Update when linked.
      - Linked at the current version → no checkbox, and `replaceBundle` gets `expectedVersion` and `notes`.
      - Linked but stale → warning + required checkbox.
      - Unlinked with a matching title → preselected + checkbox.
      - Success updates the chip version, clears dirty and stays on `/studio`.
      - 409 → refetch, message, checkbox again, notes kept. 404 → unlink.
      - A new publish sets the link with `version: 1`.
      - An apiBase mismatch hides the chip and defaults to New.
      - Opening a template/folder/zip clears the link.
      - Reload folder (mock `reloadLocalProject`) keeps the link, replaces files and confirms when dirty. It is hidden without `localFolder`, and hidden after a "no longer available" error.
      - The Open menu works from the keyboard: Enter opens it, arrow/Tab reaches the items, Escape closes it and returns focus.
    - `GamePage`/`EditGamePage`: the Open in Studio link target; Download uses `platform.saveFile` when present, else `downloadBlob`.
    - Existing Studio tests stay green. The "Open folder" button label changes, so update the selectors, but `STUDIO_OPEN_FOLDER_EVENT` behaviour is unchanged.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
1. **`src-tauri/src/project.rs`**: a session folder registry `ProjectFolders(Mutex<…>)`:
   - Maps an opaque `folderId` (UUID v4, or 128 random bits as hex) to the **canonical** project root path chosen in the dialog (after the existing `project_root` single-wrapper resolution).
   - Bounded to **16** entries; the least recently used is evicted. Kept in memory only, never persisted.
   - `pick_project_folder` registers the folder and adds `folderId: string` to the returned `ProjectIndex` (camelCase via serde). `folder` (the display name) stays.
2. **New command** `reload_project_folder(folderId: String) -> Result<Option<ProjectIndex>, String>`:
   - Look up the path. An unknown id → `Err("The folder is no longer available. Open it again.")`.
   - Re-read it with `read_project_dir(path, Limits::UPLOAD)`, with the same validation, symlink rules and limits as a pick. If the path is gone or no longer a directory → the same error message, and remove the id.
   - Return a fresh index with a new binary `ticket` (the existing `OpenProjects` flow). The `folderId` stays the same.
   - Register it in `lib.rs`'s `invoke_handler`, and in the capability/permission file if the app uses an allowlist for commands.
3. **`src/platform.ts`**:
   - `openLocalProject` returns `LocalProject` with `localFolder: { id: index.folderId, name: index.folder }`.
   - New `reloadLocalProject(folderId)` reuses the same index → files assembly, so factor the binary-fetch part into a helper. Wire it into the platform object passed to `WebGameApp` (`App.tsx`), desktop only, like `openLocalProject`.
4. **No native menu change** in F013. File → "Open local game folder…" keeps working through `STUDIO_OPEN_FOLDER_EVENT`.
5. **Tests**:
   - Rust unit tests in `project.rs`:
     - The registry is bounded, and the LRU entry is evicted.
     - An unknown id errors.
     - Reload after editing a file on disk returns the new content.
     - Reload after deleting the folder errors and forgets the id.
     - The id is random, not derived from the path: two picks of the same folder get two different ids.
   - `platform.test.ts` (if present; otherwise add one with mocked `invoke`): `localFolder` mapping, and `reloadLocalProject` calls `reload_project_folder` and assembles files.
6. **Manual verification** after `build:ui`, against a local backend:
   - Open a local folder, edit a file on disk, Reload, Run, then Publish → Update an existing game with notes.
   - "Open in Studio" from a game page (HashRouter `#/studio?open=…`).
   - "Download current bundle" through the native save dialog.

**Acceptance:** `npm run build -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test && cargo check`.

### Sequencing
- **Backend** can start at once. It has no migration and doesn't touch F004's tables, but `download_bundle` reads `game_versions.created_at` with a fallback, so it compiles and works before or after F004's `0007` lands. Rebase on F004's `upload_bundle` changes (same file, `routes/games.rs`).
- **Frontend** depends on F004's UI (`ReleaseNotesField`, `replaceBundle` opts). Start with `unzip.ts`, `project.ts` and `downloadBundle` (independent), and do the Publish dialog after F004's frontend merges.
- **Desktop** can start at once (Rust + `platform.ts`). Its manual verification happens last.

## 5. Edge cases and security
- **Who can download**: only the owner, with a session token. The game files are already readable by anyone who knows a path under `/games/{id}/files/*` (games must load them in a credential-less sandbox). The **full listing** in one archive is new information, though: unreferenced files, dev notes and unused assets. So the endpoint is owner-only. Preview tokens are refused, admins get no special access, and there is no public "download source" in F013 (remixing is a non-goal).
- **Resource use**: a build reads up to 200 MB from disk and keeps the zip in memory (at most 64 MiB, since uploads were ≤ 50 MB compressed). Two concurrent builds at most (≈128 MiB peak), 30 per user per hour, and 503 + `Retry-After` when busy. Files are streamed into the writer, not buffered whole.
- **Concurrent replace during a download**: no lock is taken. If the version dir disappears mid-build, or the version changed by the end → 409, and the client retries once. On Windows, an open file can make the replacer's best-effort delete of the old version dir fail. The R1 cleanup already tolerates that, and the startup cleanup removes orphaned folders (review-fix Ops).
- **Header injection**: `Content-Disposition` uses an ASCII slug only. `X-Game-Version` is an integer.
- **Untrusted zips in the browser** ("Open .zip"): limits are counted on actual inflated bytes, along with entry count, CRC and declared-size checks, and path normalisation (no `..`, no absolute paths). ZIP64, encryption and unknown methods are refused. A project from any source only ever runs in the sandboxed `/play/studio` iframe (unchanged). SVGs are previewed with `<img>` (scripts don't run).
- **Wrong-game overwrite**: replacing a game with the wrong project is the main product risk. Defences:
  - the confirmation checkbox whenever the project isn't linked to the selected game at its current version;
  - the stale-link warning;
  - `expectedVersion` against races;
  - the F004 version history, which records what happened. There is no rollback, so the dialog copy says "replace all files".
- **Server switch (desktop)**: links carry `apiBase` and are ignored on another server, so a project never updates a game id from another server.
- **Deleted or transferred game**: an update returns 404/403 and the link is dropped. `?open=` for a deleted id shows the error toast and leaves the project alone.
- **Draft games**: allowed. The F004 rules apply (version row written, no "Updated" badge, no feed event), and the dialog says so.
- **Achievements**: an update follows the v2 rule (achievements no longer declared are removed). The Studio's game.json form shows them, so the creator sees what will be kept.
- **Large projects and autosave**: a downloaded game may be too large for localStorage. The existing "⚠ Too large to autosave" state applies, and the link is saved with the project or not at all. If the autosave fails, a page reload falls back to the previous autosave. That's acceptable, and the warning is visible.
- **Desktop folder ids**: they are opaque and session-scoped, and never reveal the path to the webview (keeping the existing "the webview never supplies a filesystem path" rule). The webview can only reload folders the user picked in this session; the Rust registry is the allowlist. Reload re-applies every validation.
- **Byte-exact round trip**: text files are decoded to strings in the Studio and re-encoded as UTF-8 on publish. A non-UTF-8 text file (for example latin1 `.txt`) changes its bytes on re-upload, as with folder imports today. A UTF-8 BOM is kept as `﻿` and survives.
- **Old servers**: the buttons are always shown. On a server without F013, `GET …/bundle` returns 405 (the route only has PUT). `downloadBundle` maps a 405, or a 404 without an error JSON body, to the message "This server doesn't support opening games in the Studio."

## 6. Test expectations
- **Backend**: `tests/f013.rs` plus the `export.rs` unit tests, as listed. All existing suites stay green.
- **UI**: the listed tests, all with mocked `ApiClient` and platform. `readZip` tests run on Node 22's `DecompressionStream`.
- **Desktop**: `cargo test` for the registry and reload, a green build, and the manual checks.
- **QA end-to-end** (seeded examples; A owns Space Dodge, B follows A):
  1. A opens Space Dodge from its game page into the Studio. The chip shows v1. A edits `main.js`, runs it, and publishes an update with "Faster asteroids". The toast says v2; the game page shows v2 with the note; B's feed shows the F004 item.
  2. A replaces Space Dodge from the game page (v3), then publishes from the still-open Studio (linked v2): a stale warning and a required checkbox. After ticking it, v4 is live.
  3. A clicks Download current bundle on the edit page, opens that zip with Studio → Open → .zip file, and publishes it as an update to Space Dodge. Title matches, so it is preselected, but the checkbox is required because opening a zip clears the link. v5 is live, and its files are identical to v4.
  4. B navigates to `/studio?open={Space Dodge id}`: an error toast, and B's project is unchanged. `GET /api/games/{id}/bundle` as B → 403/404.
  5. Desktop: A opens `examples/pixel-peaks` as a local folder, edits a file on disk, clicks Reload, and the preview shows the change. A publishes as an update to Pixel Peaks, preselected by title.
  6. Desktop: A switches the server setting to another backend. The chip disappears and Publish defaults to New game.

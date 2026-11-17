# F005: Screenshot capture and share

Status: **shipped**. Size: **M** (engine + frontend main; backend medium; desktop small; one round). Areas: engine (+ examples), backend, frontend, desktop.
Contracts: `docs/GAME_FORMAT.md` § F005 additions (engine API, messages), `docs/API.md` § F005 additions (endpoints, types, limits), `docs/ARCHITECTURE.md` § F005 additions (capture pipeline, storage, migration `0009_f005.sql`).
Depends on: nothing unshipped. It builds on the F001 request/reply pattern, `validate_image` and the N5 `Limit::Image` pattern (review round 2), `useModal`, `platform.saveFile`, and the moderation queue. The migration is **`0009_f005.sql`** and runs after the review-fix `0008_review2.sql`.

## 1. Goal and user stories
Games run in a sandboxed iframe with an opaque origin, so today there is no way to save what's on screen. The browser's "save image" doesn't work on a WebGL canvas, and the parent page can't read the iframe's pixels. Creators make thumbnails by hand with OS screenshot tools and crop out the letterbox. Players can't share a moment from a game.

F005 adds:
- **Engine capture**: a frame grab at a defined point in the frame, at a predictable resolution, without `preserveDrawingBuffer`. It is exposed three ways: the parent asks for it (camera button), the game shares one (`engine.platform.shareScreenshot`), and the game takes one for its own use (`engine.captureFrame`).
- **Player camera button and screenshot tray**: download (native save dialog on desktop), copy, post to the game page with a caption, and "Set as thumbnail" for owners.
- **Game-page screenshot gallery**: community screenshots with a lightbox, delete (author, owner or admin) and reports.
- **Moderation and privacy**: screenshots are a report target. The server decodes and re-encodes every upload, which strips metadata. Nothing is ever uploaded without an explicit click.
- **Desktop**: View → Take Screenshot (`CmdOrCtrl+Shift+S`), and the save dialog opens in the Pictures folder.

User stories:
1. As a player, I clear a hard level in Pixel Peaks and click 📷. The stage flashes, and a thumbnail appears in the tray under the player. I click it, type "Finally!", and click **Post to game page**. My screenshot shows up in the game's Screenshots section.
2. As a creator, I play my own game, press 📷 on a nice scene and choose **Set as thumbnail**. My game card now shows that exact frame at the right aspect ratio, with no letterbox bars.
3. As a player in Space Dodge, I set a personal best. The game shows "Press P to capture". I press P, and the tray gets a screenshot with the caption "New best: 12,340" already filled in. Nothing is posted until I post it.
4. As a desktop player, I press Ctrl+Shift+S while playing. The screenshot lands in the tray. **Download** opens the native save dialog in my Pictures folder, with the name `space-dodge-20261114-153012.png`.
5. As a game owner, I delete an off-topic screenshot from my game's gallery. As any user, I report an offensive one. The admin sees the image in the queue and deletes it.
6. As a Studio user, I capture my preview and download it to put on my itch.io page.

Non-goals (later items): screenshot feed items (F002 kind `screenshotPosted`), a profile "Screenshots" tab, GIF/video capture, in-browser cropping and annotation, "Set as thumbnail" from the Studio, an owner switch that turns off community screenshots, likes on screenshots.

## 2. UX notes

### 2.1 Player bar (`GamePlayer`)
- New icon button **📷** between Mute and Fullscreen: `aria-label="Take screenshot"`, `title="Screenshot"`. It is disabled until `webgame:ready`, and while a capture is in flight (shows a spinner).
- On success, the stage plays a 150 ms white flash (skipped under `prefers-reduced-motion`). A polite live region announces "Screenshot captured". The new item is added at the front of the tray.
- On failure or timeout (5 s): an error toast "Couldn't capture a screenshot" with the reason ("The game is still loading", "Try again in a moment", or "This game can't take screenshots right now").
- Game-initiated shares (`source: "game"`) add a tray item marked "from game" and show an info toast "{title} captured a screenshot". There is no flash.

### 2.2 Screenshot tray (`ScreenshotTray`)
- A horizontal strip under the player bar. It shows only when it has items.
- Each item is a 96px-high thumbnail button (`aria-label="Screenshot {n}, captured {time}"`). A "Clear all" link sits at the end.
- It holds up to 12 items per player mount, newest first. The oldest is evicted and its object URL revoked. Items live in memory only: nothing goes to localStorage, and they are gone when you leave the page. The tray says so in a small hint.
- Clicking an item opens the **ScreenshotDialog** (`useModal`: focus trap, Esc, focus restored to the thumbnail):
  - The image at up to 100% of the dialog width, with `alt` = caption or "Screenshot of {title}". The dimensions are shown under it.
  - A **Caption** text input (0–140 chars, single line, live counter), prefilled with the game's caption for game-initiated shares.
  - **Download**: `platform.saveFile(name, blob)` when present, otherwise an `<a download>`. The name is `{slug}-{YYYYMMDD-HHmmss}.png` in local time; `slug` uses the same rule as the F013 bundle download.
  - **Copy**: only when `navigator.clipboard?.write` and `ClipboardItem` exist. It writes `image/png`. Toast "Copied".
  - **Post to game page**:
    - Hidden in the Studio.
    - When anonymous, it is disabled with "Sign in to post".
    - For an unpublished game it is shown only to the owner, with the hint "Visible after you publish".
    - It uploads `POST /api/games/{id}/screenshots`, then shows the toast "Posted" with a "View" link that scrolls to the gallery, and invalidates the gallery.
  - **Set as thumbnail**: owner only, behind `ConfirmDialog` "Replace the thumbnail of {title}?". It calls `PUT /api/games/{id}/thumbnail` with the image fitted to 2 MB (§ 4 frontend, `fitImageForUpload`) and updates the game in place.
  - **Remove** (from the tray only).
  - Errors map to toasts: 429 "You're posting too many screenshots, try again in {Retry-After}", 422 cap "You've posted 20 screenshots for this game; delete one first", 503 "The server is busy, try again in a few seconds".

### 2.3 Game page gallery (`ScreenshotGallery`)
- A "Screenshots" section between "What's new" (F004) and comments. The heading shows the total count.
- A responsive grid of `thumbUrl` images (`loading="lazy"`, 16:9 boxes with `object-fit: contain` on the dark surface). 12 per page, with a "Load more" button.
- Empty state: "No screenshots yet. Press 📷 while playing to capture one."
- Clicking opens a lightbox dialog (`useModal`, ← / → keys move between loaded items) showing:
  - the full `imageUrl`, the caption as plain text, the author (link to the profile), a relative date and "v{gameVersion}";
  - actions **Delete** (`canDelete`, behind a confirm), **Report** (signed in and not the author; uses `ReportDialog` with `targetType: "screenshot"`), **Set as thumbnail** (owner), and **Open image** (a plain link to `imageUrl`, `rel="noopener"`).
- The gallery reads `GET /api/games/{id}/screenshots` without auth for anonymous visitors, with the session otherwise (for `canDelete`).

### 2.4 Studio preview (`StudioPreview`)
- The same 📷 button in the preview toolbar and the same tray (max 12). It offers Download, Copy and Remove only. Game-initiated shares are accepted too, so creators can test `shareScreenshot`.

### 2.5 Admin queue (`AdminPage`)
- Screenshot reports show a 120px `targetImageUrl` thumbnail (a click opens it full size in a new tab), the preview text and a link to the game. The resolve actions are **Dismiss** and **Delete** (no Unpublish).
- When the screenshot is already gone, the thumbnail is replaced by "(deleted)".

### 2.6 Desktop
- View → **Take Screenshot** (`CmdOrCtrl+Shift+S`). It works while the game iframe has focus, because menu accelerators are handled natively. With no player or Studio preview mounted, it does nothing.
- The native save dialog for `.png/.jpg/.jpeg/.webp` names opens in the OS Pictures folder (then the last folder used for an image during this session).

## 3. Contract changes (summary; normative text lives in docs/)
- **GAME_FORMAT.md § F005 additions**:
  - Engine API: `engine.captureFrame(opts?)` and `engine.platform.shareScreenshot(opts?)`.
  - Messages: `webgame:screenshot-request` (parent → game), `webgame:screenshot` (game → parent), `webgame:screenshot-result` (parent → game).
  - The capture point, output size rule, blob limits, and the parent's validation and laundering rules.
- **API.md § F005 additions**:
  - Type `Screenshot`. `Report` gains `targetType: "screenshot"` and `targetImageUrl`.
  - Endpoints: `GET/POST /api/games/{id}/screenshots` and `DELETE /api/screenshots/{id}`.
  - `/media/screenshots/*` serving, `Limit::Screenshot` (10/hour per user), the decode slots (503) and the per-user per-game cap (20).
- **ARCHITECTURE.md § F005 additions**: the capture pipeline diagram, why not `preserveDrawingBuffer` and why not `readPixels`, server re-encode, storage layout, migration `0009_f005.sql` (with the `reports` rebuild), file cleanup, `PLAYER_SCREENSHOT_EVENT`, and ownership.

## 4. Per-area tasks

### engine-dev (`packages/engine/**`, `examples/**`)
1. **`src/capture.ts`** (new):
   - `screenshotSize(w, h, maxSize = 1920): { width, height }`, a pure function implementing the output-size rule (GAME_FORMAT § F005).
   - `class FrameCapture`. It owns a single pending capture slot and a lazily created scratch canvas (`OffscreenCanvas` when available, else a detached `<canvas>`). Its methods:
     - `request(kind, opts): Promise<Blob | null>` queues one capture. A second call while one is queued or encoding fails fast with `busy`.
     - `grab(glCanvas, defaultSmooth)` is called by the engine at the capture point. It does `drawImage(glCanvas, 0, 0, glCanvas.width, glCanvas.height, 0, 0, outW, outH)`, with `imageSmoothingEnabled = defaultSmooth || !integerRatio` and `imageSmoothingQuality = "high"`.
     - Encoding uses `convertToBlob({ type: "image/png" })` or `toBlob`, which is async and runs after the frame.
     - Afterwards the scratch canvas is shrunk to 1×1.
     - A 2000 ms timeout applies when no frame reaches the capture point (hidden tab, rAF throttled).
     - A blob larger than 8 MiB counts as `failed`.
     - A `SecurityError` or a lost context counts as `failed`.
     - The grabber is injectable, so tests run without WebGL.
   - If `drawImage` of the WebGL canvas throws (very old WebKit), fall back to `gl.readPixels` into a `Uint8Array` at backing size, then flip rows, `putImageData` and scale. This keeps one code path for encoding.
2. **`engine.ts`**:
   - The capture point is in `render()`, right after `this.scenes.render(alpha); r.flush();` and **before** `drawDebug()`, the host pause overlay and the error overlay. Only when `state === "running"`.
   - In `start()`'s message switch, handle `webgame:screenshot-request` (validated `requestId`, 1–64 chars) by queuing a capture, then post `webgame:screenshot` with `source: "player"`, echoing `requestId`, or post `error: "unavailable" | "busy" | "failed"`.
   - `loading`/`error`/`destroyed` → `unavailable` immediately.
   - Public `captureFrame(opts?: { maxSize?: number }): Promise<Blob | null>`: `maxSize` is rounded and clamped to 64–4096 (invalid → 1920).
   - `destroy()` resolves every pending capture with `null`.
3. **`platform.ts`**:
   - `shareScreenshot(opts?: { caption?: string }): Promise<boolean>`. The caption is coerced to a string, control characters are removed, and it is cut to 140 code points.
   - It has a 3000 ms minimum interval between shares (earlier calls → `false` + warning) and needs a parent (`hasParent()`, else `false`).
   - It captures through the engine's `FrameCapture` (wire it via a setter, as storage is wired), posts `webgame:screenshot` with `source: "game"` and `requestId: "ss-<n>"`, and awaits `webgame:screenshot-result` through the existing pending map: `accepted === true` → `true`; an error, `accepted: false` or the 5000 ms timeout → `false`.
   - Extend `PlatformMessage`/`PlatformReply`, `handleReply` (new kind `ss`) and `cancelPending`.
4. **`index.ts`**: export the `ScreenshotOptions` and `ShareScreenshotOptions` types and `screenshotSize`.
5. **README.md**: a "Screenshots (F005)" section covering the three entry points, the size rule, what is excluded (debug overlay, pause overlay), the busy/timeout semantics, and a note that games must never put secrets on screen when calling `shareScreenshot` (the player can post it publicly).
6. **Examples**:
   - `space-dodge`: `P` (or gamepad Select) → `engine.platform.shareScreenshot({ caption: \`Score ${score} in Space Dodge\` })`. After a `personalBest` result, show "Press P to capture" for 3 s.
   - `pixel-peaks`: a "photo mode" on `P` that hides the HUD for one frame and then calls `shareScreenshot()`. It hides the HUD in `render()` while a flag is set, and calls after the next frame.
   - Repack the examples with `npm run examples`.
7. **Tests** (`test/capture.test.ts`, `test/platform.test.ts`):
   - the size rule table (320×180 → 1280×720, 800×600 → 800×600, 64×4096 → 30×1920 rounded, 3840×2160 → 1920×1080, maxSize clamp);
   - busy, the 2000 ms timeout and destroy (fake timers, fake grabber);
   - the request/reply message flow with a mock poster (echoed id; unknown id ignored; replies only from `window.parent`);
   - the `shareScreenshot` interval, caption sanitising, the `accepted: false` path, and no parent → `false`;
   - `captureFrame` in `loading` → `null`.

**Acceptance:** `npm test -w @webgame/engine`, `npm run typecheck -w @webgame/engine`, `npm run build:engine`, `npm run examples`. Manual: run space-dodge at `/play/{id}` with the F3 overlay on and press 📷: the overlay is not in the image, and the image size follows the rule.

### backend-dev (`backend/**`)
1. **Migration `backend/migrations/0009_f005.sql`** exactly as in ARCHITECTURE § F005: the `screenshots` table and indices, plus the `reports` rebuild that widens the `target_type` CHECK to `'screenshot'`. All existing rows and indices are preserved.
2. **Cargo**: add `image = { version = "0.25", default-features = false, features = ["png", "jpeg", "webp"] }`.
3. **`src/screenshots.rs`** (new): `process_screenshot(bytes) -> Result<Processed, AppError>`, run inside `spawn_blocking`.
   - Read the dimensions from the header first (`ImageReader::with_guessed_format()?.into_dimensions()`). Each side must be within 64–4096, else 422 "image must be between 64 and 4096 pixels per side".
   - Decode with `Limits { max_image_width: 4096, max_image_height: 4096, max_alloc: 128 MiB }`. A decode error → 422 "image could not be decoded".
   - Convert to RGB8 (alpha composited on black). Only the first frame of an animated image is used.
   - Encode the full image as PNG (`CompressionType::Fast`) when the sniffed input is PNG, else JPEG at quality 90. Encode the thumb: fit inside 480×480 (Triangle filter, never upscaled), JPEG at quality 80.
   - The output carries no metadata.
4. **Storage**:
   - `screenshots_dir()` = `data/screenshots`, created in `ensure_dirs`.
   - Write `{id}.{png|jpg}` and `{id}_t.jpg` through temp file + rename (as `replace_image`).
   - `remove_screenshot_files(id)` removes `{id}.png`, `{id}.jpg` and `{id}_t.jpg`.
5. **Routes** (`src/routes/screenshots.rs`):
   - `GET /api/games/{id}/screenshots` (🔓)
   - `POST /api/games/{id}/screenshots` (🔒)
   - `DELETE /api/screenshots/{id}` (🔒)
   Order for POST:
   1. auth
   2. game visible to the user (else 404)
   3. `limit_user(&state, Limit::Screenshot, &user.id)?` (the N5 pattern: after the visibility check, before reading the body)
   4. multipart (`image` required; `caption` optional, raw > 1 KB → 422; unknown fields ignored)
   5. `validate_image(&bytes, "image")` (413 / 422)
   6. caption rules
   7. per-user per-game count < 20 (422)
   8. `AppState.image_slots` (`Semaphore`, 2 permits, `try_acquire` → 503 `Retry-After: 5`)
   9. process
   10. write files
   11. a **guarded** `INSERT … SELECT … WHERE (SELECT COUNT(*) …) < 20`. 0 rows → remove the files, 422.
   12. 201 `Screenshot`
6. **`Limit::Screenshot`** in `ratelimit.rs`: 10/hour per user. Add it to the backend README rate-limit list.
7. **Serving**: `.nest_service("/media/screenshots", …)` wrapped in a layer that sets `Cache-Control: public, max-age=31536000, immutable`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`. ACAO `*` is kept, like other `/media` routes.
8. **Reports** (`routes/reports.rs`):
   - `targetType: "screenshot"`: the target must exist and its game must be visible to the reporter (else 404). `target_game_id` = the screenshot's game. `target_preview` = the caption's first 140 chars, else `"Screenshot by {displayName or username}"`.
   - `Report.targetImageUrl` = the screenshot's `thumbUrl` while the row exists, else `null` (`LEFT JOIN screenshots`). It is `null` for other target types.
   - Resolve: `delete` deletes the screenshot (row + files); `unpublish` → 422 (as for comments).
   - **Any** screenshot delete (author, owner, admin, resolve) marks that screenshot's open reports `resolved` / `delete`.
9. **Cleanup**:
   - `remove_game` selects the game's screenshot ids before deleting the row (cascade), then removes their files (best effort).
   - `sweep_stale_files` also removes files in `data/screenshots` whose id has no row, and stray `.*.tmp` files.
10. **Tests** (`tests/f005.rs`):
   - Upload png/jpg/webp, and check that the stored image has no `tEXt`/EXIF (upload a PNG carrying a `tEXt` chunk and a JPEG with an EXIF APP1; the stored files don't contain the marker bytes).
   - 63×63 and 4097×10 → 422; a bad decode → 422; > 2 MB → 413; an HTML file → 422.
   - The caption rules, including `\n` → 422 and a bidi control → 422.
   - Visibility: an unpublished game → 404 for others, OK for the owner.
   - The cap at 20 → 422; `RATE_LIMIT=on` with 11 uploads → 429 + `Retry-After`.
   - List paging and order; `canDelete` for author/owner/admin/other/anonymous.
   - Delete permissions (403 for others, 404 unknown) and that files are gone.
   - Reports on screenshots: create, duplicate → 409, `targetImageUrl`, resolve delete, unpublish → 422, and auto-resolve on author delete.
   - Game delete removes the files; the sweep removes orphans.
   - The migration upgrades a database with existing game + comment reports intact (same ids, statuses and indices).

**Acceptance:** `cd backend && cargo test` (all suites green, including `review_fixes.rs` and F001–F013) and `cargo clippy --all-targets -- -D warnings`.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **API client and types**:
   - `Screenshot`, `ScreenshotPage = Page<Screenshot>`
   - `listScreenshots(gameId, { page, perPage })`
   - `postScreenshot(gameId, blob, caption)` (multipart `image` + `caption`)
   - `deleteScreenshot(id)`
   - `ReportTargetType` gains `"screenshot"`, and `Report` gains `targetImageUrl`.
2. **`src/screenshot.ts`** (new, pure helpers with tests):
   - `launderImage(blob): Promise<{ blob: Blob; width; height }>`:
     - reject `size > 8 MiB`;
     - `createImageBitmap(blob)` (it throws on non-images);
     - each side 1–4096;
     - draw to a canvas and `toBlob("image/png")`, then close the bitmap.
   - `fitImageForUpload(blob, maxBytes = 2 * 1024 * 1024)`: the PNG as-is if small enough; else WebP 0.92, then JPEG 0.9, then shrink by 0.75 steps (max 4 steps); else throw.
   - `screenshotFileName(title, date)`.
   - `PLAYER_SCREENSHOT_EVENT = "webgame:player-screenshot"`, exported from `index.ts`.
3. **`GamePlayer.tsx`**:
   - The 📷 button and capture state.
   - Request flow: parent ids `ps-<n>`, one in flight, a 5 s timeout.
   - The `webgame:screenshot` handler, accepted only from `iframe.contentWindow`:
     - validate the shape;
     - `source: "player"` must match the in-flight id, else it is ignored;
     - launder and add to the tray.
   - For `source: "game"`:
     - rate limit: 1 per 3 s and 20 per mount, else reply `accepted: false, error: "rate_limited"`;
     - laundering failure → `error: "invalid"`;
     - success → `accepted: true`;
     - sanitise the caption (strip control/bidi characters, 140 code points).
   - Listen for `PLAYER_SCREENSHOT_EVENT` on `window` while mounted, and trigger the same flow as the button.
   - The original Blob from the iframe is **never** given an object URL, downloaded or uploaded. Only the laundered PNG is.
4. **Components** (new):
   - `ScreenshotTray.tsx`, `ScreenshotDialog.tsx` (tray item actions, § 2.2)
   - `ScreenshotGallery.tsx` (+ lightbox, § 2.3), mounted in `GamePage.tsx`.
   - Object URLs are revoked on evict and unmount.
5. **`StudioPreview.tsx`**: the same capture flow and tray, with Post/Thumbnail hidden. Factor the flow in step 3 into a shared hook `useScreenshotCapture(iframeRef, { mode: "player" | "studio" })` used by both.
6. **`Report.tsx` / `AdminPage.tsx`**: the screenshot target type, the thumbnail in the queue, and Dismiss/Delete only for screenshots.
7. **Set as thumbnail**:
   - From the tray: `fitImageForUpload(laundered)`.
   - From the gallery: `fetch(apiBase + imageUrl)` → `launderImage` → `fitImageForUpload`.
   - Then `PUT /api/games/{id}/thumbnail` (existing `Limit::Image` errors are surfaced).
8. **Styles**: tray, flash (`@media (prefers-reduced-motion: reduce)` disables it), gallery grid and lightbox in `styles.css`, using existing tokens.
9. **Docs page** (if the in-app docs page lists engine APIs): add `captureFrame` / `shareScreenshot`.
10. **Tests**:
   - `screenshot.test.ts`: fit steps with a mocked encoder, and file names.
   - `GamePlayer.f005.test.tsx`:
     - button → request posted to the iframe window;
     - a reply from another source is ignored;
     - a mismatched id is ignored;
     - timeout → toast;
     - game share rate limit → `rate_limited` reply;
     - an invalid blob → `invalid`;
     - `PLAYER_SCREENSHOT_EVENT` triggers capture;
     - no object URL is created for the raw blob (spy on `URL.createObjectURL`).
   - `ScreenshotGallery.test.tsx`: paging, delete visibility, report entry, empty state.
   - `ScreenshotDialog.test.tsx`: Post hidden in the Studio and disabled when anonymous; thumbnail confirm; 429/422/503 messages.
   - Admin: screenshot report rendering.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
1. **Menu** (`src-tauri/src/menu.rs`):
   - Add View → "Take &Screenshot" with id `"screenshot"`, accelerator `CmdOrCtrl+Shift+S`.
   - Add `"screenshot"` to `FORWARDED` and update the module doc and the test.
2. **`src/nativeMenu.ts`**: on `"screenshot"`, `window.dispatchEvent(new CustomEvent(PLAYER_SCREENSHOT_EVENT))` (import the constant from `@webgame/ui`). Do not navigate.
3. **`save.rs`**:
   - When the sanitised name's extension is `png|jpg|jpeg|webp`, call `set_directory(dir)`. `dir` is the last directory used for an image save in this session (an in-memory `Mutex<Option<PathBuf>>` in managed state), else `app.path().picture_dir()` when it exists. Otherwise there is no directory hint (current behaviour).
   - Update the remembered directory after a successful image save.
   - Extract `fn image_save_dir(ext, last, pictures) -> Option<PathBuf>` as a pure function with unit tests.
4. **Verify**: the player and the Studio preview capture, the Download uses the native dialog, Copy works in the Tauri webview (or is hidden when `ClipboardItem` is missing), and the accelerator works while the iframe has focus.

**Acceptance:** `npm run build -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test && cargo check`.

### Sequencing
- The engine and backend parts are independent and can start in parallel.
- Frontend can build the tray, gallery and dialogs against mocks at once. The end-to-end capture needs the engine build, and posting needs the backend.
- Desktop needs only the exported `PLAYER_SCREENSHOT_EVENT` constant, which frontend lands first (a one-line change).

## 5. Edge cases and security
- **Untrusted pixels and blobs**:
  - The iframe controls the Blob's bytes and its `type`. An object URL created by the parent has the **parent's origin**, so opening a blob that is really `text/html` or SVG would run script as the app.
  - Rule: the parent decodes with `createImageBitmap` and re-encodes to PNG before any object URL, download, clipboard write or upload. The raw blob is dropped.
  - The server never trusts the client either: `validate_image`, a dimensions check, then decode + re-encode (polyglots and metadata don't survive).
  - Stored files are served with `nosniff` and `CSP: sandbox` under unguessable UUID names.
- **Sandbox model unchanged**:
  - No `allow-same-origin` and no new iframe permissions.
  - The game never receives API data or URLs for screenshots. `webgame:screenshot-result` carries only `accepted` and an error code.
  - The game can't post, download or set thumbnails. Only user clicks in the parent do that.
- **Flooding**:
  - Engine: one capture at a time, and shares 3 s apart.
  - Parent: game shares at 1 per 3 s and 20 per mount, a tray of 12 items, and blobs of 8 MiB max.
  - Backend: `Limit::Screenshot` 10/hour per user, 20 stored per user per game, 2 decode slots (503), and the 2 MB upload cap.
  - A game spamming `webgame:screenshot` with `source: "player"` and made-up ids gets them ignored.
- **Capture timing**:
  - With `preserveDrawingBuffer: false`, the drawing buffer is only valid inside the task that rendered it. Captures are therefore queued and fulfilled inside `tick` at the capture point, never from a message handler.
  - A hidden tab (rAF stopped) → a 2 s engine timeout → `unavailable`.
  - Paused by host: the frame still renders, and the pause overlay is not in the image.
  - A game that draws nothing (`background: null`, no clear) captures whatever is in the buffer, which may be black. That is acceptable.
- **Lost context / crash**: `failed` or `unavailable`. The player shows the toast and the game keeps running.
- **Huge logical resolution** (4096×4096): the output is capped to 1920. Encoding a 1920×1920 PNG may take ~100 ms off the frame, which is acceptable for a user action.
- **Game deleted or unpublished** while a dialog is open: the post returns 404 → toast "This game is no longer available".
- **Account or game deletion**: rows cascade, and files are removed by `remove_game` or the startup sweep.
- **Unpublished game media**: a screenshot URL stays fetchable by direct link after unpublishing, like thumbnails. The ids are unguessable, and listing endpoints hide it.
- **Privacy**:
  - Nothing leaves the device until the user clicks Post or Set as thumbnail.
  - Posted screenshots are public on published games, and the dialog says "Visible to everyone on the game page".
  - Images may show other players' display names (F001 in-game boards). These are already public.
  - Re-encoding strips EXIF, XMP and text chunks.
  - The author can delete at any time, and the game owner and admins can also delete.
  - Tray items are never persisted.
  - Creators: README warns not to render secrets in frames passed to `shareScreenshot`.
- **Older engine builds**: a cached older `engine.js` won't answer → 5 s timeout → "This game can't take screenshots right now". The engine is served `no-cache` + ETag (R6), so this is rare.

## 6. Test expectations
- **Engine**: the size rule, busy/timeout/destroy, the message flow, the share interval and caption sanitising, and the capture point excluding overlays (via a fake renderer recording the call order: game render → flush → grab → debug).
- **Backend**: `tests/f005.rs` as listed (upload formats and limits, metadata stripping, visibility, cap and rate limit, permissions, reports, cleanup, migration upgrade). All previous suites stay green.
- **UI**: laundering is always applied (no raw object URLs), the request/reply validation, the tray limits, the gallery and dialog behaviour, the admin rendering, and `fitImageForUpload`.
- **Desktop**: `image_save_dir` unit tests, the menu `FORWARDED` test, and a green build. Manual: the accelerator while the iframe has focus, and the Pictures default.
- **Manual end to end**:
  - Capture in the web player and the desktop player.
  - Post with a caption and see it in the gallery.
  - Report it and delete it as admin.
  - Set the thumbnail as owner and see the card update.
  - Studio capture and download.
  - The examples' P key on space-dodge and pixel-peaks.

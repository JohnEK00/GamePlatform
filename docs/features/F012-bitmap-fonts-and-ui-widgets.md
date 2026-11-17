# F012: Engine bitmap fonts, 9-slice and UI widgets

Status: **shipped**. Size: **M** (engine is the main area; frontend small to medium; backend and desktop small; one round). Areas: engine (+ examples), frontend, backend, desktop.
Contracts: `docs/GAME_FORMAT.md` § F012 additions (the `.fnt` bundle extension, the BMFont formats and limits, the built-in `pixel` font, `drawText` with bitmap fonts, `NineSlice`/`drawNineSlice`, `engine.ui`, the frame order), `docs/API.md` § F012 additions (the bundle allowlist and the files `Content-Type`), `docs/ARCHITECTURE.md` § F012 additions (engine modules, the font registry, the frame order, the allowlist copies, ownership).
Depends on: nothing unshipped. It reuses `Texture`/`SpriteSheet`, the renderer's batching and atlas pages, the F009 action map (for menu navigation) and the F005 capture point. **No migration, no new endpoints, no rate limit changes, no new Rust or JS dependencies.**

## 1. Goal and user stories
All text in Pixelforge goes through one path: a canvas-rasterised, mipmapped font atlas. It is fine for large smooth text, but pixel-art games at 320×180 or 480×270 get blurry, anti-aliased HUD text that does not match their art. Creators can't use the bitmap fonts that every pixel-art tool exports. Menus and dialogs are also hand-rolled in every game: each example and template has its own "press any key" screen, and none has a clickable or gamepad-navigable menu. A panel with a decorated border has to be built from rectangles, because there is no way to stretch a framed image without distorting its corners.

F012 adds three engine features:
- **Bitmap fonts**:
  - `assets.loadBitmapFont(name, path)` loads AngelCode BMFont descriptors in the text (`.fnt`) or JSON (`.json`) format, with their PNG pages.
  - `assets.gridFont(name, texture, opts)` builds a monospace font from a grid of glyphs, such as a sprite sheet.
  - The engine has a built-in crisp **`pixel`** font: 5×7 glyphs covering ASCII, with no asset needed.
  - All of them work with the existing `drawText`/`measureText` through the `font` option, including align, baseline, wrap, shadow and letter spacing. BMFont kerning is applied.
- **9-slice**: `new engine.NineSlice(texture, insets)`, `assets.loadNineSlice(path, insets)` and `renderer.drawNineSlice(...)` stretch a framed image to any size while keeping its corners. A `scale` option draws crisp pixel-art borders at 2× or 3×.
- **`engine.ui`**: a small immediate-mode helper with `ui.panel`, `ui.label` and `ui.button`.
  - Buttons react to the mouse and touch.
  - They can also be navigated with the keyboard and gamepad. Navigation follows the game's remappable F009 `up`/`down`/`left`/`right`/`confirm` actions when they are declared.
  - Widgets have a theme that can use 9-slices and bitmap fonts.
  - They are drawn in screen space after the game's render and before the screenshot capture point.

The platform changes are small:
- `.fnt` becomes an allowed bundle file extension. It is served as `text/plain` and treated as a text file by the Studio and the desktop folder opener.
- The Studio gets a "Menu & HUD" template.
- The docs page gets a section on fonts and menus.
- Pixel Peaks is upgraded to show the new features.

User stories:
1. As a pixel-art creator, I write `r.drawText("SCORE " + score, 4, 4, { font: "pixel" })` and get sharp 1-pixel text at 480×270 with no asset. With `size: 16` it is exactly 2× and still sharp.
2. As a creator, I export a font from Hiero, BMFont or Snowb as `title.fnt` + `title_0.png` and drop both into my bundle. `await engine.assets.loadBitmapFont("title", "assets/title.fnt")`, then `drawText("GAME OVER", W / 2, 80, { font: "title", align: "center" })`, renders my font with its kerning.
3. As a creator with a retro sprite sheet of letters, I call `engine.assets.gridFont("retro", sheetTexture, { cellW: 8, cellH: 8, chars: " !\"#…ABC…" })` and use it like any other font.
4. As a creator, I load a 24×24 frame image with 8-pixel corners as a `NineSlice`. I draw a 200×120 dialog box and a 90×24 button from the same image, and the corners are not stretched.
5. As a creator, my title screen calls `if (engine.ui.button("play", "PLAY", 190, 140, 100, 24)) start()` in `update`. Mouse, touch, arrow keys + Enter, and the gamepad D-pad + A all work. A player who remapped `confirm` to `K` in the ⌨ panel presses `K`.
6. As a player on a controller, I press D-pad down on a menu. A visible focus ring appears on the first button, and A activates it.
7. As a Studio user, I start from the "Menu & HUD" template and see a working title menu, pause menu and pixel-font HUD that I can restyle.
8. As a creator, I drag `title.fnt` into the Studio's asset list. It is accepted, opens in the code editor as text, and is published with the bundle.

Non-goals (later items): BMFont XML descriptors (a clear error tells the creator to export text or JSON), signed-distance-field and MSDF fonts (they are drawn as plain bitmaps, with a warning), channel-packed fonts, rich text (inline colours or icons), text input fields, sliders, toggles, scroll lists, layout containers (rows and columns), tiled (repeating) 9-slice centres, and rotated 9-slices. These are candidates for a follow-up (roadmap F019).

## 2. UX notes

### 2.1 In games (engine)
- **Crispness rule.** A bitmap font with nearest filtering (the default) is drawn with its line origin rounded to whole game units, so glyph texels map to whole pixels at integer sizes. Recommended sizes are multiples of the font's native size (`pixel`: 8, 16, 24…). Non-integer scales work but may shimmer.
- **Focus ring.** Keyboard and gamepad navigation shows a 2-unit ring in `theme.focusColor` around the focused button. Focus is hidden until the player first presses a navigation key. A pointer press clears it again, which matches browser `:focus-visible` behaviour.
- **Feedback states.** Buttons have normal, hover (pointer over), down (pressed and pointer still over) and disabled states. Disabled buttons are drawn at 50 % alpha with `theme.disabledTextColor` and never react.
- **Default theme.** Without any assets, widgets use the engine's default font and flat colours that fit the engine's own loading screen: panel `#141a2e` with a `#3a4470` border, button `#2a3358`/hover `#3a4780`/down `#1e2540` with a `#5a6bc0` border, white text, focus `#ffd166`. Games restyle by assigning `engine.ui.theme` fields.

### 2.2 Studio (frontend)
- **New template "Menu & HUD"** (id `menu-hud`; 480×270; pixel art). It contains:
  - A title menu with `ui.button`s "PLAY", "SOUND: ON/OFF" and "HOW TO PLAY", stacked vertically.
  - A short star-catching game: move with `left`/`right`, the HUD uses the `pixel` font at `size: 8`, and the score goes to `submitScore`.
  - A pause menu opened by the `pause` action. It is a `ui.panel` with "RESUME" and "QUIT".
  - A game-over panel.
  - The panel and button frames are 9-slices built from procedural textures (`assets.createTexture`), because templates ship no asset files.

  game.json declares `left`, `right`, `up`, `down` (Arrows + WASD; D-pad), `confirm` (`Enter`, `Space`; `A`) and `pause` (`KeyP`; `Start`). It uses `KeyP` because `Escape` is not bindable (F009). There are no achievements, and `controls` reads "Arrows or WASD to move, Enter to choose, P to pause. Remap keys with ⌨." The code has short comments that point at the docs section.
- **`.fnt` files** are accepted by "Add asset", opened as text in the code editor and included in publish, export and zip open. The toast for an invalid new-file name lists `.fnt` among the text types.
- **Docs page**: a new section "16. Text, fonts and menus". It covers:
  - the built-in `pixel` font and the crispness rule;
  - a `loadBitmapFont` snippet, the exporter settings (text or JSON format, PNG pages, no channel packing) and `gridFont`;
  - a `NineSlice` snippet;
  - a `ui.button` menu snippet, the "call widgets from `update`" rule and `{ nav: false }` for HUD buttons during play;
  - the bundle layout line, which gains `fnt`.

### 2.3 Desktop
- Nothing new in the UI. A local folder opened in the Studio (F013 `localFolder`) passes `.fnt` files as text, and "↻ Reload folder" picks them up.

## 3. Contract changes (summary; normative text lives in docs/)
- **GAME_FORMAT.md § F012 additions**:
  - The `.fnt` bundle extension.
  - Engine API: `assets.loadBitmapFont`, `assets.gridFont`, `renderer.addBitmapFont`, `renderer.hasFont`, the `BitmapFont` read-only surface, the built-in `pixel` font metrics, and `drawText`/`measureText` semantics for bitmap fonts.
  - `NineSlice`, `assets.loadNineSlice`, `renderer.drawNineSlice` and the shrink rule.
  - `engine.ui` (widgets, theme, activation and navigation rules, phase rules, draw order).
  - The frame order, with the UI layer before the F005 capture point.
  - The accepted BMFont formats, limits and error messages.
  - **No new messages, no game.json keys, no boot options.**
- **API.md § F012 additions**: `fnt` in the bundle allowlist (upload and replace); `GET /games/{id}/files/*.fnt` → `Content-Type: text/plain; charset=utf-8` (plus the existing `nosniff` and CSP sandbox); F013 bundle export is unchanged. No new types, endpoints or limits.
- **ARCHITECTURE.md § F012 additions**: new engine modules, the font registry, the frame order, the five copies of the extension allowlist, ownership.

## 4. Per-area tasks

### engine-dev (`packages/engine/**`, `examples/**`)
1. **`src/bmfont.ts`** (new, pure, no DOM):
   - `parseBMFont(source: string | object, path?: string): BitmapFontData`. It accepts the text format and the JSON format (GAME_FORMAT § F012 "Accepted descriptors").
     - A string starting with `{` is parsed as JSON. A string starting with `<` (after trimming whitespace and a BOM) throws.
     - Every rule in the limits table is enforced.
     - Errors are `Error`s whose message starts with `BMFont "{path}": `.
   - `BitmapFontData`, `BitmapGlyph` and `Kerning` types per GAME_FORMAT.
   - `class BitmapFont`: built from `BitmapFontData` plus page `Texture[]`. It has `glyph(codePoint)` (a Map lookup), `kerning(a, b)` (a Map keyed `a * 0x110000 + b`) and the read-only fields in GAME_FORMAT. `BitmapFont.grid(name, texture, opts)` builds the grid font.
   - `layoutText(font: FontMetricsSource, text, opts) → { lines: { glyphs: { page, x, y, w, h, u0, v0, u1, v1 }[]; width: number }[]; width; height }`. It is a pure layout function used by both `drawText` and `measureText`, for bitmap fonts only, and it covers kerning, letter spacing, wrapping, alignment, baseline, snapping and the missing-glyph fallback.
2. **`src/pixelfont.ts`** (new): the built-in `pixel` font.
   - Glyphs for ASCII 32–126 are stored as a compact bit table (each glyph is 5 columns × up to 9 rows), with the metrics in GAME_FORMAT § F012.
   - The glyph data must be hand-authored or CC0. Record the source in README.md.
   - Its texture is built lazily, on the first use of `font: "pixel"` or `ui.theme.font = "pixel"`: an `ImageData` uploaded through `renderer.createTexture(…, { atlas: true })`, so it batches with sprites. No canvas text APIs are used.
3. **`src/renderer.ts`**:
   - Generalise the font registry to hold either the existing canvas `FontAtlas` or a `BitmapFont`, behind one internal interface.
   - `setFont(name, …)` and `addBitmapFont(name, font)` replace an existing entry of either kind (flushing first). Neither may replace `default`, `mono` or `pixel`: replacing them throws `Error("font name \"…\" is reserved")`. **Exception:** `setFont("default" | "mono", …)` keeps working as today, for compatibility.
   - `hasFont(name)`.
   - `drawText`/`measureText` with a bitmap font follow GAME_FORMAT exactly: the default `size` is the font's native size, line height, rounding (snapping), kerning, `?` fallback, one warning per font for missing glyphs, and `shadow` drawn as a second pass. Canvas-font behaviour is **unchanged** (pixel-compare is not required; existing tests must pass).
   - `drawNineSlice(src, x, y, w, h, opts?)` per GAME_FORMAT, using the pure `nineSliceQuads` (below). It emits up to 9 quads on the source texture's page, counts as one sprite in `counter`, and keeps batching (no flush unless the page changes).
4. **`src/nineslice.ts`** (new):
   - `class NineSlice` (validation in the constructor).
   - `nineSliceQuads(src: { width, height, u0, v0, u1, v1 }, insets, x, y, w, h, scale, center) → { x, y, w, h, u0, v0, u1, v1 }[]`, pure and applying the shrink rule. Zero-area quads are omitted.
5. **`src/ui.ts`** (new): `class Ui`, constructed with injected dependencies so it can be tested without the DOM:
   - `{ input: { mouse, actions, actionDown/Pressed, isDown/wasPressed, gamepad(0) }`
   - `renderer: { drawNineSlice, drawRect, strokeRect, drawText, measureText, ui(fn) }`
   - `warn }`

   It implements every rule in GAME_FORMAT § F012 `engine.ui`: the per-step command list (`beginStep`/`endStep`, the committed list), hit testing, `hot`/`active`/`focus`, activation edges, navigation with the action fallback (check `input.actions.some(a => a.id === id)` **before** calling `actionPressed`, so F009's unknown-id warning never fires), duplicate-id and render-phase warnings (once each per id), `autoDraw`/`draw()`, and the theme defaults.
6. **`src/assets.ts`**:
   - `loadBitmapFont(name, path, opts?: { smooth?: boolean })`:
     - Fetch the descriptor through `fetchOk` (`files` first). Its body must be ≤ 1 MiB (check `Content-Length` when present and the text length).
     - `parseBMFont`, then resolve each page path relative to the descriptor's directory with `normalizePath`. Pages must be png, webp, gif or jpg/jpeg, and must stay inside the bundle.
     - Load the pages with `loadTexture(page, { smooth, atlas: !smooth })`, check each page's real size against glyph rects (out-of-bounds glyphs are dropped with one warning), build the `BitmapFont`, `renderer.addBitmapFont(name, font)` and resolve it.
     - Cache key `bmfont:{name}:{path}:{smooth}`.
   - `gridFont(name, texture, opts)` is synchronous and returns `BitmapFont`.
   - `loadNineSlice(path, insets, opts?: TextureOptions)` loads the texture and returns `new NineSlice(...)`.
7. **`src/engine.ts`**:
   - `readonly ui: Ui` and `readonly NineSlice = NineSlice`.
   - In `step`: `ui.beginStep()` after `input.beginStep()`, and `ui.endStep()` before `input.endStep()`.
   - In `render`: set the phase to `render` around `game.render` and `scenes.render`. After `scenes.render`, if `ui.autoDraw` and `ui.draw()` was not already called this frame, draw the committed list (screen space, `normal` blend), **then** the existing flush and capture point.
   - The phase is `update` only inside `step`. `load` and everything else count as `other`: widgets called there draw nothing and return `false`, with the render-phase warning.
8. **`src/files.ts`**: `fnt: 'text/plain'` in `MIME`. **`vite.config.ts`**: `'.fnt': 'text/plain'` in the dev harness MIME map.
9. **`src/index.ts`**: export `BitmapFont`, `parseBMFont`, `layoutText`, `NineSlice`, `nineSliceQuads` and `Ui`, plus the types `BitmapFontData`, `BitmapGlyph`, `Kerning`, `GridFontOptions`, `Insets`, `NineSliceOptions`, `UiTheme` and `ButtonOptions`.
10. **README.md**:
    - Extend `engine.renderer` (bitmap fonts, `drawNineSlice`) and `engine.assets` (`loadBitmapFont`, `gridFont`, `loadNineSlice`).
    - Add a new "UI widgets (F012)" section: widgets, the theme, the update-only rule, navigation and actions, `{ nav: false }`, and `autoDraw`/`draw()`.
    - Add the crispness rule, recommended exporter settings and the `pixel` glyph source.
11. **Example, `examples/pixel-peaks`**:
    - HUD text (coins, score, time, pops, MUTED) uses `font: "pixel"` at `size: 8` (score pops may use 8 too).
    - The title and level banners use a committed BMFont: `assets/fonts/peaks.fnt` (text format) + `assets/fonts/peaks_0.png`, a 1-px-outlined, two-tone variant of the pixel glyphs. Generate them with a dependency-free script `packages/engine/scripts/gen-bitmap-font.mjs` (Node `zlib` for PNG), commit both outputs and the script, and include at least a few kerning pairs (e.g. `AV`, `LT`) so kerning is exercised.
    - `TitleScene` becomes a menu: `ui.button` "PLAY" and "SOUND: ON/OFF", stacked, navigable. Keep the `actionLabel` controls line.
    - `MessageScene` draws its box with `ui.panel` and a 9-slice `assets/ui/panel.png` (a 12×12, 4-px frame, generated by the same script), using `theme.nineSliceScale = 2`, and keeps "press any key".
    - The on-screen touch buttons stay as they are, so the gameplay input path does not change.
    - Repack with `npm run examples`. The bundle must pass the backend allowlist (`.fnt` is new, so the backend change must land before the repacked zip is seeded).
12. **Tests** (`test/bmfont.test.ts`, `test/nineslice.test.ts`, `test/ui.test.ts`; node environment, no WebGL):
    - `parseBMFont`:
      - A text descriptor with quoted values containing spaces, `size=-32`, two pages and kernings.
      - The equivalent JSON gives an identical `BitmapFontData`.
      - The XML string throws the "XML is not supported" message.
      - Each limit violation throws: 0 or 17 pages, 8193 chars, 65537 kernings, a missing `common`, negative `width`, `page` out of range, a code point > 0x10FFFF, a non-numeric field, and `packed=1`. A fractional field (`xoffset=1.6`) is rounded, not rejected.
      - A duplicate char id keeps the first and records a warning.
      - `distanceField` is accepted with a warning.
    - `layoutText`:
      - Native-size default, `size: 16` → scale 2, `letterSpacing`, kerning applied between pairs only, and `\n`.
      - `maxWidth` wrap at spaces, and a word longer than `maxWidth` stays on its own line.
      - The three aligns and three baselines, and snapping on and off (`smooth`).
      - A missing glyph uses `?`, or advances by half the native size when there is no `?`. Measure width equals laid-out width.
    - The `pixel` font table: 95 glyphs, metrics per GAME_FORMAT, and no glyph wider than 5 or taller than 9.
    - `gridFont`: the chars map to cells in order, with `spacing`/`margin`; and rejects `chars` longer than the cell count or a duplicate char.
    - `nineSliceQuads`:
      - 9 quads, UVs at the inset boundaries, and `scale: 2` borders.
      - Shrink when `w < (l+r)·scale` (the centre column is omitted), `center: false` → 8 quads, and `w`/`h` ≤ 0 → none.
      - `NineSlice` constructor errors.
    - `Ui` with a fake input and a recording renderer:
      - Click = press inside + release inside → `true` exactly once; release outside → `false`; press outside then release inside → `false`.
      - A disabled button never activates; a duplicate id warns once.
      - Navigation: down from no focus → the first nav button; wrap; up → the last; `{ nav: false }` and disabled are skipped; the declared `confirm` action is used instead of Enter, and Enter is ignored when `confirm` is declared; gamepad Down/A; Escape/B clear focus.
      - Focus is cleared when the focused id is not declared in a step; a pointer press clears focus.
      - Phases: a call during render draws immediately, returns `false` and warns once.
      - The committed list survives steps with no `beginStep` (paused) and is replaced (possibly by an empty list) by the next step.
      - `autoDraw = false` without `draw()` draws nothing; `draw()` twice in a frame draws once.
    - The `files.ts` MIME for `.fnt`.

**Acceptance:** `npm test -w @webgame/engine`, `npm run typecheck -w @webgame/engine`, `npm run build:engine`, `npm run examples`. Manual (dev harness `npm run dev -w @webgame/engine`):
- Pixel Peaks shows crisp HUD text, an outlined title font with visible kerning, and a 9-slice message box.
- The title menu works with the mouse, arrows + Enter, and a gamepad.
- F3 shows fewer draw calls than or the same number as before on the HUD.
- A 📷 capture includes the menu.

### backend-dev (`backend/**`)
1. **`src/bundle.rs`**: add `"fnt"` to `ALLOWED_EXTS` (keep the order, append after `"ttf"`). The 422 message, which lists the allowed extensions, picks it up automatically.
2. **`src/routes/files.rs`** `mime_for`: `"fnt" => "text/plain; charset=utf-8"`, explicit (do not rely on `mime_guess`). The existing `nosniff`, CSP sandbox and `Access-Control-Allow-Origin: *` headers apply unchanged.
3. **`src/export.rs`**: nothing to change (`.fnt` is text and is not in `STORED_EXTS`, so it is deflated). Verify with a test.
4. **Tests** (`tests/f012.rs`):
   - Upload a bundle containing `assets/f.fnt` + `assets/f_0.png` → 201. `GET /games/{id}/files/assets/f.fnt` → 200, `Content-Type: text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`, body identical.
   - A bundle replace with a `.fnt` → 200.
   - A bundle with `assets/f.xml` → still 422 `validation`, and the message lists `fnt`.
   - The F013 owner export of a bundle with a `.fnt` round-trips the file byte for byte.
   - When `examples/dist/pixel-peaks.zip` is present, it uploads successfully (follow the `f009.rs` pattern).

**Acceptance:** `cd backend && cargo test` (all suites green) and `cargo clippy --all-targets -- -D warnings`. No new crates, no migration.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **`src/studio/project.ts`**: add `"fnt"` to `ALLOWED_EXTENSIONS` and `TEXT_EXTENSIONS`. `StudioPage.tsx`: the "New files must be …" toast lists `.fnt`. `ASSET_ACCEPT` picks it up automatically. Check that `CodeEditor` opens `.fnt` as plain text (no syntax mode needed).
2. **`src/studio/templates.ts`**: the `menu-hud` template (§ 2.2), appended to `STUDIO_TEMPLATES`. Its `main.js` uses only the documented F012 API (`engine.ui.*`, `engine.NineSlice`, `assets.createTexture`, `font: "pixel"`), F009 actions and `submitScore`. Update the file header comment ("No asset files are needed" still holds).
3. **`src/pages/DocsPage.tsx`**: section "16. Text, fonts and menus" (§ 2.2), plus `fnt` in the bundle layout block (line ~131) and a `drawNineSlice` / `font` mention in "4. Engine API at a glance" → renderer and assets.
4. **Tests**:
   - `project.f013.test.ts` (or a new `project.f012.test.ts`): `isTextPath("assets/a.fnt")`, and a project with a `.fnt` survives zip export → open with the file as a string.
   - The template tests that iterate `STUDIO_TEMPLATES` (`controls.test.ts` validateActions, `zip.review.test.ts`) cover `menu-hud` automatically; add an assertion that `menu-hud` declares a `confirm` action and that its `main.js` contains `engine.ui.button(`.
   - `Studio.test.tsx`: the template picker lists "Menu & HUD", and adding an asset named `font.fnt` is accepted.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`. Manual: create a project from "Menu & HUD", play it in the preview with the mouse, keys and the ⌨ remap of `confirm`, then publish it.

### desktop-dev (`apps/desktop/**`)
1. **`src-tauri/src/project.rs`**: add `"fnt"` to `ALLOWED_EXTS` and `TEXT_EXTS`, and extend the existing unit test (or add one) so that a folder containing `a.fnt` yields it as a text entry.
2. **Verify**:
   - Open `examples/pixel-peaks` as a local folder in the desktop Studio: the preview loads the BMFont and the panel.
   - "↻ Reload folder" after editing `peaks.fnt` on disk reloads it.
   - Pixel Peaks played from the server shows the same rendering as on the web.

**Acceptance:** `cd apps/desktop/src-tauri && cargo test && cargo check`, `npm run build -w @webgame/desktop`.

### Sequencing
- All four areas can start in parallel.
- The allowlist change (backend, frontend, desktop) is tiny and must be merged **before** the repacked Pixel Peaks zip is seeded or uploaded, because an old backend rejects `.fnt` with a 422.
- The frontend template needs the engine build to be playable in the preview. The UI unit tests do not.

## 5. Edge cases and security
- **Untrusted descriptors run only in the game's own sandbox.** Parsing happens in the opaque-origin iframe, so a malicious descriptor can only hurt its own game. The limits (1 MiB descriptor, ≤ 16 pages, ≤ 8192 chars, ≤ 65536 kernings, numeric fields within −32768..32767, `common.scaleW/scaleH` 1–8192) bound memory and CPU anyway, so a broken export fails fast with a readable message instead of freezing the tab.
- **Page paths** are resolved relative to the descriptor and normalised with `normalizePath`. Paths that escape the bundle root, absolute URLs (`http:`, `data:`, `blob:`) and non-image extensions are rejected with an error. The engine never fetches outside `baseUrl`/`files`.
- **`.fnt` on the files origin** is served as `text/plain; charset=utf-8` with `nosniff` and the existing CSP sandbox, exactly like `.txt`, so it can't be interpreted as HTML or script. Upload validation (size, count, traversal) is unchanged.
- **XML BMFont**: the descriptor is rejected with "BMFont XML is not supported; export the text or JSON format" rather than guessed at. The engine never uses `DOMParser` on bundle content.
- **Glyphs outside the real page size** (the descriptor claims `scaleW` 512 but the PNG is 256): those glyphs are dropped with one warning, so their UVs never sample a neighbouring atlas image.
- **Atlas bleeding**: bitmap font pages and 9-slices from smooth textures use `atlas: false`, so linear filtering can't sample neighbours. With nearest filtering, atlas packing is safe, because the packer pads by 2 px.
- **Unicode**: text is iterated by code point (`for…of`), so surrogate pairs map to one glyph. Control characters other than `\n` are skipped, and `\r\n` counts as one newline. The `pixel` font has ASCII only, and anything else renders as `?`.
- **Reserved font names** (`default`, `mono`, `pixel`): `addBitmapFont`/`gridFont`/`loadBitmapFont` with them throw, so the engine's debug overlay, loading screen and paused overlay always render.
- **UI input conflicts**:
  - Navigation keys are the game's keys too. A game that shows buttons **during gameplay** (a HUD pause button) should pass `{ nav: false }`. Otherwise an arrow press would show a focus ring and Enter/Space or `confirm` would activate it.
  - Focus is never set until a navigation key is pressed while at least one nav-enabled button exists, so games with no menu on screen are unaffected.
  - `Tab` is deliberately not a navigation key: it must keep moving browser focus, for accessibility.
- **Immediate-mode latency**: navigation uses the button order of the previous step, so a menu that appears this step can be navigated from the next step on (1/60 s). Activation by pointer is decided within the step of the release.
- **Fixed-step vs render**: widgets are logic plus queued drawing in `update`. With 0 steps in a frame (high refresh rate) the previous list is redrawn. With several steps, the last list wins, and an activation in an earlier step is still returned by that step's call.
- **Pause**: while the host or author pause is active, no steps run, so the committed UI stays visible but inert. The host "PAUSED" overlay is drawn on top of it.
- **Screenshots**: the UI layer is game content and is drawn before the capture point, so screenshots include menus. The debug and paused overlays are still excluded.
- **Camera**: widgets always use screen space. Games with a zoomed camera don't need to convert coordinates; `input.mouse` is already in screen-space game units.
- **Performance**: a 9-slice is ≤ 54 vertices. Text with a bitmap font batches per page. The UI list is rebuilt each step with plain objects (at most 256 commands per step; more are dropped with one warning, to bound accidental per-frame growth).
- **Compatibility**: existing games are unaffected. `drawText` defaults (canvas `default` font, size 16) do not change. `engine.ui` and `engine.NineSlice` are new names on the engine instance. A bundle that set `engine.ui = …` itself would now hit a read-only property; this is acceptable, since nothing in the examples or templates does it.

## 6. Test expectations
- **Engine**: as in engine task 12. Pure modules (`bmfont.ts`, `nineslice.ts`, `ui.ts`, `layoutText`, the `pixel` table) are fully covered in the node environment. Existing suites (`world`, `capture`, `input`, `actions`, `platform`, `debug`, `files`) stay green, and the capture tests still pass with the UI layer added before the capture point.
- **Backend**: `tests/f012.rs` as listed; all earlier suites green.
- **UI**: the `.fnt` text handling, the template checks and the Studio picker. Existing template-iterating tests stay green.
- **Desktop**: the `project.rs` unit test and green builds.
- **Manual end to end**:
  - Upload the repacked Pixel Peaks on the web: the HUD is crisp at every window size with integer scaling, the title font shows its outline and kerning, and the menu works with the mouse, touch (devtools emulation), keys and a gamepad.
  - Pixel Peaks declares no `confirm` action, so Enter/Space activate its menu. In the "Menu & HUD" template, remap `confirm` to `K` in the preview ⌨ panel: `K` activates and Enter no longer does.
  - Take a 📷 screenshot on the title: the menu is in the image, and F3 stats are not.
  - Upload a bundle with an XML `.fnt`: the game shows the engine error overlay with the "XML is not supported" message (the upload itself succeeds, because the backend does not parse fonts).
  - Desktop: open the Pixel Peaks folder in the Studio and edit `peaks.fnt` (change an `xadvance`), then reload: the spacing changes.

# F019: Engine UI widgets 2: slider, toggle, text field and list

Status: **shipped**. Size: **M** (engine is the main area; frontend small: one template and one docs subsection; backend and desktop verification only; one round). Areas: engine (+ examples), frontend, backend (verification only), desktop (verification only).
Contracts: `docs/GAME_FORMAT.md` § F019 additions (the four widgets, theme fields, the navigation table, text editing, change signals, `input.textEvents`, `input.keyboardCaptured`, exact warning texts), `docs/API.md` § F019 additions (no changes), `docs/ARCHITECTURE.md` § F019 additions (modules, widget state, step order, capture design, ownership).
Depends on: F012 (`engine.ui`, theme, phases, navigation), F009 (actions), F016 (`lastDevice`, the resume latch, fixed gamepad fallbacks) and review 5 (cancelled releases), all shipped. **No migration** (the next free number stays `0021`), no endpoints, no messages, **no new Rust or JS dependencies.**

## 0. Decisions on ambiguities (read first)
The last rounds lost time on wording and edge cases. These are settled here; GAME_FORMAT § F019 is normative.
1. **Value in, value out.** Widgets take the game's value and return the new one (`v = ui.slider(id, v, …)`), like F012 buttons return activations. The engine keeps only interaction state per id. There is no retained "model" object.
2. **"Changed" vs "committed".** `ui.changed(id)` = the player changed the value this step; `ui.committed(id)` = the player finished (drag released, key step, toggle flip, `Enter` in a field, row activated). Clamping or snapping the game's own value is **never** a change. Both return `false` before the widget's call in the step.
3. **Keyboard capture is engine-wide for actions only.** While a text field is editing, actions and `axis()` ignore keyboard keys (gamepad and mouse still count); raw input and `typed` are untouched. Capture starts and ends one step after editing does. Keys held at the start report `actionReleased`; keys held at the end are latched until released.
4. **No on-screen keyboard, no IME, no selection/copy/undo** in this round. Paste is supported. Touch and controller-only players need a game-provided fallback (documented; F023 is proposed for an on-screen keyboard).
5. **Hold repeat** only for slider adjustment and list cursor movement: 0.4 s delay, then every 0.08 s of fixed-step time. Focus movement between widgets stays one per press (F012 unchanged).
6. **Lists scroll by whole rows** and never clip: the renderer has no scissor, and this round adds none. Text fields show a window of code points that fits; long list rows are truncated with `...`.
7. **Exact warning texts** are listed in GAME_FORMAT § F019 ("Phases, ids and disabled state" and each widget). Tests assert them verbatim, including the `[pixelforge] ui: ` prefix. The F012 `button` texts do not change.
8. **State lifetime**: per-id state is dropped at the end of any step that does not declare that id (same as F012 focus). While paused, no steps run, so nothing is dropped.
9. **`Space` on a focused, non-editing field** starts editing and inserts a space (text events win over "activate"). `Enter` starts editing without inserting anything.
10. **Text typed during a pause** (for example while the ⌨ panel is open) is discarded on resume.

## 1. Goal and user stories
F012 gave creators panels, labels and buttons. Every settings screen still fakes sliders and switches with buttons that cycle values ("SOUND: ON", "MODE: NORMAL"), there is no way to type a name, and long choices (levels, colours, saves) need hand-made scrolling. Ember Garden's settings screen and the Menu & HUD template both show the workaround.

F019 completes the menu toolkit with four widgets that follow the F012 theme, phase and navigation rules and work with mouse, touch, keyboard and gamepad:
- **`ui.slider`**: a horizontal value slider (volume, difficulty, sensitivity). Drag it, or focus it and press left/right (hold to repeat).
- **`ui.toggle`**: a labelled on/off switch.
- **`ui.textField`**: a single-line text field for name entry, with a caret, paste, a length limit and a per-character filter.
- **`ui.list`**: a vertical list of rows with a cursor, wheel and drag scrolling, and keyboard/gamepad movement that hands focus back to the other widgets at its ends.

Plus `ui.changed(id)`/`ui.committed(id)` for saving, `input.textEvents` for text input, and `input.keyboardCaptured` so typing never moves the player.

User stories:
1. As a creator, I write `s.volume = ui.slider("vol", s.volume, 150, 80, 160, 12, { step: 0.05 })` and `if (ui.committed("vol")) save()`. Players drag it with the mouse or a finger, or focus it with the arrows and hold right to raise the volume.
2. As a creator, `s.shake = ui.toggle("shake", s.shake, "SCREEN SHAKE", 80, 104, 200, 14)` gives me a labelled switch that works with clicks, `confirm` and gamepad `A`.
3. As a player on the game-over screen, I click the NAME field (or move to it and press Enter), type "MIA", press Enter, and the game saves my name. While I type, `A`/`D` do not move my character and `P` does not pause the game.
4. As a player with a controller, I move down a settings menu: the D-pad goes through the name field, the slider (left/right changes it), the toggle and the list (up/down moves inside it and leaves it at its ends).
5. As a creator with 40 levels, `const i = ui.list("levels", names, 20, 40, 200, 160, { selected: current })` gives a scrollable list; it returns the index the player picks.
6. As a Studio user, the Menu & HUD template has a SETTINGS screen showing all four widgets that I can copy.

Non-goals (later items): an on-screen keyboard (F023 proposed), IME composition, multi-line text, text selection/copy/cut/undo, password masking, vertical sliders, interactive scrollbars, clipping and scroll containers, layout helpers (rows/columns), tooltips, animation of the toggle knob, stick-based navigation, `Tab` navigation.

## 2. UX notes

### 2.1 In games (engine)
- **Look**: the default theme stays the F012 palette. New colours are listed in GAME_FORMAT § F019 (`trackColor`, `fillColor`, `knobColor`, `fieldColor`, `fieldBorder`, `caretColor`, `placeholderColor`, `rowHoverColor`, `rowSelectedColor`) plus optional `track`/`knob`/`field` 9-slices. Disabled widgets use the F012 alpha 0.5 rule.
- **Focus ring**: the same F012 ring (2 units of `focusColor`, 2 units outside the rect) on every focusable widget. A list also outlines its cursor row while focused. A field that is editing shows the ring and the caret.
- **Settings row pattern** (used in the template and Ember Garden): label on the left with `ui.label`, slider on the right; toggles carry their own label.
- **Typing feedback**: the caret is solid (no blink) for accessibility and stable screenshots. The placeholder hides while editing.
- **Pointer**: slider drags continue outside the rect until release. List drags scroll after 4 units of vertical movement and then never activate a row, so touch scrolling never picks the wrong level.

### 2.2 Studio (frontend)
- The **"Menu & HUD"** template (`menu-hud`) replaces its title "SOUND: ON/OFF" button with **SETTINGS**, which opens a settings panel:
  - `NAME` text field (`maxLength` 12, `allow` letters, digits, space, `-` and `_`), saved with `engine.storage` and shown on the HUD ("MIA 120") and game over.
  - `VOLUME` slider (0–1, `step` 0.1) with a percentage `ui.label`, applied to `engine.audio.masterVolume`, saved on `committed`.
  - `SOUND` toggle (the old button's behaviour, `engine.audio.muted`).
  - `STAR COLOUR` list of 6 named colours, 3 visible rows (so it scrolls), `selected` = the current colour; activating a row sets the star tint.
  - `BACK` button; the `pause` action also goes back.
  - A one-line hint under the panel: "Type your name with a keyboard" shown only when `engine.input.lastDevice` is `"touch"` or `"gamepad"`.
- **Docs page** section "16. Text, fonts and menus" gains a subsection **"Settings and text entry (F019)"** with: a slider + `committed` snippet, a toggle line, a text field with `allow`, a list with `selected`, the navigation table in short form, the keyboard capture note and the touch/controller fallback note. No section renumbering.

### 2.3 Desktop
- Nothing new. Typing and paste work in WebView2 like in the browser.

## 3. Contract changes (summary; normative text lives in docs/)
- **GAME_FORMAT.md § F019 additions**: `SliderOptions`, `ToggleOptions`, `TextFieldOptions`, `ListOptions`, `TextEvent`; new `UiTheme` fields; `ui.slider`, `ui.toggle`, `ui.textField`, `ui.list`, `ui.changed`, `ui.committed`, `ui.listCursor`, `ui.editing`; the per-widget navigation table and hold repeat; text editing (start, apply, commit/revert/dropped); change signals; phases, ids, disabled and state lifetime; `input.textEvents` and `input.keyboardCaptured`; exact warnings; "For creators". **No game.json keys, boot options, messages or bundle changes.**
- **API.md § F019 additions**: no changes.
- **ARCHITECTURE.md § F019 additions**: `ui.ts` extensions, new pure `uitext.ts`, `input.ts` capture wrapper, step order, ownership. No migration.

## 4. Per-area tasks

### engine-dev (`packages/engine/**`, `examples/**`)
1. **`src/uitext.ts`** (new, pure, no DOM). All functions work on code points (`Array.from(text)`), never UTF-16 units:
   - `filterText(raw: string): string` (removes < U+0020, U+007F–U+009F, lone surrogates).
   - `applyTextEvents(state: { text: string; caret: number }, events: readonly TextEvent[], opts: { maxLength: number; allow?: (ch: string) => boolean }): { text: string; caret: number; allowThrew: boolean }` (GAME_FORMAT § "Text editing"; an `allow` that throws counts as `false` and sets `allowThrew`).
   - `visibleRun(text, caret, runStart, maxWidth, measure): { start: number; end: number }` (minimum shift rule).
   - `caretFromX(text, runStart, localX, measure): number` (nearest boundary).
   - `truncateToWidth(text, maxWidth, measure): string` (appends `...`; returns `""` if even `...` doesn't fit).
2. **`src/input.ts`**:
   - `textEvents: readonly TextEvent[]` (frozen array, `[]` when none), handed over in `beginStep` from an accumulator, capped at 64 per step. Collection rules exactly as GAME_FORMAT § F019 "Input additions" (keydown text with the AltGr exception and `isComposing`, editing keys, `paste` with newline/tab → space and 256 code points, `filterText`).
   - `keyboardCaptured` (read-only getter), `setKeyboardCapture(on: boolean)` and `clearTextEvents()` (engine-internal).
   - In `updateActions`, while captured pass `ActionMap.update` a `ButtonSource` wrapper that reports keyboard codes (`isKeyboardCode`) as up with no press edges; in the first captured step it reports `wasReleased` for keyboard codes that are `isDown`, so key-only actions get `actionReleased`. When capture turns off, record the keyboard codes still down; the wrapper reports them as up until each is released. Mouse codes and gamepads pass through.
   - `keydown` preventDefault while captured: every key producing a `textEvents` entry, and `Space`, except with `ctrlKey`/`metaKey` + `KeyV`. The existing F009 rule stays for the uncaptured case.
   - `typed` and all raw APIs unchanged.
3. **`src/ui.ts`**:
   - Extend `UiInput` (`actionDown`, `isDown`, `mouse.wheel`, `textEvents`, `gamepad(i).isDown`, optional `setKeyboardCapture`) and `UiRenderer` (`measureText`). Keep `button` behaviour and every F012 test green.
   - `beginStep(dt = 1 / 60)`: compute intents once; route them by the focused widget's kind from the previous step (navigation table); hold-repeat timers; list fresh-press exits; text field start/commit/revert; pointer for sliders (drag), toggles (button rules) and lists (press row, 4-unit drag threshold, wheel).
   - Widgets `slider`, `toggle`, `textField`, `list` with the exact return, clamp/snap, drawing and warning rules in GAME_FORMAT. Helpers `changed`, `committed`, `listCursor`; `editing` getter/setter.
   - Per-id `WidgetState` map pruned in `endStep`; `endStep` also calls `input.setKeyboardCapture?.(editing !== null)` and ends editing for an undeclared/disabled field (dropped).
   - `defaultTheme()` gains the new fields with the GAME_FORMAT defaults.
   - The nav order includes all valid, enabled, `nav !== false` widgets (empty lists skipped).
4. **`src/engine.ts`**: `this.ui.beginStep(dt)`; in `setPaused`, when the engine goes from paused to running, call `this.input.clearTextEvents()`. Wire `setKeyboardCapture` into the `Ui` deps.
5. **`src/index.ts`**: export the types `SliderOptions`, `ToggleOptions`, `TextFieldOptions`, `ListOptions`, `TextEvent`, and the `uitext.ts` functions (for tools/tests).
6. **README.md**: extend "UI widgets (F012)" with a "Settings and text entry (F019)" part: the four widgets, signals, the navigation table, keyboard capture, `textEvents`, the touch/controller note and the new theme fields. Add `textEvents`/`keyboardCaptured` to the input list next to `typed`.
7. **Example, `examples/ember-garden`** (SettingsScene only; keep the rest unchanged):
   - `SOUND` and `SCREEN SHAKE` become `ui.toggle`s; add a `VOLUME` slider (0–1, `step` 0.1) with a percentage label, applied to `engine.audio.masterVolume` on load and on change, saved via the existing `saveSettings` only on `ui.committed`. `profile.settings.volume` defaults to `1` when missing (old saves keep working).
   - `MODE`, `FLAME` (cycle buttons, `MODE` disabled mid-run) and `BACK` stay buttons. Keep `focusOnce(this, engine, 'sound')`. Make sure the panel height still fits the unlock list (move rows if needed).
   - Repack with `npm run examples`.
8. **Tests** (node environment; new `test/ui-widgets2.test.ts`, `test/uitext.test.ts`, `test/input-text.test.ts`; existing `ui.test.ts`, `input*.test.ts`, `actions.test.ts` stay green):
   - `uitext`: insert at caret, `maxLength` cut mid-event, `allow` rejecting and throwing, Backspace/Delete at the ends (no-ops), Home/End, astral code point (emoji) counts as one, `filterText` removals, `visibleRun` minimum shift both ways, `caretFromX` nearest boundary, `truncateToWidth` including the "nothing fits" case.
   - Slider: press sets value under the pointer; drag outside the rect clamps; release ends the drag and `committed` fires once only if the value changed; cancelled release ends the drag; keys adjust by `keyStep` and do not move focus while up/down do; hold repeat at 0.4 s and every 0.08 s (fake `dt`); snapping incl. `toFixed(10)` (`0.1 + 0.2` case); clamping the game value is not `changed`; invalid range → disabled + exact warning once; non-finite `value` → `min`.
   - Toggle: click flips once; press outside then release inside doesn't; activate flips; disabled never flips; `changed` and `committed` both true in the flip step.
   - Text field: click starts editing with caret from x; activate starts at end; typing while focused starts editing and suppresses navigation in that step; Space precedence; edits applied in order; Enter commits with `committed` true even unchanged; up/down raw arrows commit and move focus; pointer press outside commits; Escape and pad `B` revert (returns original, `changed` true, `committed` false, focus kept); undeclared field drops editing with no signal; `ui.editing = id` starts next step; only one field edits; `maxLength` clamp warning text; `setKeyboardCapture` called with the right value at `endStep`.
   - List: click on a row returns its index and sets the cursor; release on another row returns −1; drag over 4 units scrolls and never activates; wheel scrolls by the formula; cursor on focus from next/previous/`selected`; up/down move and scroll into view; fresh press at the ends leaves, repeat never leaves; empty list skipped by navigation; 1001 items → warning once, 1000 rows; invalid `rowHeight` warning; `listCursor`; state discarded when undeclared for a step.
   - Shared: duplicate id across kinds (button + slider) → second one inert with the exact `{kind}` warning; invalid id warning; phase warning for each kind from render; disabled returns inputs; changed/committed are false before the call in the step; command cap counts widgets once.
   - Input: `textEvents` from keydown (repeat counts, Ctrl+C ignored, AltGr char kept, `isComposing` ignored), editing keys, paste normalisation and 256 cap, 64-per-step cap, `clearTextEvents`; capture: a key-only action reports `actionReleased` in the first captured step, keys don't press actions while captured, a key held at capture end doesn't count until released, gamepad and `Mouse0` still drive actions, `axis()` follows, raw `wasPressed`/`typed` unaffected; preventDefault for text keys and Space only while captured, never for Ctrl+V.
   - Engine message/pause: text events typed while paused are discarded on resume.

**Acceptance:** `npm test -w @webgame/engine`, `npm run typecheck -w @webgame/engine`, `npm run build:engine`, `npm run examples`. Manual (dev harness `npm run dev -w @webgame/engine`, Ember Garden): the settings screen works with mouse, touch emulation, arrows + Enter and a gamepad; holding right on VOLUME repeats; F3 is still toggleable; a 📷 capture includes the widgets.

### backend-dev (`backend/**`)
1. No code changes. After the engine-dev repack, run the suites that upload `examples/dist/*.zip` to confirm the repacked Ember Garden still passes upload validation.

**Acceptance:** `cd backend && cargo test` (all suites green) and `cargo clippy --all-targets -- -D warnings`. No migration, no new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **`src/studio/templates.ts`**: update `menu-hud` per § 2.2. Its `main.js` uses only documented API (`engine.ui.*` incl. the F019 widgets and signals, `engine.input.lastDevice`, `engine.audio`, `engine.storage`, `submitScore`). Keep `ui.focus` restoration when returning from settings. Update the template's header comment and `controls` hint if wording changes.
2. **`src/pages/DocsPage.tsx`**: the "Settings and text entry (F019)" subsection in section 16 (§ 2.2). Keep the section list and ids unchanged (no renumbering).
3. **Tests**:
   - Template test (`templates` test file or the existing `menu-hud` assertions from F012): `main.js` contains `engine.ui.slider(` or `ui.slider(`, `ui.toggle(`, `ui.textField(`, `ui.list(` and `ui.committed(`; `menu-hud` still declares `confirm`, `pause`, `left`, `right`, `up`, `down` and passes `validateActions`.
   - The `STUDIO_TEMPLATES` iterating tests (`controls.test.ts`, `zip.review.test.ts`) stay green.
   - `DocsPage` test: the new subsection heading renders and the section list is unchanged.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`. Manual: create a project from "Menu & HUD", open SETTINGS in the preview, type a name, drag the volume, flip sound, pick a colour from the scrolling list; with the ⌨ panel remap `confirm` to `K` and check `K` types a "k" in the name field instead of submitting.

### desktop-dev (`apps/desktop/**`)
1. No code changes expected. Verify in the Tauri app (WebView2): typing in the template's NAME field, `Ctrl+V` paste, AltGr characters on a non-US layout if available, F11 fullscreen while editing, and that the native menu accelerators (`Ctrl+Shift+K`) still open the controls panel while a field is editing (the engine pauses, and text typed under the panel is discarded on resume).

**Acceptance:** `npm run build -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test && cargo check`.

### Sequencing
- Engine first (`uitext.ts` and the `input.ts` capture can start in parallel with `ui.ts`). Frontend's template and docs can be written in parallel; the template is only playable once the engine build lands. Backend and desktop verify after the repack.

## 5. Edge cases and security
- **Sandbox model unchanged**: no new message, permission or host involvement. Text stays inside the opaque-origin iframe unless the game stores it through existing APIs (`engine.storage`, which is private to the player); the platform never reads or displays it.
- **Clipboard**: only `paste` events (a user gesture into the game document) are read; `navigator.clipboard` is never called, so there is no permission prompt and no silent read.
- **Name entry is not identity**: a text field value is game data, not the platform display name; leaderboards and comments still use the account name. No content filtering is added, because no platform surface shows typed text to other players. The engine README says so in the F019 part.
- **Key conflicts**: typed letters can be bound to actions; capture prevents them from triggering actions or menu navigation (menu navigation reads actions). Raw `typed`/`wasPressed` games must check `ui.editing`.
- **Remapped `confirm` to a letter**: while editing, that letter types (capture), and `Enter` / gamepad `A` submit. Documented in the manual test.
- **Escape in fullscreen**: browsers consume `Escape` to leave fullscreen; the player then presses it again to revert. Not worked around.
- **Host pause during editing**: steps stop, editing stays on; keys typed while paused are discarded on resume; the resume latch (F016) and cancelled releases (review 5) still apply.
- **Window blur while editing**: `releaseAll` (F009) still runs; editing stays on; no text is lost.
- **Touch/controller only**: fields can be focused but not typed into; the game should offer a fallback (template shows the hint). No hidden `<input>` trick in this round (gesture timing makes it unreliable inside the step model).
- **Huge inputs**: paste ≤ 256 code points, ≤ 64 events per step, `maxLength` ≤ 256, list ≤ 1000 items, only visible rows measured and drawn: bounded CPU per step.
- **Unicode**: code-point editing keeps surrogate pairs whole; combining marks and grapheme clusters are not merged (documented limitation). Characters missing from a bitmap font draw as `?` (F012 rule).
- **Compatibility**: existing games are unaffected; capture only turns on when a game calls `textField`; `button` and the F012 nav behaviour are unchanged; `UiTheme` only gains fields. Old engine builds simply lack the methods (games calling them fail, as with any new API).

## 6. Test expectations
- **Engine**: as in engine task 8; all F009/F012/F016/review-5 suites stay green.
- **Backend**: all suites green with the repacked examples (no new tests).
- **UI**: template and docs assertions; template-iterating suites green.
- **Desktop**: green build; manual typing, paste and pause checks.
- **Manual end to end**:
  - Web player, Ember Garden: settings via mouse, keys and gamepad; volume persists after reload (saved once per drag); a pre-F019 save without `volume` loads at full volume.
  - Studio preview, Menu & HUD: name entry blocks movement keys while typing, `Escape` reverts, `Enter` saves, the HUD shows the name.
  - Paste a 300-character string: 12 characters kept (template `maxLength`).
  - Open ⌨ while editing, type, close: nothing typed reaches the field.

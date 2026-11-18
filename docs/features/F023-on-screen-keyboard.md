# F023: Engine on-screen keyboard for `ui.textField`

Status: **shipped**. Size: **S** (engine is the only code area; frontend is small: one template change, one docs subsection and two tests; backend not dispatched; desktop verification only; one round).
Areas: engine, frontend (template + docs), desktop (verification only). Backend: none.
Contracts:
- `docs/GAME_FORMAT.md` § F023 additions (normative: the layout, sizing, when it opens and closes, input routing, precedence, disabled keys, `TextFieldOptions.keyboard`, `ui.keyboardRect`, exact texts).
- `docs/ARCHITECTURE.md` § F023 additions (the new pure module `osk.ts`, state, step order, ownership).
- `docs/API.md` § F023 additions (no changes).

Depends on: F019 (text field, `textEvents`, keyboard capture, hold repeat), F016 (`input.lastDevice`, fixed gamepad fallbacks), F012 (theme, phases, command list) and review 5/8 (cancelled releases, pending start). All are shipped.

This round adds **no migration** (the latest stays `0022_f015.sql`, and the next free number stays `0023`). It also adds no endpoints, no messages, no game.json keys and **no new Rust or JS dependencies**. The six examples don't change, and nothing needs repacking.

## 0. Decisions on ambiguities (read first)
GAME_FORMAT § F023 is normative. Tests assert the texts below verbatim.

1. **The keyboard is built into `ui.textField` (no separate widget).** It is not a separate `ui.keyboard(...)` call. It is part of the editing state of the field being edited, so there is always at most one keyboard. It has no id, it is never in the navigation order, and it is never `ui.hot`, `ui.active` or `ui.focus`. While it is open, `ui.focus` stays on the field.
2. **When it opens.** It opens only when editing **starts**, which is decided at the field's call in that step. The new option `TextFieldOptions.keyboard` controls it: `"auto"` (default), `"always"` or `"never"`.
   - `"auto"` opens it when `input.lastDevice` is `"touch"` or `"gamepad"` at that moment.
   - `"always"` opens it on every start.
   - `"never"` never opens it.
   - Any other value is treated as `"auto"` and warns once per id: `textField "{id}" keyboard must be "auto", "always" or "never"`.
   - When a step starts editing, the keyboard is drawn from the end of that step. It takes input from the **next** step on, so the gamepad `A` press that started editing never also types a key.
3. **When it closes.** It closes whenever editing ends: submit (including its OK key), commit, revert or dropped. It also hides for the rest of the edit (editing continues) in the step where any physical `input.textEvents` entry arrives (typing or a paste). That way a phone with a Bluetooth keyboard, or a player who picks the keyboard back up, isn't covered.
   - A pointer press on the field that is being edited reopens a hidden keyboard when the mode is `"always"`, or when the mode is `"auto"` and `lastDevice` is `"touch"` at that press. The caret also moves (F019 rule).
   - Nothing else reopens it.
4. **Layout (fixed, ASCII only, so the built-in `pixel` font draws every label).** The grid has 10 columns and 5 rows:
   - row 0: `1 2 3 4 5 6 7 8 9 0`
   - row 1: `Q W E R T Y U I O P`
   - row 2: `A S D F G H J K L '`
   - row 3: `Z X C V B N M - _ .`
   - row 4: `SHIFT` (columns 0–1), `SPACE` (2–5), `DEL` (6–7), `OK` (8–9)

   Letters show as capitals each time the keyboard opens. `SHIFT` toggles between capitals and small letters, caps-lock style (not one-shot), and affects letters only.

   Labels: a character key shows its character. `SHIFT` shows `abc` while capitals are on and `ABC` while small letters are on (the case a press switches to). The others show `SPACE`, `DEL` and `OK`.

   There are no symbol pages, accents or localised layouts. That is F025.
5. **Size and position.** These follow an exact formula (GAME_FORMAT): the panel is docked at the bottom of the game screen, centred, with keys sized from `renderer.width` and `renderer.height`. If the field's rect reaches into the bottom panel and a top panel wouldn't cover it, the panel docks at the top instead.

   If the formula gives keys narrower than 8 units or a panel taller than the game, the keyboard is not shown. In that case it warns once per `Ui`: `on-screen keyboard does not fit a {W}x{H} game; it is not shown`. `{W}` and `{H}` are the integer game size, and the separator is a plain `x`.
6. **Gamepad (pad 0 only, the F012 convention).**

   | Input | Effect |
   |---|---|
   | D-pad or declared `up`/`down`/`left`/`right` actions | move the keyboard cursor |
   | `A` | press the cursor key |
   | `B` | revert (F019, unchanged) |
   | `X` | `DEL` |
   | `Y` | `SPACE` |
   | `LB` | `SHIFT` |
   | `Start` | `OK` |

   - While the keyboard is shown, `A` and the declared `confirm` action **don't** submit, and the D-pad and the direction actions **don't** commit or leave the field. Those F019 rules still apply when the keyboard is closed or hidden.
   - The direction actions count here only through gamepad or mouse bindings, because keyboard capture is on.
7. **Physical keyboard.** Raw `Enter`/`NumpadEnter` still submit, and `Escape` still reverts. With `ui.navigation` on, raw `ArrowUp`/`ArrowDown` still commit and move focus (F019). The keyboard cursor never moves with raw arrow keys.
8. **Pointer.** Keys follow the F012 button rules: the press and the release must be on the same key, and a cancelled release never fires. Keys fire on **release**, with no repeat.
   - A press inside the panel never reaches the widgets underneath. It doesn't commit the field, doesn't clear focus, and sets `ui.hot` to `null`.
   - A press outside both the panel and the field commits (F019) and closes the keyboard.
9. **Hold repeat** uses the F019 timing (0.4 s, then every 0.08 s of step time). It applies to cursor movement on each axis, and to `DEL` when it is held with `X`, or with `A` while the cursor is on `DEL`. Character keys, `SPACE`, `SHIFT` and `OK` never repeat.
10. **Cursor movement.**
    - The cursor opens on `Q` (row 1, column 0).
    - Left and right move one key along the row (a wide key counts once) and wrap within the row.
    - Up and down move to the key in the next row that covers the cursor's **anchor column**, wrapping from row 4 to row 0 and back.
    - The anchor column is the first column of the key last reached with left or right, or column 0 at open. Up and down never change it.
    - When a horizontal and a vertical move happen in the same step, the vertical move applies first.
11. **Disabled keys.** These are re-evaluated every step against the field's text and caret after that step's edits:
    - A character key or `SPACE` is disabled when the text already has `maxLength` code points, or when `allow(ch)` is falsy or throws. A throw uses the existing F019 warning `textField "{id}" allow threw; the character was rejected`.
    - `DEL` is disabled when the caret is at 0.
    - `SHIFT` and `OK` are always enabled.
    - Disabled keys stay in the grid, so the cursor can rest on them. Pressing them does nothing, and they draw at alpha 0.5 with `disabledTextColor`.
12. **Order within one step** (with the keyboard shown at the start of the step):
    1. Revert (`Escape` or pad `B`) wins over everything. The keyboard's events are dropped, and the field reverts and closes.
    2. Otherwise the field applies the physical `input.textEvents` first, then the keyboard's events in this order: the pointer key; then pad `A` on the key the cursor was on **at the start of the step**; then the cursor move; then `X`, `Y`, `LB` and `Start`.
    3. `SHIFT` changes the case of the events that follow it in the same step.
    4. After the events, `OK`/`Start` or raw `Enter` submits, and raw `ArrowUp`/`ArrowDown` commits and moves focus.
13. **Keyboard events stay inside the field.** They go only to the field being edited. They never appear in `input.textEvents`, never change `input.lastDevice` and never fire actions. A gamepad `A` press itself still reports `actionPressed("confirm")` to the game, as in F019, so games guard gameplay with `ui.editing`.
14. **Drawing.**
    - The panel is one command, appended **after** all widgets when the step ends. It draws on top of them in the UI layer, before the F005 capture point, so screenshots include it (as they include the caret). It does not count toward the 256-command cap.
    - It uses the panel style (`theme.panel` or `panelColor` + `panelBorder`). Keys use the button styles (normal, hover and down) and the theme font, `textSize` and `textColor`.
    - The cursor key gets a 2-unit `focusColor` outline **inside** its rect, so neighbours aren't covered. The field keeps its F019 ring and caret.
    - No new theme fields.
15. **`ui.keyboardRect`** (read-only) is `{ x, y, w, h }` (frozen, game units) for the panel drawn at the end of the last completed step, or `null`. Games use it to move HUD elements. Raw `input.mouse` and `touches` still report presses on the panel, so games that read raw pointer input during editing check this rect.
16. **Pause.** Host or author pauses keep the keyboard open (editing stays on). `cancelPointer` drops a key press in progress and the repeat timers. Text typed while paused is still discarded (F019).
17. **Existing games.** Fields default to `"auto"`, so every existing field gains the keyboard for touch and controller players with no code change. Mouse and keyboard players see no difference. None of the six examples uses `ui.textField`; only the Menu & HUD template does.

## 1. Goal and user stories
F019 shipped text fields that need a physical keyboard. Phone and controller players can focus a name field but can't type into it, so the Menu & HUD template shows "Type your name with a keyboard". F023 removes that gap in the engine, so every game gets it for free.

User stories:
1. As a phone player, I tap the NAME field in a game's settings. A keyboard slides up at the bottom of the screen, I tap `M`, `I`, `A`, then `OK`, and my name is saved.
2. As a controller player, I move to NAME with the D-pad and press `A`. The keyboard appears with the cursor on `Q`. I move with the D-pad, press `A` to type, `X` to delete and `Start` to finish, or `B` to cancel.
3. As a creator, my existing `ui.textField("name", …)` call gets this with no changes. I pass `{ keyboard: "never" }` where I draw my own picker, or `{ keyboard: "always" }` for a pointer-only kiosk game.
4. As a creator with `allow: (c) => /[A-Z]/.test(c)`, digits and symbols appear dimmed on the keyboard and can't be typed.
5. As a creator, I read `engine.ui.keyboardRect` to move my score display while the keyboard covers the bottom of the screen.
6. As a Studio user, the Menu & HUD template no longer tells touch players to find a keyboard.

Non-goals (later items): symbol pages, accented letters and localised layouts (F025 proposed), word suggestions, a one-shot shift, IME, a native OS keyboard (a hidden `<input>` inside the sandbox; see § 5), animation, sound, and a keyboard for anything other than `ui.textField`.

## 2. UX notes

### 2.1 In games (engine)
- **Look**: the same theme as menus. The panel looks like a `ui.panel`, keys look like buttons, and the cursor ring uses `focusColor`. For small pixel-art games, set `ui.theme.font = "pixel"`. With the default 16 px canvas font, labels are drawn centred and not clipped (F012 rule).
- **Sizes** (from the formula in GAME_FORMAT):
  - Menu & HUD (480×270): keys 45×24, panel 476×136 at (2, 134), docked at the bottom.
  - A 320×180 game: keys 29×16, panel 316×96.
  - A 1280×720 game: keys 125×48, panel 1276×256.
- **Feedback**: hover in `buttonHoverColor` and press in `buttonDownColor` (pointer), plus the cursor ring (gamepad). Disabled keys at alpha 0.5. The caret stays solid (F019).
- **Focus**: never leaves the field while the keyboard is used. After `OK` the field keeps focus (F019 submit), so the next D-pad press moves to the next widget as before.

### 2.2 Studio (frontend)
- **Menu & HUD template** (`menu-hud`, settings screen):
  - Remove the `if (input.lastDevice === "touch" || input.lastDevice === "gamepad") { ui.label("Type your name with a keyboard", …) }` block.
  - Replace its comment with exactly `// Touch and controller players get the engine's on-screen keyboard when they start typing (F023).`
  - The NAME field call stays as it is (default `"auto"`). Its `allow` (`/^[A-Za-z0-9 _-]$/`) makes `'` and `.` appear dimmed, which shows the filter at work.
  - The hint was the only use of `input` in `settings()`, so its destructuring becomes `const { ui, audio, storage } = engine;`. Other methods (`menus`, `update`) keep their own `input`.
- **Docs page** section 16:
  - After the "Settings and text entry (F019)" subsection, add an `h3` **"On-screen keyboard (F023)"** with:
    - one paragraph on when it appears (`"auto"` / `"always"` / `"never"`) and that it hides when a physical key is typed;
    - a table with the accessible name `"On-screen keyboard controls"` and rows: `D-pad` move, `A` press key, `B` cancel, `X` delete, `Y` space, `LB` shift, `Start` OK, `Tap` press key;
    - a snippet `ui.textField("name", s.name, 120, 120, 160, 16, { keyboard: "never" })`;
    - a `keyboardRect` line.
  - Replace the F019 bullet that starts "**Touch and controller players:**" with: "**Touch and controller players:** an on-screen keyboard opens when they start typing (see below)."
  - No other text changes, and no renumbering.

### 2.3 Desktop
- Nothing new. On touch-screen Windows devices, WebView2 reports `pointerType` `"touch"`, so the keyboard opens on a tap.

## 3. Contract changes (summary; normative text lives in docs/)
- **GAME_FORMAT.md § F023 additions**:
  - `TextFieldOptions.keyboard`, `ui.keyboardRect` and the `TextFieldKeyboard` type
  - the layout table, the sizing formula and docking
  - when it opens and closes
  - pointer, gamepad and physical keyboard routing
  - order within a step, disabled keys, drawing and pause
  - the exact warnings, and a "For creators" note
  - No game.json, boot option, message or bundle changes.
- **ARCHITECTURE.md § F023 additions**: the new pure `osk.ts`, the `UiInput`/`UiRenderer` additions, the keyboard state in `Ui`, the step order, and ownership. No migration.
- **API.md § F023 additions**: no changes.

## 4. Per-area tasks

### engine-dev (`packages/engine/**`)
1. **`src/osk.ts`** (new, pure, no DOM, no renderer). Export:
   - `OSK_ROWS: readonly (readonly OskKeyDef[])[]`, where `OskKeyDef = { kind: "char"; lower: string; upper: string } | { kind: "shift" | "space" | "del" | "ok"; col: number; span: number }`. Character keys sit at their index (one column each). This is the § 0.4 layout exactly.
   - `oskLayout(gameW: number, gameH: number, field: { x: number; y: number; w: number; h: number }): OskLayout | null`, returning `{ x, y, w, h, keyW, keyH, keys: { row, col, span, x, y, w, h }[] }`. Implement the GAME_FORMAT formula, with `null` when it doesn't fit.
   - `oskKeyAt(layout, x, y): number` gives the key index, or `-1` for gaps and outside.
   - `oskMove(cursor: { row: number; col: number; anchor: number }, dx: -1 | 0 | 1, dy: -1 | 0 | 1)` returns the new cursor (§ 0.10, vertical first).
   - `oskLabel(key, upper: boolean): string` and `oskChar(key, upper): string | null`.
2. **`src/ui.ts`**:
   - `TextFieldOptions.keyboard?: TextFieldKeyboard`, with `export type TextFieldKeyboard = "auto" | "always" | "never"`. Add the invalid-value warning, exact text from § 0.2.
   - `UiInput`:
     - optional `readonly lastDevice?: string` (absent → `"keyboard"`);
     - widen `NavButton` to also include `'X' | 'Y' | 'Start' | 'LB'` (these are `GamepadButtons` names in `input.ts`).
   - `UiRenderer`: optional `readonly width?: number; readonly height?: number` (`Renderer` already has both). Without them, the keyboard is never shown.
   - Keyboard state on `Ui` (one, private):
     - `{ field: string; shown: boolean; upper: boolean; cursor: { row, col, anchor }; pressKey: number; layout: OskLayout | null; fieldRect; mode }`;
     - repeat timers for the two cursor axes and for `DEL`.
   - `beginStep` (only when `_editing !== null` and the keyboard is shown from the previous step):
     - In `pointerStep`, handle panel presses and releases **before** widget hit-testing, in the same "release, then press" split as now (§ 0.8).
     - In `navigateStep`'s editing branch, apply the § 0.6 / 0.7 routing.
     - Build `oskEvents: TextEvent[]` plus an OK flag in the § 0.12 order, and set `editAction` (`'submit'` for OK, unless reverting).
   - `textField`:
     - When `startedNow`, decide `shown` (§ 0.2) from `input.lastDevice` and `keyboard`.
     - While editing, pass `[...input.textEvents, ...oskEvents]` to `applyTextEvents`, and set `shown = false` if `input.textEvents.length > 0`.
     - Handle the reopen-on-press rule (§ 0.3).
     - Store the field rect for docking.
   - `endStep`:
     - When editing has ended, clear the state.
     - Otherwise, when shown, compute the layout and the disabled keys (§ 0.11) against the current text and caret. Append the panel command to the committed list after the widgets. Set `keyboardRect`.
     - The not-fit warning is § 0.5, exact text.
   - `cancelPointer`: drop `pressKey` and the repeat timers.
   - The getter `keyboardRect: Readonly<{ x: number; y: number; w: number; h: number }> | null`.
   - `exec` draws the panel command (§ 0.14).
3. **`src/engine.ts`**: no change needed beyond confirming `this.input` and `this.renderer` satisfy the widened interfaces (`lastDevice`, `width`, `height` already exist).
4. **`src/index.ts`**: export the type `TextFieldKeyboard`. `osk.ts` stays internal (tests import it from `src/`).
5. **README.md**: in "Settings and text entry (F019)", replace the touch/controller note with an "On-screen keyboard (F023)" part covering: the modes, the gamepad table, the hide/reopen rules, `keyboardRect`, the `pixel` font tip for small games, and that keyboard events never reach `input.textEvents`.
6. **Tests** (node environment):
   - New `test/osk.test.ts`:
     - layout for 480×270, 320×180 and 1280×720 (§ 2.1 numbers);
     - the doesn't-fit `null` for 60×40;
     - docking at the top when the field reaches into the bottom panel;
     - `oskKeyAt` on keys, gaps and outside;
     - `oskMove`: row wrap, column wrap, anchor through row 4 (from `B`, row 3 column 4: down → `SPACE`, up → `B`; from `SHIFT` reached with left, up → `Z`), vertical before horizontal;
     - labels and characters for both cases.
   - New `test/ui-osk.test.ts`, with a fake input that has `lastDevice`, gamepad `X`/`Y`/`Start`/`LB` and a renderer with `width`/`height`:
     - It opens on a start with `lastDevice` `"touch"` and `"gamepad"`, not with `"keyboard"` or `"mouse"`. `"always"` and `"never"` behave as named. An invalid `keyboard` value gives the exact warning once and acts as `"auto"`.
     - The `A` press that starts editing types nothing. The next `A` types `Q`.
     - D-pad moves, with hold repeat at 0.4 s and every 0.08 s (fake `dt`). `X` deletes, and repeats while held. `Y` types a space. `LB` toggles case, and the label flips between `abc` and `ABC`. `Start` submits (`committed` true, focus kept, keyboard closed, `keyboardRect` null after that step).
     - `B` reverts and drops the keyboard's events of that step.
     - While shown, the declared `confirm` action and pad `A` don't submit, and pad `Up`/`Down` don't leave the field. Raw `ArrowDown` still commits and moves focus.
     - Pointer: a tap on a key types on release. A release on another key types nothing. A cancelled release types nothing. A press on the panel over another widget doesn't commit, doesn't change focus, leaves `ui.hot` null, and doesn't activate that widget. A press outside the panel and the field commits and closes.
     - A physical `text` event hides the keyboard and still applies. A touch press on the field reopens it; a mouse press with `"auto"` doesn't.
     - Disabled keys: `maxLength` reached, `allow` rejecting, `allow` throwing (the existing F019 warning, once), `DEL` at caret 0. Pressing them does nothing.
     - Order: pointer key, then `A` on the start-of-step cursor key, then the move, then `X`/`Y`/`LB`/`Start` (one combined-step test).
     - The panel command is drawn after the widgets and isn't counted toward the 256 cap. The doesn't-fit warning text is exact and appears once.
     - Pause: `cancelPointer` drops a press. The keyboard stays open.
     - Dropped editing (the field isn't declared) closes it with no signal.
   - Existing `ui.test.ts`, `ui-widgets2.test.ts`, `review5.test.ts`, `review8.test.ts` and `input*.test.ts` stay green. Fakes without `lastDevice` or `width` must keep working, and never show a keyboard.

**Acceptance:**
- `npm test -w @webgame/engine`
- `npm run typecheck -w @webgame/engine`
- `npm run build:engine`

Manual check in the dev harness (`npm run dev -w @webgame/engine`) or the Studio preview of Menu & HUD:
- Chrome device emulation (touch): tap NAME, type with the keyboard, then OK.
- With a gamepad: A, the D-pad, X, Y, LB, Start and B.
- Typing on a physical keyboard hides the panel.
- 📷 includes the panel.
- F3 still toggles.

### backend-dev (`backend/**`)
Not dispatched. There are no backend changes, no migration (the next free number stays `0023`), and no example repack, because the examples don't change and the engine is served from `packages/engine/dist`.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **`src/studio/templates.ts`** (`menu-hud`): the § 2.2 change. Don't change anything else in the template.
2. **`src/pages/DocsPage.tsx`**: the § 2.2 subsection, and the replacement bullet.
3. **Tests**:
   - Update `src/__tests__/templates.f019.test.ts`. Remove the two hint assertions (the `lastDevice` regex and `"Type your name with a keyboard"`). Add assertions that the template does **not** contain `Type your name with a keyboard`, and does contain the exact § 2.2 comment. Keep everything else, including the pause-guard tests.
   - New `src/__tests__/Docs.f023.test.tsx`:
     - the `h3` "On-screen keyboard (F023)" renders inside section 16, after "Settings and text entry (F019)";
     - the table named "On-screen keyboard controls" has the 8 rows in the § 2.2 order;
     - the snippet contains `keyboard: "never"`, and the text mentions `keyboardRect`;
     - the F019 bullet no longer contains "there is no on-screen keyboard yet".
   - `Docs.f019.test.tsx` and `Docs.f012.test.tsx` stay green. Adjust them only if they assert the old bullet text; today they don't.

**Acceptance:**
- `npm test -w @webgame/ui`
- `npm run typecheck -w @webgame/ui`
- `npm run build:ui`
- `npm run build:web`
- `npm test -w @webgame/desktop` (the desktop tests render the UI package)

Manual: create a project from Menu & HUD, open SETTINGS in the preview with touch emulation, and type a name with the on-screen keyboard. `'` and `.` are dimmed.

### desktop-dev (`apps/desktop/**`)
1. No code changes. In the Tauri app (WebView2), check that:
   - a gamepad opens and drives the keyboard on the Menu & HUD template preview;
   - on a touch screen, if one is available, a tap opens it;
   - F11 fullscreen with the keyboard open keeps the panel at the bottom of the game area;
   - View → Controls (`CmdOrCtrl+Shift+K`) while it is open pauses the game, and on resume the keyboard is still open and nothing typed under the panel reached the field.

**Acceptance:**
- `npm run build -w @webgame/desktop`
- `npm test -w @webgame/desktop`
- `cd apps/desktop/src-tauri && cargo test && cargo check`

### Sequencing
Engine first. `osk.ts` and its tests can land before the `ui.ts` wiring. Frontend's template and docs can be written in parallel, but they are only testable by hand once the engine build lands. Desktop verifies last.

## 5. Edge cases and security
- **The sandbox model doesn't change.** There is no hidden `<input>`, no OS keyboard, no new message and no permission. The keyboard is pixels drawn in the opaque-origin iframe, and its text never leaves the game unless the game stores it (F019 rule).
- **Why not the native OS keyboard:** focusing an element to raise the phone keyboard must happen inside the user gesture, and the fixed-step model decides editing later. That was F019's reason, and it also brings in IME and composition handling that F019 excludes. An engine-drawn keyboard also works for controllers, which no native keyboard does.
- **Remapped `confirm` on a gamepad button.** It doesn't submit while the keyboard is shown. `Start` and `OK` always do, and `B` always cancels, so a remap can't trap the player (the F016 principle).
- **Several pads.** Only pad 0 drives the keyboard, the F012 rule. The known F016 `lastDevice` caveat (any pad sets `"gamepad"`) can open the keyboard for a player who uses a keyboard. Their first keystroke hides it (§ 0.3).
- **Mouse users with `"auto"`** never see it. A touch laptop where the player taps the field does.
- **Tiny or odd game sizes.** The formula is bounded (`keyH` 12–48). If it doesn't fit, nothing is shown and there is one warning. The field still works with a physical keyboard.
- **The field near the bottom.** The panel docks at the top. If the field is so tall that it reaches into both positions, the panel stays at the bottom (it may cover the field; the caret still moves).
- **`autoDraw = false` without `ui.draw()`.** The keyboard is still interactive but invisible, the same as other widgets. This is documented.
- **Raw pointer games.** `input.mouse` still sees panel taps, so games use `keyboardRect`.
- **Cost.** There are 44 keys, `allow` is called at most 41 times per step (40 character keys plus `SPACE`), and the panel is one command: bounded.
- **Compatibility.** Every existing F019 behaviour is unchanged whenever the keyboard isn't shown. All F019 and review-8 tests stay green.

## 6. Test expectations
- **Engine**: `osk.test.ts` and `ui-osk.test.ts` as in engine task 6. All existing suites stay green.
- **UI**: the updated template test, `Docs.f023.test.tsx`, and the existing docs and template suites green. The desktop suite is green.
- **Desktop**: a green build and tests, plus the manual gamepad, touch and pause checks.
- **Manual end to end**:
  - Phone (LAN dev, `WEBGAME_LAN=1`): Menu & HUD, tap NAME, type `MIA`, OK. The HUD shows `MIA 0`.
  - Gamepad on the web player: the same flow with `A`/`Start`. `B` restores the old name.
  - A Bluetooth or physical keyboard while the panel is open: the panel hides on the first key.

## Review-fix additions (REVIEW-2026-11-17-10)
- **M1:** while the keyboard takes input, the gamepad buttons it uses never reach game actions, and they stay latched until released. `ui.editing` keeps reporting the field for the rest of the step in which the keyboard submits or closes. The exact rules are in GAME_FORMAT § "F023 review-fix additions".
- **L1 (accessibility):** the keyboard is drawn only on the canvas and makes no screen-reader announcements. Screen-reader users should type on a physical keyboard, and the first key they press hides the panel.
- **L2:** touch players can't cancel an edit and gamepad players can't move the caret. Both are planned for F025.

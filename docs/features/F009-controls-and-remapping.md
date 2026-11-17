# F009: Controls overlay and key remapping

Status: **shipped**. Size: **M** (engine and frontend main; backend small to medium; desktop small; one round). Areas: engine (+ examples), backend, frontend, desktop.
Contracts: `docs/GAME_FORMAT.md` § F009 additions (the `actions` and `controls` keys in game.json, the engine action API, the `webgame:controls` message, the key tables), `docs/API.md` § F009 additions (`Game.actions`, `Game.controlsHint`, validation), `docs/ARCHITECTURE.md` § F009 additions (data flow, migration `0010_f009.sql`, startup backfill, override storage).
Depends on: nothing unshipped. It reuses the v2 `hello`/`load` handshake, the host pause message, `useModal`, the F005 "window CustomEvent from the host" pattern (`PLAYER_SCREENSHOT_EVENT`) and the desktop `FORWARDED` menu ids. The migration is **`0010_f009.sql`** and runs after `0009_f005.sql`. **No new Rust or JS dependencies.**

## 1. Goal and user stories
Today a game's controls live only in its code. Players find out by trial and error, or by reading the description. A player on an AZERTY keyboard, a left-handed player, or someone who can't use a key combination has no way to change keys. The three example games already put a free-text `"controls"` string in their game.json, but nothing reads it.

F009 adds:
- **Declared actions**: game.json lists named actions with default keys and gamepad buttons (`"actions": [...]`). The backend validates them and exposes them on `Game`.
- **Engine action API**: `input.actionDown/actionPressed/actionReleased(id)`, `input.actionLabel(id)` for "Press [Space] to jump" prompts, and `input.axis()` that follows the `left/right/up/down` actions when they exist.
- **Controls panel** in the player (⌨ button): shows every action with its keys and gamepad buttons. Players remap keys (up to 3 per action). Changes are applied to the running game at once and saved on this device.
- **Controls hint**: the existing free-text `controls` string is now shown in the panel and on the game page, so games that never declare actions still get a discoverable controls description.
- **Game page "Controls" section** and a one-time "see the controls" hint on first play.
- **Studio**: an "Actions" editor in the game.json form, the controls panel in the preview, and updated templates.
- **Desktop**: View → Controls (`CmdOrCtrl+Shift+K`).

User stories:
1. As a player, I open Pixel Peaks for the first time. A small hint next to the ⌨ button says "See and change the controls". I click ⌨, the game pauses, and I see "Jump: Space, ↑ · Gamepad A". I click the empty third slot, press `K`, click Done, and the game resumes. `K` now jumps.
2. As an AZERTY player, I rebind "Move up" from `W` to `Z` (the physical key labelled Z on my keyboard). The panel shows the label of my own layout. The next time I play on this computer my binding is still there.
3. As a creator, I declare `"actions"` in game.json and call `engine.input.actionPressed("jump")`. My title screen shows `Press ${engine.input.actionLabel("jump")} to start`, which says "Press K" for the player in story 1.
4. As a creator of an older game, I already wrote `"controls": "Arrows move, Space shoots"`. Without re-uploading, players now see that text in the ⌨ panel and on my game page.
5. As a Studio user, I add a "Fire" action in the game.json form by clicking its key slot and pressing `Z`. The preview's ⌨ panel lets me test a remap before I publish. A wrong entry (an Escape binding) is flagged in the form before upload.
6. As a desktop player, I press Ctrl+Shift+K while playing and the controls panel opens.

Non-goals (later items): gamepad button remapping (the gamepad column is read-only), syncing bindings to the account across devices, analog-axis actions and dead-zone settings, key combinations (Shift+X) as one binding, per-action "hold vs toggle" accessibility options, sending the player's keyboard layout into the game.

## 2. UX notes

### 2.1 Player bar (`GamePlayer`)
- New icon button **⌨** between Restart and Mute: `aria-label="Controls"`, `title="Controls"`, `aria-haspopup="dialog"`. It is shown when the game has at least one action **or** a non-empty `controlsHint`, and hidden otherwise. It is enabled before `webgame:ready` (the panel works without the engine).
- **First-play hint**: when the game has at least one action, the first time it reports `webgame:ready` on this device, a small popover anchored to ⌨ says "See and change the controls" with a × button. It closes after 8 s, on ×, or when the panel opens. It is shown once per game per device (localStorage `webgame.controls.hinted.{gameId}` = `"1"`) and never in the Studio. It has `role="status"` and no animation under `prefers-reduced-motion`.

### 2.2 Controls panel (`ControlsPanel`, a `useModal` dialog)
- Title "Controls"; subtitle the game title.
- On open, the parent posts `webgame:pause` (reason `controls`, see § 4 frontend 3). On close it posts `webgame:resume` only when no other parent pause reason remains (e.g. the tab is still hidden), then focuses the iframe so keys go back to the game.
- If `controlsHint` is non-empty, it is shown first as a plain-text paragraph (the backend has already turned line breaks into spaces).
- If the game has actions, a table follows, one row per action in manifest order: **Action** (name) | **Keys** (3 slots) | **Gamepad** (read-only labels, "—" when none).
  - Each key slot is a `KeyCaptureButton` showing the key label, or "—" when empty. A filled slot has a small × "Clear" button (`aria-label="Clear {key} from {action}"`).
  - Clicking a slot enters capture mode: the slot shows "Press a key…", with `aria-live="polite"` text "Press a key for {action}, or Escape to cancel".
    - The next `keydown` (capture phase on `window`, `preventDefault` + `stopPropagation`) with a bindable code (GAME_FORMAT § F009) is assigned to the slot. A code already in another slot of the same action moves to this slot.
    - `Escape` cancels. A non-bindable key (Tab, F-keys, Escape-like system keys) keeps capture mode and shows "{label} can't be used" inline.
    - Capture also ends without change on blur of the button, a mouse click elsewhere or after 10 s.
    - Mouse buttons can't be captured. A mouse default (e.g. "Left click") is displayed in its slot and can be cleared or replaced by a key.
  - Changed rows show a "Changed" tag and a **Reset** button that restores that action's default keys.
  - **Conflicts** are warnings, never blocking: a row whose key is also bound to another action shows "Also used by {other action names}" (`aria-describedby` on the row). When any action has a `ControlLeft`/`ControlRight` binding and any action has `KeyW`, `KeyT` or `KeyN`, the panel shows "Browsers may close or open tabs on Ctrl+W, Ctrl+T or Ctrl+N" once.
  - An action whose keys and gamepad buttons are all empty shows "Unbound" in the warning colour.
- Footer: **Reset all** (shown only when something changed; no confirm, since it is easy to remap again), the note "Saved on this device", and **Done**.
- Every change is applied at once: the panel writes the overrides (§ 4 frontend 2) and the player posts a fresh `webgame:controls` to the iframe. There is no Save button.
- Key labels in the panel use the parent's keyboard layout when `navigator.keyboard?.getLayoutMap` exists (Chromium/WebView2), otherwise the default label table. The layout is **never** sent to the iframe (§ 5).

### 2.3 Game page (`GamePage`)
- A "Controls" section (`ControlsSummary`) between the player and "What's new" (F004), shown under the same condition as the ⌨ button.
- It shows the hint text and a compact read-only list "Jump — Space, ↑ · A". The bindings shown are the **effective** ones on this device (defaults plus overrides), and update live when the panel changes them.
- A **Customize** button dispatches `PLAYER_CONTROLS_EVENT` (§ 4 frontend 1) to open the panel of the mounted player. It is shown only when the game has actions.

### 2.4 Studio
- **game.json form**: a new "Controls" fieldset after "Leaderboard".
  - A "Controls hint" text input (0–300 chars, live counter) bound to `controls`.
  - An "Actions" list. Each row has `id` (input), `name` (input), three `KeyCaptureButton` key slots (same capture rules as § 2.2, but writing the manifest), two gamepad selects (none + the 16 names), and remove (🗑). "+ Add action" appends a row with `id` `action{n}`, up to 32. "+ Add movement" appends `left`, `right`, `up`, `down` rows with Arrow + WASD keys and D-pad buttons, skipping ids that already exist.
  - Inline errors use `validateActions(manifest)` (§ 4 frontend 2), which mirrors the backend rules. The Publish dialog shows "Fix the errors in game.json → Controls first" and disables publish while there are errors.
- **Preview**: the preview toolbar gets the same ⌨ button and panel. Overrides in the Studio are kept in memory for the Studio session only and are not written to localStorage. No first-play hint.
- **Templates**: every Studio template declares the actions it uses and reads them with the action API.

### 2.5 Desktop
- View → **Controls** (`CmdOrCtrl+Shift+K`). It dispatches `PLAYER_CONTROLS_EVENT`. It works while the game iframe has focus, because menu accelerators are handled natively. With no player or Studio preview mounted, or a game without actions or hint, it does nothing.

## 3. Contract changes (summary; normative text lives in docs/)
- **GAME_FORMAT.md § F009 additions**:
  - game.json: `actions` (validated, 422 on errors) and the free-text `controls` string (lenient, never 422).
  - The bindable key table, the gamepad button names and the default label table.
  - `boot` option `actions`; engine API `input.actions`, `input.defaultActions`, `input.actionDown/actionPressed/actionReleased`, `input.actionLabel`, `input.keyLabel`; `input.axis` behaviour with movement actions; `preventDefault` for bound keys.
  - Message `webgame:controls` (parent → game) and the parent behaviour.
  - The player page and Studio page pass `actions` to `boot`.
- **API.md § F009 additions**: `ControlAction`, `Game.actions`, `Game.controlsHint`, validation errors on upload and bundle replace. No new endpoints, no rate limit changes.
- **ARCHITECTURE.md § F009 additions**: data flow, migration `0010_f009.sql`, the startup backfill of existing games, the override storage, the three independent copies of the key table, ownership.

## 4. Per-area tasks

### engine-dev (`packages/engine/**`, `examples/**`)
1. **`src/actions.ts`** (new, pure, no DOM):
   - `BINDABLE_KEYS: readonly string[]` (83 keyboard codes + `Mouse0..2`, exactly the GAME_FORMAT § F009 table), `GAMEPAD_BUTTON_NAMES` (16 names, `Home` excluded), `keyLabel(code)` and `gamepadLabel(name)` per the default label table (unknown → the input string).
   - `parseActions(raw: unknown): { actions: ControlAction[]; warnings: string[] }`, **lenient**: applies the GAME_FORMAT rules, drops each invalid entry (or invalid key/button inside an entry) with a warning, and never throws. Non-array → `[]` + warning (absent/`null` → `[]`, no warning).
   - `applyOverrides(defaults, overrides: unknown): ControlAction[]`: for each known action id with an array value, replace `keys` with the valid, de-duplicated bindable codes, keeping the first 3. Unknown ids, non-array values and invalid codes are ignored. `gamepad` is never overridden.
   - `class ActionMap` built from the effective actions: per-action `down/pressed/released` computed from an `InputState` plus the first connected `GamepadState`, with the edge rules in GAME_FORMAT § F009 (action-level edges; a second bound key pressed while the first is held does not fire `pressed` again; a tap within one step reports both `pressed` and `released`).
2. **`input.ts`**:
   - `Input` owns an `ActionMap`. `setActions(defaults)` (from `boot`) and `setOverrides(overrides)` (from `webgame:controls`) rebuild it; the rebuild takes effect at the next `beginStep`. Button states are keyed by code, so a rebuild never leaves a key stuck.
   - Public: `actions` (frozen effective list, manifest order), `defaultActions`, `actionDown(id)`, `actionPressed(id)`, `actionReleased(id)`, `actionLabel(id)`, `keyLabel(code)`. An unknown id returns `false`/`""` and warns once per id.
   - `axis("horizontal")` uses `actionDown("left")`/`actionDown("right")` (plus the left stick analog) when **both** actions exist; `axis("vertical")` likewise with `up`/`down`. Otherwise the current hard-coded behaviour is unchanged.
   - `keydown`: also `preventDefault()` for any keyboard code bound in the effective actions (when neither Ctrl nor Meta is held), in addition to the existing `PREVENT` set. The F3 debug key is not bindable, so it is unaffected.
3. **`engine.ts`**: `BootOptions.actions?: unknown`, parsed with `parseActions` (warnings go to `console.warn` with the prefix `[pixelforge] actions:`). In the `start()` message switch, handle `webgame:controls` from `window.parent` only: `overrides` must be a plain object with at most 32 own keys, otherwise ignore the message. Each message replaces the previous overrides (it is not merged).
4. **`index.ts`**: export the `ControlAction` and `GamepadButtonName` types and `BINDABLE_KEYS`, `GAMEPAD_BUTTON_NAMES`, `keyLabel`.
5. **README.md**: an "Actions and remapping (F009)" section: declaring actions, the action API, `actionLabel` for prompts, how `axis()` changes when movement actions exist, the edge rules, and why games should read actions instead of raw codes. Note that `isDown(code)` still reports physical keys and ignores remapping.
6. **Examples** (`examples/*/game.json` and `main.js`), keeping the existing `controls` strings (shortened to ≤ 300 chars and ending with "Remap keys with ⌨."):
   - `space-dodge`: actions `left`, `right`, `up`, `down` (Arrows + WASD; D-pad), `fire` (`Space`, `KeyZ`, `KeyJ`; `A`, `RT`), `photo` (`KeyP`; `Back`), `mute` (`KeyM`). Replace raw key checks with the action API; title/game-over "press any key" stays on `anyPressed()`.
   - `pixel-peaks`: `left`, `right`, `down` (Arrows + A/D/S; D-pad), `jump` (`Space`, `ArrowUp`, `KeyW`; `A`), `photo`, `mute`. Note `KeyZ` is dropped from jump's defaults by the 3-key limit; mention it in the commit. Title text shows `actionLabel("jump")`.
   - `brick-breaker`: `left`, `right` (Arrows + A/D; D-pad), `launch` (`Space`, `Enter`, `Mouse0`; `A`), `mute` (`KeyM`). Paddle mouse/touch steering is unchanged.
   - Repack with `npm run examples`. Each example must also pass the backend's strict validation (§ backend 10).
7. **Tests** (`test/actions.test.ts`, extend `test/input.test.ts` and the engine message tests):
   - `parseActions`: valid manifest, each invalid case is dropped with a warning (bad id, duplicate id, name length, `Escape`, `F1`, `Home` gamepad, > 3 keys, duplicate key, zero bindings, > 32 entries), non-array.
   - `applyOverrides`: replace, clear (`[]`), unknown id, invalid code, > 3, de-duplication, gamepad untouched.
   - Edges with a fake `InputState`/`GamepadState`: hold key 1 then press key 2 → one `pressed`; tap within a step → `pressed` and `released`; release one of two held keys → no `released`; gamepad-only action.
   - `axis()` with and without movement actions; with only `left` declared → legacy behaviour.
   - `webgame:controls` from a non-parent source is ignored; a message with 33 keys is ignored; a second message replaces the first.
   - `keyLabel` table spot checks and the `BINDABLE_KEYS` length (86).

**Acceptance:** `npm test -w @webgame/engine`, `npm run typecheck -w @webgame/engine`, `npm run build:engine`, `npm run examples`. Manual: in space-dodge, remap fire to `K` in the panel while playing; `K` fires at once and `Space` no longer does; reload the page and it persists.

### backend-dev (`backend/**`)
1. **Migration `backend/migrations/0010_f009.sql`** exactly as in ARCHITECTURE § F009 (two nullable columns on `games`).
2. **`src/bundle.rs`**:
   - `ControlActionMeta { id, name, keys: Vec<String>, gamepad: Vec<String> }`, `BundleMeta.actions: Vec<ControlActionMeta>` and `BundleMeta.controls_hint: String`.
   - `parse_actions(v: &Value) -> Result<Vec<ControlActionMeta>, AppError>`: **strict**, the GAME_FORMAT § F009 rules; the first violation → 422 `validation` with a message naming the path, e.g. `game.json: actions[2].keys[1] "Escape" can't be bound`. Constants `MAX_ACTIONS = 32`, `MAX_ACTION_KEYS = 3`, `MAX_ACTION_GAMEPAD = 2`, `ACTION_NAME_MAX = 40`, and the `BINDABLE_KEYS` / `GAMEPAD_BUTTONS` tables.
   - `parse_controls_hint(v: &Value) -> String`: **lenient**, never errors (GAME_FORMAT rule). A non-string `controls` is ignored.
   - `parse_game_json` calls both. Name checks reuse the control/bidi character rules from `versions.rs`.
3. **Write path** (`routes/games.rs`): the create `INSERT` and the guarded bundle-replace `UPDATE … WHERE id = ? AND version = ?` also set `actions_json` (compact `serde_json` of the normalised list, `[]` when none) and `controls_hint`. Ordering and R1/F004 guarantees are unchanged.
4. **Read path** (`models.rs`): `GAME_SELECT` reads both columns. `Game.actions: Vec<ControlAction>` (deserialised from `actions_json`; `NULL` or unparsable → `[]`, logging a warning for unparsable) and `Game.controls_hint: String` (`NULL` → `""`). `GameSummary` is unchanged.
5. **Player page** (`routes/play.rs`): `render_player_html` gains an `actions_json: &str` argument and renders `actions: {ACTIONS}` into the `boot` options, where `ACTIONS` is a new helper `js_json_literal(json)` that applies the same escapes as `js_string_content` (`<`, `>`, `&`, U+2028, U+2029) to the JSON text. `NULL` → `[]`. The `Cache-Control: no-cache` and CSP are unchanged.
6. **Studio page** (`routes/play.rs`, the `/play/studio` script): pass `actions: manifest.actions` to `boot` (the engine parses it leniently; no server validation in the Studio).
7. **Startup backfill** (`src/controls_backfill.rs`, new, spawned after migrations like the screenshot sweep): in batches of 200, `SELECT id, version FROM games WHERE actions_json IS NULL`; read `data/games/{id}/v{version}/game.json` (skip > 1 MiB); compute `parse_actions` (on error, store `[]` and log at `info`) and `parse_controls_hint`; `UPDATE games SET actions_json = ?, controls_hint = ? WHERE id = ? AND version = ? AND actions_json IS NULL`. A missing or unreadable file stores `[]`/`""`. Best effort; a failure is logged and retried at the next start. Expose `backfill_controls(&AppState) -> anyhow::Result<usize>` for tests.
8. **Seed** (`seed.rs`): nothing to change if seeding goes through the normal upload path; verify the seeded examples get `actions`.
9. **Docs**: backend README, mention the backfill in the startup tasks list.
10. **Tests** (`tests/f009.rs`):
    - Upload with valid actions → `Game.actions` normalised (trimmed name, `keys`/`gamepad` defaulted to `[]`, unknown keys dropped), and `controlsHint` from `controls`.
    - Each 422 case: `actions` not an array; 33 entries; bad/duplicate id; empty or 41-char name; name with a control or bidi character; a `keys` entry that is not a string, `Escape`, `Tab`, `F5`, `MetaLeft`, duplicated, or 4 keys; `gamepad` with `Home` or 3 entries; no bindings at all. Also on bundle replace.
    - `controls` as a number/object → ignored, no 422; 500-char string → cut to 300; `\n` and tabs → spaces; collapsed whitespace.
    - Bundle replace updates both fields; a replace without `actions` clears them.
    - `/play/{id}` HTML contains the actions literal, and a name containing `</script>` is escaped (`</script>`).
    - `/play/studio` script passes `manifest.actions`.
    - Backfill: insert a game row with `actions_json = NULL` and a stored game.json → backfilled; an invalid stored `actions` → `[]`; a missing file → `[]`/`""`; a second run updates 0 rows.
    - The three packed examples (`examples/dist/*.zip`, when present) validate.

**Acceptance:** `cd backend && cargo test` (all suites green, including `review_fixes.rs` and F001–F013/F005) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types and constants**: `ControlAction`, `GamepadButtonName`; `Game.actions` and `Game.controlsHint`. `GamePlayerGame` picks `actions` and `controlsHint` (optional). New `src/controls.ts` exports `PLAYER_CONTROLS_EVENT = "webgame:player-controls"` (also from `index.ts`).
2. **`src/controls.ts`** (pure helpers with tests):
   - `BINDABLE_KEYS`, `GAMEPAD_BUTTON_NAMES`, `keyLabel(code, layout?: Map<string, string>)`, `gamepadLabel(name)`. With a layout, `Key*`, `Digit*` and punctuation codes use the layout's character uppercased; everything else uses the default table.
   - `validateActions(manifest): { path: string; message: string }[]`, the backend's strict rules (for the Studio form).
   - Overrides store: `readOverrides(gameId)`, `writeOverrides(gameId, overrides)`, `subscribeOverrides(gameId, fn)` (in-memory listeners plus the `storage` event for other tabs). Format and limits per ARCHITECTURE § F009. `writeOverrides` drops entries equal to the defaults and ids not in the current actions, and removes the key when nothing is left. localStorage errors fall back to memory for the session.
   - `effectiveActions(defaults, overrides)` (same semantics as the engine's `applyOverrides`) and `findConflicts(actions)`.
   - `useKeyboardLayout()`: resolves `navigator.keyboard.getLayoutMap()` once per app session when available, else `null`.
3. **`GamePlayer.tsx`**:
   - The ⌨ button and `ControlsPanel`. Listen for `PLAYER_CONTROLS_EVENT` on `window` while mounted (open the panel; ignored when the button is hidden).
   - **Pause reasons**: replace the single `pausedByVisibility` flag with a set of parent pause reasons (`visibility`, `controls`). Post `webgame:pause` when the set becomes non-empty and `webgame:resume` when it becomes empty. Existing visibility tests must still pass.
   - **`webgame:controls`**: when the game has ≥ 1 action, post `{ type: "webgame:controls", overrides }` to `iframe.contentWindow` right after the first `webgame:load` reply to each `webgame:hello` (so restarts get it too), and after every override change. Send only action ids and key codes. Never send labels, the layout map or any user data.
   - The first-play hint (§ 2.1).
4. **Components** (new): `ControlsPanel.tsx` (§ 2.2; `mode: "player" | "studio"`), `KeyCaptureButton.tsx` (shared by the panel and the Studio form; capture rules in § 2.2), `ControlsSummary.tsx` (§ 2.3, mounted in `GamePage.tsx`).
5. **Studio**:
   - `StudioPage.tsx` `ManifestForm`: the "Controls" fieldset (§ 2.4), using `validateActions`.
   - `PublishDialog.tsx`: block publish while `validateActions` returns errors.
   - `StudioPreview.tsx`: ⌨ button, panel in `studio` mode, in-memory overrides, and `webgame:controls` after each `studio-load`'s `hello`/`load`.
   - `templates.ts`: declare actions in every template and use `actionPressed`/`actionDown`/`axis()`.
6. **Docs page** (`DocsPage.tsx`): an "Actions and remapping" entry under input, with a game.json snippet.
7. **Styles**: panel table, capture state, "Changed" tag, warnings, hint popover, using existing tokens.
8. **Tests**:
   - `controls.test.ts`: label table and layout mapping; `validateActions` cases matching the backend list; overrides store round trip, pruning, defaults-equal removal, malformed stored JSON → `{}`, size cap; `findConflicts`.
   - `ControlsPanel.test.tsx`: capture assigns a key; Escape cancels; Tab shows "can't be used"; moving a key within an action; clear; reset row and reset all; conflict and Ctrl+W warnings; unbound warning; the gamepad column is read-only.
   - `GamePlayer.f009.test.tsx`: ⌨ hidden without actions and hint, shown with only a hint; `webgame:controls` posted after `load` and after a change, with only ids and codes; pause on open and resume on close; no resume while the tab is still hidden; `PLAYER_CONTROLS_EVENT` opens the panel; the first-play hint appears once per game.
   - `ControlsSummary.test.tsx`: effective bindings and live update; Customize dispatches the event.
   - Studio: the form fieldset (add, movement preset, capture, errors), publish blocked on errors, preview posts `webgame:controls` with in-memory overrides only.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
1. **Menu** (`src-tauri/src/menu.rs`): add View → "&Controls" with id `"controls"`, accelerator `CmdOrCtrl+Shift+K`, next to Take Screenshot. Add `"controls"` to `FORWARDED`, and update the module doc and the test.
2. **`src/nativeMenu.ts`**: on `"controls"`, `window.dispatchEvent(new CustomEvent(PLAYER_CONTROLS_EVENT))` (import the constant from `@webgame/ui`). Do not navigate.
3. **Verify**: in the Tauri webview, `navigator.keyboard.getLayoutMap` labels appear in the panel (WebView2), the accelerator opens the panel while the iframe has focus, and remaps persist across app restarts (the webview's localStorage).

**Acceptance:** `npm run build -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test && cargo check`.

### Sequencing
- Engine and backend are independent and can start in parallel.
- Frontend can build `controls.ts`, the panel and the Studio form at once against mocks. Live remapping needs the engine build, and `Game.actions` from the API needs the backend.
- Desktop needs only the exported `PLAYER_CONTROLS_EVENT` constant, which frontend lands first (a one-line change).
- The examples must be repacked after the engine part so the seed and `tests/f009.rs` see the new game.json files.

## 5. Edge cases and security
- **Sandbox model unchanged**: no new iframe permissions and no new API reads from the game. `webgame:controls` carries only action ids (which the game declared) and key codes. The engine accepts it only from `window.parent`; the parent sends it only to its own iframe.
- **No layout leak**: the Keyboard Map API is restricted to top-level documents because a layout is a fingerprinting signal. The parent uses it for its own panel labels only and never forwards labels or the map. As a consequence, in-game `actionLabel` uses the default (US) label table. On an AZERTY keyboard a default `KeyW` binding is labelled "W" in-game but "Z" in the panel. This is a documented limitation.
- **Untrusted manifest text in HTML/JS**: action names are plain text everywhere in the UI (React text nodes). In the player page they are inside a JSON literal escaped for `<script>` (`js_json_literal`), and the backend already rejects control and bidi characters in names. The hint is plain text with control characters removed.
- **Browser-reserved shortcuts**: `Escape` (exits fullscreen and pointer lock), `Tab` (focus), F-keys (F3 debug, F5 reload, F11 fullscreen), `Meta*`, `CapsLock`, `ContextMenu`, `PrintScreen` and the gamepad `Home` button are not bindable. Ctrl+W/T/N can't be prevented by any page; the panel warns (§ 2.2).
- **Stale overrides after a game update**: overrides are keyed by action id. Ids that no longer exist are ignored by the engine and pruned on the next write. If a creator changes an action's defaults, players who never remapped it follow the new defaults (equal-to-default overrides are not stored).
- **Old engine build** (cached `engine.js`): the message is ignored and the game uses its own code paths. The engine is served `no-cache` + ETag (R6), so this is rare.
- **Games that ignore actions**: a game may declare actions but read raw codes. Remapping then has no effect. The README tells creators to read actions; the panel can't detect this.
- **Raw `isDown(code)` is not remapped** by design, so text entry, debug keys and games that intentionally read physical keys keep working.
- **Keys stuck after a remap**: button state is per code, and the action map is rebuilt between steps, so a held key that is unbound simply stops counting for that action. A key held while the panel is open is released by the engine's `blur` handler (focus moves to the parent dialog).
- **Pause interplay**: the host pause reason in the engine is a single flag. The parent keeps its own reason set so closing the panel does not resume a game whose tab is hidden, and vice versa.
- **Backward compatibility of game.json**:
  - `controls` was free text in existing bundles and stays lenient (never 422), so re-uploading old bundles keeps working.
  - `actions` is new. A bundle that happened to use an `actions` key with another meaning now gets a 422 on upload; the stored copy of such a game is backfilled as `[]` instead of failing.
- **Backfill**: idempotent (`WHERE actions_json IS NULL`) and guarded by `version`, so a bundle replace during the backfill wins. Reading `game.json` is capped at 1 MiB.
- **localStorage**: per device and per origin, so web and desktop keep separate bindings, and clearing site data resets them. A stored entry is capped at 4 KB; a larger or malformed entry is discarded.
- **Studio**: the preview's overrides never touch localStorage and never call the API (Studio rule).

## 6. Test expectations
- **Engine**: lenient parsing, override application, action edge rules, `axis()` with and without movement actions, `preventDefault` for bound keys (a jsdom keydown test), the message origin check and replace semantics, the label table.
- **Backend**: `tests/f009.rs` as listed (strict validation on upload and replace, lenient hint, normalisation, player page escaping, Studio page wiring, backfill, packed examples). All previous suites stay green.
- **UI**: `controls.ts` helpers, the panel's capture and warnings, the player message and pause-reason behaviour, the summary, the Studio form and publish gate, the first-play hint.
- **Desktop**: the menu `FORWARDED` test and a green build. Manual: the accelerator while the iframe has focus, layout labels, persistence across restarts.
- **Manual end to end**:
  - Play space-dodge on the web, open ⌨, remap fire to `K`, close: the game resumes and `K` fires. Reload: the binding persists. Reset all: `Space` fires again.
  - Pixel Peaks' title prompt shows the remapped jump key after a restart.
  - A game uploaded before F009 with a `controls` string shows the hint after a backend restart, with no re-upload.
  - Upload a bundle with `"keys": ["Escape"]` → 422 with the path in the message.
  - Studio: add actions in the form, remap in the preview, publish, and see `Game.actions` on the game page.
  - Desktop: Ctrl+Shift+K opens the panel while playing.

# F016: Gamepad remapping and synced control bindings

Status: **shipped**. Size: **M** (engine and frontend main; backend small; desktop verification only; one round). Areas: engine (+ examples), backend, frontend, desktop.
Contracts: `docs/GAME_FORMAT.md` § F016 additions (the `gamepad` field of `webgame:controls`, gamepad override rules, `input.lastDevice`, `actionLabel(id, device)`, the resume latch, parent capture rules), `docs/API.md` § F016 additions (`ControlBindings`, `GET`/`PUT /api/games/{id}/controls`, validation, `Limit::Controls`, body limit), `docs/ARCHITECTURE.md` § F016 additions (migration `0020_f016.sql`, the sync algorithm, the extended on-device entry, ownership).
Depends on: F009 (shipped): actions, overrides store, `ControlsPanel`, `webgame:controls`. Reuses the cloud-save pattern (`fetch_visible_game`, per-user per-game row, debounced `PUT` with `keepalive`), the F009 pause reasons and `useModal`. The migration is **`0020_f016.sql`** and runs after `0019_f021.sql`. **No new Rust or JS dependencies.**

## 1. Goal and user stories
F009 let players remap keys, but the gamepad column of the controls panel is read-only, and bindings live in one browser's localStorage. A controller player who prefers jump on `B`, a player with an adaptive controller, or someone whose `A` button is broken has no way to change anything. A player who remaps on the web loses their bindings in the desktop app (a different origin, so a different localStorage), and on every other device.

Games also can't tell which device the player is using, so prompts say "Press Space" to someone holding a controller.

F016 adds:
- **Gamepad remapping** in the controls panel: two capture slots per action, using the parent page's Gamepad API. Applied to the running game at once, like key remaps.
- **Account sync**: when signed in, bindings (keys and gamepad) are stored per user per game on the server and follow the account to every device, the desktop app included. Anonymous players keep the F009 device-only behaviour.
- **Device-aware prompts in the engine**: `input.lastDevice` and `input.actionLabel(id, "auto")`, which says "Press A" after the player touches a controller and "Press Space" after they touch the keyboard.
- **Resume latch**: gamepad buttons held when the game resumes (e.g. the button just captured in the panel) never fire `pressed` in the game.

User stories:
1. As a controller player in Pixel Peaks, I open ⌨, click the first Gamepad slot of "Jump", press `B` on my controller and click Done. `B` now jumps; `A` no longer does.
2. As the same player, I sign in on the desktop app the next day. My `B` jump binding (and my key remaps) are already there.
3. As a player who remapped keys on this laptop before F016, I sign in for the first time after F016: my existing device bindings are uploaded to my account instead of being lost.
4. As a creator, I write `Press ${engine.input.actionLabel("jump", "auto")} to start`. Keyboard players see "Press Space"; when someone moves the stick, it changes to "Press A" (or "Press B" for the player in story 1).
5. As a player whose remap upload failed (offline on a train), my change still applies and is kept on the device; the panel says it couldn't save to my account, and it is uploaded the next time I play that game online.
6. As a Studio user, I remap gamepad buttons in the preview to test my game; nothing is stored or sent to the server.

Non-goals (later items): remapping analog sticks or axes, dead-zone and trigger-threshold settings, per-controller-model bindings, button glyphs per controller family (Xbox/PlayStation icons), non-standard-mapping controllers, selecting a gamepad button from a list without a controller, global (all games) default bindings, a "stop syncing" switch, syncing the Studio preview's in-memory overrides.

## 2. UX notes

### 2.1 Controls panel (`ControlsPanel`)
- The **Gamepad** column becomes two `GamepadCaptureButton` slots per action (same layout as the three key slots). A filled slot shows the label (`gamepadLabel`, e.g. "A", "D-pad ↑") and a small × "Clear" button (`aria-label="Clear gamepad {button} from {action}"`). An empty slot shows "—".
- Clicking a slot enters **gamepad capture** (§ 2.2). Only one slot (key or gamepad) can be in capture mode at a time.
- **Changed** tag and the row **Reset** button now cover keys **and** gamepad buttons: Reset restores both to the defaults. **Reset all** likewise.
- **Unbound** ("Unbound" in the warning colour) uses the effective keys and effective gamepad buttons.
- **Conflicts**: a row whose key **or** gamepad button is also bound to another action shows "Also used by {names}" (one combined list, manifest order, no duplicates). Warnings never block.
- Footer note (replaces "Saved on this device"):
  - `mode="studio"`: "Kept for this Studio session".
  - player, anonymous: "Saved on this device".
  - player, signed in, last sync OK or pending: "Saved to your account".
  - player, signed in, last upload failed: "Saved on this device. Couldn't save to your account; it will be retried." (`role="status"`).
- The panel never shows controller names (`Gamepad.id`).

### 2.2 Gamepad capture (`GamepadCaptureButton` + `gamepadCapture.ts`)
- The slot shows "Press a button…", with `aria-live="polite"` text "Press a button on your controller for {action}, or Escape to cancel".
- The parent polls `navigator.getGamepads()` once per animation frame while capturing (§ GAME_FORMAT F016 "Parent capture").
- The first standard-mapping button that goes from released to pressed **after capture started** is assigned to the slot. Buttons already held when capture starts, or when a controller is first seen, are ignored until released and pressed again.
- A button already in the other gamepad slot of the same action moves to this slot.
- Inline messages (capture continues unless stated):
  - No controller seen yet: "Press any button on your controller. If nothing happens, reconnect it." (shown at once; the first press of a newly seen controller only "wakes" it, see GAME_FORMAT).
  - `Home` (button 16) or any index above 16: "That button can't be used".
  - A press on a controller whose `mapping` is not `"standard"`: "This controller isn't supported yet".
  - The Gamepad API is missing or throws (e.g. plain-`http` LAN address, permissions policy): "Controllers aren't available on this page" and capture **ends**.
- Capture ends without change on `Escape` (keyboard), blur of the button, a mouse click elsewhere, or after 10 s. Keyboard keys other than `Escape` are ignored during gamepad capture.
- Respects `prefers-reduced-motion` (no pulsing) like `KeyCaptureButton`.

### 2.3 Game page `ControlsSummary`
- Shows the effective gamepad buttons (defaults plus overrides) instead of the defaults, and updates live, like keys.

### 2.4 Sync (player only; invisible unless it fails)
- Signed-in players get account sync automatically, like cloud saves. There is no switch: the panel footer says where bindings are saved (§ 2.1).
- Signing in on a device whose stored bindings were never synced uploads them when the account has none for that game (story 3). If the account already has bindings for that game, the account copy wins.
- Signing out keeps the device copy (it is a cache and the anonymous store).

### 2.5 Studio
- The preview's panel gets gamepad capture too; overrides stay in memory (`mode="studio"`), never touch localStorage or the API, and are sent with `webgame:controls` after each load, as in F009.
- The game.json form's gamepad selects (manifest defaults) are unchanged.
- The "Menu & HUD" template's prompt uses `actionLabel(id, "auto")`.

### 2.6 Desktop
- No new UI. View → Controls (F009) opens the same panel; capture works in WebView2. Bindings synced on the web appear in the desktop app after sign-in, and vice versa.

## 3. Contract changes (summary; normative text lives in docs/)
- **GAME_FORMAT.md § F016 additions**: `webgame:controls` gains optional `gamepad: { [actionId]: GamepadButtonName[] }`; gamepad override rules; `input.lastDevice`; `input.actionLabel(id, device?)`; the resume latch; parent capture and sending rules; "For creators".
- **API.md § F016 additions**: `ControlBindings`, `ControlBindingsResponse`; `GET 🔒 /api/games/{id}/controls`, `PUT 🔒 /api/games/{id}/controls`; strict validation (422), normalisation against the current actions, 16 KiB body limit (413), `Limit::Controls` 60/min per user on `PUT`.
- **ARCHITECTURE.md § F016 additions**: migration `0020_f016.sql` (`control_bindings`), the sync algorithm and the `unsynced` marker, the extended on-device entry (`gamepad`, cap raised to 8192 bytes), the fourth copy of the tables (none: the backend reuses `bundle.rs`), ownership.

## 4. Per-area tasks

### engine-dev (`packages/engine/**`, `examples/**`)
1. **`src/actions.ts`**:
   - `export type GamepadOverrides = Record<string, GamepadButtonName[]>`.
   - `applyOverrides(defaults, keyOverrides: unknown, gamepadOverrides?: unknown)`: keys exactly as today; additionally, for each known id with an array value in `gamepadOverrides`, `gamepad` becomes the valid (`isGamepadButtonName`), de-duplicated names, first 2. Non-object `gamepadOverrides`, unknown ids, non-array values and invalid names are ignored. `[]` means "no gamepad buttons".
2. **`src/input.ts`**:
   - `setOverrides(keys: unknown, gamepad?: unknown)` replaces both (absent `gamepad` = no gamepad overrides) and rebuilds at the next step, as today.
   - `lastDevice: InputDevice` (`type InputDevice = "keyboard" | "mouse" | "touch" | "gamepad"`), read-only, initial `"keyboard"`. Update rules in GAME_FORMAT § F016.
   - `actionLabel(id, device?: "keyboard" | "gamepad" | "auto")`: without `device`, unchanged. `"keyboard"`: label of the first effective key (mouse codes included) or `""`. `"gamepad"`: label of the first effective gamepad button or `""`. `"auto"`: `"gamepad"` when `lastDevice === "gamepad"` and the action has an effective gamepad button, otherwise the no-argument behaviour. Unknown ids → `""` with the existing once-per-id warning.
   - **Resume latch**: `GamepadState.latch()` makes the next `poll` copy the new pressed state into `prev` (no edges in that step). `Input.latchGamepads()` calls it on all four pads. The engine calls it on host `webgame:resume` and on window `focus`. Held buttons then report `isDown` but not `wasPressed`; a release after that reports `wasReleased` as usual.
3. **`src/engine.ts`**: in the `webgame:controls` case, accept `d.gamepad` when it is `undefined` or passes the existing `isOverridesObject` check (plain object, ≤ 32 own keys); otherwise ignore the **whole** message. Call `input.setOverrides(d.overrides, d.gamepad)`. Call `input.latchGamepads()` on `webgame:resume`.
4. **`src/index.ts`**: export the `InputDevice` and `GamepadOverrides` types.
5. **README.md**: extend "Actions and remapping" with gamepad remapping (players can now change gamepad buttons, so read actions instead of `gamepad(0).wasPressed("A")`), `lastDevice`, `actionLabel(id, "auto")`, and the resume latch. Note that F012 menu navigation keeps the fixed gamepad D-pad/`A`/`B` fallbacks.
6. **Examples**:
   - `pixel-peaks`: the title prompt uses `actionLabel("jump", "auto")`.
   - `space-dodge`: title/game-over prompts that name a key use `actionLabel(…, "auto")`. Any raw `gamepad(0)` checks for declared actions are replaced with the action API.
   - `brick-breaker`, `ember-garden`: replace raw gamepad checks for declared actions with the action API if any exist; otherwise unchanged.
   - Repack with `npm run examples`; each must still pass the backend's strict `actions` validation.
7. **Tests** (extend `test/actions.test.ts`, `test/input.test.ts`, `test/input-gamepad.test.ts`, the engine message tests):
   - `applyOverrides` with gamepad: replace, `[]` clears, unknown id, `Home`, invalid name, 3 names → first 2, duplicates, keys and gamepad independent, absent gamepad leaves defaults.
   - An action remapped from `A` to `B`: `B` fires `pressed`, `A` no longer does; edges still action-level.
   - Message: `gamepad` absent → defaults; `gamepad` an array or with 33 keys → whole message ignored (keys not applied either); a second message without `gamepad` clears earlier gamepad overrides.
   - `lastDevice` transitions for keydown, mouse button, touchstart, a gamepad button edge and a stick crossing 0.5; same-step precedence (gamepad last); key repeat does not count.
   - `actionLabel` with each `device` value, including `"auto"` falling back to the key when the action has no gamepad button.
   - Resume latch: a button held across `webgame:resume` reports `isDown` but not `wasPressed`/`actionPressed`; a fresh press after release fires.

**Acceptance:** `npm test -w @webgame/engine`, `npm run typecheck -w @webgame/engine`, `npm run build:engine`, `npm run examples`. Manual: in Pixel Peaks, remap jump to `B` in the panel with a controller; `B` jumps and `A` doesn't; the title prompt switches between "Space" and "B" as you touch keyboard and controller.

### backend-dev (`backend/**`)
1. **Migration `backend/migrations/0020_f016.sql`** exactly as in ARCHITECTURE § F016.
2. **`src/routes/controls.rs`** (new), modelled on `saves.rs`:
   - `get_controls`: `fetch_visible_game(&state, &id, Some(&user.id))`; read the row; `None` → `{ "bindings": null, "updatedAt": null }`; otherwise parse the stored JSON (unparsable → treat as no row and log a warning) and return it **filtered** against the game's current actions (`normalize_bindings`, below).
   - `put_controls`: `fetch_visible_game`, then `limit_user(&state, Limit::Controls, &user.id)`, then validate the body strictly (API § F016 rules; the first violation → 422 naming the path, e.g. `bindings.gamepad.jump[0] "Home" can't be bound`). Normalise, upsert (`INSERT … ON CONFLICT (user_id, game_id) DO UPDATE`), return `{ bindings, updatedAt }`. An empty result is stored as `{"keys":{},"gamepad":{}}` (a row, not a delete).
   - `normalize_bindings(bindings, actions: &[ControlAction]) -> ControlBindings`: keep only ids declared by the current version, de-duplicate in order, drop entries equal to that action's defaults (same order), serialise with ids in manifest order.
   - Reuse `bundle.rs`'s `BINDABLE_KEYS`, `GAMEPAD_BUTTONS`, the action id rule and the `MAX_ACTIONS`/`MAX_ACTION_KEYS`/`MAX_ACTION_GAMEPAD` constants (make them `pub(crate)` if needed). No new copy of the tables.
3. **Router** (`routes/mod.rs`): `/games/{id}/controls` → `get(get_controls).put(put_controls)` with `.layer(DefaultBodyLimit::max(CONTROLS_BODY_LIMIT))`, `pub const CONTROLS_BODY_LIMIT: usize = 16 * 1024`.
4. **Rate limit** (`ratelimit.rs`): `Limit::Controls` = 60 per 60 s, per user, doc comment "F016 control bindings `PUT …/controls`: 60/min, per user". The check comes after the visibility 404 (as `put_save` does).
5. **Docs**: backend README endpoint list.
6. **Tests** (`tests/f016.rs`, using `common::test_dir()` for any custom config and the `TestApp.clock` `ManualClock` for the rate limit):
   - Anonymous `GET`/`PUT` → 401. Unpublished game: non-owner → 404, owner → 200. Unknown game → 404.
   - `GET` with no row → `{ bindings: null, updatedAt: null }`.
   - `PUT` valid → 200, normalised (unknown ids dropped, entries equal to defaults dropped, duplicates removed, manifest order); `GET` returns the same; `updatedAt` RFC3339.
   - `PUT` with `keys` and `gamepad` absent / `null` → stored as empty objects; a second `GET` returns `{ keys: {}, gamepad: {} }` (not `null`).
   - `Mouse0` accepted in `keys`.
   - Each 422: `bindings` missing, an array, or a string; `keys` an array; 33 ids; an id `"Jump!"`; a value that is not an array; a non-string code; `Escape`; `F5`; 4 keys; duplicate key; gamepad `Home`; gamepad `"Triangle"`; 3 buttons.
   - 413 for a 17 KiB body (`payload_too_large`).
   - Rate limit: 60 `PUT`s succeed, the 61st → 429 with `Retry-After`; after `clock.advance(Duration::from_secs(60))` it succeeds. `GET` is never limited.
   - Bundle replace that removes action `fire` → `GET` no longer returns `fire`; one that changes `jump`'s default to the stored override → `GET` drops it (equal to defaults).
   - Users are isolated: user B's `GET` never returns user A's bindings.
   - Deleting the game deletes its rows (FK cascade).

**Acceptance:** `cd backend && cargo test` (all suites green) and `cargo clippy --all-targets -- -D warnings`. No new crates.

### frontend-dev (`packages/ui/**`, `apps/web/**`)
1. **Types and client** (`api/types.ts`, `api/client.ts`): `GamepadOverrides`, `ControlBindings = { keys: ControlOverrides; gamepad: GamepadOverrides }`, `ControlBindingsResponse = { bindings: ControlBindings | null; updatedAt: string | null }`. `getControls(id, signal?)`, `putControls(id, bindings, opts?: { keepalive?: boolean })` → `{ bindings: ControlBindings; updatedAt: string }`.
2. **`src/controls.ts`**:
   - `sanitizeGamepadOverrides(raw)` (ids per rule, arrays only, valid names, unique, ≤ 2, ≤ 32 ids), `sanitizeBindings(raw): ControlBindings`.
   - `effectiveActions(defaults, overrides, gamepad?)` also applies gamepad overrides (engine semantics). `pruneBindings(bindings, defaults)` drops undeclared ids and entries equal to the defaults, for keys and gamepad separately. `isActionChanged` covers both. `findConflicts` covers keys and gamepad buttons (combined list per action).
   - Store: the entry gains optional `gamepad` and `unsynced` (ARCHITECTURE § F016); `CONTROLS_OVERRIDES_MAX_BYTES` becomes 8192. New `readBindings(gameId)`, `writeBindings(gameId, bindings, defaults?, opts?: { unsynced?: string | null })`, `subscribeBindings`, `useStoredBindings`, `readUnsynced(gameId)`. Keep `readOverrides`/`writeOverrides`/`subscribeOverrides`/`useStoredOverrides` as thin wrappers for keys (an entry written by F009 code without `gamepad` must still read correctly, and a keys-only write must keep the stored `gamepad`).
   - `controlsMessage(defaults, bindings)` → `{ type: "webgame:controls", overrides, gamepad }`, both pruned; `gamepad` is always present (possibly `{}`), so each message replaces both sets.
3. **`src/gamepadCapture.ts`** (new, pure logic plus one rAF loop, testable with a fake `getGamepads`): `startGamepadCapture({ onButton(name), onMessage(kind), onUnavailable() }): () => void` implementing GAME_FORMAT § F016 "Parent capture" (per-pad baseline, standard mapping only, indices 0–15, `Home`/>16 message, non-standard message, `SecurityError`/missing API → unavailable). It never reads or exposes `Gamepad.id` beyond the baseline key (index + id kept in memory only).
4. **Components**:
   - `GamepadCaptureButton.tsx` (new; § 2.2; mirrors `KeyCaptureButton`'s focus, blur, click-outside, Escape and 10 s rules; one capture at a time across the panel).
   - `ControlsPanel.tsx`: props become `bindings: ControlBindings` and `onChange(bindings)`, plus `syncState?: "device" | "account" | "failed"` for the footer (§ 2.1). Gamepad slots, combined Changed/Reset/Unbound/conflicts.
   - `ControlsSummary.tsx`: effective gamepad buttons, live.
5. **Sync** (`src/controlsSync.ts`, new hook `useControlsSync(gameId, defaults, user, api)` used by `GamePlayer` only; algorithm in ARCHITECTURE § F016): mount/user change → upload-or-adopt; changes → write locally with `unsynced`, debounced `PUT` (1000 ms); flush on unmount with `keepalive`; success clears `unsynced` only when the entry hasn't changed since; exposes `syncState`. Adopting a server copy writes the device store, which (through the existing subscription) posts a fresh `webgame:controls`.
6. **`GamePlayer.tsx`**: use `useStoredBindings` + `useControlsSync`; post `controlsMessage(defaults, bindings)` after the first `webgame:load` and after every change (keys or gamepad). Never post labels, `Gamepad.id`, user ids or sync state into the iframe.
7. **Studio** (`StudioPreview.tsx`): in-memory `ControlBindings`; panel `mode="studio"`; `controlsMessage` with gamepad. `templates.ts`: the Menu & HUD prompt uses `actionLabel(id, "auto")`.
8. **Docs page** (`DocsPage.tsx`): under "Actions and remapping", gamepad remapping, `lastDevice` and `actionLabel(id, "auto")` with a snippet.
9. **Styles**: gamepad slots reuse the key-slot styles; capture state; the failed-sync note uses the warning colour.
10. **Tests**:
    - `controls.test.ts`: gamepad sanitise/prune/effective; `findConflicts` with buttons; store round trip with `gamepad` and `unsynced`; an F009-format entry reads with empty gamepad; keys-only write keeps `gamepad`; 8192-byte cap; message always has `gamepad`.
    - `gamepadCapture.test.ts` (fake `navigator.getGamepads` + fake rAF): assigns on a released→pressed edge; ignores a button held at start and at first sighting until re-pressed; `Home` and index 17 messages; non-standard mapping message; throwing `getGamepads` → unavailable; cancel stops polling.
    - `ControlsPanel.test.tsx`: gamepad capture assigns, moves within an action, clears; Reset row/Reset all restore both; Unbound with all gamepad cleared; button conflict warning; footer text for each `syncState` and Studio mode; one capture at a time.
    - `controlsSync.test.ts` (mock client, fake timers): server row adopted (local overwritten, message posted); no server row + local non-empty → `PUT`; `unsynced === user.id` → `PUT` without adopting; `PUT` failure → `failed` and `unsynced` kept; success clears `unsynced` only when unchanged; debounce coalesces 3 changes into 1 `PUT`; unmount flush uses `keepalive`; anonymous → no requests; user switch re-runs; a `401` does not retry in a loop.
    - `GamePlayer.f016.test.tsx`: posted message includes `gamepad` and only ids/codes/names; adoption posts a fresh message.
    - `ControlsSummary.test.tsx`: effective gamepad buttons.
    - `ApiClient.f016.test.ts`: paths, methods, body shape, `keepalive`.

**Acceptance:** `npm test -w @webgame/ui`, `npm run typecheck -w @webgame/ui`, `npm run build:ui`, `npm run build:web`.

### desktop-dev (`apps/desktop/**`)
1. No code changes are expected. Verify in the Tauri app (WebView2):
   - Gamepad capture in the controls panel (View → Controls, `Ctrl+Shift+K`) with a standard controller.
   - Bindings synced from the web app appear after sign-in on desktop, and a desktop remap appears on the web after reload.
   - The app's CSP `connect-src` already allows the configured server for `PUT …/controls` (no change expected; fix only if blocked).
2. If WebView2 needs a permission or setting for the Gamepad API in the top-level document, add it and document it in `apps/desktop/README.md`.

**Acceptance:** `npm run build -w @webgame/desktop`, `cd apps/desktop/src-tauri && cargo test && cargo check`.

### Sequencing
- Engine, backend and the frontend's pure parts (`controls.ts`, `gamepadCapture.ts`, panel) can start in parallel.
- Live gamepad remapping needs the engine build; sync needs the backend endpoints (frontend tests mock the client).
- Examples are repacked after the engine part. Desktop verifies last.

## 5. Edge cases and security
- **Sandbox model unchanged**: no new iframe permissions and no new data readable by games. `webgame:controls` still carries only declared action ids, key codes and gamepad button names. The engine accepts it only from `window.parent`.
- **Controller fingerprinting**: the parent reads gamepads only while a gamepad slot is capturing. `Gamepad.id` (vendor/product) is never stored, sent to the server or posted to the game.
- **Server copy is private**: only the owning user can read or write their bindings; nothing is exposed to game owners, in stats or on profiles. Rows cascade on user and game deletion.
- **Strict server validation, lenient engine**: the server rejects malformed bindings with 422 (bounded size, known tables), the client sanitises before sending, and the engine ignores anything invalid.
- **Stale bindings after a game update**: ids not declared by the current version and entries equal to the current defaults are filtered on `GET` and dropped on `PUT`; the device store prunes on write (F009 rule). Players who never remapped an action follow new defaults.
- **Conflicting devices**: the account copy wins on load, except when this device holds an unsynced change for the same user (then the device copy is uploaded). Two devices editing offline: the last successful upload wins; no merge.
- **Shared device**: the device entry is per game, not per user. A second account with no server copy for that game adopts the device bindings on first play. Bindings are not sensitive; documented.
- **Lockout**: a player can unbind or move menu buttons, but F012 menu navigation keeps the fixed D-pad / `A` / `B` fallbacks, and the parent panel is always reachable with the mouse, the ⌨ button and `Ctrl+Shift+K` on desktop. Reset all restores the defaults.
- **Captured button leaking into the game**: the game is paused while the panel is open, and the resume latch stops a still-held button from firing `pressed`.
- **Gamepad API unavailable** (plain-`http` LAN, permissions policy, old browsers): capture shows "Controllers aren't available on this page"; gamepad slots can still be cleared and reset. The engine already falls back to no gamepads.
- **Wake-up press**: browsers expose a controller only after a button press while the page is visible. The first press may only wake the controller (it is held at first sighting and ignored); the message tells the player to press a button.
- **Non-standard controllers**: their button indices have no meaning, so they can't be captured (message); the engine still reads them as before.
- **Old engine build**: ignores `gamepad` in the message (only keys apply). Old parent with a new engine: no `gamepad` → defaults.
- **Body and rate limits**: 16 KiB body (413), 60 `PUT`/min per user (429). The client's 1 s debounce keeps normal use far below.
- **Studio**: preview bindings never touch localStorage or the API (Studio rule).

## 6. Test expectations
- **Engine**: gamepad overrides in `applyOverrides` and the message (replace semantics, whole-message rejection), remapped edges, `lastDevice`, `actionLabel` devices, resume latch. All F009/F012 input tests stay green.
- **Backend**: `tests/f016.rs` as listed (auth, visibility, normalisation, every 422, 413, the `ManualClock` rate limit, bundle-replace filtering, isolation, cascade). All previous suites stay green.
- **UI**: `controls.ts` extensions and backward-compatible store, `gamepadCapture.ts`, the panel, the sync hook, the player message, the summary, the client.
- **Desktop**: green build; manual capture and cross-app sync.
- **Manual end to end**:
  - Web, signed in: remap Pixel Peaks jump to gamepad `B` and a key to `K`; reload: both persist; the network shows one `PUT …/controls` per burst of changes.
  - Desktop, same account: both bindings are there on first play.
  - Anonymous: remap, reload: persists (device only); sign in: the bindings are uploaded (`PUT`), and appear on another device.
  - Offline (devtools): remap shows the failed-sync note; back online, reopen the game: uploaded.
  - Title prompt in Pixel Peaks flips between "Space" and "B" with the last device used.
  - Studio preview: gamepad remap works; no `…/controls` requests.

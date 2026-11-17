# Game bundle format & engine runtime contract

## Bundle (.zip)
```
my-game.zip
├─ game.json        (required, at zip root — or inside a single top-level folder, which the backend strips)
├─ main.js          (entry, ES module)
└─ assets/...       (any png/jpg/jpeg/webp/gif/svg/json/txt/fnt/wav/mp3/ogg/js/css/woff2/ttf files; see the "F012 additions" section for .fnt)
```
`game.json`:
```json
{ "name": "Space Dodge", "entry": "main.js", "width": 800, "height": 600, "engine": "1" }
```
- `entry` must be a relative `.js` path inside the bundle. `width`/`height` 64–4096 (logical resolution; the canvas scales to fit, preserving aspect).
- Backend validation: ≤ 50MB compressed, ≤ 200MB uncompressed, ≤ 2000 files, reject absolute paths / `..` / symlinks, only allowed extensions; missing/invalid game.json → 422 `validation`.

## Game module (what the author writes)
The entry module default-exports a **game object or class** (class → instantiated with `new`):
```js
export default {
  async load(engine) {},          // optional: load assets (engine.assets.*), set up scenes
  update(engine, dt) {},          // dt in seconds, fixed 60Hz steps
  render(engine, alpha) {},       // draw with engine.renderer.*
};
```
Authors import nothing — the engine instance is passed in. Constants/classes are available on `engine` too (e.g. `engine.Vec2`, `engine.Color`), so bundles stay dependency-free.

## Engine public surface (minimum — engine-dev may add more, must document in packages/engine/README.md)
- `boot(canvas: HTMLCanvasElement, game, opts: { width, height, baseUrl }) : Promise<Engine>` — named export of `engine.js`.
- `engine.width`, `engine.height`, `engine.time` (seconds), `engine.frame`
- `engine.renderer`: `clear(color)`, `drawSprite(tex, x, y, opts?{w,h,rotation,originX,originY,frame,flipX,tint,alpha})`, `drawRect(x,y,w,h,color)`, `drawLine`, `drawCircle`, `drawText(text,x,y,{size,color,align})`, `camera {x,y,zoom,shake()}`, batched WebGL2 sprite renderer.
- `engine.assets`: `loadTexture(path)`, `loadSpriteSheet(path, frameW, frameH)`, `loadSound(path)`, `loadJSON(path)`, `loadText(path)` — paths relative to the bundle `baseUrl`.
- `engine.input`: `isDown(key)`, `wasPressed(key)`, `wasReleased(key)` (KeyboardEvent.code, e.g. "ArrowLeft", "Space"), `mouse {x,y,down,pressed}` in game coords, `touches`, `gamepad(i)`, `axis("horizontal"|"vertical")` (WASD/arrows/gamepad).
- `engine.audio`: `play(sound, {volume, loop, pitch})` → handle with `stop()`, `masterVolume`. Unlocks on first user gesture.
- `engine.scenes`: optional scene stack `push/pop/replace(scene)`; scene has same `load/update/render` shape.
- Utilities: `Vec2`, `Color`, `Rect` AABB `intersects`, `Tilemap` (from 2D array or JSON), `random`, `Tween`/easing, simple `Physics` (AABB bodies, gravity, velocity, collision resolution vs tilemap/solids), `ParticleEmitter`.
- `engine.storage`: `get(key)`, `set(key, value)` — per-game save data (in-memory, since the sandbox has no storage; also mirrored to parent via `webgame:save` message, best effort).
- `engine.platform`:
  - `submitScore(n)` → `parent.postMessage({ type: "webgame:score", score: n }, "*")`
  - `ready()` → `{ type: "webgame:ready" }` (engine calls it automatically after `load`)
  - `error` → engine posts `{ type: "webgame:error", message }` on uncaught errors
  - parent may send `{ type: "webgame:pause" }` / `{ type: "webgame:resume" }` / `{ type: "webgame:mute", muted }`
  - `requestFullscreen()` → `{ type: "webgame:fullscreen" }` (parent fullscreens its player wrapper)
  - storage persistence: engine posts `{ type: "webgame:save", data }` on `storage.set/remove`; the parent persists `data` (localStorage key `webgame.save.{gameId}`, max 256KB) Handshake: at the start of `boot` the engine posts `{ type: "webgame:hello" }`; the parent replies `{ type: "webgame:load", data: <saved or null> }`; the engine waits up to 500ms for that reply before calling `game.load`, so saved data is available from the first read.

## Player page (served by backend at /play/{id})
Backend renders this HTML (engine-dev owns nothing here; backend-dev owns it, but it MUST match):
```html
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{display:block;margin:auto}</style>
</head><body><canvas id="game"></canvas>
<script type="module">
  import { boot } from "{ORIGIN}/runtime/engine.js";
  const base = "{ORIGIN}/games/{ID}/files/";
  const mod = await import(base + "{ENTRY}?v={VERSION}");
  await boot(document.getElementById("game"), mod.default, { width: {W}, height: {H}, baseUrl: base });
</script></body></html>
```
`{ORIGIN}` is `PUBLIC_ORIGIN` when set, otherwise the backend's absolute origin derived from the request `Host` header (+ `X-Forwarded-Proto`) (absolute URLs are needed because the sandboxed iframe has an opaque origin).


---

# v2 additions

## Achievements in game.json (optional)
```json
"achievements": [
  { "id": "first_blood", "name": "First Blood", "description": "Destroy your first asteroid", "icon": "assets/ach_first.png" }
]
```
- Max 50 entries. `id` matches `^[a-z0-9_-]{1,32}$` and is unique. `name` 1–60 chars, `description` max 200, `icon` optional bundle-relative image path that must exist in the bundle. Invalid → 422 on upload.
- Engine: `engine.platform.unlockAchievement(id)` posts `{ type: "webgame:achievement", id }` (the engine de-duplicates per session).
- Parent (GamePlayer): calls `POST /api/games/{id}/achievements/{achId}` when logged in and shows a toast when `new: true`.

## Cloud saves
The engine protocol is unchanged (`hello` → `load`, `save`). The parent now:
- when logged in, prefetches `GET /api/games/{id}/save` as soon as the player mounts and answers `hello` with the server data. It falls back to local data if the request fails or takes > 400ms; a server copy that arrives later is sent as an extra `webgame:load`, which the engine merges.
- on `webgame:save`, writes localStorage immediately and debounces `PUT …/save` (at least 2s).
- Anonymous players: localStorage only, as before.

## In-memory files (engine)
`boot(canvas, game, { width, height, baseUrl, files? })`. `files?: Record<string, Blob | ArrayBuffer | string>` is keyed by bundle-relative path. When present, all asset loaders resolve paths through it first (creating object URLs inside the iframe) and fall back to `baseUrl`.

## Debug overlay
F3 (or `engine.debug = true`) toggles an overlay: FPS, frame ms, draw calls, sprites, active tweens/particles/bodies.

## Studio protocol (GET /play/studio)
1. The page loads the engine, then posts `{ type: "webgame:studio-ready" }` to the parent.
2. The parent posts `{ type: "webgame:studio-load", manifest: <game.json object>, files: { [path]: string | ArrayBuffer } }`. Text files are strings, binary files ArrayBuffers; `manifest.entry` must be present in `files`.
3. The page creates an object URL for the entry source (blob, `text/javascript`), imports it, and calls `boot(canvas, mod.default, { width, height, baseUrl: "about:blank", files })`.
4. Errors at any stage are posted as `webgame:error` (with line/column when available).

All other `webgame:*` messages behave as on /play/{id}. The parent must NOT call score/achievement/play APIs for studio sessions; it shows "would unlock / would submit" toasts instead.


---

## F001 additions

Leaderboards 2.0 (spec: `docs/features/F001-leaderboards-2.md`).

### `leaderboard` in game.json (optional)
```json
"leaderboard": { "order": "asc", "format": "time", "label": "Best time" }
```
- `order`: `"desc"` (higher is better, default) or `"asc"` (lower is better).
- `format`: `"number"` (default) or `"time"`, where the score is an integer number of milliseconds, displayed as `m:ss.mmm` (or `h:mm:ss.mmm` from 1h).
- `label`: optional string, trimmed, 0–24 chars. `""` means the UI default.
- Every key is optional, and unknown keys are ignored. If `leaderboard` is present but is not an object, or any key has a wrong type or value → 422 `validation` on upload or bundle replace.
- The values are stored per game version (a bundle replace updates them) and exposed as `Game.leaderboard`.

### Engine API
```ts
type LeaderboardPeriod = "day" | "week" | "all";
type LeaderboardView = {
  period: LeaderboardPeriod;
  order: "desc" | "asc"; format: "number" | "time"; label: string;
  totalPlayers: number;
  entries: { rank: number; name: string /* displayName, or username if empty */; score: number; display: string /* formatted per format */; isMe: boolean }[];
  me: { rank: number; score: number; display: string } | null;   // null when anonymous or no score in the period
  sample?: true;                                                   // set by the Studio preview
};
type ScoreResultView = {
  score: number; display: string;
  rank: number;                                       // ScoreSubmitResult.rank
  personalBest: boolean;
  ranks: { day: number; week: number; all: number };
};
```
- `engine.platform.getLeaderboard(opts?: { period?: LeaderboardPeriod; limit?: number }): Promise<LeaderboardView | null>`
  - Defaults: `period` `"all"`, `limit` 10, clamped to 1–25.
  - Resolves `null` on timeout (5000ms), when there is no parent window, on a reply carrying `error`, or on an invalid period (with a warning).
  - At most 4 requests may be pending; extra calls resolve `null` immediately (with a warning).
- `engine.platform.submitScore(n): Promise<ScoreResultView | null>` (previously `void`)
  - It posts synchronously as before.
  - The promise resolves on the matching `webgame:score-result`, or `null` on timeout (8000ms), on `error`, or for non-finite `n` (which is not posted).
  - Existing callers that ignore the return value are unaffected.
- On engine destroy, all pending promises resolve `null`.

### Messages
| Direction | Message |
|---|---|
| game → parent | `{ type: "webgame:leaderboard-get", requestId: string, period: LeaderboardPeriod, limit: number }` |
| parent → game | `{ type: "webgame:leaderboard", requestId: string, leaderboard: LeaderboardView \| null, error?: "unavailable" \| "rate_limited" }` |
| game → parent | `{ type: "webgame:score", score: number, requestId?: string }` (`requestId` is new and optional) |
| parent → game | `{ type: "webgame:score-result", requestId: string, result: ScoreResultView \| null, error?: "anonymous" \| "rate_limited" \| "failed" \| "studio" }` |

- `requestId` is 1–64 chars. The engine uses `"lb-<n>"` / `"sc-<n>"`, and replies with an unknown `requestId` are ignored.
- The engine accepts replies only from `window.parent`. The parent accepts requests only from its iframe's `contentWindow`.

### Parent behaviour (GamePlayer on /play/{id})
- Ignore malformed requests: a bad `requestId`, a `period` outside the three values, or a non-numeric `limit`. A numeric `limit` is rounded and clamped to 1–25.
- `webgame:leaderboard-get`:
  - Call `GET /api/games/{id}/leaderboard?period=&limit=` with the viewer's session (anonymous allowed).
  - Cache each `(period, limit)` pair for 10s, with at most one in-flight request per pair; concurrent requests share the result.
  - Reply with a **sanitised** `LeaderboardView` built from `Leaderboard`: name, rank, score, display, `isMe` (`entry.user.id === viewer.id`), and `me`. Never include user ids, usernames distinct from the shown name, avatar URLs or any token.
  - On a 429, reply `error: "rate_limited"`; on any other failure, reply `error: "unavailable"`.
- `webgame:score` with `requestId`:
  - Anonymous → reply `error: "anonymous"` at once.
  - Otherwise submit as before. On success, reply with a `result` built from `ScoreSubmitResult`. On a 429, reply `error: "rate_limited"`; on other errors, reply `error: "failed"`.
  - Without `requestId`, behaviour is unchanged.

### Studio preview (/play/studio)
- `webgame:leaderboard-get` → `sample: true` with 5 entries "Player 1"…"Player 5" and deterministic scores that respect the manifest's `order`/`format` (defaults if absent), `me: null`, `totalPlayers: 5`.
- `webgame:score` with `requestId` → `error: "studio"` (the "would submit" toast is kept).
- No API calls are made.


---

## F002 additions

Follow creators and an activity feed (spec: `docs/features/F002-follow-and-feed.md`).

**No engine, bundle or message changes.** The `game.json` format, the engine API and the `webgame:*` protocol are unchanged. This section tells creators which existing calls now also produce feed items for the player's followers (rules in API.md § F002 "Event production"):
- `engine.platform.submitScore(n)`: when the result has `personalBest: true` (F001), followers of the player see "set a new personal best in {game}". It's limited to one item per player, game and UTC day, keeping the best. Calling `submitScore` more often does not create more items.
- `engine.platform.unlockAchievement(id)`: on a first unlock, followers see "unlocked {name}". Several unlocks in one UTC day are grouped ("…and 2 more").
- A published bundle replace shows as "updated {game} to v{version}" to the creator's followers and to everyone who favorited the game, at most once per 24h.
- The owner's own scores and unlocks on their own game never produce feed items. Neither do Studio previews (`/play/studio`), since they make no API calls.

## Review-fix additions (REVIEW-2026-11-14-1)

- **Studio multi-file modules (R3):** on `studio-load`, the /play/studio page creates a `blob:` URL for every `.js` file in `files`. It rewrites relative module specifiers (`./` or `../`) in static `import ... from`, `export ... from`, bare `import "..."` and dynamic `import("...")` with string literals, so each one points at the dependency's blob URL. Dependencies are processed first, in topological order. Cycles, missing files and specifiers that escape the bundle are reported as `webgame:error` with a clear message. Non-relative specifiers are left unchanged. Errors carry `file` (the bundle-relative path, mapped back from the blob URL) next to `line`/`column`, so the Studio can attribute errors to the right file.

## F003 additions

Trending and "More like this" discovery (spec: `docs/features/F003-trending-and-related.md`).

**No engine, bundle, `game.json` or message changes.** What creators need to know:
- **Tags drive "More like this".** The related shelf on each game page ranks other games by the tags they share with yours.
  - A shared tag counts more when fewer games use it, so specific tags (`platformer`, `roguelike`, `puzzle`) help more than generic ones (`game`, `fun`).
  - The existing tag limits apply: at most 8 tags, each at most 24 chars, lowercased.
- **Trending counts players, not reloads.** The Trending sort and the home-page shelf rank games by distinct players per day over the last 7 UTC days, with recent days weighted higher.
  - Your own signed-in plays of your own game never count.
  - A play is recorded once per player per game per 10 minutes when the game sends `webgame:ready` (unchanged). Sending it again or reloading does not raise your rank.
- Studio previews (`/play/studio`) record no plays.
- **Implementation notes (R3):**
  - Only modules reachable from the entry are linked.
  - Rewriting is regex-based, so import-like text inside comments is rewritten too.
  - Errors use the shape `{ type: "webgame:error", message, file?, line?, column? }`.
  - Errors raised by the engine runtime itself don't carry `file` yet.

## F004 additions

Version changelogs and an "Updated" badge (spec: `docs/features/F004-version-changelogs.md`).

**No engine, bundle, `game.json` or message changes.** Release notes are entered in the upload/replace forms, not inside the bundle. What creators need to know:
- **Release notes.** When you upload a new bundle (game page → Replace bundle, or the edit page), you can add a "What's new" note: plain text, up to 1000 characters, line breaks kept. HTML, Markdown and links are shown as plain text. You can also add notes to your first upload, and fix any note later from the game page's version history.
- **Who sees them.** Notes appear in the game page's "What's new" panel and version history. For a published game, your followers and everyone who favorited the game see the note in their feed with the F002 "updated {game} to v{n}" item. Several updates within 24h are grouped, showing up to 3 notes.
- **"Updated" badge.** Replacing the bundle of a **published** game shows an "Updated" badge on its cards for 7 days. Editing the title/description/thumbnail, publishing a draft, or editing a note does not.
- **Removed content.** A replace still drops achievements that the new `game.json` no longer declares (v2 rule). Say so in the note.
- Version numbers stay integers assigned by the server (1, 2, 3, …). There is no rollback: only the current version's files are kept.

## F013 additions

Studio: publish updates to an existing game (spec: `docs/features/F013-studio-publish-updates.md`).

**No engine, bundle, `game.json` or message changes.** What creators need to know:
- **Getting your bundle back.** Owners can download the current version (edit page → "Download current bundle", or `GET /api/games/{id}/bundle`).
  - The archive holds exactly the stored files, with `game.json` at the root and listed first.
  - If your upload had a single top-level folder, it is gone in the download (the backend strips it on upload).
  - The archive can be re-uploaded unchanged.
- **Open in Studio.** "Open in Studio" (game page or edit page) and Studio → Open → "My game…" load that archive into the Studio. Studio → Open → ".zip file…" loads any bundle from disk. Opened projects follow the same rules as folder imports:
  - a single top-level folder is stripped only when it contains `game.json`;
  - dotfiles and disallowed extensions are skipped;
  - text files (`js json txt css svg md csv`) are decoded as UTF-8.
  A non-UTF-8 text file is re-encoded as UTF-8 when you publish from the Studio.
- **Publishing an update from the Studio.** Publish → "Update an existing game" replaces **all** files of the chosen game with the Studio project. It creates version n+1 and accepts optional release notes (F004 rules).
  - Title, description, tags and visibility don't change.
  - Achievements no longer declared in `game.json` are removed (v2 rule).
  - The Studio asks for confirmation when the project wasn't opened from (or last published to) that game at its current version.
- **Desktop local folders.** A folder opened with "Open local game folder…" can be re-read with "↻ Reload folder" after you edit files on disk. Edits made inside the Studio are **not** written back to the folder. Export a .zip to keep them.
- The Studio protocol (`/play/studio`) is unchanged. Opened games run only in the sandboxed Studio preview, and Studio sessions still record no plays, scores or achievements.


## F005 additions

Screenshot capture and share (spec: `docs/features/F005-screenshots.md`). There are no bundle or `game.json` changes. The new message pairs follow the F001 request/reply pattern.

### Engine API
```ts
type ScreenshotOptions = { maxSize?: number };          // longest output side; rounded, clamped 64–4096; default 1920
type ShareScreenshotOptions = { caption?: string };     // suggestion shown to the player; max 140 code points after sanitising

engine.captureFrame(opts?: ScreenshotOptions): Promise<Blob | null>
engine.platform.shareScreenshot(opts?: ShareScreenshotOptions): Promise<boolean>
```
- **`captureFrame`** returns an `image/png` Blob of the next rendered frame to the **game itself**. Nothing is posted to the parent. It resolves `null` when:
  - the engine is not `running` (loading, error, destroyed);
  - another capture is queued or encoding (with a warning);
  - no frame reaches the capture point within 2000 ms (hidden tab);
  - the context is lost or the encoder fails;
  - the PNG is larger than 8 MiB.
- **`shareScreenshot`** captures the next frame in the same way and offers it to the player. The parent adds it to the player's screenshot tray and **never** uploads or downloads it by itself. It resolves `true` when the parent accepted it. It resolves `false` when:
  - there is no parent;
  - it is called less than 3000 ms after the previous share (with a warning);
  - the capture fails;
  - the parent replies `accepted: false` or an error;
  - there is no reply within 5000 ms.
  The caption is coerced to a string, control and bidi characters are removed, and it is cut to 140 code points.
- Only one capture (from any of the three sources) is in flight at a time.
- `destroy()` resolves pending captures with `null` and pending shares with `false`.

### What is captured
- **Capture point**: inside the frame, after `game.render`, `scenes.render` and the batch flush, and **before** the F3 debug overlay, the host "PAUSED" overlay and the error overlay. None of these appear in screenshots. Everything the game draws (including its own HUD) does.
- **Output size**: let `w×h` be the logical resolution from `game.json` and `L = max(w, h)`.
  - `k = max(1, floor(1280 / L))`, and the size is `(w·k) × (h·k)`. Small games are upscaled by an integer factor.
  - If the longest side is then larger than `maxSize` (default 1920), the image is scaled down to fit, keeping the aspect ratio. Sides are rounded and each is at least 1.
  - Examples: 320×180 → 1280×720; 800×600 → 800×600; 3840×2160 → 1920×1080.
  - The size never depends on the window size or `devicePixelRatio`. The source pixels are the canvas backing store, so a small window gives a softer image at the same size.
- **Sampling**: nearest-neighbour when the backing-to-output ratio is an integer and `smooth` is off (crisp pixel art), bilinear ("high" quality) otherwise.
- **Format**: PNG, opaque (the context has `alpha: false`).

### Messages
| Direction | Message |
|---|---|
| parent → game | `{ type: "webgame:screenshot-request", requestId: string }` |
| game → parent | `{ type: "webgame:screenshot", requestId: string, source: "player", image: Blob, width: number, height: number }` (reply to a request) |
| game → parent | `{ type: "webgame:screenshot", requestId: string, source: "player", error: "unavailable" \| "busy" \| "failed" }` (no `image`) |
| game → parent | `{ type: "webgame:screenshot", requestId: string, source: "game", image: Blob, width: number, height: number, caption?: string }` (from `shareScreenshot`) |
| parent → game | `{ type: "webgame:screenshot-result", requestId: string, accepted: boolean, error?: "rate_limited" \| "invalid" \| "unavailable" }` (reply to `source: "game"` only) |

- **Ids**: `requestId` is 1–64 chars. The parent uses `"ps-<n>"`, and the engine uses `"ss-<n>"` for shares. The engine echoes the parent's id on `source: "player"` replies.
- **Errors**: `unavailable` = the engine is not running or no frame within 2000 ms; `busy` = a capture is already in flight; `failed` = lost context, a security or encoder error, or more than 8 MiB.
- **Transport**: the image travels as a structured-cloned `Blob` (no transfer list, never a data URL), at most **8 MiB**. `width`/`height` are informational; the parent re-measures.
- **Origin checks**: as in F001, the engine accepts requests and replies only from `window.parent`, and the parent accepts messages only from its iframe's `contentWindow`.

### Parent behaviour (GamePlayer on /play/{id}, StudioPreview on /play/studio)
- **Validation**: ignore malformed messages. That includes a bad `requestId`, an unknown `source`, `image` not a `Blob` or larger than 8 MiB, and a `source: "player"` message whose `requestId` is not the parent's in-flight request.
- **Laundering (mandatory)**: decode the Blob with `createImageBitmap`. Each side must be 1–4096. Draw it to a canvas and re-encode it as PNG. Only this re-encoded PNG may be displayed (object URL), downloaded, copied or uploaded. The game's original Blob is never given an object URL. A blob URL has the parent's origin, so an HTML or SVG payload would otherwise run as the app.
- **Player requests**: at most one in flight, with a 5000 ms timeout.
- **Game shares**: at most 1 accepted per 3000 ms and 20 per player mount, else `accepted: false, error: "rate_limited"`. Laundering failure → `error: "invalid"`. The parent sanitises `caption` again (control and bidi characters, 140 code points) and shows it as plain text only.
- The tray holds at most 12 items in memory. Nothing is persisted, and nothing is uploaded without an explicit user action.
- **Studio**: captures and shares behave the same, but the tray offers download, copy and remove only. It makes no API calls (Studio rule).
- **For creators**: a screenshot the player posts is public. Don't draw secrets (codes, tokens) on frames you pass to `shareScreenshot`.


## F009 additions

Controls overlay and key remapping (spec: `docs/features/F009-controls-and-remapping.md`). Two optional game.json keys, an engine action API and one new parent → game message. Existing games keep working unchanged.

### `actions` in game.json (optional, strict)
```json
"actions": [
  { "id": "left",  "name": "Move left",  "keys": ["ArrowLeft", "KeyA"], "gamepad": ["Left"] },
  { "id": "right", "name": "Move right", "keys": ["ArrowRight", "KeyD"], "gamepad": ["Right"] },
  { "id": "jump",  "name": "Jump",       "keys": ["Space", "ArrowUp", "KeyW"], "gamepad": ["A"] },
  { "id": "fire",  "name": "Fire",       "keys": ["Mouse0", "KeyZ"] }
]
```
- Absent or `null` → no actions. Otherwise it must be an array of at most **32** objects.
- `id`: matches `^[a-z0-9_-]{1,32}$`, unique within the list.
- `name`: string, trimmed, 1–40 chars, no control characters (C0, C1, DEL) and no bidi controls (same set as F004 notes).
- `keys`: optional array (default `[]`) of at most **3** unique strings from the bindable key table below.
- `gamepad`: optional array (default `[]`) of at most **2** unique names from the gamepad table below.
- Each action needs at least one key or gamepad button.
- Unknown keys inside an action are ignored and dropped from the stored copy.
- Any violation → 422 `validation` on upload or bundle replace. The message names the path, e.g. `game.json: actions[2].keys[1] "Escape" can't be bound`.
- Order is significant: it is the display order in the controls panel and in `input.actions`.

### `controls` in game.json (optional, lenient)
- A free-text controls description, e.g. `"controls": "Arrows move, Space shoots"`. Existing bundles already use it.
- If it is a string: control characters (including `\n`, `\r`, `\t`) become spaces, bidi controls are removed, runs of whitespace collapse to one space, and the result is trimmed and cut to **300** chars. It is exposed as `Game.controlsHint`.
- Any other type is ignored. `controls` **never** causes a 422.
- The Studio and the player show it as plain text.

### Bindable key table (normative)
`KeyboardEvent.code` values (physical keys), plus mouse buttons:

| Group | Codes | Default label |
|---|---|---|
| Letters | `KeyA` … `KeyZ` | `A` … `Z` |
| Digits | `Digit0` … `Digit9` | `0` … `9` |
| Numpad | `Numpad0` … `Numpad9`, `NumpadAdd`, `NumpadSubtract`, `NumpadMultiply`, `NumpadDivide`, `NumpadDecimal`, `NumpadEnter` | `Num 0` … `Num 9`, `Num +`, `Num -`, `Num *`, `Num /`, `Num .`, `Num Enter` |
| Arrows | `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight` | `↑`, `↓`, `←`, `→` |
| Editing | `Space`, `Enter`, `Backspace` | `Space`, `Enter`, `Backspace` |
| Modifiers | `ShiftLeft`, `ShiftRight`, `ControlLeft`, `ControlRight`, `AltLeft`, `AltRight` | `Left Shift`, `Right Shift`, `Left Ctrl`, `Right Ctrl`, `Left Alt`, `Right Alt` |
| Punctuation | `Minus`, `Equal`, `BracketLeft`, `BracketRight`, `Backslash`, `Semicolon`, `Quote`, `Backquote`, `Comma`, `Period`, `Slash`, `IntlBackslash` | `-`, `=`, `[`, `]`, `\`, `;`, `'`, `` ` ``, `,`, `.`, `/`, `Intl \` |
| Navigation | `Insert`, `Delete`, `Home`, `End`, `PageUp`, `PageDown` | `Insert`, `Delete`, `Home`, `End`, `Page Up`, `Page Down` |
| Mouse | `Mouse0`, `Mouse1`, `Mouse2` | `Left click`, `Middle click`, `Right click` |

That is 83 keyboard codes and 3 mouse codes (86 in total). Everything else is **not bindable**, notably `Escape`, `Tab`, `F1`–`F24`, `MetaLeft`/`MetaRight`, `CapsLock`, `ContextMenu`, `PrintScreen`, `ScrollLock`, `Pause` and `NumLock`. Mouse codes may be defaults in game.json; the remapping UI assigns keyboard codes only.

### Gamepad buttons (normative)
`A`, `B`, `X`, `Y`, `LB`, `RB`, `LT`, `RT`, `Back`, `Start`, `LS`, `RS`, `Up`, `Down`, `Left`, `Right` (the existing `GamepadButtons` names without `Home`).
- Default labels are the names, except `Up`/`Down`/`Left`/`Right` → `D-pad ↑`, `D-pad ↓`, `D-pad ←`, `D-pad →`.
- Gamepad buttons are read from the first connected gamepad (as `input.axis` does).
- They are **not** remappable in F009.

### Boot option and pages
- `boot(canvas, game, { …, actions?: unknown })`. The engine parses `actions` **leniently** with the same rules as above. Invalid entries (or invalid keys/buttons inside an entry) are dropped with a `console.warn` prefixed `[pixelforge] actions:`, and parsing never throws.
- `/play/{id}`: the backend renders the stored, already validated list: `boot(…, { width: {W}, height: {H}, baseUrl: base, actions: {ACTIONS} })`. `{ACTIONS}` is a JSON literal escaped for `<script>` (`<`, `>`, `&`, U+2028 and U+2029 written as `\uXXXX`). Games without actions get `[]`.
- `/play/studio`: the page passes `actions: manifest.actions` from `webgame:studio-load` (no server validation; the engine's lenient parse applies).

### Engine API
```ts
type GamepadButtonName = "A" | "B" | "X" | "Y" | "LB" | "RB" | "LT" | "RT" | "Back" | "Start" | "LS" | "RS" | "Up" | "Down" | "Left" | "Right";
type ControlAction = { id: string; name: string; keys: string[]; gamepad: GamepadButtonName[] };

engine.input.actions: readonly ControlAction[]         // effective bindings (defaults + player overrides), manifest order, frozen
engine.input.defaultActions: readonly ControlAction[]  // as declared (after lenient parsing)
engine.input.actionDown(id: string): boolean
engine.input.actionPressed(id: string): boolean
engine.input.actionReleased(id: string): boolean
engine.input.actionLabel(id: string): string           // label of the first effective key, else of the first gamepad button, else ""
engine.input.keyLabel(code: string): string            // default label table; an unknown code returns the code
engine.input.gamepadLabel(name: string): string        // default label of a gamepad button name ("Up" → "D-pad ↑"); an unknown name returns the name
```
- Unknown ids return `false` / `""` and warn once per id.
- **Edge rules** (per fixed update step, like `wasPressed`). Let `prevDown` be the action's `down` at the previous step:
  - `down` = any effective key `isDown` **or** any gamepad button `isDown`.
  - `pressed` = (any effective key `wasPressed` or any gamepad button `wasPressed`) **and not** `prevDown`. Pressing a second bound key while the first is held does not fire `pressed` again.
  - `released` = **not** `down` **and** (`prevDown` or `pressed`) **and** (any effective key `wasReleased` or any gamepad button `wasReleased`). Releasing one of two held keys does not fire it. A tap within one step reports both `pressed` and `released` (with `down` false), like raw keys.
- **`input.axis`**: when **both** `left` and `right` actions exist, `axis("horizontal")` uses `actionDown("left")` / `actionDown("right")` plus the left-stick analog value, and the hard-coded Arrows/WASD/D-pad no longer apply. The same holds for `axis("vertical")` with `up` / `down`. Otherwise `axis` is unchanged.
- **Raw input is not remapped**: `isDown/wasPressed/wasReleased(code)`, `mouse`, `touches`, `gamepad(i)`, `anyPressed()` and `typed` report physical input as before.
- **Default handling**: on `keydown`, the engine now also calls `preventDefault()` for any keyboard code bound in the effective actions (when neither Ctrl nor Meta is held), in addition to the existing set.
- Overrides take effect at the next fixed step.

### Message
| Direction | Message |
|---|---|
| parent → game | `{ type: "webgame:controls", overrides: { [actionId: string]: string[] } }` |

- `overrides` must be a plain object with at most 32 own keys, otherwise the whole message is ignored.
- Each value replaces that action's `keys` (never `gamepad`). Non-array values, unknown action ids and non-bindable codes are ignored, duplicates are removed, and only the first 3 codes are kept. `[]` means "no keys" (gamepad defaults still apply).
- Each message **replaces** all previous overrides. There is no reply.
- The engine accepts it only from `window.parent`.

### Parent behaviour (GamePlayer on /play/{id}, StudioPreview on /play/studio)
- When the game has at least one action, the parent posts `webgame:controls` right after its first `webgame:load` reply to each `webgame:hello` (so restarts receive it), and again after every change in the controls panel.
- It sends only action ids and key codes. It never sends key labels, the keyboard layout, user data or tokens.
- `GamePlayer` reads overrides from localStorage (ARCHITECTURE § F009). `StudioPreview` keeps them in memory for the Studio session.
- Opening the controls panel pauses the game with `webgame:pause`. Closing it sends `webgame:resume` only when no other parent pause reason (a hidden tab) remains.

### For creators
- Declare every key your game uses as an action, and read actions (`actionPressed("jump")`) instead of codes (`wasPressed("Space")`). Only actions can be remapped by players.
- Use `actionLabel` in prompts (`Press ${engine.input.actionLabel("jump")} to start`) so they follow the player's bindings. Labels are US-layout names, because the platform does not reveal the player's keyboard layout to games.
- Name movement actions `left`, `right`, `up` and `down` to make `input.axis()` follow remapping.
- Keep `controls` for what actions can't describe (mouse aiming, touch gestures). It is shown next to the action list.

## Review-fix additions (REVIEW-2026-11-15-3)

- **Screenshot size rule (L6):** first upscale by the integer `k = max(1, floor(1280 / max(w, h)))`, giving long side `L` and short side `S`. Then scale by `s = max(min(1, maxSize / L), 64 / S)`, keeping the aspect ratio, and round each side and clamp it to 64–4096. The short side is never below 64, even if that pushes the long side past `maxSize`. Game sizes are 64–4096 per side, so every capture is a valid upload.


## F006 additions
Comment replies and reactions (spec: `docs/features/F006-comment-replies-and-reactions.md`). **No changes** to the bundle format, the engine API or the game ↔ parent messages. Games can neither read nor write comments, replies or hearts.

- **Screenshot laundering, pre-decode check (review 3, M1):** before calling `createImageBitmap`, the parent sniffs the magic bytes (PNG, JPEG or WebP only) and reads the image dimensions from the header. It rejects any side outside 1–4096, more than 4096² pixels, and malformed or unknown headers. A share that fails laundering still uses its throttle slot (1 per 3000 ms).


## F007 additions
In-app notifications (spec: `docs/features/F007-in-app-notifications.md`). **No changes** to the bundle format, the engine API or the game ↔ parent messages. Games can neither read nor create notifications, and no notification data is ever posted into the game iframe. Desktop OS notifications are shown only by the parent app (through the `PlatformConfig.osNotifications` host contract), never by games.


## F012 additions
Bitmap fonts, 9-slice and UI widgets (spec: `docs/features/F012-bitmap-fonts-and-ui-widgets.md`). **No changes** to game.json, the boot options or the game ↔ parent messages. Everything below is engine API plus one new bundle file extension.

### Bundle
- `.fnt` is an allowed bundle extension (text; BMFont descriptors). The bundle layout becomes `assets/...  (any png/jpg/webp/gif/svg/json/txt/fnt/wav/mp3/ogg/js/css/woff2/ttf files)`.

### Types
```ts
type BitmapGlyph = {
  id: number;                       // Unicode code point, 0–0x10FFFF
  x: number; y: number;             // top-left in the page, px, >= 0
  width: number; height: number;    // px, 0–4096
  xoffset: number; yoffset: number; // px from the pen position / line top to the glyph's top-left
  xadvance: number;                 // px the pen moves after this glyph
  page: number;                     // index into pages
}
type Kerning = { first: number; second: number; amount: number }   // amount in px, added between first and second
type BitmapFontData = {
  face: string;                     // info.face, "" when absent
  size: number;                     // native size: abs(info.size); 0 or absent → lineHeight
  lineHeight: number;               // common.lineHeight, 1–4096
  base: number;                     // common.base, 0–4096 (line top → baseline)
  scaleW: number | null; scaleH: number | null;   // common.scaleW/scaleH when present, 1–8192
  pages: string[];                  // page file names, relative to the descriptor, index = page id
  chars: BitmapGlyph[];
  kernings: Kerning[];
  warnings: string[];               // non-fatal issues (duplicate ids, distanceField, …)
}
type GridFontOptions = {
  cellW: number; cellH: number;     // cell size in px, integers >= 1
  chars: string;                    // glyphs in cell order (left→right, top→bottom), one code point per cell
  spacing?: number; margin?: number;// as SpriteSheet; default 0
  advance?: number;                 // pen advance, default cellW
  lineHeight?: number;              // default cellH
}
type Insets = { left: number; top: number; right: number; bottom: number }   // source px, integers >= 0
type NineSliceOptions = {
  insets?: number | Insets;         // only used when src is a Texture (a NineSlice carries its own)
  scale?: number;                   // border scale on screen, default 1 (pixel art: 2, 3…); > 0
  tint?: ColorLike; alpha?: number; // as drawSprite
  center?: boolean;                 // draw the middle piece; default true (false = frame only)
}
type UiTheme = {
  font: string;                     // "default"
  textSize: number | null;          // null = the font's default size (16 for canvas fonts, native size for bitmap fonts)
  textColor: ColorLike;             // "#ffffff"
  disabledTextColor: ColorLike;     // "#8b91b0"
  panel: NineSlice | null;          // null = flat panelColor with a 1-unit panelBorder
  panelColor: ColorLike;            // "#141a2e"
  panelBorder: ColorLike;           // "#3a4470"
  button: NineSlice | null;         // null = flat colours below
  buttonHover: NineSlice | null;    // null = button
  buttonDown: NineSlice | null;     // null = buttonHover ?? button
  buttonColor: ColorLike;           // "#2a3358"
  buttonHoverColor: ColorLike;      // "#3a4780"
  buttonDownColor: ColorLike;       // "#1e2540"
  buttonBorder: ColorLike;          // "#5a6bc0"
  focusColor: ColorLike;            // "#ffd166"
  nineSliceScale: number;           // scale passed to drawNineSlice for panels and buttons; default 1
}
type ButtonOptions = { disabled?: boolean; nav?: boolean /* default true */; font?: string; textSize?: number; textColor?: ColorLike }
```

### Bitmap fonts (engine API)
- `engine.assets.loadBitmapFont(name: string, path: string, opts?: { smooth?: boolean }): Promise<BitmapFont>`
  - It loads the descriptor (text or JSON, ≤ 1 MiB), then each page relative to the descriptor's directory. Pages must be png, webp, gif, jpg or jpeg inside the bundle. Absolute URLs, `data:`/`blob:` URLs and paths escaping the bundle are rejected.
  - It registers the font for `drawText({ font: name })` and resolves it. Pages use nearest filtering unless `smooth: true`; smooth pages are not atlas-packed.
  - It rejects (and the engine shows the error if `load` doesn't catch it) with a message starting `BMFont "{path}": `.
  - Glyphs whose rect lies outside the real page image are dropped with one warning.
  - Loads are cached by `name + path + smooth`.
- `engine.assets.gridFont(name: string, texture: Texture, opts: GridFontOptions): BitmapFont`
  - It is synchronous. Cells are cut like `SpriteSheet` (row-major, `spacing`/`margin`).
  - Each glyph is the full cell (`xoffset = yoffset = 0`, `xadvance = advance`), with `size = base = cellH`.
  - It throws when `chars` has more code points than cells or a duplicate code point.
- `engine.renderer.addBitmapFont(name: string, font: BitmapFont): void` registers an already built font. `engine.renderer.hasFont(name): boolean`.
- **Names**: `default`, `mono` and `pixel` are reserved. `addBitmapFont`, `gridFont` and `loadBitmapFont` throw `font name "…" is reserved` for them. `setFont("default" | "mono", …)` keeps working (unchanged). Registering an existing non-reserved name replaces it, whether it is a canvas or a bitmap font.
- `BitmapFont` read-only surface: `name`, `face`, `size`, `lineHeight`, `base`, `pages: Texture[]`, `smooth`, `glyph(codePoint): BitmapGlyph | undefined`, `kerning(first, second): number`, `has(char: string): boolean`.
- `parseBMFont(source: string | object, path?: string): BitmapFontData` is exported from `engine.js` for tools and tests. It is pure and has no DOM.

#### Accepted descriptors
- **Text format** (the AngelCode `.fnt` text output of BMFont, Hiero, Snowb, Littera…):
  - One tag per line, followed by `key=value` pairs. Values are bare (`id=65`), comma lists (`padding=0,0,0,0`; ignored) or double-quoted (`face="Press Start"`, which may contain spaces).
  - Used tags: `info` (`face`, `size`), `common` (`lineHeight`, `base`, `scaleW`, `scaleH`, `pages`, `packed`), `page` (`id`, `file`), `char` (`id`, `x`, `y`, `width`, `height`, `xoffset`, `yoffset`, `xadvance`, `page`) and `kerning` (`first`, `second`, `amount`).
  - Other tags (`chars`, `kernings`) and keys (`chnl`, `stretchH`, `aa`, `padding`, `spacing`, `outline`, …) are ignored.
- **JSON format** (`.json`; the layout used by msdf-bmfont-xml, Snowb and others): `{ info?: { face?, size? }, common: { lineHeight, base, scaleW?, scaleH?, packed? }, pages: string[], chars: BitmapGlyph-like[], kernings?: Kerning[], distanceField?: object }`. Unknown keys are ignored.
- **XML** (a descriptor that starts with `<` after whitespace and a BOM) → error `BMFont XML is not supported; export the text or JSON format`.

#### Limits and errors
Each violation is an error that names the field, e.g. `BMFont "assets/a.fnt": char[12].width must be a number from 0 to 4096`.

| Field | Rule |
|---|---|
| descriptor | ≤ 1 MiB; `common` present; `lineHeight` and `base` present |
| pages | 1–16; text-format page ids 0..n-1 without gaps; file is a relative image path |
| chars | 1–8192 entries; `id` 0–0x10FFFF; `page` < pages.length; `x`, `y` ≥ 0; `width`, `height` 0–4096; `x`/`y`/`width`/`height`/`xadvance` required, `xoffset`/`yoffset`/`page` default 0 |
| kernings | 0–65536 entries; `first`/`second` 0–0x10FFFF |
| numbers | finite numbers within −32768..32767 (`scaleW`/`scaleH` 1–8192, `lineHeight` 1–4096), rounded to integers; non-numeric → error |
| `common.packed` | `1` → error `channel-packed fonts are not supported` |
| duplicate char id | first wins; warning |
| duplicate kerning pair | last wins |
| `distanceField` present | accepted and drawn as a plain bitmap; warning |

Warnings go to `console.warn` with the prefix `[pixelforge] font "{name}":`.

#### Built-in `pixel` font
- An always-available bitmap font named `pixel`, with ASCII 32–126 (95 glyphs). Any other character draws as `?`.
- Metrics: `size` 8, `lineHeight` 10, `base` 7. Every glyph advances 6 px, glyph images are at most 5×9 px, and capitals occupy rows 0–6 of the line (descenders use rows 7–8).
- Nearest filtering; its texture is created on first use and shares an atlas page with sprites.

#### `drawText` / `measureText` with a bitmap font (normative)
Let `F` be the font, `size = o.size ?? F.size`, `s = size / F.size`, `sp = o.letterSpacing ?? 0`.
- **Line height** `lh = F.lineHeight · s · (o.lineHeight ?? 1)`. **Block height** `= (lines − 1) · lh + F.lineHeight · s`. `baseline` `top`/`middle`/`bottom` places the block's top at `y`, `y − block/2` or `y − block`. (Canvas fonts keep their existing defaults: size 16, line height multiplier 1.2.)
- **Pen**: for each code point `c` on a line, after the first, add `F.kerning(prev, c) · s`. Draw the glyph quad at `(pen + xoffset·s, lineTop + yoffset·s)` with size `(width·s, height·s)`, then advance `pen += xadvance·s + sp`.
- **Line width** = the sum of the advances (with kerning) minus the last `sp`; 0 for an empty line. `align` `left`/`center`/`right` offsets each line by `0`, `−width/2` or `−width` from `x`.
- **Snapping**: when the font is not smooth, each line's start x (after alignment) and each line top are rounded to whole game units.
- **Wrap**: `\n` (and `\r\n`) breaks lines. With `maxWidth`, lines wrap greedily at spaces using the same width rule, and a single word wider than `maxWidth` stays on its own line. Other control characters are skipped.
- **Missing glyphs**: draw `?` when the font has it; otherwise advance by `size / 2` and draw nothing. One warning per font, ever. A missing space (U+0020) never warns and advances by `size / 2` (grid fonts: `advance · s`).
- `color` (default `#fff`) tints the glyphs and `alpha` multiplies. `shadow`/`shadowOffset` draw a second pass offset by `shadowOffset ?? max(1, size / 12)`, as for canvas fonts.
- `measureText` returns `{ width: max line width, height: block height }` with the same rules.

### 9-slice
- `new engine.NineSlice(texture: Texture, insets: number | Insets)`. A number means all four sides. Insets must be integers ≥ 0 with `left + right ≤ texture.width` and `top + bottom ≤ texture.height`, otherwise `RangeError`. Read-only: `texture`, `left`, `top`, `right`, `bottom`. A sprite-sheet frame (`sheet.frame(i)`) is a valid `Texture`.
- `engine.assets.loadNineSlice(path: string, insets: number | Insets, opts?: TextureOptions): Promise<NineSlice>`.
- `engine.renderer.drawNineSlice(src: NineSlice | Texture, x, y, w, h, opts?: NineSliceOptions): void`
  - The four corners are drawn unscaled (× `scale`), the edges stretch along one axis, and the centre stretches along both. A `Texture` without `opts.insets` is drawn as one stretched quad.
  - **Shrink rule**: if `w < (left + right) · scale`, the left and right borders are drawn at `left · scale · f` and `right · scale · f` with `f = w / ((left + right) · scale)`, and the centre column is omitted. The same applies vertically with `h`.
  - `w ≤ 0` or `h ≤ 0` draws nothing. Zero-area pieces are skipped. There is no rotation. The camera applies as for `drawSprite`. One call counts as one sprite in the debug stats.

### UI widgets: `engine.ui`
An immediate-mode helper. **Call widgets from `update`** (`game.update` or a scene's `update`). Each fixed step builds a list of draw commands, and the engine draws the list from the most recent step in **screen space** (camera ignored, `normal` blend) after the game's render.
- `ui.panel(x, y, w, h, opts?: { style?: NineSlice | null; color?: ColorLike; alpha?: number }): void`: `style` (default `theme.panel`) as a 9-slice at `theme.nineSliceScale`, or a flat `color ?? theme.panelColor` rect with a 1-unit `theme.panelBorder` outline.
- `ui.label(text: string | number, x, y, opts?: TextOptions): void`: `drawText` with `font`, `size` and `color` defaulting to the theme.
- `ui.button(id: string, label: string, x, y, w, h, opts?: ButtonOptions): boolean`: returns `true` exactly once per activation, in the step it happens. The label is centred (`align: "center"`, `baseline: "middle"`) in the rect and is not clipped.
- Properties:
  - `ui.theme: UiTheme` (mutable fields)
  - `ui.hot: string | null` (button under the pointer, read-only)
  - `ui.active: string | null` (button being pressed, read-only)
  - `ui.focus: string | null` (read/write; setting an id shows the focus ring)
  - `ui.navigation: boolean` (default `true`)
  - `ui.autoDraw: boolean` (default `true`)
  - `ui.draw(): void`

**Ids**: a non-empty string of up to 64 characters, unique within a step. An invalid id, or a duplicate within the step, gets one warning per id; that button is drawn but never activates.

**Pointer** (mouse, and the primary touch through `input.mouse`; rects are `[x, x + w) × [y, y + h)` in game units):
- `hot` is the enabled button containing the pointer while `mouse.inside`. When buttons overlap, the one declared last in the previous step wins.
- `mouse.pressed` on a hot button makes it `active` and clears `focus`.
- The button activates on the step where `mouse.released` happens while it is both `active` and `hot`. Any release clears `active`. A press that started outside the button never activates it.

**Keyboard and gamepad navigation** (when `ui.navigation`):
- The navigation order is the enabled buttons with `nav !== false`, in call order, **from the previous step**. Edges are read at the start of each step:

  | Intent | Keys / buttons (all "pressed" edges) |
  |---|---|
  | previous | action `up` if declared, else `ArrowUp`; action `left` if declared, else `ArrowLeft`; gamepad 0 `Up`, `Left` |
  | next | action `down` if declared, else `ArrowDown`; action `right` if declared, else `ArrowRight`; gamepad 0 `Down`, `Right` |
  | activate | action `confirm` if declared, else `Enter`, `NumpadEnter`, `Space`; gamepad 0 `A` |
  | clear focus | `Escape`; gamepad 0 `B` |

  "Declared" means present in `input.actions` (F009), so player remapping applies. `Tab` is never used, because it must keep moving browser focus.
- With an empty order, nothing happens.
- "Next" with no focus focuses the first button and "previous" focuses the last. Both wrap around.
- "Activate" with a focus makes that button's call in this step return `true`, if it is still declared and enabled.
- At the end of a step, `focus` is cleared if its id was not declared (or was disabled) in that step, and `active` likewise.
- Disabled buttons are never hot, active or focused.

**Phases**:
- Widgets called outside a fixed step (from `render`, `load` or a timer callback outside update) draw immediately at the call site and never activate (`button` returns `false`). The first such `button` call per id warns.
- `panel` and `label` may be used from `render` freely, as styled drawing helpers.

**Drawing**:
- A step's list replaces the previous step's list, even when empty, so a menu disappears as soon as the game stops declaring it. With no step in a frame (paused, or a high refresh rate) the last list is drawn again.
- At most 256 commands per step; extra commands are dropped with one warning.
- `ui.draw()` (from `render`) draws the list at that point. It draws at most once per frame, and when it was called the automatic layer is skipped for that frame.
- `autoDraw = false` without `draw()` draws nothing.
- Buttons use `theme.button`/`buttonHover`/`buttonDown` 9-slices when set, otherwise the flat colours with a 1-unit `buttonBorder`. Disabled buttons are drawn at alpha 0.5 with `disabledTextColor`. A focused button gets a 2-unit `focusColor` outline drawn 2 units outside its rect.

### Frame order (updated)
1. Clear to `renderer.background`.
2. `game.render`, then `scenes.render`.
3. **UI layer** (`engine.ui`'s committed list; skipped when `autoDraw` is off or `ui.draw()` already ran this frame).
4. Batch flush → **F005 capture point** (screenshots include the UI layer).
5. F3 debug overlay, then the host "PAUSED" overlay (not captured, as before).

### For creators
- For pixel art, use the `pixel` font or a nearest-filtered bitmap font at whole multiples of its native size. Canvas fonts (`default`, `mono`, `loadFont`) stay best for large smooth text.
- Export BMFont descriptors as **text or JSON** with PNG pages, without channel packing.
- Buttons shown during gameplay (a pause icon on the HUD) should pass `{ nav: false }`, so arrow keys and `confirm` keep controlling the game.
- Declare a `confirm` action (and `up`/`down`) to let players remap menu keys.


## F017 additions
Creator comment tools (spec: `docs/features/F017-creator-comment-tools.md`). **No changes**: games can't read, pin, lock or sort comments, and there are no new messages, engine APIs or `game.json` fields.


## Review-fix additions (REVIEW-2026-11-16-5)
- **Cancelled releases (M2):** a release caused by window blur, engine pause/resume or `pointercancel` is a *cancelled* release. It never activates a `ui.button`; it only clears the button's active state. Games can tell a cancelled release apart with `input.wasCancelled(code)` and `input.mouse.cancelled` (`mouse.released` is still true for one step, so existing games behave as before).
- **BMFont limits (L1, L2b):** the "≤ 1 MiB" descriptor cap is measured in UTF-8 bytes. Text-format lines may be at most 4096 characters; a longer line fails with `BMFont "<name>": line N is longer than 4096 characters`.
- **Page paths (L2a):** page file names are percent-decoded exactly once. After decoding they must not contain `%`, `\`, `?` or `#`, and must resolve inside the bundle; otherwise loading fails.
- **Binary BMFont (L6):** a descriptor starting with `BMF` plus a version byte fails with `BMFont "<name>": binary BMFont is not supported; export the text or JSON format`.
- **Widgets outside a step (L2c):** widgets called outside `update` (in `render`, `load` or a timer) draw immediately and `button` returns `false` with a one-time warning, as § F012 already specifies.


## F008 additions
Collections (spec: `docs/features/F008-collections.md`). **No changes** to the bundle format, game.json, the engine API or the game ↔ parent messages. Collections are a platform feature only; games can't read or change them.


## F018 additions
Notification controls (spec: `docs/features/F018-notification-controls.md`). **No changes**: games can't read or change mutes or notifications, and there are no new messages, engine APIs or `game.json` fields.


## F021 additions
Collection activity (spec: `docs/features/F021-collection-activity.md`). **No changes**: games can't read or write the feed, notifications or collections, and there are no new messages, engine APIs or `game.json` fields.


## F016 additions
Gamepad remapping and synced control bindings (spec: `docs/features/F016-gamepad-remapping-and-sync.md`). **No changes** to game.json or the boot options. The `webgame:controls` message gains an optional field, and the engine gains a device hint, a label option and a resume latch. Existing games keep working unchanged. This section supersedes the F009 sentence "They are **not** remappable in F009" for gamepad buttons.

### Message (extended)
| Direction | Message |
|---|---|
| parent → game | `{ type: "webgame:controls", overrides: { [actionId: string]: string[] }, gamepad?: { [actionId: string]: GamepadButtonName[] } }` |

- `overrides` keeps every F009 rule.
- `gamepad` is optional. When present (not `undefined`), it must be a plain object with at most 32 own keys; otherwise the **whole** message is ignored (keys are not applied either).
- Each `gamepad` value replaces that action's `gamepad` buttons: non-array values, unknown action ids and names outside the F009 gamepad table (`Home` included) are ignored, duplicates are removed and only the first **2** names are kept. `[]` means "no gamepad buttons" (keys still apply).
- Each message **replaces** all previous key **and** gamepad overrides. A message without `gamepad` therefore restores the gamepad defaults.
- `engine.input.actions` reflects both kinds of override. `engine.input.defaultActions` is unchanged.

### Engine API (additions)
```ts
type InputDevice = "keyboard" | "mouse" | "touch" | "gamepad";
type GamepadOverrides = Record<string, GamepadButtonName[]>;

engine.input.lastDevice: InputDevice     // read-only; initial "keyboard"
engine.input.actionLabel(id: string, device?: "keyboard" | "gamepad" | "auto"): string
```
- **`lastDevice`** changes on player input only:
  - `"keyboard"`: a `keydown` that is not a repeat (`e.repeat === false`), for any code.
  - `"mouse"`: a mouse button press (`pointerdown` with `pointerType === "mouse"`, or `mousedown`).
  - `"touch"`: a `touchstart`, or `pointerdown` with `pointerType` `"touch"` or `"pen"`.
  - `"gamepad"`: at the start of a fixed step, any connected pad with a button `wasPressed`, or a left/right stick axis whose absolute value crosses from below 0.5 to 0.5 or above.
  - DOM events update it when they arrive; gamepads are checked when the step starts, so if both happen before the same step, `"gamepad"` wins. Mouse movement, the wheel and synthetic (cancelled) releases never change it.
- **`actionLabel(id, device)`**:
  - no `device`: unchanged (first effective key, else first gamepad button, else `""`).
  - `"keyboard"`: label of the first effective key (mouse codes included), else `""`.
  - `"gamepad"`: label of the first effective gamepad button (`gamepadLabel`), else `""`.
  - `"auto"`: like `"gamepad"` when `lastDevice === "gamepad"` and the action has at least one effective gamepad button; otherwise like no `device`.
  - Unknown ids return `""` and warn once per id (F009 rule).
- **Resume latch**: on host `webgame:resume` and on window `focus`, the engine latches all gamepads. On the next poll, every button's previous state is set to its current state, so a button held at that moment reports `isDown` but not `wasPressed`, and actions bound to it report `actionDown` but not `actionPressed`. Releasing it afterwards reports `wasReleased` as usual. Keyboard and mouse keep the F009 / review-5 blur and cancel rules.
- `input.gamepad(i)` and the raw `GamepadState` methods still report physical buttons; they are not remapped (same rule as raw keys).

### Parent behaviour (GamePlayer on /play/{id}, StudioPreview on /play/studio)
- When the game has at least one action, `webgame:controls` (sent at the same moments as in F009) always includes `gamepad` (possibly `{}`), with only entries that differ from the defaults.
- It sends only declared action ids, key codes and gamepad button names. It never sends key labels, the keyboard layout, `Gamepad.id`, user ids, tokens or sync state.
- `GamePlayer` reads bindings from the device store, which signed-in players sync with their account (API § F016, ARCHITECTURE § F016). `StudioPreview` keeps them in memory.

### Parent capture (normative for the controls panel)
- While, and only while, a gamepad slot is capturing, the parent calls `navigator.getGamepads()` once per animation frame.
- If `navigator.getGamepads` is missing or throws (for example a `SecurityError` on a non-secure origin), capture ends with "Controllers aren't available on this page".
- **Baseline**: when capture starts, and when a pad (keyed by `index` and `id`, in memory only) is first seen during capture, its currently pressed buttons are recorded as held. A held button counts only after it has been released and pressed again.
- A button counts when its `pressed` flag goes from `false` to `true` on a pad with `mapping === "standard"`. Indices 0–15 map to `A, B, X, Y, LB, RB, LT, RT, Back, Start, LS, RS, Up, Down, Left, Right`. Index 16 (`Home`) or higher shows "That button can't be used" and capture continues. A press on a pad whose `mapping` is not `"standard"` shows "This controller isn't supported yet" and capture continues.
- The first counted button is assigned; capture then ends. `Escape`, blur, a click elsewhere or 10 s end it without change.

### For creators
- Players can now remap gamepad buttons too. Read actions (`actionPressed("jump")`) instead of raw buttons (`gamepad(0).wasPressed("A")`) for everything you declared.
- Use `actionLabel("jump", "auto")` in prompts so they show "Space" to keyboard players and "A" (or the player's remapped button) to controller players.
- Menus built with `engine.ui` keep the fixed gamepad D-pad, `A` and `B` navigation fallbacks (F012), so a remap can never lock a player out of a menu.


### F016 implementation notes (engine)
- **Release at the latched poll:** the latched step has no edges, so a button released at exactly that poll doesn't report `wasReleased` either. Stick values are latched too, so a stick already pushed past 0.5 doesn't change `lastDevice`.
- **Latch with no pad connected:** the next poll uses up the latch even when no pad is connected. A pad that connects later with a button already held does fire `pressed`.
- **`lastDevice` sources:**
  - Gamepad: any button index counts, including `Home` and indices above 16. Sticks count on axes 0–3 only.
  - Mouse and touch: `mousedown` and `touchstart` count only on the canvas. Mouse events that the browser generates from touch are ignored.
  - Gamepad input is checked when each step starts, so it wins a tie with keyboard or mouse input from the same step.
- **Window `focus` latch:** registered when input is attached, alongside the `webgame:resume` latch.
- **`setActions`:** clears gamepad overrides as well as key overrides.


## F019 additions
Engine UI widgets 2 (spec: `docs/features/F019-ui-widgets-2.md`). **No changes** to the bundle format, game.json, the boot options or the game ↔ parent messages. Everything below is engine API. All F012 `engine.ui` rules (ids, phases, the per-step command list, drawing, pointer and navigation) still apply unless this section changes them. Existing games keep working unchanged: `ui.button` behaves exactly as before, and nothing below happens unless a game calls a new widget.

### Model
- The new widgets are **value in, value out**: the game owns the value, passes it in every step and stores what comes back. The engine keeps only interaction state (pointer drag, list cursor and scroll, text caret).
- `ui.changed(id)` and `ui.committed(id)` report what happened to a widget in the current step (§ "Change signals").
- All widget kinds share one id namespace: a `button` and a `slider` with the same id in one step are duplicates.

### Types
```ts
type SliderOptions = {
  min?: number;            // default 0
  max?: number;            // default 1; needs finite min < max
  step?: number;           // default 0 = continuous; > 0 snaps the value
  keyStep?: number;        // keyboard/gamepad increment; default step > 0 ? step : (max - min) / 20
  disabled?: boolean;
  nav?: boolean;           // default true
}
type ToggleOptions = { disabled?: boolean; nav?: boolean; font?: string; textSize?: number; textColor?: ColorLike }
type TextFieldOptions = {
  maxLength?: number;      // in code points; default 24; integers 1–256
  placeholder?: string;    // shown when empty and not editing
  allow?: (ch: string) => boolean;   // called per code point; false rejects it
  disabled?: boolean; nav?: boolean; font?: string; textSize?: number; textColor?: ColorLike;
}
type ListOptions = {
  rowHeight?: number;      // default 16; integers 4–256
  selected?: number;       // the "current" row, drawn highlighted; default -1 (none)
  disabled?: boolean; nav?: boolean; font?: string; textSize?: number; textColor?: ColorLike;
}
type TextEvent =
  | { kind: "text"; text: string }   // one or more code points (typed or pasted), already filtered
  | { kind: "key"; key: "Backspace" | "Delete" | "ArrowLeft" | "ArrowRight" | "Home" | "End" }
```
`UiTheme` gains (defaults after the colon):
```ts
  trackColor: ColorLike;        // "#0e1224"  slider track, toggle switch when off, scrollbar track
  fillColor: ColorLike;         // "#5a6bc0"  slider fill, toggle switch when on, scrollbar thumb
  knobColor: ColorLike;         // "#ffffff"  slider knob, toggle knob
  fieldColor: ColorLike;        // "#0e1224"  text field and list background
  fieldBorder: ColorLike;       // "#5a6bc0"  text field and list 1-unit border
  caretColor: ColorLike;        // "#ffd166"
  placeholderColor: ColorLike;  // "#5d6488"
  rowHoverColor: ColorLike;     // "#2a3358"
  rowSelectedColor: ColorLike;  // "#3a4780"
  track: NineSlice | null;      // null = flat trackColor/fillColor bars
  knob: NineSlice | null;       // null = flat knobColor square
  field: NineSlice | null;      // null = flat fieldColor + fieldBorder (text field and list frame)
```
9-slices are drawn at `theme.nineSliceScale`, as for panels and buttons.

### Widgets
- `ui.slider(id: string, value: number, x, y, w, h, opts?: SliderOptions): number`
  - Returns the new value. A non-finite `value` is treated as `min`. The return value is always clamped to `[min, max]` and, when `step > 0`, snapped: `min + Math.round((v - min) / step) * step`, clamped again, then `Number(v.toFixed(10))`. Clamping or snapping the game's value is not a change (`changed` stays `false`).
  - Invalid range (`min`/`max` not finite, or `max <= min`): drawn disabled, returns `value` unchanged, with the warning `slider "{id}" needs finite min < max; it is drawn disabled` (once per id). A `step` or `keyStep` that is not a finite number > 0 falls back to its default without a warning.
  - **Pointer**: a press inside the rect makes the slider `active` (and clears `focus`, as in F012). While it is active, every step sets `t = clamp((mouse.x - (x + h / 2)) / max(1, w - h), 0, 1)` and `v = min + t · (max - min)` (then snapped), so the knob follows the pointer even outside the rect. The press step already applies the value under the pointer. Any release (cancelled or not) ends the drag.
  - **Keys** (when focused): "left"/"right" subtract/add `keyStep` (then clamp and snap) and **do not move focus**. "up"/"down" move focus as in F012. "activate" does nothing.
  - Drawing: a bar of height `max(2, round(h / 3))`, vertically centred, across the full width (`theme.track` 9-slice, or `trackColor`); the part from `x` to the knob centre in `fillColor`; a knob `h × h` centred at `x + h / 2 + t · (w - h)` (`theme.knob` 9-slice, or a `knobColor` square). There is no label or value text: draw those with `ui.label`.
- `ui.toggle(id: string, on: boolean, label: string, x, y, w, h, opts?: ToggleOptions): boolean`
  - Returns the new state. It flips on a pointer click (F012 button rules: press and release on it; cancelled releases never flip) or on "activate" while focused. "left"/"right" move focus, as for buttons.
  - Drawing: the label left-aligned at `x` and vertically centred (`font`/`textSize`/`textColor` from opts or the theme). A switch of width `sw = min(w, 2h)` and height `h`, right-aligned in the rect: the track in `fillColor` when on and `trackColor` when off (or `theme.track`), and a knob `(h - 4) × (h - 4)` inset 2 units from the left (off) or right (on) end, in `knobColor` (or `theme.knob`). There is no animation.
- `ui.textField(id: string, text: string, x, y, w, h, opts?: TextFieldOptions): string`
  - Returns the new text. A non-string `text` is treated as `String(text ?? "")`. The text is not cut to `maxLength` unless the player edits it.
  - A `maxLength` that is not an integer from 1 to 256 is clamped into that range after `Math.floor` (`NaN` → 24), with the warning `textField "{id}" maxLength must be an integer from 1 to 256` (once per id).
  - Editing: § "Text editing".
  - Drawing: the frame (`theme.field` 9-slice, or `fieldColor` with a 1-unit `fieldBorder`); the text left-aligned at `x + 4` and vertically centred; the placeholder in `placeholderColor` when the text is empty and the field is not editing; while editing, a solid caret 1 unit wide and as tall as the text, in `caretColor` (no blinking). When the text is wider than `w - 8`, the field shows a contiguous run of code points that contains the caret and fits in `w - 8`; when the caret leaves the run, the run moves by the minimum amount. Nothing is drawn outside the rect.
- `ui.list(id: string, items: readonly (string | number)[], x, y, w, h, opts?: ListOptions): number`
  - Returns the index of the row activated in this step, else `-1`. At most 1000 items are used; more give the warning `list "{id}" has more than 1000 items; only the first 1000 are shown` (once per id). An invalid `rowHeight` falls back to 16 with the warning `list "{id}" rowHeight must be an integer from 4 to 256` (once per id).
  - `visibleRows = max(1, floor(h / rowHeight))`. Rows scroll by whole rows; `scroll` (the first visible row) stays within `[0, max(0, count - visibleRows)]`.
  - **Pointer**: a press on a row makes the list `active` and remembers the row and the pointer y. A release on the **same row** activates it, sets the cursor to it and returns its index, unless the pointer moved more than 4 units vertically while pressed. In that case the press became a **drag scroll** (`scroll = clamp(pressScroll + round((pressY - mouse.y) / rowHeight))` every step while pressed) and never activates. The row under the pointer is drawn in `rowHoverColor`. The wheel (`mouse.wheel ≠ 0` while the pointer is over the list) scrolls by `sign(wheel) · max(1, round(|wheel| / 100))` rows.
  - **Keys** (when focused): the cursor (−1 = none) is set when the list gains focus: `selected` if it is a valid index; otherwise row 0 when focus arrived with "next" or through `ui.focus = id`, and the last row when it arrived with "previous". "up"/"down" move the cursor by one row and scroll it into view. A **fresh press** (not a hold repeat) of "up" on row 0 moves focus to the previous widget, and of "down" on the last row to the next widget. "left"/"right" move focus, as for buttons. "activate" returns the cursor index.
  - An empty list, or a disabled one, is drawn but skipped by navigation and never activates.
  - Drawing: the frame as for the text field; each visible row's text left-aligned at `x + 4` and vertically centred in its row, truncated with `...` to fit; the `selected` row's background in `rowSelectedColor`; the cursor row, while the list is focused, with a 1-unit `focusColor` outline inside the row. When `count > visibleRows`, a 3-unit scrollbar inside the right edge (`trackColor`, with a `fillColor` thumb of height `max(4, h · visibleRows / count)`); row text then fits in `w - 12` instead of `w - 8`. The scrollbar is not interactive.
- Helpers:
  - `ui.changed(id: string): boolean` and `ui.committed(id: string): boolean` (§ "Change signals").
  - `ui.listCursor(id: string): number`: the list's cursor, or `-1` (no cursor, an unknown id, or not a list).
  - `ui.editing: string | null` (read/write): the text field being edited. Setting it to an id focuses that id and starts editing in the next step, with the caret at the end, if that step declares an enabled text field with that id; otherwise it is cleared at the end of that step. Setting it to `null` stops editing with **commit**.

### Navigation (updated)
F012 navigation is unchanged for buttons. The intents are computed as in F012 ("previous" = up **or** left, "next" = down **or** right). The new rule is that the focused widget decides what each intent does:

| Focused widget | "left" / "right" | "up" / "down" | "activate" | `Escape` / pad `B` |
|---|---|---|---|---|
| none, `button`, `toggle` | previous / next focus (F012) | previous / next focus | button: activate; toggle: flip | clear focus |
| `slider` | −/+ `keyStep` (hold repeats) | previous / next focus | nothing | clear focus |
| `list` | previous / next focus | cursor −/+ 1 (hold repeats); a fresh press past the first/last row leaves the list | activate the cursor row | clear focus |
| `textField`, not editing | previous / next focus | previous / next focus | start editing | clear focus |
| `textField`, editing | ignored (raw `ArrowLeft`/`ArrowRight` move the caret through `textEvents`) | commit, then previous / next focus; raw `ArrowUp`/`ArrowDown` also count | raw `Enter`/`NumpadEnter`, the declared `confirm` action (gamepad or mouse only, because of capture) or gamepad 0 `A`: commit and stop editing (focus kept) | revert and stop editing (focus kept) |

- Each single intent follows F012: "left" is action `left` if declared, else `ArrowLeft`, plus gamepad 0 `Left`; "right", "up" and "down" likewise; "activate" is action `confirm` if declared, else `Enter`/`NumpadEnter`/`Space`, plus gamepad 0 `A`. While editing, keyboard keys don't reach actions (keyboard capture), so only the raw keys named in the table act on the keyboard side.
- When both intents of a pair are pressed in the same step, that pair does nothing (F012 rule).
- **Hold repeat** (slider adjustment and list cursor only): while the intent stays held (`actionDown` of the declared action, else `isDown` of the fallback key, or gamepad 0 `isDown` of the D-pad direction), it repeats after 0.4 s and then every 0.08 s of step time (the sum of fixed-step `dt`). The timer restarts when the held intent or the focus changes. Moving focus between widgets never repeats (F012 unchanged), and a repeat never leaves a list.
- Navigation order: every valid, enabled widget with `nav !== false`, in call order, from the previous step (F012). Panels and labels are never in it; empty lists are skipped.

### Text editing
- **Start editing**:
  - a pointer press on an enabled text field (the caret goes to the code-point boundary nearest the pointer);
  - "activate" while it is focused (caret at the end);
  - `ui.editing = id` (caret at the end);
  - while it is focused and not editing, a step with at least one `text` event: editing starts, that step's events are applied, and no navigation or activation happens in that step. This takes precedence over "activate", so `Space` on a focused field starts editing and inserts a space.
- **While editing**, the step's `textEvents` are applied in order:
  - `text`: each code point is inserted at the caret, unless `allow` returns `false` for it (or throws: treated as `false`, one warning per id) or the text already has `maxLength` code points (then the rest of the event is dropped).
  - `Backspace` / `Delete` remove the code point before / after the caret. `ArrowLeft` / `ArrowRight` move the caret by one code point. `Home` / `End` move it to the start / end.
- The return value is the edited text in every step (live). The engine stores the text as it was when editing started (the **original**).
- **Stop editing**:
  - **commit**: raw `Enter`/`NumpadEnter`, the `confirm` action or gamepad 0 `A` (together "**submit**"), leaving with "up"/"down", a pointer press outside the field, `ui.editing = null`, or `ui.focus` set to another id. Focus stays on the field for a submit and for `ui.editing = null`.
  - **revert**: `Escape` or gamepad 0 `B`. The field returns the original text in that step, and focus stays on it.
  - **dropped**: the field is not declared, or is disabled, in a step. Editing ends at the end of that step, with no signal.
- Only one field edits at a time. `Tab` is never used. Paste works. Copy, selection, undo, IME composition and an on-screen keyboard are **not** supported.

### Change signals
`ui.changed(id)` and `ui.committed(id)` are true only in the step where it happens, and only **after** the widget's call in that step. Before the call, or for an id not declared in the step, they return `false`.

| Widget | `changed(id)` | `committed(id)` |
|---|---|---|
| slider | the player changed the returned value (pointer or keys) | the step of the release that ends a drag during which the value changed; every keyboard/gamepad adjustment step that changed the value |
| toggle | it flipped | it flipped |
| textField | the returned text differs from the text passed in (an edit or a revert) | the step it stops editing with **commit**: always for a submit, otherwise only when the text differs from the original |
| list | the cursor moved (keys or a click) | a row was activated |
| button | it activated | it activated |

Use `committed` to save settings once, instead of on every drag step.

### Phases, ids and disabled state
- Outside a fixed step, the new widgets draw at the call site and return their input unchanged (`value`, `on`, `text`, `-1`), with the warning `{kind} "{id}" was called outside update; it is drawn but never changes (call widgets from update)` once per id. `{kind}` is `slider`, `toggle`, `textField` or `list`. The F012 `button` wording is unchanged.
- An invalid id gives `{kind} id {json} must be a string of 1–64 characters; it never changes`, and a duplicate gives `{kind} id "{id}" is used twice in one step; the second one never changes` (once per id each; `{json}` is `JSON.stringify(String(id))`). Such a widget is drawn and returns its input unchanged.
- Disabled widgets are drawn at alpha 0.5 (text in `disabledTextColor`). They are never hot, active, focused or editing, and return their input (a slider's clamped and snapped).
- Each widget is one command toward the 256-commands-per-step cap.
- Interaction state (list cursor and scroll, the text caret and visible run, a slider drag) is kept per id and **discarded at the end of a step that does not declare that id**. A list that reappears starts scrolled so that `selected` is visible, or at the top.
- All warnings use the F012 prefix `[pixelforge] ui: `.

### Input additions
```ts
engine.input.textEvents: readonly TextEvent[]   // this step's typing, in order; [] when none
engine.input.keyboardCaptured: boolean          // read-only
```
- **`textEvents`** is collected from window events and handed over at the start of each step (like `typed`). At most 64 events per step are kept; extras are dropped.
  - A `keydown` with `isComposing === false`, an `e.key` of exactly one code point, and neither `ctrlKey` nor `metaKey` (unless both `ctrlKey` and `altKey` are set, which is AltGr on Windows) → `{ kind: "text", text: e.key }`. Key repeats count.
  - A `keydown` whose `e.key` is `Backspace`, `Delete`, `ArrowLeft`, `ArrowRight`, `Home` or `End`, without `ctrlKey`/`metaKey`/`altKey` → `{ kind: "key", key: e.key }`. Key repeats count.
  - A `paste` on the window → `{ kind: "text", text }` from `clipboardData.getData("text/plain")`. `\r\n`, `\r`, `\n` and `\t` become spaces, and the text is cut to 256 code points. The event's default is prevented. An empty result adds nothing.
  - Every `text` event is filtered: code points below U+0020, U+007F–U+009F and lone surrogates are removed, and an event that becomes empty is dropped.
  - Events that arrived while the engine was paused are discarded when it resumes (host `webgame:resume` or the end of an author pause), so keys typed under the ⌨ panel never reach a field.
  - `typed` is unchanged (F009 raw input).
- **`keyboardCaptured`** is `true` while a `ui.textField` is editing. It turns on in the step where editing starts (before the game's update), so the key that starts editing never fires its action; at the end of each step it is recomputed as `ui.editing !== null` (review 8, M1). Capture covers the keyboard only: starting an edit with gamepad A still reports `actionPressed("confirm")`. While it is `true`:
  - `actionDown/actionPressed/actionReleased` and `axis()` ignore keyboard codes. Mouse codes (`Mouse0`…) and gamepad buttons still count.
  - An action that was down only through keyboard keys reports `actionReleased` in the first captured step.
  - When capture ends, keyboard keys that are still held don't count for actions until they are released.
  - `keydown` events that produce a `textEvents` entry, and `Space`, have their default prevented (so Firefox quick find and page scrolling never trigger), except `Ctrl`/`Meta` + `V`, which must reach the browser to fire `paste`.
  - Raw input (`isDown/wasPressed/wasReleased(code)`, `anyPressed`, `typed`, `mouse`, `touches`, `gamepad(i)`) is unchanged. The F3 debug key still works.

### Frame order
Unchanged from F012. The new widgets are part of the UI layer, before the F005 capture point, so screenshots include them (and the caret while editing).

### For creators
- Keep the value in your own state and pass it back every step: `s.volume = ui.slider("vol", s.volume, 120, 80, 160, 12, { step: 0.05 })`. Save on `ui.committed("vol")`.
- While `engine.ui.editing` is set, your keyboard actions pause (`input.keyboardCaptured`), so typing a name never moves the player. Gamepad and mouse still work. If you read raw keys or `typed` for gameplay, check `engine.ui.editing` yourself.
- Text fields need a physical keyboard. On touch devices, and for controller-only players, offer a fallback (for example preset names in a `ui.list`). An on-screen keyboard is a later roadmap item (F023).
- Labels and value read-outs are plain `ui.label` calls, so you choose the wording and the format.


### F019 implementation notes (engine)
- **`allow` callback:** any falsy return rejects the character. If `allow` throws, the character is rejected and this warning is logged once per id: `textField "{id}" allow threw; the character was rejected`.
- **`ui.navigation = false`:** Enter (submit) and Escape or B (revert) still work while editing, and typing on a focused field still starts editing. Up and down only commit and move focus when navigation is on.
- **Slider drag ended by a cancelled release or a pause:** `committed` still fires if the value changed during the drag. A normal release applies the pointer position at the moment of release.
- **List focus and empty lists:** when focus arrives on a list, the cursor is set without counting as `changed`; only keys and clicks change it. An empty list can't take focus.
- **Long text:** when the visible part of the text reaches its end, it extends left as far as fits, so backspacing at the end of long text never leaves a gap.
- **IME composition:** while `isComposing` is true, editing keys are ignored as well as text keys. A paste is cut to 256 code points before `allow` filtering.
- **Duplicate-id warnings:** these are deduplicated per widget kind and id. Buttons keep the F012 wording.
- **Setting `ui.editing`:**
  - After `ui.editing = id`, the getter returns that id from then on. From the start of the next step, `ui.editing` also reports a field that is starting to edit in that step (typed text, a pointer press or activate on the focused field) before the field's call, so `!engine.ui.editing` guards work in that step. Moving `ui.focus` away, setting `ui.editing`, or calling the field `disabled` before its call cancels that start; capture then stays on until the end of the step, and held keys are latched until released (review 8, M1).
  - `ui.editing = null`, or moving `ui.focus` away, commits the edit. The field reports `committed` at its next call.
- **Volume:** the volume API is `engine.audio.masterVolume`. There is no `audio.volume`.
- **Mute at load:** the host's `webgame:mute` also sets `engine.audio.muted`. So a game's SOUND setting should only force `muted = true` at load when the saved setting is off, and never unmute at load.

### F019 note: Escape in browser fullscreen (review 8, L2)
When the player uses the site's fullscreen button, the browser takes the first Escape to leave fullscreen, and the game never receives it. A text field that is being edited stays in editing mode. A second Escape, gamepad B, Enter, clicking elsewhere, or Up/Down still ends editing, so the game never gets stuck. To cancel an edit reliably, use gamepad B or a second Escape. Desktop F11 fullscreen is native window fullscreen and doesn't have this problem.


## F015 additions
None. Screenshots reach the feed and profiles through the existing F005 post flow (the 📷 button, `engine.platform.shareScreenshot()`), with no engine, message or bundle changes.


## F023 additions
On-screen keyboard for `ui.textField` (spec: `docs/features/F023-on-screen-keyboard.md`). **No changes** to the bundle format, game.json, the boot options or the game ↔ parent messages. Everything below is engine API.

All F019 rules still apply whenever the keyboard isn't shown. This section changes them only while it is shown. Existing games keep working: their fields default to `"auto"`, so touch and controller players get the keyboard with no code change.

### API
```ts
type TextFieldKeyboard = "auto" | "always" | "never";
type TextFieldOptions = { /* F019 fields */ keyboard?: TextFieldKeyboard };   // default "auto"
engine.ui.keyboardRect: Readonly<{ x: number; y: number; w: number; h: number }> | null   // read-only
```
- An invalid `keyboard` value counts as `"auto"`, and warns once per id: `textField "{id}" keyboard must be "auto", "always" or "never"`.
- `keyboardRect` is the panel drawn at the end of the last completed step, in game units (frozen), or `null` when no keyboard was drawn.

### Layout (normative)
The grid has 10 columns and 5 rows. Each character key takes one column; the row 4 keys take the columns given.

| Row | Keys |
|---|---|
| 0 | `1` `2` `3` `4` `5` `6` `7` `8` `9` `0` |
| 1 | `Q` `W` `E` `R` `T` `Y` `U` `I` `O` `P` |
| 2 | `A` `S` `D` `F` `G` `H` `J` `K` `L` `'` |
| 3 | `Z` `X` `C` `V` `B` `N` `M` `-` `_` `.` |
| 4 | `SHIFT` (columns 0–1), `SPACE` (2–5), `DEL` (6–7), `OK` (8–9) |

- **Case.** Letters show as capitals each time the keyboard opens. `SHIFT` toggles between capitals and small letters (caps lock, not one-shot) and only affects letters.
- **Labels.**
  - A character key shows its character in the current case.
  - `SHIFT` shows `abc` while capitals are on, and `ABC` while small letters are on.
  - The other row 4 keys show `SPACE`, `DEL` and `OK`.
- **Output.**
  - A character key gives `{ kind: "text", text: ch }`, and `SPACE` gives `{ kind: "text", text: " " }`.
  - `DEL` gives `{ kind: "key", key: "Backspace" }`.
  - `OK` submits (F019 "submit": `committed` is true and focus stays on the field).
  - `SHIFT` gives no event.
  - These events go only to the field being edited. They never appear in `input.textEvents`, never change `input.lastDevice` and never fire actions.

### Size and position (normative)
Let `W = renderer.width` and `H = renderer.height` (game units), with margin `m = 4` and gap `g = 2`.
- `keyH = clamp(round(H · 0.09), 12, 48)` and `keyW = floor((W − 2m − 9g) / 10)`.
- `panelW = 10·keyW + 9g + 2m` and `panelH = 5·keyH + 4g + 2m`.
- `panelX = floor((W − panelW) / 2)`.
- `panelY = H − panelH` (bottom), unless the edited field's rect satisfies `field.y + field.h > H − panelH` **and** `field.y >= panelH`. In that case `panelY = 0` (top).
- Key at row `r`, column `c`, span `s`: `x = panelX + m + c·(keyW + g)`, `y = panelY + m + r·(keyH + g)`, `w = s·keyW + (s − 1)·g`, `h = keyH`.
- If `keyW < 8` or `panelH > H`, no keyboard is shown, and this warns once per `Ui`: `on-screen keyboard does not fit a {W}x{H} game; it is not shown`. `{W}` and `{H}` are the integer game size, and the separator is the letter `x`. The field keeps working with a physical keyboard.

### Opening and closing
- **Open.** The decision is made at the field's call in the step where editing starts, by any F019 start: a pointer press, activate, typing, or `ui.editing = id`.
  - `"always"` opens the keyboard.
  - `"auto"` opens it when `input.lastDevice` is `"touch"` or `"gamepad"` at that moment.
  - `"never"` doesn't open it.

  The keyboard is drawn from the end of that step and takes input from the next step, so the press that started editing never types a key.
- **Hide.** In a step with at least one `input.textEvents` entry (physical typing or a paste), the events are applied and the keyboard is hidden for the rest of this edit. Editing continues.
- **Reopen.** A pointer press on the field being edited reopens a hidden keyboard when `keyboard` is `"always"`, or when it is `"auto"` and `lastDevice` is `"touch"` at that press. The caret also moves (F019).
- **Close.** The keyboard closes whenever editing ends, whether by submit, commit, revert or drop (F019 "Stop editing"). The next start decides again, and the keyboard reopens with capitals and the cursor on `Q`.

### Input while the keyboard is shown
- **Pointer** (mouse and the primary touch). The panel uses the previous step's layout and is tested **before** widgets:
  - A press inside the panel is taken by the keyboard: it doesn't reach any widget, doesn't commit, doesn't change `ui.focus`, and `ui.hot` is `null`.
  - A key fires on a release over the key that was pressed, if that key is enabled. A cancelled release never fires.
  - Keys have no pointer repeat.
  - A press on the field moves the caret (F019).
  - A press anywhere else commits (F019) and closes the keyboard.
  - Raw `input.mouse` and `input.touches` still report presses on the panel.
- **Gamepad 0** (fixed; not remappable except for the direction actions):

  | Input | Effect |
  |---|---|
  | D-pad `Up`/`Down`/`Left`/`Right`, or the declared `up`/`down`/`left`/`right` actions | move the keyboard cursor |
  | `A` | press the cursor key |
  | `B` | revert and stop editing (F019) |
  | `X` | `DEL` |
  | `Y` | `SPACE` |
  | `LB` | `SHIFT` |
  | `Start` | `OK` |

  - While the keyboard is shown, pad `A` and the declared `confirm` action don't submit, and pad `Up`/`Down` and the `up`/`down` actions don't commit or move focus.
  - Because of keyboard capture, the direction actions count only through gamepad or mouse bindings.
  - A pad `A` press still reports `actionPressed("confirm")` to the game, as in F019.
- **Physical keyboard.** These F019 rules are unchanged:
  - raw `Enter`/`NumpadEnter` submit;
  - `Escape` reverts;
  - with `ui.navigation` on, raw `ArrowUp`/`ArrowDown` commit and move focus;
  - `ArrowLeft`/`ArrowRight` and the other editing keys go through `textEvents`, so they hide the keyboard.

  Raw arrow keys never move the keyboard cursor.
- **Cursor.**
  - It opens on `Q` (row 1, column 0), with anchor column 0.
  - Left and right move one key along the row (a wide key counts once), wrap within the row, and set the anchor to the new key's first column.
  - Up and down move to the key in the adjacent row that covers the anchor column, wrapping between rows 0 and 4. They don't change the anchor.
  - When both a vertical and a horizontal move happen in one step, the vertical one applies first.
- **Hold repeat** uses the F019 timing (the first repeat after 0.4 s, then every 0.08 s of step time). It applies to:
  - cursor movement, with a separate timer for each axis;
  - `DEL` while pad `X` is held, or while pad `A` is held with the cursor on `DEL`.

  Other keys never repeat.
- **Disabled keys** are evaluated every step against the field's text and caret after that step's edits:
  - A character key or `SPACE` is disabled when the text has `maxLength` code points, or when `allow(ch)` is falsy or throws. A throw logs the F019 warning `textField "{id}" allow threw; the character was rejected`, once per id.
  - `DEL` is disabled when the caret is at 0.
  - `SHIFT` and `OK` are always enabled.
  - The cursor can rest on a disabled key, but pressing it does nothing.
- **Order within a step:**
  1. A revert (`Escape` or pad `B`) wins: this step's keyboard events are dropped.
  2. Otherwise the field applies `input.textEvents`, then the keyboard events in this order:
     - the pointer key;
     - pad `A` on the key the cursor was on at the **start** of the step;
     - the cursor move;
     - pad `X`, `Y`, `LB` and `Start`.

     A `SHIFT` affects the events after it.
  3. Then a submit (`OK`/`Start`/raw `Enter`) or a commit (raw `ArrowUp`/`ArrowDown`) applies.
- **Focus.** The keyboard has no id. It is never in the navigation order, and never `ui.hot`, `ui.active` or `ui.focus`. `ui.focus` stays on the field.

### Drawing
- The panel is one command, appended after all of the step's widgets, so it draws on top of them in the UI layer (before the F005 capture point; screenshots include it). It does not count toward the 256-command cap.
- **Panel:** `theme.panel` as a 9-slice at `theme.nineSliceScale`, or `panelColor` with a 1-unit `panelBorder`.
- **Keys:** button styles. `theme.button`/`buttonHover`/`buttonDown`, or `buttonColor`/`buttonHoverColor`/`buttonDownColor` with a 1-unit `buttonBorder`. Hover means the key under the pointer while `mouse.inside`; down means the key being pressed.
- **Labels:** centred, using `theme.font`, `theme.textSize` and `textColor`. Disabled keys are drawn at alpha 0.5 with `disabledTextColor`.
- **Cursor key:** a 2-unit `focusColor` outline **inside** its rect.
- There are no new theme fields. The field keeps its F019 ring and caret.

### Pause
Host and author pauses keep the keyboard open (editing stays on). A key press in progress is dropped (a cancelled release), and so are the repeat timers. Text typed while paused is still discarded (F019).

### For creators
- Nothing to do: a `ui.textField` now works for phone and controller players. Pass `{ keyboard: "never" }` if you draw your own picker, or `{ keyboard: "always" }` for pointer-only games.
- Your `allow` filter dims the keys it rejects, so restrict names with `allow` instead of cleaning them up afterwards.
- For small pixel-art games, use `ui.theme.font = "pixel"` so the key labels fit.
- Move HUD elements out of `ui.keyboardRect` if they matter while typing. If you read raw `input.mouse` during editing, ignore presses inside it.
- Gamepad `A` still reports your `confirm` action while typing, so guard gameplay with `engine.ui.editing` (F019).

### F023 implementation notes (engine)
- **Reopening** a hidden keyboard counts as opening it: the keys go back to capitals and the cursor returns to `Q`.
- **`ui.navigation = false`:** the D-pad still moves the keyboard cursor. Only the raw `ArrowUp`/`ArrowDown` commit depends on navigation, as in F019.
- **Holding `DEL`:**
  - A repeat from `A` held on `DEL` takes `A`'s place in the step order, and a repeat from `X` takes `X`'s place.
  - Moving the cursor off `DEL` while `A` is held restarts the repeat timer.
- **Pressing a dimmed key** sends its event as usual, and `applyTextEvents` rejects it under the usual rules (`maxLength`, `allow`, Backspace at caret 0). So a SHIFT earlier in the same step is applied correctly.
- **Keyboard that doesn't fit:** it counts as not shown. `keyboardRect` is `null` and all F019 rules apply, including gamepad A submitting. In the warning, `{W}x{H}` is the renderer size rounded to whole pixels.
- **Hover and pressed styles** come from the mouse state at the end of the step. A disabled key never shows them.

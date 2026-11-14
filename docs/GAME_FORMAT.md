# Game bundle format & engine runtime contract

## Bundle (.zip)
```
my-game.zip
├─ game.json        (required, at zip root — or inside a single top-level folder, which the backend strips)
├─ main.js          (entry, ES module)
└─ assets/...       (any png/jpg/webp/gif/svg/json/txt/wav/mp3/ogg/js/css/woff2/ttf files)
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

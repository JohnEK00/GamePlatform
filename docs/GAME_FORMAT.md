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
`{ORIGIN}` is the backend's absolute origin derived from the request `Host` header (absolute URLs are needed because the sandboxed iframe has an opaque origin).


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

# Pixelforge — `@webgame/engine`

A small, dependency-free **WebGL2** 2D game engine for WebGameApp. It builds to a single ES module,
`dist/engine.js`, which the backend serves at `/runtime/engine.js`. Its types go in `dist/types/`.

Games are plain JS bundles (see [docs/GAME_FORMAT.md](../../docs/GAME_FORMAT.md)). **Authors import nothing.**
The engine instance is passed to your game and carries every system and utility class.

```bash
npm run build -w @webgame/engine   # dist/engine.js + dist/types/*.d.ts
npm test      -w @webgame/engine   # vitest (pure logic)
npm run dev   -w @webgame/engine   # playground at http://localhost:5174/?game=space-dodge
node scripts/pack-examples.mjs     # examples/<name>/ -> examples/dist/<name>.zip
```

The **playground** (`index.html`) is a host page. It loads `player.html` (a copy of the backend player
page) in a `sandbox="allow-scripts"` iframe, which runs `examples/<name>/`. As the parent it answers
`webgame:hello` with `webgame:load` from its own localStorage (`webgame.save.{name}`), persists
`webgame:save`, fullscreens the iframe on `webgame:fullscreen`, sends `webgame:pause`/`resume`/`mute`
from its toolbar ("Clear save" wipes the stored data) and shows the messages the game posts.
`window.engine` is set inside the iframe; pick the iframe context in devtools to poke around.
`webgame:achievement` messages show a toast with the achievement's name and icon from game.json.

**Studio mode** (`studio.html`, linked from the toolbar) mimics the platform's `/play/studio` protocol. The
host fetches every file of the example itself (via `/examples/<name>/files.json`), loads `studio-player.html`
(a copy of the backend's studio player page) in a sandboxed iframe, waits for `webgame:studio-ready` and
posts `webgame:studio-load { manifest, files }`. The player imports the entry from a `blob:` URL and boots
with `baseUrl: "about:blank"` and the in-memory `files`, so every asset load goes through the files path.
Scores and achievements show "would submit / would unlock" toasts instead of being recorded.

---

## Quick example

```js
// main.js — default-export an object (or a class; it is instantiated with `new Game(engine)`)
export default {
  async load(engine) {
    this.ship = await engine.assets.loadTexture('assets/ship.png');
    this.boom = await engine.assets.loadSound('assets/boom.wav');
    this.pos = new engine.Vec2(engine.width / 2, engine.height / 2);
    this.score = 0;
  },
  update(engine, dt) {                       // fixed 60 Hz, dt = 1/60
    const { input } = engine;
    this.pos.x += input.axis('horizontal') * 200 * dt;
    this.pos.y += input.axis('vertical') * 200 * dt;
    if (input.wasPressed('Space')) {
      engine.audio.play(this.boom, { volume: 0.5 });
      engine.camera.shake(6, 0.2);
      this.score += 10;
    }
    if (this.score >= 100) engine.platform.submitScore(this.score);
  },
  render(engine, alpha) {                    // alpha = interpolation between fixed steps
    const r = engine.renderer;
    r.clear('#101020');
    r.drawSprite(this.ship, this.pos.x, this.pos.y, { originX: 0.5, originY: 0.5 });
    r.ui(() => r.drawText(`Score ${this.score}`, 10, 10, { size: 20, color: '#fff' }));
  },
};
```

## Boot (host side)

```js
import { boot } from '/runtime/engine.js';
const engine = await boot(canvas, gameModule.default, { width: 800, height: 600, baseUrl });
```

`boot(canvas, game, opts) → Promise<Engine>`. It resolves after `game.load()` finishes, at which point the
engine has already posted `webgame:ready`. It rejects when start-up fails, for example when WebGL2 is
missing or `load()` throws. In that case it shows an overlay and posts `webgame:error` first.

| option | default | meaning |
|---|---|---|
| `width`, `height` | — | logical resolution (game units) |
| `baseUrl` | page dir | bundle file URL; asset paths resolve against it |
| `fit` | `"window"` | `"window"` letterboxes into the viewport (aspect kept, centered), `"parent"` fits the parent element, `"none"` leaves CSS sizing to you |
| `maxPixelRatio` | `3` | cap on devicePixelRatio for the HiDPI backing store |
| `smooth` | `false` | default texture filtering (`false` = crisp pixel art) |
| `background` | `#000` | auto-clear color each frame (`renderer.background = null` disables) |
| `storageKey` | baseUrl | namespace for `engine.storage`. Studio boots (`baseUrl` "about:blank" or `files` given) without it derive `studio:id:<hash of game.json id/title>`, else `studio:paths:<hash of file paths>`, so projects do not share saves (`deriveStorageKey()` is exported) |
| `pauseOverlay` | `true` | draw "PAUSED" while the host has paused the game |
| `files` | — | in-memory bundle: `{ [bundlePath]: Blob \| ArrayBuffer \| ArrayBufferView \| string }` (see below) |
| `debug` | `false` | start with the debug overlay visible |
| `actions` | `[]` | the game.json `actions` list (F009), parsed leniently; see [Actions and remapping](#actions-and-remapping-f009) |

### In-memory files (`files`)

The studio player uses this option because there the bundle is not served over HTTP. Keys are bundle-relative
paths such as `"assets/ship.png"`; `./`, a leading `/`, `..` segments and query strings are normalized.
**Every** loader (`loadTexture`, `loadSpriteSheet`, `loadSound`, `loadJSON`, `loadText`, `loadBinary`,
`loadFont`) looks the path up there first and only falls back to fetching `baseUrl + path`.
* **Values:** a `Blob`, an `ArrayBuffer` (or typed array), or a string (text content, or a `data:` URL). They are decoded inside the iframe with the MIME type of the file extension.
* **URLs:** `assets.url(path)` returns a `blob:` object URL for an in-memory file (handy for `new Image()` or CSS). `engine.destroy()` revokes these URLs.
* **Access:** `engine.files` (`BundleFiles`: `has(path)`, `paths()`, `blob(path)`, `objectUrl(path)`) exposes the map.

## Engine instance

| member | description |
|---|---|
| `width`, `height` | logical resolution |
| `time` | simulated seconds (advances only while running) |
| `frame` | number of fixed update steps run |
| `dt` | fixed step (1/60) |
| `fps`, `pixelRatio` | measured fps; device pixels per game unit |
| `paused`, `pause()`, `resume()` | the author's own pause, separate from host or visibility pause |
| `after(sec, fn)`, `every(sec, fn)` | game-time timers → `{ cancel() }` |
| `camera` | shortcut for `renderer.camera` |
| `game` | your (instantiated) game object |
| `debug` | show the debug overlay (**F3** also toggles it) |
| `debugStats` | `{ fps, frameMs, workMs, drawCalls, sprites, tweens, particles, bodies }`, updated every frame |
| `files` | the in-memory bundle files (`boot` option `files`) |
| `captureFrame({ maxSize? })` | PNG Blob of the next frame, or `null` (see Screenshots) |
| `renderer`, `assets`, `input`, `audio`, `scenes`, `tweens`, `storage`, `platform`, `random` | systems (below) |
| `ui` | immediate-mode widgets: `panel`, `label`, `button` (see [UI widgets](#ui-widgets-f012)) |
| `Vec2`, `Rect`, `Color`, `Random`, `Tilemap`, `Physics`, `Body`, `ParticleEmitter`, `Tween`, `Easing`, `SpriteSheet`, `Animation`, `Texture`, `Sound`, `Camera`, `GamepadButtons`, `NineSlice` | classes and constants |
| `math` | `clamp, lerp, invLerp, remap, approach, wrap, degToRad, radToDeg, damp, circlesOverlap, circleRectOverlap` |

**Each frame, in order:** each fixed step runs `game.update` → top scene(s) `update` → tweens → timers →
camera shake. Then a render pass clears to `background` and runs `game.render` → scenes `render` (bottom to top)
→ the `engine.ui` layer (screen space) → batch flush → screenshot capture point → F3 debug overlay → host "PAUSED" overlay.

**Automatic behavior:**
* **Visibility:** the game pauses while the tab or iframe is hidden.
* **Audio unlock:** audio is unlocked on the first pointer or key gesture.
* **Host messages:** the engine handles `webgame:pause`, `webgame:resume`, `webgame:mute {muted}`, `webgame:screenshot-request {requestId}` and `webgame:controls {overrides, gamepad?}` from the parent window.
* **Crashes:** if `update` or `render` throws, the loop stops, an error overlay appears, and `webgame:error` is posted. Uncaught errors and rejections are also posted.

## Debug overlay

Press **F3** (or set `engine.debug = true`) to toggle the overlay. The engine draws it in screen space, at the
top left, with its own text renderer (the `mono` font). It shows:
* FPS and the smoothed frame time, plus the CPU time spent in update and render
* draw calls and sprites in the current frame
* active tweens, particles and physics bodies

Where the numbers come from:
* The renderer counts draw calls and `drawSprite` calls per frame. The running counts are in `renderer.counter`, and the last frame's totals are in `renderer.stats`.
* Particles and bodies are summed over every `ParticleEmitter` updated or drawn, and every `Physics` world stepped, since the previous frame. You don't need to register anything.
* The overlay's own geometry is not counted.

## `engine.renderer`

A batched WebGL2 sprite renderer. It uses one dynamic vertex buffer and premultiplied alpha.
* **Atlas packing:** small pixel-art textures are packed into shared 2048² atlas pages, so most sprites batch into a single draw call.
* **Shape batching:** every atlas page has a white texel, so shapes batch together with sprites.
* **Text:** a canvas-generated font atlas with mipmaps. Glyphs are rasterized lazily, so any Unicode character works.
  **Bitmap fonts** (F012) are drawn from their pages, which are ordinary textures: nearest-filtered pages are atlas-packed
  and batch with sprites. See [Text and fonts](#text-and-fonts-f012).

| method | notes |
|---|---|
| `clear(color)` | |
| `drawSprite(tex \| sheet, x, y, { w, h, scale, rotation, originX, originY, frame, flipX, flipY, tint, alpha })` | origin is a 0..1 fraction of the size (default top-left), and `(x, y)` is where the origin lands |
| `drawRect(x, y, w, h, color, { outline?, alpha? })` / `strokeRect(x, y, w, h, color, thickness)` | |
| `drawLine(x1, y1, x2, y2, color, thickness = 1)` | |
| `drawCircle(x, y, r, color, { outline?, segments?, alpha? })` | |
| `drawTriangle(...)`, `drawPolygon([x0, y0, ...], color)` | polygons must be convex |
| `drawText(text, x, y, { size = 16, color, align: left\|center\|right, baseline: top\|middle\|bottom, font, alpha, shadow, shadowOffset, letterSpacing, lineHeight, maxWidth })` | `\n` and word-wrap are supported |
| `measureText(text, opts) → { width, height }` | with a bitmap font, `size` defaults to its native size |
| `setFont(name, cssFamily, weight)` | built-in fonts: `"default"` (bold sans), `"mono"` and the bitmap `"pixel"`; `pixel` can't be replaced |
| `addBitmapFont(name, font)` / `hasFont(name)` | register a `BitmapFont`; `default`, `mono`, `pixel` are reserved (`font name "…" is reserved`) |
| `drawNineSlice(nineSlice \| texture, x, y, w, h, { insets?, scale = 1, tint, alpha, center = true })` | corners keep their size × `scale`; one sprite in the stats |
| `setBlend('normal' \| 'additive' \| 'multiply')` | |
| `ui(fn)` / `setCamera(bool)` | draw in screen space (HUD) without the camera |
| `camera` | `x, y` (view top-left at zoom 1), `zoom` (around the view center), `bounds`, `roundPixels`, `shake(intensity, duration)`, `follow(x, y, smoothing)`, `centerOn(x, y)`, `view()`, `screenToWorld(x, y)`, `worldToScreen(x, y)` |
| `background`, `defaultSmooth`, `stats { drawCalls, sprites }`, `createTexture(source, opts)` | |

Colors (`ColorLike`) can be any of:
* a `Color`
* a string: `"#rgb"`, `"#rrggbbaa"`, `"rgb()"`/`"rgba()"`, or a named color
* a number: `0xRRGGBB`
* an array: `[r, g, b, a?]` with values from 0 to 1

## `engine.assets`

Paths are relative to the bundle's `baseUrl`. Loads are cached, and `assets.progress` (0..1) drives the built-in loading bar.

* **Load from the bundle:**
  * `loadTexture(path, { smooth?, atlas? }) → Texture` (`{ width, height, sub(x, y, w, h) }`)
  * `loadSpriteSheet(path, frameW, frameH, { spacing?, margin?, smooth? }) → SpriteSheet` (`{ count, cols, rows, frame(i) }`)
  * `loadSound(path) → Sound` (`.duration`)
  * `loadJSON(path)`, `loadText(path)`, `loadBinary(path)`
  * `loadFont(name, path, weight?)`: registers a woff2 or ttf font for `drawText({ font: name })`
  * `loadBitmapFont(name, path, { smooth? }) → BitmapFont`: an AngelCode BMFont (`.fnt` text or `.json`) and its pages
  * `loadNineSlice(path, insets, { smooth?, atlas? }) → NineSlice`
* **Procedural textures:**
  * `createTexture(w, h, (ctx2d, w, h) => {...}, opts) → Texture`
  * `textureFrom(canvasOrImage, opts)`
  * `spriteSheet(texture, frameW, frameH)`
  * `gridFont(name, texture, { cellW, cellH, chars, spacing?, margin?, advance?, lineHeight? }) → BitmapFont` (synchronous)
* `Animation(frames[], fps, loop)` is a frame helper: call `.update(dt)`, then read `.frame` and `.finished`.

## `engine.input`

Keys use `KeyboardEvent.code` (`"ArrowLeft"`, `"KeyA"`, `"Space"`). Mouse buttons are `"Mouse0"`, `"Mouse1"` and `"Mouse2"`.
`pressed` and `released` are true for **exactly one fixed step**, and a quick tap between two steps is still seen.

* `isDown(code)`, `wasPressed(code)`, `wasReleased(code)`, `anyPressed()`
* `mouse { x, y, down, pressed, released, rightDown, rightPressed, wheel, inside }`, in **game coordinates**. Letterboxing and HiDPI are already accounted for. For world coordinates, use `camera.screenToWorld`. The primary touch also drives `mouse`.
* `touches: { id, x, y, startX, startY, pressed, released }[]`
* `gamepad(i)` returns:
  * `connected`, `axes`, `leftX`, `leftY`, `rightX`, `rightY`
  * `isDown(b)`, `wasPressed(b)`, `wasReleased(b)`, where `b` is an index or a name: `A B X Y LB RB LT RT Back Start LS RS Up Down Left Right Home` (type `GamepadButtonKey`)
* `axis('horizontal' | 'vertical')` returns -1..1 from the arrow keys, WASD, or the first gamepad (left stick with a deadzone, plus the d-pad). With movement actions it follows them instead (see below)
* `actions`, `defaultActions`, `actionDown/actionPressed/actionReleased(id)`, `actionLabel(id, device?)`, `keyLabel(code)`, `gamepadLabel(name)`, `lastDevice`: see [Actions and remapping](#actions-and-remapping-f009)
* `typed`: printable characters typed this step
* `textEvents`: this step's typing for text entry (F019), in order and frozen: `{ kind: "text", text }` (typed or pasted,
  filtered) and `{ kind: "key", key }` for `Backspace`/`Delete`/`ArrowLeft`/`ArrowRight`/`Home`/`End`. At most 64 per step.
  `[]` when there are none. See [Settings and text entry](#settings-and-text-entry-f019)
* `keyboardCaptured` (read-only): `true` while a `ui.textField` is editing. Actions and `axis()` then ignore keyboard keys

## Actions and remapping (F009)

Contract: docs/GAME_FORMAT.md § F009 and § F016. Declare every control your game uses as a named **action** in game.json.
Players see them in the player's ⌨ controls panel and can remap the keys (up to 3 per action) and, since F016, the
gamepad buttons (up to 2 per action); the change reaches the running game at once through `webgame:controls`.

```json
"actions": [
  { "id": "left",  "name": "Move left",  "keys": ["ArrowLeft", "KeyA"], "gamepad": ["Left"] },
  { "id": "right", "name": "Move right", "keys": ["ArrowRight", "KeyD"], "gamepad": ["Right"] },
  { "id": "jump",  "name": "Jump",       "keys": ["Space", "ArrowUp", "KeyW"], "gamepad": ["A"] },
  { "id": "fire",  "name": "Fire",       "keys": ["Mouse0", "KeyZ"] }
],
"controls": "Mouse aims. Remap keys with ⌨."
```

* `id` matches `^[a-z0-9_-]{1,32}$` (unique); `name` is 1–40 chars; `keys` are up to 3 codes from the bindable table
  (`BINDABLE_KEYS`: letters, digits, numpad, arrows, Space/Enter/Backspace, Shift/Ctrl/Alt, punctuation, Insert/Delete/Home/End/PageUp/PageDown,
  `Mouse0..2`; **not** Escape, Tab, F-keys, Meta, CapsLock…); `gamepad` is up to 2 of `GAMEPAD_BUTTON_NAMES` (no `Home`).
  At most 32 actions; each needs a key or a button. The backend rejects a bad list with a 422; the engine itself parses
  the `actions` boot option leniently and drops bad entries with a `[pixelforge] actions:` warning.
* `controls` (free text, ≤ 300 chars) is shown next to the action list. Use it for what actions can't say (mouse aim, touch).

```js
update(engine) {
  const input = engine.input;
  if (input.actionPressed('jump')) jump();          // up → down this step
  if (input.actionDown('fire')) fire();             // held
  if (input.actionReleased('jump')) cutJump();      // down → up this step
  const dx = input.axis('horizontal');              // follows "left"/"right" when both are declared
},
render(engine) {
  engine.renderer.drawText(`Press ${engine.input.actionLabel('jump')} to start`, 10, 10); // "Press Space" / "Press K" after a remap
}
```

* `input.actions`: effective bindings (defaults plus the player's overrides), manifest order, frozen. `input.defaultActions`: as declared.
* `actionDown(id)` = any bound key or gamepad button (first connected pad) is held.
* **Edges are per action**, once per fixed step: `actionPressed` fires when the action goes from up to down, so pressing a
  second bound key while the first is held does **not** fire it again; `actionReleased` fires when the last bound input
  is let go (releasing one of two held keys does not). A tap within one step reports both `pressed` and `released`, like raw keys.
* `actionLabel(id)`: the label of the first effective key, else of the first gamepad button, else `""`. Labels come from the
  US-layout table (`keyLabel(code)`, also exported): the platform never tells games the player's keyboard layout, so an AZERTY
  player's default `KeyW` is "W" in-game (the panel shows "Z").
* `gamepadLabel(name)`: the default label of a gamepad button name (`"A"` → `A`, `"Up"` → `D-pad ↑`; an unknown name returns
  itself), also exported. With `keyLabel` it lets a game list every binding of an action, e.g.
  `a.keys.map((k) => input.keyLabel(k))` and `a.gamepad.map((b) => input.gamepadLabel(b))` for each `a` of `input.actions` (see ember-garden's pause screen).
* Unknown ids return `false` / `""` and warn once per id.
* **`axis()`**: when both `left` and `right` actions exist, `axis('horizontal')` uses them plus the left stick, and the built-in
  Arrows/WASD/d-pad no longer apply; likewise `axis('vertical')` with `up`/`down`. With only one of the pair, `axis` is unchanged.
* Overrides apply at the next fixed step. Button state is kept per code, so a key held during a remap is never stuck.
* Keys bound to an action get `preventDefault()` on keydown (unless Ctrl or Meta is held), so `Slash` or `Quote` won't open
  the browser's quick find.
* **Read actions, not codes.** `isDown/wasPressed/wasReleased(code)`, `mouse`, `touches`, `gamepad(i)`, `anyPressed()` and
  `typed` still report the physical input and ignore remapping (useful for text entry and debug keys). A game that declares
  actions but checks `wasPressed('Space')` can't be remapped.
### Gamepad remapping, device-aware prompts and the resume latch (F016)

* **Gamepad buttons are remappable.** The parent's `webgame:controls` message may carry `gamepad: { [actionId]: GamepadButtonName[] }`;
  each value replaces that action's buttons (valid names only, no `Home`, de-duplicated, first 2; `[]` = no buttons, keys still apply).
  Every message replaces both the key and the gamepad overrides, so a message without `gamepad` restores the gamepad defaults.
  A `gamepad` field that is present but not a plain object with at most 32 keys makes the engine ignore the whole message.
  `input.actions` shows both kinds of override; `input.defaultActions` is unchanged.
* So **read actions, not buttons**: `input.actionPressed('jump')`, never `input.gamepad(0).wasPressed('A')`, for anything
  you declared. `gamepad(i)` keeps reporting the physical buttons and ignores remapping, like raw keys.
* `input.lastDevice`: `"keyboard"` (initial), `"mouse"`, `"touch"` or `"gamepad"`, the kind of device the player pressed last.
  A non-repeat keydown, a mouse button, a touch / pen contact, or (checked at the start of each fixed step) a gamepad button
  edge or a stick axis crossing 0.5. Mouse movement, the wheel, key repeat and cancelled releases don't change it; a gamepad
  edge wins over DOM events that arrived before the same step.
* `input.actionLabel(id, device?)`: without `device`, as above. `"keyboard"`: the first key (mouse codes included) or `""`.
  `"gamepad"`: the first gamepad button or `""`. `"auto"`: the gamepad button when `lastDevice === "gamepad"` and the action has
  one, otherwise the no-argument label. Use `"auto"` in prompts:

```js
render(engine) {
  // "Press Space" for keyboard players; "Press A" (or the remapped button) once they touch a controller.
  engine.renderer.drawText(`Press ${engine.input.actionLabel('jump', 'auto')} to start`, 10, 10);
}
```

* **Resume latch:** on host `webgame:resume` and on window `focus`, the engine latches every gamepad (`input.latchGamepads()`).
  A button held at that moment, such as the one the player just captured in the controls panel, reports `isDown` and
  `actionDown` but not `wasPressed` / `actionPressed`; letting go reports `wasReleased` as usual, and the next press fires.
* Menus built with `engine.ui` (F012) keep their fixed gamepad D-pad / `A` / `B` navigation fallbacks, so a remap can never
  lock a player out of a menu.

* The dev harness (`index.html`, `studio.html`) has a ⌨ button with a small remapping panel that sends `webgame:controls`
  (persisted in localStorage on `index.html`, in memory on `studio.html`).

## `engine.audio`

* `play(sound, { volume, loop, pitch, pan }) → { stop(), setVolume(v), playing }`
  * Before the audio unlock, one-shot sounds are dropped. Looping sounds start once audio unlocks.
* `masterVolume` (0..1+), `muted`, `stopAll()`, `unlocked`
* Built-in sound-effect synth, so you need no asset files:
  * `tone({ freq, freqEnd, duration, type, volume, attack, vibrato, vibratoRate })`
  * `noise({ duration, volume, filterStart, filterEnd })`
  * `createSound(seconds, (t, i) => sample)`

## `engine.scenes`

A scene has the same shape as a game: `load` (may be async), `update`, `render`. It can also have `enter`, `exit`, `pause`, `resume`, plus two flags:
* `overlay: true`: the scene below keeps rendering.
* `updateBelow: true`: the scene below keeps updating.

`push(scene | SceneClass)`, `pop()`, `replace(scene)` and `clear()` all return promises and run in order. Other members: `current`, `size`, and `engine.setScene(s)`.

## Utilities

| | |
|---|---|
| `Vec2` | `add/sub/mul/scale` return new vectors (`addSelf/subSelf/scaleSelf` mutate). Also `dot, cross, length, lengthSq, distance, normalize, limit, angle, rotate, perp, lerp, equals`, plus the statics `fromAngle`, `distance`, `from` |
| `Rect` | `x, y, w, h`, `left/right/top/bottom/centerX/centerY`, `intersects` (strict AABB), `intersection`, `contains`, `containsRect`, `inflate`, statics `intersects`, `separation` (MTV), `fromCenter` |
| `Color` | `Color.from/hex/rgb/hsl/parse`, `lerp`, `withAlpha`, `scale`, `toHex`, `toCSS`, constants `WHITE BLACK ...` |
| `Random` | seedable: `next, range, int (inclusive), chance, sign, pick, shuffle, angle`. `engine.random` is a shared instance |
| `Tween`, `Easing` | `engine.tweens.to(obj, { x: 100 }, 0.5, { ease: 'backOut', delay, repeat, yoyo, onStart, onUpdate, onComplete })` → tween with `.finished` (Promise) and `.stop(jumpToEnd)`. Easing names: `linear`, `quad/cubic/quart/sine/expo/back/elastic/bounce` + `In/Out/InOut`. Also `tweens.killTweensOf(obj)` |
| `Tilemap` | see below |
| `Physics`, `Body` | see below |
| `ParticleEmitter` | see below |

### `Tilemap`

* **Creating:**
  * `Tilemap.fromArray(rowsOfNumbersOrStrings, tileW, tileH?, legend?)`: string rows use `legend` to map characters to ids. `.` or unknown characters mean 0 (empty).
  * `Tilemap.fromJSON(json)`: Pixelforge `{ cols, rows, tileW, tileH, data, solid?, oneWay? }`, or a Tiled map (first tile layer).
* **Collision setup:**
  * Tile id `0` is empty. By default every non-zero tile is solid; change this with `setSolid(ids)`.
  * `setOneWay(ids)` makes jump-through tiles.
  * `solidBounds.{ left, right, top, bottom }` makes the map edges solid.
* **Queries:** `get/set(col, row)`, `getAt(x, y)`, `colAt`, `rowAt`, `tileRect`, `tileCenter`, `isSolid`, `isOneWay`, `isSolidAt`, `tileRange(rect)`, `solidTilesIn(rect)`, `overlapsSolid(rect)`, `forEach`, `find(id)`, `replace(from, to)`, `fill`, `pixelWidth/Height`, `bounds`.
* **Drawing:** `draw(renderer, spriteSheet | (id, x, y, col, row) => void)` culls to the camera view. With a sheet, tile id N draws frame N-1.

### `Physics`

Arcade AABB physics.
* **World:** `new engine.Physics({ gravity: 900 | { x, y }, tilemap })`, then `world.add(bodyOrOptions)`, `remove`, `step(dt)`, `query(rect, tag?)`, `overlaps(a, b)`.
* **Body properties:**

  | group | properties |
  |---|---|
  | geometry and motion | `x, y, w, h, vx, vy, ax, ay` |
  | body type | `isStatic` (give it velocity for a **kinematic** moving platform), `oneWay`, `sensor` |
  | movement tuning | `gravityScale`, `bounce`, `dragX/Y`, `maxSpeedX/Y` |
  | metadata | `tag`, `data`, `enabled`, `ignoreOneWay` |

* **Collision results:**
  * `touching { left, right, top, bottom }`, `onGround`, `ground` (the static body underneath)
  * `prevX/prevY`, `lerpPos(alpha)`
  * `onCollide(other, side)`
* **Resolution:**
  * Dynamic bodies collide with tilemap tiles and static bodies. Movement is per axis, with substeps that prevent tunneling.
  * Moving platforms carry their riders.
  * Dynamic-vs-dynamic contacts are not resolved. Use `overlaps`/`query` for those (enemies, pickups).

### `ParticleEmitter`

`new engine.ParticleEmitter(config)`, then call `update(dt)` and `draw(renderer)` yourself. Other methods: `burst(n, x?, y?)` (alias `emit`), `emitting`, `count`, `clear()`.

`config` options:
* **Emission:** `x, y, spawnW, spawnH, rate, maxParticles`
* **Motion:** `life, speed, angle, gravityX, gravityY, drag, spin`. Values written as ranges take `[min, max]`.
* **Appearance:** `size, sizeEnd, color` (a single color or an array to pick from), `colorEnd, shape: 'square' | 'circle'`, `texture`, `frame`, `blend: 'additive'`

## `engine.storage`

* `get(key, fallback?)`, `set(key, value)` (any JSON value), `remove(key)`, `snapshot()` (the full object).
* **Handshake:** at the start of `boot` the engine posts `{ type: 'webgame:hello' }` to the parent and waits
  up to 500 ms for `{ type: 'webgame:load', data }` (accepted only from `window.parent`). An object `data`
  seeds storage **before** `game.load()`, so saved values are there from the first read; `null` or a
  non-object is ignored. On timeout, or with no parent (`window.parent === window`), boot just continues.
  A later `webgame:load` is still accepted and merged in.
* **Saving:** every `set`/`remove` posts `{ type: 'webgame:save', data: <full storage object> }`, debounced
  by 250 ms (flushed on `pagehide` and `destroy()`). The parent persists it (max 256 KB; the engine warns
  above that).
* **In the sandbox** values live only in memory plus the parent's copy. Where `localStorage` is
  available (a non-sandboxed page), it is used as well.

## `engine.platform`

| call | posts to `window.parent` |
|---|---|
| `submitScore(n)` | `{ type: 'webgame:score', score: n, requestId: 'sc-<n>' }` (non-finite values are ignored). Returns `Promise<ScoreResultView \| null>`, see [Leaderboards](#leaderboards-f001) |
| `getLeaderboard(opts?)` | `{ type: 'webgame:leaderboard-get', requestId: 'lb-<n>', period, limit }`. Returns `Promise<LeaderboardView \| null>` |
| `ready()` | `{ type: 'webgame:ready' }` (called automatically after `load`) |
| `error(message)` | `{ type: 'webgame:error', message }` (also posted automatically on crashes) |
| `requestFullscreen()` | `{ type: 'webgame:fullscreen' }` (the parent fullscreens its player wrapper) |
| `unlockAchievement(id)` | `{ type: 'webgame:achievement', id }`, posted once per id per session; returns `true` if posted. Ids must match `/^[a-z0-9_-]{1,32}$/`; invalid ids are warned about and ignored. Related: `isUnlocked(id)`, and `achievements` (ids unlocked this session) |
| *(boot)* | `{ type: 'webgame:hello' }`, the storage handshake |
| `storage.set/remove` | `{ type: 'webgame:save', data }`, debounced |

Messages accepted from the parent (only when `event.source === window.parent`):
* `webgame:pause`
* `webgame:resume`
* `webgame:mute { muted }`
* `webgame:load { data }`, the handshake reply (a later one is merged in)
* `webgame:leaderboard { requestId, leaderboard, error? }` and `webgame:score-result { requestId, result, error? }`,
  the replies to the two requests below (unknown `requestId`s are ignored)

## Leaderboards (F001)

Optional `game.json` block (all keys optional; checked on upload and by `scripts/pack-examples.mjs`):
```json
"leaderboard": { "order": "asc", "format": "time", "label": "Best time" }
```
`order` is `"desc"` (higher is better, default) or `"asc"`; `format` is `"number"` (default) or `"time"`
(integer milliseconds, shown as `m:ss.mmm`); `label` is at most 24 characters.

```js
// game over
const result = await engine.platform.submitScore(score);       // posts immediately
if (result?.personalBest) showNewBest(result.ranks);              // { day, week, all }
const board = await engine.platform.getLeaderboard({ period: 'week', limit: 5 });
if (board) for (const e of board.entries) draw(e.rank, e.name, e.display, e.isMe);
```

* `getLeaderboard({ period?: 'day' | 'week' | 'all' = 'all', limit?: number = 10 })`: `limit` is rounded and
  clamped to 1–25. It resolves `null` when there is no parent window, on an invalid period (warned), on a reply
  carrying `error`, after `LEADERBOARD_TIMEOUT_MS` (5000 ms), or when `MAX_PENDING_LEADERBOARD` (4) requests
  are already pending (warned).
* `submitScore(n)` still posts synchronously; the promise resolves with the parent's `ScoreResultView`
  (`{ score, display, rank, personalBest, ranks: { day, week, all } }`), or `null` on `error` (e.g. anonymous
  player, Studio preview), without a parent, or after `SCORE_RESULT_TIMEOUT_MS` (8000 ms). Ignoring the
  return value is fine.
* `LeaderboardView` is `{ period, order, format, label, totalPlayers, entries: [{ rank, name, score, display, isMe }], me: { rank, score, display } | null, sample? }`.
  `me` is null for anonymous players or when they have no score in the period; `sample: true` marks the
  Studio preview's fake data. The view is sanitised by the parent: no user ids, avatars or tokens.
* Destroying the engine resolves every pending request with `null`. Always handle `null`: older hosts never
  reply.
* The types `LeaderboardPeriod`, `LeaderboardView`, `ScoreResultView` and `PlatformReply` are exported.
* The dev harness (`index.html`) and `studio.html` answer with sample boards so the UI can be tested locally.

## Achievements

Declare them in `game.json` and unlock them from the game:

```json
"achievements": [
  { "id": "first_blood", "name": "First Blood", "description": "Destroy your first asteroid", "icon": "assets/ach_first.png" }
]
```
```js
engine.platform.unlockAchievement('first_blood'); // safe to call every frame: posted once per session
```
The backend checks these rules on upload, and so does `scripts/pack-examples.mjs`:
* at most 50 achievements
* `id` matches `^[a-z0-9_-]{1,32}$` and is unique
* `name` is 1–60 characters
* `description` is at most 200 characters
* `icon` is optional; if given, it must be a bundle-relative image that exists in the bundle

The platform records the unlock for logged-in players and shows a toast. To stay compatible with v1 engines,
guard the call: `engine.platform.unlockAchievement?.(id)`.

## Screenshots (F005)

Contract: docs/GAME_FORMAT.md § F005. There are three entry points, and all of them capture the **next rendered frame**:

| entry point | who starts it | where the image goes |
|---|---|---|
| 📷 in the player bar (`webgame:screenshot-request`) | the player / host | the engine replies `webgame:screenshot` (`source: "player"`) to the parent's tray |
| `engine.platform.shareScreenshot({ caption? })` → `Promise<boolean>` | the game | offered to the player's tray (`source: "game"`); `true` when the parent accepted it |
| `engine.captureFrame({ maxSize? })` → `Promise<Blob \| null>` | the game | an `image/png` Blob for the game itself; nothing is posted |

```js
// e.g. after a personal best: the player decides whether to post it
if (input.wasPressed('KeyP')) engine.platform.shareScreenshot?.({ caption: `Score ${score}` });
```

* **Output size** doesn't depend on the window or `devicePixelRatio`. For the logical `w×h`, `k = max(1, floor(1280 / max(w, h)))`
  gives `(w·k)×(h·k)` (small games are upscaled by a whole factor). It is then scaled by `max(min(1, maxSize / long), 64 / short)`
  (`maxSize` default 1920, rounded and clamped to 64–4096), so the short side is never below 64 even if the long side
  then exceeds `maxSize`; sides are clamped to 64–4096. 4096×128 → 2048×64, 64×4096 → 64×4096. Examples: 320×180 → 1280×720, 800×600 → 800×600, 3840×2160 → 1920×1080.
  `screenshotSize(w, h, maxSize?)` is exported.
* **Sampling**: nearest-neighbour when the backing-store → output ratio is a whole number and `smooth` is off, bilinear otherwise.
  A small window therefore gives a softer image at the same size.
* **What is captured**: everything the game and its scenes draw, including your own HUD. The capture point is after the
  batch flush and before the engine's overlays, so the F3 debug overlay, the host "PAUSED" overlay and the error overlay
  are never in the image. To hide your HUD for a "photo mode", skip drawing it in the frame where you call `shareScreenshot`
  (see pixel-peaks).
* **One at a time**: only one capture (from any entry point) is queued or encoding. Another call meanwhile fails fast:
  `captureFrame` → `null` with a warning, a player request → `error: "busy"`, a share → `false`.
* **Failures**: `null` / `false` / `unavailable` when the engine isn't running (loading, crashed, destroyed) or no frame
  arrives within 2000 ms (hidden tab). `failed` for a lost context, an encoder or security error, or a PNG over 8 MiB.
* **Shares** need a parent window, must be at least 3000 ms apart (earlier calls → `false` + a warning), and resolve `false`
  on `accepted: false`, an error or no reply within 5000 ms. The caption is coerced to a string, control and bidi
  characters are removed, and it is cut to 140 code points. The parent only adds the image to the tray: nothing is
  uploaded or downloaded without the player clicking.
* `destroy()` resolves pending captures with `null` and pending shares with `false`.
* **Never draw secrets** (codes, tokens, private data) in frames you pass to `shareScreenshot`: the player can post the image publicly.
* Encoding uses `OffscreenCanvas.convertToBlob` (or `<canvas>.toBlob`) after the frame; the drawing buffer is copied with
  `drawImage` at the capture point (`gl.readPixels` is a fallback), so the context keeps `preserveDrawingBuffer: false`.
* The dev harness (`index.html`) and `studio.html` have a 📷 button and an in-memory tray, and they answer game shares,
  re-encoding every image in the parent as the real host does.

## Text and fonts (F012)

Contract: docs/GAME_FORMAT.md § F012. `drawText`/`measureText` take a `font` name; canvas fonts and bitmap fonts share
one registry.

```js
r.drawText('SCORE ' + score, 4, 4, { font: 'pixel' });            // built-in, crisp 8 px, no asset
r.drawText('SCORE ' + score, 4, 4, { font: 'pixel', size: 16 });  // exactly 2×
await engine.assets.loadBitmapFont('title', 'assets/title.fnt');  // + assets/title_0.png
r.drawText('GAME OVER', W / 2, 80, { font: 'title', align: 'center' });
engine.assets.gridFont('retro', sheetTexture, { cellW: 8, cellH: 8, chars: ' !"#0123456789ABC…' });
```

* **`pixel`**: ASCII 32–126, `size` 8, `lineHeight` 10, `base` 7, every glyph advances 6. Capitals use rows 0–6 of the
  line, descenders rows 7–8. Any other character draws as `?`. Its texture is built on first use (an `ImageData`, no canvas
  text) and shares an atlas page with sprites. **Glyph source**: hand-drawn for Pixelforge and dedicated to the public
  domain (CC0); the table is `PIXEL_GLYPHS` in `src/pixelfont.ts`.
* **Crispness rule**: a nearest-filtered bitmap font (the default) has each line's start x and top rounded to whole game
  units, so at whole multiples of its native size (`pixel`: 8, 16, 24…) every texel is a whole pixel. Other sizes work but
  may shimmer. Canvas fonts (`default`, `mono`, `loadFont`) stay best for large smooth text.
* **Bitmap layout**: `size` defaults to the font's native size, the line height is `lineHeight × scale × (opts.lineHeight ?? 1)`,
  BMFont kerning and `letterSpacing` apply between glyphs, `maxWidth` wraps at spaces, `\r\n` is one newline, other control
  characters are skipped, missing glyphs draw `?` (or advance `size / 2`) with one warning per font, and `shadow` is a
  second pass. `layoutText(font, text, opts)` (exported) is the pure layout behind both `drawText` and `measureText`.
* **Recommended exporter settings** (BMFont, Hiero, Snowb, Littera…): a **text or JSON** descriptor (XML is rejected with
  `BMFont XML is not supported; export the text or JSON format`), **PNG pages**, **no channel packing**. Limits: descriptor
  ≤ 1 MiB, 1–16 pages, ≤ 8192 chars, ≤ 65536 kernings, numbers within −32768..32767. Pages resolve relative to the
  descriptor and must stay inside the bundle. Errors start with `BMFont "{path}": `; warnings with `[pixelforge] font "{name}":`.
  Distance-field fonts are drawn as plain bitmaps (with a warning). `smooth: true` loads the pages with linear filtering
  and without atlas packing.
* `BitmapFont` is read-only: `name`, `face`, `size`, `lineHeight`, `base`, `pages`, `smooth`, `glyph(cp)`, `kerning(a, b)`,
  `has(char)`. `parseBMFont(source, path?)` is exported for tools.

### 9-slice

```js
const frame = await engine.assets.loadNineSlice('assets/ui/frame.png', 8); // or new engine.NineSlice(texture, { left, top, right, bottom })
r.drawNineSlice(frame, 140, 70, 200, 120);              // a dialog
r.drawNineSlice(frame, 195, 150, 90, 24, { scale: 2 }); // crisp 2× pixel-art borders
```

Insets are source pixels (integers ≥ 0, `left + right ≤ width`, `top + bottom ≤ height`, else `RangeError`). When the box
is smaller than its borders, they shrink proportionally and the centre is omitted. `center: false` draws the frame only.
A `Texture` with `opts.insets` works too; a texture without insets is one stretched quad. A sprite-sheet frame is a valid
texture. `scale` must be > 0 (anything else draws at 1).

## UI widgets (F012)

`engine.ui` is an immediate-mode helper. **Call widgets from `update`** (the game's or a scene's): each fixed step builds a
draw list, and the engine draws the last step's list in screen space (camera ignored, `normal` blend) after your render and
**before** the screenshot capture point, so 📷 captures include menus (the F3 and PAUSED overlays are still excluded).

```js
update(engine) {
  const ui = engine.ui;
  if (ui.button('play', 'PLAY', 190, 140, 100, 24)) this.start();
  if (ui.button('sound', `SOUND: ${engine.audio.muted ? 'OFF' : 'ON'}`, 190, 170, 100, 24)) engine.audio.muted = !engine.audio.muted;
  if (this.playing && ui.button('pause', 'II', 4, 4, 16, 16, { nav: false })) this.paused = true; // a HUD button
}
```

* `ui.panel(x, y, w, h, { style?, color?, alpha? })`: `theme.panel` as a 9-slice at `theme.nineSliceScale`, or a flat rect
  with a 1-unit border.
* `ui.label(text, x, y, textOptions)`: `drawText` with the theme's font, size and colour as defaults.
* `ui.button(id, label, x, y, w, h, { disabled?, nav?, font?, textSize?, textColor? }) → boolean`: `true` exactly once per
  activation, in the step it happens. Ids are 1–64 characters and unique within a step (otherwise one warning, and that
  button never activates). States: normal, hover, down and disabled (alpha 0.5, `disabledTextColor`, never reacts).
* **Pointer** (mouse and primary touch): a press and a release on the same button activate it; a press that started
  elsewhere never does. `ui.hot` / `ui.active` are the button under the pointer / being pressed (read-only).
* **Keyboard and gamepad**: "next" is action `down`/`right` if declared, else `ArrowDown`/`ArrowRight`, plus D-pad
  Down/Right; "previous" likewise with `up`/`left`; "activate" is action `confirm` if declared, else `Enter`,
  `NumpadEnter`, `Space`, plus gamepad A; `Escape` / gamepad B clear the focus. Declared actions follow the player's ⌨
  remapping. `Tab` is never used. The order is the enabled `nav !== false` buttons of the previous step, and it wraps.
  The focus ring (2 units of `theme.focusColor`, 2 units outside the button) appears on the first navigation press, a
  pointer press hides it again, and `ui.focus = id` shows it. `ui.navigation = false` turns navigation off.
* **`{ nav: false }`** for buttons shown during gameplay, so arrows and `confirm` keep controlling the game.
* **Phases**: a widget called from `render` draws immediately, and a `button` there returns `false` (one warning per id).
  From `load` or other code outside a step, widgets draw nothing. `panel`/`label` are fine in `render` as drawing helpers.
* **Drawing**: a step's list replaces the previous one (even when empty); with no step in a frame (paused, high refresh
  rate) the last list is drawn again. At most 256 commands per step. `ui.autoDraw = false` turns the automatic layer off;
  `ui.draw()` (from `render`) draws the list at that point, once per frame, and skips the automatic layer.
* **Theme** (`ui.theme`; assign fields to restyle): `font` `"default"`, `textSize` `null` (= the font's default), `textColor`
  `#ffffff`, `disabledTextColor` `#8b91b0`, `panel` / `button` / `buttonHover` / `buttonDown` (`NineSlice | null`),
  `panelColor` `#141a2e`, `panelBorder` `#3a4470`, `buttonColor` `#2a3358`, `buttonHoverColor` `#3a4780`,
  `buttonDownColor` `#1e2540`, `buttonBorder` `#5a6bc0`, `focusColor` `#ffd166`, `nineSliceScale` 1.
* `Ui` takes its input and renderer in the constructor (`new Ui({ input, renderer, warn })`), so its rules are unit-tested
  without a DOM.

### Settings and text entry (F019)

Four more widgets follow the same theme, phase, id and navigation rules. They are **value in, value out**: keep the value
in your own state, pass it every step and store what comes back. The engine keeps only interaction state (drag, list
cursor and scroll, caret), and it drops that state at the end of any step that doesn't declare the id.

```js
update(engine) {
  const ui = engine.ui, s = this.settings;
  ui.label('VOLUME', 80, 84);
  s.volume = ui.slider('vol', s.volume, 150, 80, 160, 12, { step: 0.05 });
  if (ui.changed('vol')) engine.audio.masterVolume = s.volume;
  if (ui.committed('vol')) this.save();                       // once per drag, or per key step
  s.shake = ui.toggle('shake', s.shake, 'SCREEN SHAKE', 80, 104, 230, 14);
  s.name = ui.textField('name', s.name, 150, 124, 160, 16, { maxLength: 12, allow: (c) => /[A-Za-z0-9 _-]/.test(c) });
  if (ui.committed('name')) this.save();
  const i = ui.list('levels', this.names, 80, 150, 230, 80, { selected: this.level });
  if (i >= 0) this.level = i;
}
```

* `ui.slider(id, value, x, y, w, h, { min = 0, max = 1, step = 0, keyStep, disabled, nav }) → number`: the result is
  clamped and, with `step > 0`, snapped (`toFixed(10)`, so `0.1 + 0.2` gives `0.3`). A non-finite value counts as `min`.
  Dragging follows the pointer even outside the rect until release. When focused, left/right add or subtract `keyStep`
  (default `step`, or `(max - min) / 20`). A bad range draws the slider disabled and warns once.
* `ui.toggle(id, on, label, x, y, w, h, opts) → boolean`: the label is on the left and the switch is right-aligned. It
  flips on a click (button rules) or on activate.
* `ui.textField(id, text, x, y, w, h, { maxLength = 24, placeholder, allow, … }) → string`: to start editing, click it,
  activate it, type while it is focused (`Space` then types a space) or set `ui.editing = id`. `Enter`, `confirm` or pad A
  submit, and so do up/down, which also move focus, and a click elsewhere. `Escape` or pad B revert to the text you had
  when editing started. The caret is solid. Paste works. There is no selection, undo, IME or on-screen keyboard.
* `ui.list(id, items, x, y, w, h, { rowHeight = 16, selected = -1, … }) → number`: returns the index activated this step,
  else `-1`. A click on a row activates it. A drag over 4 units scrolls instead and never activates. The wheel scrolls
  whole rows. Long rows end in `...`, and a 3-unit scrollbar shows when the items overflow. At most 1000 items are used.
* `ui.changed(id)`: the player changed the value this step. `ui.committed(id)`: the player finished a change, which is
  the end of a drag, a key step, a flip, a submit or a picked row. Both are `false` before the widget's call in the step,
  and clamping the game's own value is never a change. `ui.listCursor(id)` returns a list's cursor, or `-1`.
  `ui.editing` (read/write) is the field being edited.
* **Navigation by focused widget**:

  | Focused | left / right | up / down | activate | Escape / B |
  |---|---|---|---|---|
  | none, button, toggle | focus | focus | activate / flip | clear focus |
  | slider | −/+ `keyStep` (hold repeats) | focus | nothing | clear focus |
  | list | focus | cursor (hold repeats); a fresh press past an end leaves | pick the cursor row | clear focus |
  | text field | focus | focus | start editing | clear focus |
  | text field, editing | caret (raw arrows) | commit + focus | commit | revert |

  Hold repeat waits 0.4 s, then repeats every 0.08 s of step time. Moving focus never repeats.
* **Keyboard capture**: while a field edits, `input.keyboardCaptured` is `true` from the next step on. Actions and
  `axis()` then ignore keyboard keys, so typing "wasd" never moves the player. Gamepad and mouse bindings still count. An
  action held only by keys reports `actionReleased` once, and keys still held when editing ends count only after they are
  released. Raw `isDown`/`wasPressed`/`typed` are unchanged, so if you read them for gameplay, check `ui.editing`. Text typed
  while the game is paused is discarded on resume.
* **Touch and controller players** can focus a field but can't type into it. Offer a fallback, for example preset names in
  a `ui.list`. Typed text is game data, not the player's platform name: it stays in the sandboxed game unless you store it
  with `engine.storage`, and the platform never shows it to other players.
* **New theme fields**: `trackColor` `#0e1224`, `fillColor` `#5a6bc0`, `knobColor` `#ffffff`, `fieldColor` `#0e1224`,
  `fieldBorder` `#5a6bc0`, `caretColor` `#ffd166`, `placeholderColor` `#5d6488`, `rowHoverColor` `#2a3358`,
  `rowSelectedColor` `#3a4780`, and `track` / `knob` / `field` (`NineSlice | null`).
* The pure helpers `filterText`, `applyTextEvents`, `visibleRun`, `caretFromX` and `truncateToWidth` are exported for
  tools and tests.

## Examples

* `examples/space-dodge`: a neon arcade shooter. It uses procedural textures, additive particles, screen shake, power-ups, the synth SFX and a stored high score.
* `examples/pixel-peaks`: a 3-level pixel-art platformer. It uses `Tilemap` and `Physics` (one-way and moving platforms), scenes, a sprite sheet, tweens, touch buttons, and levels loaded from `assets/levels.json`.
  F012: its HUD uses the `pixel` font, titles and banners use the kerned, outlined BMFont `assets/fonts/peaks.fnt`, the
  title is an `engine.ui` menu, and message boxes are a 9-slice (`assets/ui/panel.png`). The font and the panel are
  generated by `node packages/engine/scripts/gen-bitmap-font.mjs` from the `pixel` glyph table.

* `examples/ember-garden`: a top-down night arena (keep the lanterns lit, net the moths). It shows the newer features together:
  10 game.json actions with keyboard and gamepad defaults (`input.axis`, `actionPressed/Down`), HUD hints and a pause-screen
  binding table built from `input.actions` with `keyLabel`/`gamepadLabel`; an italic BMFont (`assets/fonts/ember.fnt`) and
  9-slice panel and button skins driving `engine.ui` menus (title, pause, settings, game over, leaderboard) for mouse,
  keyboard and gamepad; `submitScore`'s rank/personal-best view and a `getLeaderboard` screen with day/week/all tabs;
  a game-over "Share screenshot" button (`shareScreenshot` with a sanitised caption, buttons hidden for the captured frame,
  cooldown and failure messages); 5 achievements with icons; `engine.storage` for the best score, unlocked settings,
  settings and the last leaderboard tab; and `Tilemap`, top-down `Physics`, circle collisions, particles, tweens, camera
  shake and the synth. Its font, 9-slices and badges are generated by `node packages/engine/scripts/gen-ember-assets.mjs`.
* `examples/overclock`: a fast top-down one-hit-kill action game (a rogue maintenance drone clears a server facility of
  sentry robots). Four hand-authored floors in `assets/floors.json` (walls, cover, swing doors, guards and patrols) become a
  `Tilemap` with top-down `Physics`; circle collisions for blows, nails, scatter pellets and door leaves; BFS-field sentry
  navigation with line of sight, view cones and gunfire noise; an instant one-press floor reboot on death; a combo
  multiplier, style/variety/speed bonuses and a letter grade per floor. It also shows: 11 game.json actions with keyboard,
  mouse-button and gamepad defaults, twin-stick aim (mouse cursor or right stick) and live binding labels on the HUD and
  pause screen; a BMFont (`assets/fonts/overclock.fnt`) and 9-slice skins driving `engine.ui` menus (title, floor select,
  settings, pause, floor results, run end, leaderboard); `submitScore` at the end of a run with the score-result view and a
  day/week/all leaderboard; "Share screenshot" on the floor results and run-end screens; 6 achievements with icons;
  `engine.storage` for unlocked floors, best grade and score per floor, best run and settings; additive muzzle flashes and
  sparks, debris and smoke particles, tweens, camera follow with bounds, shake and a short hit-stop. Its font, 9-slices and
  badges are generated by `node packages/engine/scripts/gen-overclock-assets.mjs`.
* `examples/brick-breaker`: a six-level neon brick breaker with levels loaded from `assets/levels.json`. It has tough, steel and explosive bricks; six power-ups (wide paddle, multi-ball, slow ball, lasers, catch, extra life); combo multipliers; tweened level intros; and achievement badge icons in `assets/`.
* `examples/kiln-clash`: a one-on-one versus fighting game (pottery golems from a mountain kiln town). Four fighters
  (all-rounder, grappler, rushdown, zoner) are drawn procedurally from a pose skeleton (arms by joint angles, legs by
  two-bone IK), and every move's frame data, hit/hurt boxes, cancels and animation keys live in `assets/fighters.json`.
  A fixed 60 Hz simulation handles walking, jumps, dashes, high/low blocking with overheads and lows, throws with a
  tech window and an untechable 360 command throw, motion and charge specials read from a lenient input buffer
  (quarter circle, dragon punch, half circle, 360, charge back-forward and down-up), supers with a freeze, hitstop,
  combos with damage scaling, a juggle limit, chip damage, knockdown/wakeup and corner push; rounds are best of 3 on a
  99-second timer with KO, time-over, double KO and draw handling. It has an arcade ladder (4 CPU fights, score
  submitted once per run), local 2-player versus (split keyboard through two sets of game.json actions, plus gamepad 2
  read with `input.gamepad(1)`), and a training room (dummy modes, infinite health and meter, input display, frame
  advantage, hit/hurt boxes). The CPU has 3 levels and sees its opponent only through a reaction-delayed snapshot. It
  also shows 20 game.json actions with live labels on the HUD, pause table and move list; a BMFont and 9-slice skins
  for every menu; `submitScore` with the score-result view and day/week/all leaderboard; "Share screenshot" on the
  match result and arcade results; 6 achievements with icons; and `engine.storage` for unlocks, per-fighter wins, best
  score, settings and training options. Its font, 9-slices and badges are generated by
  `node packages/engine/scripts/gen-kiln-assets.mjs`.

All six declare their keys as game.json `actions` and read them with the action API (F009); space-dodge,
pixel-peaks, ember-garden, overclock and kiln-clash show the effective key labels on screen.
All six games call `engine.platform.submitScore` on game over (overclock: at the end of a run; kiln-clash: at the end of an arcade run) and keep their best score in `engine.storage`.
Each declares achievements in game.json: brick-breaker, overclock and kiln-clash have 6 (with icons), ember-garden 5 (with icons), the other two have 3 each.

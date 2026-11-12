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
| `storageKey` | baseUrl | namespace for `engine.storage` |
| `pauseOverlay` | `true` | draw "PAUSED" while the host has paused the game |

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
| `renderer`, `assets`, `input`, `audio`, `scenes`, `tweens`, `storage`, `platform`, `random` | systems (below) |
| `Vec2`, `Rect`, `Color`, `Random`, `Tilemap`, `Physics`, `Body`, `ParticleEmitter`, `Tween`, `Easing`, `SpriteSheet`, `Animation`, `Texture`, `Sound`, `Camera`, `GamepadButtons` | classes and constants |
| `math` | `clamp, lerp, invLerp, remap, approach, wrap, degToRad, radToDeg, damp, circlesOverlap, circleRectOverlap` |

**Each frame, in order:** each fixed step runs `game.update` → top scene(s) `update` → tweens → timers →
camera shake. Then a render pass clears to `background` and runs `game.render` → scenes `render` (bottom to top).

**Automatic behavior:**
* **Visibility:** the game pauses while the tab or iframe is hidden.
* **Audio unlock:** audio is unlocked on the first pointer or key gesture.
* **Host messages:** the engine handles `webgame:pause`, `webgame:resume` and `webgame:mute {muted}` from the parent window.
* **Crashes:** if `update` or `render` throws, the loop stops, an error overlay appears, and `webgame:error` is posted. Uncaught errors and rejections are also posted.

## `engine.renderer`

A batched WebGL2 sprite renderer. It uses one dynamic vertex buffer and premultiplied alpha.
* **Atlas packing:** small pixel-art textures are packed into shared 2048² atlas pages, so most sprites batch into a single draw call.
* **Shape batching:** every atlas page has a white texel, so shapes batch together with sprites.
* **Text:** a canvas-generated font atlas with mipmaps. Glyphs are rasterized lazily, so any Unicode character works.

| method | notes |
|---|---|
| `clear(color)` | |
| `drawSprite(tex \| sheet, x, y, { w, h, scale, rotation, originX, originY, frame, flipX, flipY, tint, alpha })` | origin is a 0..1 fraction of the size (default top-left), and `(x, y)` is where the origin lands |
| `drawRect(x, y, w, h, color, { outline?, alpha? })` / `strokeRect(x, y, w, h, color, thickness)` | |
| `drawLine(x1, y1, x2, y2, color, thickness = 1)` | |
| `drawCircle(x, y, r, color, { outline?, segments?, alpha? })` | |
| `drawTriangle(...)`, `drawPolygon([x0, y0, ...], color)` | polygons must be convex |
| `drawText(text, x, y, { size = 16, color, align: left\|center\|right, baseline: top\|middle\|bottom, font, alpha, shadow, shadowOffset, letterSpacing, lineHeight, maxWidth })` | `\n` and word-wrap are supported |
| `measureText(text, opts) → { width, height }` | |
| `setFont(name, cssFamily, weight)` | built-in fonts: `"default"` (bold sans) and `"mono"` |
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
* **Procedural textures:**
  * `createTexture(w, h, (ctx2d, w, h) => {...}, opts) → Texture`
  * `textureFrom(canvasOrImage, opts)`
  * `spriteSheet(texture, frameW, frameH)`
* `Animation(frames[], fps, loop)` is a frame helper: call `.update(dt)`, then read `.frame` and `.finished`.

## `engine.input`

Keys use `KeyboardEvent.code` (`"ArrowLeft"`, `"KeyA"`, `"Space"`). Mouse buttons are `"Mouse0"`, `"Mouse1"` and `"Mouse2"`.
`pressed` and `released` are true for **exactly one fixed step**, and a quick tap between two steps is still seen.

* `isDown(code)`, `wasPressed(code)`, `wasReleased(code)`, `anyPressed()`
* `mouse { x, y, down, pressed, released, rightDown, rightPressed, wheel, inside }`, in **game coordinates**. Letterboxing and HiDPI are already accounted for. For world coordinates, use `camera.screenToWorld`. The primary touch also drives `mouse`.
* `touches: { id, x, y, startX, startY, pressed, released }[]`
* `gamepad(i)` returns:
  * `connected`, `axes`, `leftX`, `leftY`, `rightX`, `rightY`
  * `isDown(b)`, `wasPressed(b)`, `wasReleased(b)`, where `b` is an index or a name: `A B X Y LB RB LT RT Back Start LS RS Up Down Left Right Home`
* `axis('horizontal' | 'vertical')` returns -1..1 from the arrow keys, WASD, or the first gamepad (left stick with a deadzone, plus the d-pad)
* `typed`: printable characters typed this step

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
| `submitScore(n)` | `{ type: 'webgame:score', score: n }` (non-finite values are ignored) |
| `ready()` | `{ type: 'webgame:ready' }` (called automatically after `load`) |
| `error(message)` | `{ type: 'webgame:error', message }` (also posted automatically on crashes) |
| `requestFullscreen()` | `{ type: 'webgame:fullscreen' }` (the parent fullscreens its player wrapper) |
| *(boot)* | `{ type: 'webgame:hello' }`, the storage handshake |
| `storage.set/remove` | `{ type: 'webgame:save', data }`, debounced |

Messages accepted from the parent (only when `event.source === window.parent`):
* `webgame:pause`
* `webgame:resume`
* `webgame:mute { muted }`
* `webgame:load { data }`, the handshake reply (a later one is merged in)

## Examples

* `examples/space-dodge`: a neon arcade shooter. It uses procedural textures, additive particles, screen shake, power-ups, the synth SFX and a stored high score.
* `examples/pixel-peaks`: a 3-level pixel-art platformer. It uses `Tilemap` and `Physics` (one-way and moving platforms), scenes, a sprite sheet, tweens, touch buttons, and levels loaded from `assets/levels.json`.

Both games call `engine.platform.submitScore` on game over.

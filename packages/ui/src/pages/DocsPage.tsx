import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/auth";
import { useDocumentTitle } from "../util";

const GAME_JSON = `{
  "name": "Space Dodge",
  "entry": "main.js",
  "width": 800,
  "height": 600,
  "engine": "1"
}`;

const MAIN_JS = `export default {
  async load(engine) {
    this.ship = await engine.assets.loadTexture("assets/ship.png");
    this.boom = await engine.assets.loadSound("assets/boom.wav");
    this.pos = new engine.Vec2(400, 500);
    this.score = 0;
  },

  update(engine, dt) {               // fixed 60 Hz steps, dt in seconds
    this.pos.x += engine.input.axis("horizontal") * 300 * dt;
    this.score += dt * 10;
    if (engine.input.wasPressed("Space")) engine.audio.play(this.boom);
    if (this.score > 100) engine.platform.submitScore(Math.floor(this.score));
  },

  render(engine, alpha) {
    const r = engine.renderer;
    r.clear("#0b0d1a");
    r.drawSprite(this.ship, this.pos.x, this.pos.y, { originX: 0.5, originY: 0.5 });
    r.drawText("Score " + Math.floor(this.score), 16, 16, { size: 20, color: "#fff" });
  },
};`;

const ACH_JSON = `"achievements": [
  { "id": "first_blood", "name": "First Blood",
    "description": "Destroy your first asteroid", "icon": "assets/ach_first.png" }
]`;

const LB_JSON = `"leaderboard": { "order": "asc", "format": "time", "label": "Best time" }`;

const LB_JS = `const result = await engine.platform.submitScore(timeMs);
if (result?.personalBest) this.banner = "NEW BEST! #" + result.ranks.day + " today";

const board = await engine.platform.getLeaderboard({ period: "week", limit: 5 });
if (board) this.rows = board.entries.map((e) => (e.isMe ? "> " : "") + e.rank + ". " + e.name + "  " + e.display);`;

const FONT_JS = `async load(engine) {
  // A BMFont export: assets/title.fnt (text or JSON format) next to its PNG page(s).
  await engine.assets.loadBitmapFont("title", "assets/title.fnt");
  // Or a plain grid of glyphs in one image, in cell order.
  const sheet = await engine.assets.loadTexture("assets/digits.png");
  engine.assets.gridFont("digits", sheet, { cellW: 8, cellH: 8, chars: "0123456789" });
},
render(engine) {
  const r = engine.renderer;
  r.drawText("PIXEL PEAKS", engine.width / 2, 40, { font: "title", size: 32, align: "center" });
  r.drawText("SCORE " + this.score, 4, 4, { font: "pixel", size: 8 });   // built in, always there
}`;

const NINESLICE_JS = `// A frame image whose 6 px borders must not stretch.
this.frame = await engine.assets.loadNineSlice("assets/frame.png", 6);
// ...or build one from any texture: new engine.NineSlice(texture, { left: 4, top: 4, right: 4, bottom: 6 })

engine.renderer.drawNineSlice(this.frame, 20, 20, 200, 80, { scale: 2 });   // corners stay crisp`;

const MENU_JS = `load(engine) {
  engine.ui.theme.font = "pixel";
  engine.ui.theme.textSize = 8;
  engine.ui.theme.button = this.frame;          // optional NineSlice styles; flat colours otherwise
},
update(engine, dt) {
  const { ui } = engine;                         // call widgets from update, not render
  if (this.state === "title") {
    ui.panel(140, 90, 200, 96);
    if (ui.button("play", "PLAY", 160, 104, 160, 20)) this.state = "play";
    if (ui.button("help", "HOW TO PLAY", 160, 130, 160, 20)) this.state = "help";
  } else if (this.state === "play") {
    // A HUD button during play: nav: false keeps the arrows and confirm for the game.
    if (ui.button("pause", "II", engine.width - 22, 4, 18, 14, { nav: false })) this.state = "paused";
    this.step(engine, dt);
  }
}`;

const ACTIONS_JSON = `"controls": "Aim with the mouse. Remap keys with ⌨.",
"actions": [
  { "id": "left",  "name": "Move left",  "keys": ["ArrowLeft", "KeyA"], "gamepad": ["Left"] },
  { "id": "right", "name": "Move right", "keys": ["ArrowRight", "KeyD"], "gamepad": ["Right"] },
  { "id": "jump",  "name": "Jump",       "keys": ["Space", "ArrowUp", "KeyW"], "gamepad": ["A"] },
  { "id": "fire",  "name": "Fire",       "keys": ["Mouse0", "KeyZ"] }
]`;

const ACTIONS_JS = `update(engine, dt) {
  const { input } = engine;
  this.x += input.axis("horizontal") * 200 * dt;   // follows "left" / "right"
  if (input.actionPressed("jump")) this.jump();
  if (input.actionDown("fire")) this.fire();
},
render(engine) {
  engine.renderer.drawText("Press " + engine.input.actionLabel("jump") + " to start", 20, 20);
}`;

const SETTINGS_JS = `update(engine) {
  const { ui, audio, storage } = engine;
  const s = this.settings;                       // your own state: widgets take a value and return the new one
  ui.label("VOLUME", 40, 82);
  s.volume = ui.slider("vol", s.volume, 120, 80, 160, 12, { step: 0.1 });
  ui.label(Math.round(s.volume * 100) + "%", 320, 82, { align: "right" });
  if (ui.changed("vol")) audio.masterVolume = s.volume;   // live while dragging
  if (ui.committed("vol")) storage.set("settings", s);    // saved once, when the drag ends

  s.shake = ui.toggle("shake", s.shake, "SCREEN SHAKE", 40, 100, 240, 14);

  s.name = ui.textField("name", s.name, 120, 120, 160, 16, {
    maxLength: 12, placeholder: "PLAYER", allow: (ch) => /^[A-Za-z0-9 _-]$/.test(ch),
  });
  if (ui.committed("name")) storage.set("settings", s);   // Enter, or leaving the field

  const i = ui.list("level", this.levelNames, 40, 144, 240, 64, { selected: s.level });
  if (i >= 0) s.level = i;                       // the row the player picked, else -1
}`;

const OSK_JS = `// You draw your own name picker for controllers: no on-screen keyboard for this field.
s.name = ui.textField("name", s.name, 120, 120, 160, 16, { keyboard: "never" });

// Move the score up while the keyboard covers the bottom of the screen.
const k = engine.ui.keyboardRect;               // { x, y, w, h } in game units, or null
const scoreY = k && k.y > 0 ? k.y - 20 : engine.height - 20;`;

const ACTIONS_AUTO_JS = `render(engine) {
  const { input } = engine;
  // "Press Space" for keyboard players, "Press A" (or their remapped button) after they touch a controller.
  engine.renderer.drawText("Press " + input.actionLabel("jump", "auto") + " to start", 20, 20);
  if (input.lastDevice === "touch") engine.renderer.drawText("Tap to start", 20, 40);
}`;

/**
 * The numbered sections, in order: the single source for the "On this page" list and the headings (review 5, L4),
 * so the two can't drift apart.
 */
export const DOCS_SECTIONS: readonly { id: string; title: string }[] = [
  { id: "bundle-layout", title: "Bundle layout" },
  { id: "game-json", title: "game.json" },
  { id: "game-module", title: "The game module" },
  { id: "engine-api", title: "Engine API at a glance" },
  { id: "scores", title: "Scores & leaderboards" },
  { id: "achievements", title: "Achievements" },
  { id: "save-data", title: "Save data" },
  { id: "debug-overlay", title: "Debug overlay" },
  { id: "game-studio", title: "Game Studio" },
  { id: "limits", title: "Limits & rules" },
  { id: "followers", title: "Your players can follow you" },
  { id: "tags", title: "Publishing: tags & discovery" },
  { id: "release-notes", title: "Release notes" },
  { id: "screenshots", title: "Screenshots" },
  { id: "actions", title: "Actions and remapping" },
  { id: "text-fonts-menus", title: "Text, fonts and menus" },
];

/** DOM id of the heading of section `n` (1-based). */
export const docsSectionId = (n: number) => `docs-${DOCS_SECTIONS[n - 1].id}`;

function DocsHeading({ n }: { n: number }) {
  return (
    <h2 id={docsSectionId(n)} tabIndex={-1} className="pf-docs__heading">
      {n}. {DOCS_SECTIONS[n - 1].title}
    </h2>
  );
}

/**
 * In-page navigation that works under BrowserRouter and HashRouter alike: scroll to and focus the heading instead of
 * changing `location.hash` (which a HashRouter would treat as a route).
 */
function jumpTo(e: MouseEvent<HTMLAnchorElement>, id: string) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  el.focus({ preventScroll: true });
}

function Code({ children, label }: { children: string; label: string }) {
  return (
    <figure className="pf-code">
      <figcaption>{label}</figcaption>
      <pre>
        <code>{children}</code>
      </pre>
    </figure>
  );
}

export function DocsPage() {
  const { user } = useAuth();
  useDocumentTitle("Make a game");
  return (
    <div className="pf-container pf-page pf-docs">
      <header className="pf-pagehead">
        <p className="pf-eyebrow">Creator guide</p>
        <h1>Make a game for Pixelforge Arcade</h1>
        <p className="pf-hero__lead">
          Games are small ES modules running on the <strong>Pixelforge</strong> WebGL2 engine. You write three functions, zip the
          folder, and upload. No build tools or dependencies required.
        </p>
      </header>

      <nav className="pf-docs__toc pf-panel" aria-label="On this page">
        <strong>On this page</strong>
        <ol>
          {DOCS_SECTIONS.map((sec, i) => (
            <li key={sec.id}>
              <a href={`#${docsSectionId(i + 1)}`} onClick={(e) => jumpTo(e, docsSectionId(i + 1))}>
                {sec.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="pf-panel pf-docs__cta">
        <div>
          <h2>Try it right now</h2>
          <p className="pf-muted">
            The <strong>Game Studio</strong> runs in your browser: pick a template, edit the code, see it live, and publish — no
            setup.
          </p>
        </div>
        <Link to="/studio" className="pf-btn pf-btn--primary pf-btn--lg">
          Open the Studio
        </Link>
      </div>

      <section aria-labelledby={docsSectionId(1)}>
        <DocsHeading n={1} />
        <p>
          Upload a <code>.zip</code>. <code>game.json</code> must be at the zip root (or inside a single top-level folder, which is
          stripped).
        </p>
        <Code label="my-game.zip">{`my-game.zip
├─ game.json        required
├─ main.js          entry (ES module)
└─ assets/...       png jpg webp gif svg json txt fnt wav mp3 ogg js css woff2 ttf`}</Code>
      </section>

      <section aria-labelledby={docsSectionId(2)}>
        <DocsHeading n={2} />
        <Code label="game.json">{GAME_JSON}</Code>
        <ul>
          <li>
            <code>entry</code> — relative path to a <code>.js</code> file inside the bundle.
          </li>
          <li>
            <code>width</code>/<code>height</code> — logical resolution, 64–4096. The canvas scales to fit while preserving the aspect
            ratio.
          </li>
        </ul>
      </section>

      <section aria-labelledby={docsSectionId(3)}>
        <DocsHeading n={3} />
        <p>
          The entry module <strong>default-exports</strong> a game object (or a class, which is instantiated with <code>new</code>). You
          import nothing — the <code>engine</code> instance is passed in, and helpers such as <code>engine.Vec2</code> and{" "}
          <code>engine.Color</code> live on it.
        </p>
        <Code label="main.js">{MAIN_JS}</Code>
        <ul>
          <li>
            <code>load(engine)</code> <em>(optional, async)</em> — load assets and set up scenes.
          </li>
          <li>
            <code>update(engine, dt)</code> — game logic at fixed 60 Hz steps; <code>dt</code> in seconds.
          </li>
          <li>
            <code>render(engine, alpha)</code> — draw with <code>engine.renderer</code>.
          </li>
        </ul>
      </section>

      <section aria-labelledby={docsSectionId(4)}>
        <DocsHeading n={4} />
        <div className="pf-docs__grid">
          <div className="pf-panel">
            <h3>renderer</h3>
            <p>
              <code>clear(color)</code>, <code>drawSprite(tex, x, y, {"{w,h,rotation,originX,originY,frame,flipX,tint,alpha}"})</code>,{" "}
              <code>drawRect</code>, <code>drawLine</code>, <code>drawCircle</code>,{" "}
              <code>drawText(text, x, y, {"{font,size,color,align}"})</code> (<code>font: "pixel"</code> is built in),{" "}
              <code>drawNineSlice(src, x, y, w, h)</code>, <code>camera {"{x, y, zoom, shake()}"}</code>. Menus and buttons:{" "}
              <code>engine.ui</code> (see 16)
            </p>
          </div>
          <div className="pf-panel">
            <h3>assets</h3>
            <p>
              <code>loadTexture</code>, <code>loadSpriteSheet(path, frameW, frameH)</code>, <code>loadSound</code>, <code>loadJSON</code>,{" "}
              <code>loadText</code>, <code>loadFont</code>, <code>loadBitmapFont(name, path)</code>, <code>gridFont</code>,{" "}
              <code>loadNineSlice</code>, <code>createTexture(w, h, draw)</code> — paths are relative to your bundle.
            </p>
          </div>
          <div className="pf-panel">
            <h3>input</h3>
            <p>
              <code>isDown(key)</code>, <code>wasPressed</code>, <code>wasReleased</code> (KeyboardEvent.code, e.g. <code>"ArrowLeft"</code>
              , <code>"Space"</code>), <code>mouse</code>, <code>touches</code>, <code>gamepad(i)</code>,{" "}
              <code>axis("horizontal" | "vertical")</code>
            </p>
          </div>
          <div className="pf-panel">
            <h3>actions &amp; remapping</h3>
            <p>
              <code>actionDown(id)</code>, <code>actionPressed</code>, <code>actionReleased</code>, <code>actionLabel(id, device?)</code> for
              prompts, <code>lastDevice</code>, <code>actions</code>. Declared in <code>game.json</code>; players remap them (see 15).
            </p>
          </div>
          <div className="pf-panel">
            <h3>audio</h3>
            <p>
              <code>play(sound, {"{volume, loop, pitch}"})</code> → handle with <code>stop()</code>; <code>masterVolume</code>. Unlocks on
              the first user gesture.
            </p>
          </div>
          <div className="pf-panel">
            <h3>scenes &amp; utilities</h3>
            <p>
              <code>scenes.push/pop/replace</code>, <code>Vec2</code>, <code>Color</code>, <code>Rect</code>, <code>Tilemap</code>,{" "}
              <code>random</code>, <code>Tween</code>, <code>Physics</code>, <code>ParticleEmitter</code>
            </p>
          </div>
          <div className="pf-panel">
            <h3>state</h3>
            <p>
              <code>engine.width</code>, <code>height</code>, <code>time</code>, <code>frame</code>; <code>storage.get/set</code> for
              per-game save data.
            </p>
          </div>
          <div className="pf-panel">
            <h3>screenshots</h3>
            <p>
              <code>engine.captureFrame({"{maxSize}"})</code> → PNG Blob or null; <code>engine.platform.shareScreenshot({"{caption}"})</code>{" "}
              → offers the frame to the player (see 14).
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby={docsSectionId(5)}>
        <DocsHeading n={5} />
        <p>
          Call <code>engine.platform.submitScore(n)</code> to post a score. If the player is logged in, Pixelforge Arcade saves it
          to the game's leaderboard (best score per player), with <strong>Today</strong>, <strong>This week</strong> (ISO week,
          Monday 00:00 UTC) and <strong>All time</strong> boards. The engine reports <code>ready</code> automatically after{" "}
          <code>load</code>, which counts a play. The arcade may pause/resume your game when the tab is hidden and toggle mute.
        </p>
        <h3>Score semantics in game.json</h3>
        <Code label="game.json">{LB_JSON}</Code>
        <ul>
          <li>
            <code>order</code> — <code>"desc"</code> (higher is better, default) or <code>"asc"</code> (lower is better, e.g. times).
          </li>
          <li>
            <code>format</code> — <code>"number"</code> (default) or <code>"time"</code>: the score is whole milliseconds (0 to
            86,400,000) and shows as <code>1:23.456</code> (or <code>h:mm:ss.mmm</code> from one hour).
          </li>
          <li>
            <code>label</code> <em>(optional)</em> — the score column name, up to 24 characters.
          </li>
          <li>Every key is optional; a wrong type or value is rejected on upload.</li>
        </ul>
        <h3>Submit result</h3>
        <p>
          <code>submitScore(n)</code> still posts immediately, and now returns a promise. It resolves with{" "}
          <code>{"{ score, display, rank, personalBest, ranks: { day, week, all } }"}</code>, or <code>null</code> when the
          player is logged out, offline, rate-limited or in the Studio preview (after at most 8 seconds). Code that ignores the
          return value keeps working.
        </p>
        <h3>Reading the leaderboard in-game</h3>
        <Code label="main.js">{LB_JS}</Code>
        <ul>
          <li>
            <code>getLeaderboard({"{ period, limit }"})</code> — <code>period</code> is <code>"day"</code>, <code>"week"</code> or{" "}
            <code>"all"</code> (default); <code>limit</code> 1–25 (default 10).
          </li>
          <li>
            It resolves with <code>{"{ period, order, format, label, totalPlayers, entries, me }"}</code>. Each entry has{" "}
            <code>rank</code>, <code>name</code>, <code>score</code>, a formatted <code>display</code> and <code>isMe</code>;{" "}
            <code>me</code> is the player's own best in the period, or <code>null</code>.
          </li>
          <li>
            It resolves <code>null</code> when unavailable (timeout after 5 seconds, no arcade page, too many pending requests), so
            always handle <code>null</code>. Results are cached for a few seconds.
          </li>
          <li>In the Studio preview it returns sample data (“Player 1”…“Player 5”) that follows your order and format.</li>
        </ul>
      </section>

      <section aria-labelledby={docsSectionId(6)}>
        <DocsHeading n={6} />
        <p>
          Declare up to 50 achievements in <code>game.json</code>, then unlock them from code. Logged-in players earn them on
          their profile, and every game page shows how many players unlocked each one.
        </p>
        <Code label="game.json">{ACH_JSON}</Code>
        <Code label="main.js">{`if (this.kills === 1) engine.platform.unlockAchievement("first_blood");`}</Code>
        <ul>
          <li>
            <code>id</code> — <code>a-z 0-9 _ -</code>, 1–32 chars, unique. <code>name</code> 1–60 chars, <code>description</code> up
            to 200.
          </li>
          <li>
            <code>icon</code> <em>(optional)</em> — an image path inside your bundle.
          </li>
          <li>Calling it again is harmless: the engine de-duplicates per session and the server ignores repeats.</li>
        </ul>
      </section>

      <section aria-labelledby={docsSectionId(7)}>
        <DocsHeading n={7} />
        <p>
          <code>engine.storage.get(key, fallback)</code> / <code>set(key, value)</code> persist JSON values (max 256 KB per game).
          Logged-in players get <strong>cloud saves</strong> that follow them across devices and the desktop app; anonymous
          players keep their data in their browser. Players can wipe it with “Clear save data” under the game.
        </p>
      </section>

      <section aria-labelledby={docsSectionId(8)}>
        <DocsHeading n={8} />
        <p>
          Press <kbd>F3</kbd> while your game has focus (or set <code>engine.debug = true</code>) to toggle an overlay with FPS,
          frame time, draw calls, sprite count and active tweens, particles and physics bodies.
        </p>
      </section>

      <section aria-labelledby={docsSectionId(9)}>
        <DocsHeading n={9} />
        <p>
          The <Link to="/studio">Studio</Link> is a small IDE in the arcade: a file list, a code editor (<kbd>Tab</kbd> indents, <kbd>Esc</kbd> then <kbd>Tab</kbd>{" "}
          leaves the editor, <kbd>Ctrl M</kbd> switches Tab to moving focus, <kbd>Ctrl/⌘ S</kbd> runs), a <code>game.json</code> form with an achievements editor, starter templates and a live preview
          with a console that shows errors with line numbers. Scores and achievements in the preview are only simulated.
        </p>
        <ul>
          <li>Your project autosaves in this browser. Import images and sounds, or open a whole game folder.</li>
          <li>
            Split your code into several modules with relative imports (<code>import {"{ Player }"} from "./player.js"</code>); the
            preview runs them all, and errors link to the right file and line.
          </li>
          <li>
            <strong>Export .zip</strong> downloads a ready-to-upload bundle; <strong>Publish</strong> uploads it straight to the
            arcade (requires an account).
          </li>
        </ul>
        <h3>Updating a published game</h3>
        <p>
          On your game's page or its edit page, <strong>Open in Studio</strong> loads the current version into the Studio (or use{" "}
          <strong>Open → My game…</strong> in the Studio). The project is then <em>linked</em> to that game: a chip shows “Linked to
          {" "}<em>title</em> · v<em>n</em>”, and <strong>Publish</strong> defaults to <strong>Update an existing game</strong>, which replaces
          all of the game's files with your project and creates a new version, with optional release notes. When the project wasn't opened
          from that game, or the game changed since you opened it, you must tick a box to confirm the full replace. Title, description, tags
          and visibility don't change. Lost your source? <strong>Download current bundle</strong> on the edit page gives you the files of the
          current version, and <strong>Open → .zip file…</strong> loads any bundle. In the desktop app, a project opened from a local folder
          has <strong>↻ Reload folder</strong> to re-read it after you edit files on disk; edits made in the Studio are not written back to the
          folder, so export a .zip to keep them.
        </p>
      </section>

      <section aria-labelledby={docsSectionId(10)}>
        <DocsHeading n={10} />
        <ul>
          <li>≤ 50 MB compressed, ≤ 200 MB uncompressed, ≤ 2000 files.</li>
          <li>No absolute paths, no <code>..</code>, no symlinks; only the file types listed above.</li>
          <li>
            Games run in a locked-down sandbox: no cookies, storage, or access to the player's account. Use{" "}
            <code>engine.storage</code> for saves.
          </li>
          <li>A missing or invalid <code>game.json</code> is rejected with a validation error on upload.</li>
        </ul>
      </section>

      <section aria-labelledby={docsSectionId(11)}>
        <DocsHeading n={11} />
        <p>
          Players can follow you from your profile or any of your game pages. Their <Link to="/feed">feed</Link> then shows your
          activity. Nothing extra is needed in your code:
        </p>
        <ul>
          <li>
            <strong>Publishing a game</strong> shows “published {"{game}"}”, once per game, even if you unpublish and re-publish it.
          </li>
          <li>
            <strong>Replacing the bundle</strong> of a published game shows “updated {"{game}"} to v{"{version}"}”, at most once per
            24 hours. Players who favorited the game see it too.
          </li>
          <li>
            <code>engine.platform.submitScore(n)</code>: a new personal best shows to the <em>player's</em> followers, at most one
            item per player, game and UTC day (the best one wins).
          </li>
          <li>
            <code>engine.platform.unlockAchievement(id)</code>: first unlocks show to the player's followers, grouped per day
            (“unlocked Flawless and 2 more”).
          </li>
          <li>Your own scores and unlocks on your own games, and Studio previews, never create feed items.</li>
        </ul>
      </section>

      <section aria-labelledby={docsSectionId(12)}>
        <DocsHeading n={12} />
        <p>
          Tags drive <em>More like this</em>. Use specific tags (<code>platformer</code>, <code>roguelike</code>) over generic ones
          (<code>game</code>, <code>fun</code>); rarer shared tags weigh more. <em>Trending</em> counts distinct players per day over
          the last 7 days; your own plays of your own game never count.
        </p>
      </section>

      <section aria-labelledby={docsSectionId(13)}>
        <DocsHeading n={13} />
        <p>
          When you upload a new bundle (game page → <em>Replace bundle</em>, or the edit page), type what changed in the{" "}
          <em>What's new</em> box. You can add notes to your first upload too, and fix any note later from the game page's{" "}
          <em>Version history</em>. Notes are plain text, up to 1000 characters, with line breaks kept; HTML, Markdown and
          links show as typed. Replacing a bundle drops achievements your new <code>game.json</code> no longer declares, so
          say so in the note.
        </p>
        <p>
          Replacing the bundle of a <strong>published</strong> game puts an <span className="pf-badge pf-badge--updated">Updated</span>{" "}
          badge on its cards for 7 days, and your followers and everyone who favorited the game see the note in their{" "}
          <Link to="/feed">feed</Link> (several updates within 24 hours are grouped, showing up to 3 notes). Editing details,
          publishing a draft or fixing a note doesn't badge the game or notify anyone again.
        </p>
      </section>

      <section aria-labelledby={docsSectionId(14)}>
        <DocsHeading n={14} />
        <p>
          Players can press <strong>📷</strong> under the player at any time. Your game can also offer a moment to the player, or
          grab a frame for its own use:
        </p>
        <Code label="main.js">{`// Offer the next frame to the player's screenshot tray (resolves true when accepted).
if (key === "p") engine.platform.shareScreenshot({ caption: \`Score \${score}\` });

// Or keep a PNG of the next frame for yourself (resolves null when it can't).
const png = await engine.captureFrame({ maxSize: 1280 });`}</Code>
        <ul>
          <li>
            The image is the frame as your game drew it, at a size that follows your <code>game.json</code> resolution (small
            games are scaled up by a whole number, the longest side is at most 1920 by default). The F3 debug overlay and the
            "paused" overlay are never in it.
          </li>
          <li>
            Only one capture runs at a time, and <code>shareScreenshot</code> works at most once every 3 seconds. Nothing is
            posted anywhere until the player clicks <em>Post to game page</em>.
          </li>
          <li>
            Posted screenshots are public, so never draw secrets (codes, tokens) on a frame you pass to{" "}
            <code>shareScreenshot</code>.
          </li>
        </ul>
      </section>

      <section aria-labelledby={docsSectionId(15)}>
        <DocsHeading n={15} />
        <p>
          Declare the keys your game uses as named <strong>actions</strong>. Players see them under <strong>⌨</strong> in the
          player and on your game page, and can remap the keys (up to 3 per action) and the gamepad buttons (up to 2 per
          action). Their changes reach your running game at once. They are saved on their device and, when they are signed
          in, in their account, so they follow them to other devices and the desktop app.
        </p>
        <Code label="game.json">{ACTIONS_JSON}</Code>
        <Code label="main.js">{ACTIONS_JS}</Code>
        <ul>
          <li>
            <code>id</code> is a–z, 0–9, <code>_</code> and <code>-</code> (up to 32 chars); <code>name</code> is 1–40 chars; up to
            3 <code>keys</code> (<code>KeyboardEvent.code</code> values, or <code>Mouse0</code>–<code>Mouse2</code>) and 2{" "}
            <code>gamepad</code> buttons, at least one binding in all. Up to 32 actions. <code>Escape</code>, <code>Tab</code>,
            F-keys and system keys can't be bound. Invalid actions make the upload fail with a message naming the entry.
          </li>
          <li>
            Name movement actions <code>left</code>, <code>right</code>, <code>up</code> and <code>down</code>: <code>axis()</code>{" "}
            then follows the player's bindings.
          </li>
          <li>
            Read actions, not raw codes: <code>isDown("Space")</code> still reports the physical key and ignores remapping. Use{" "}
            <code>actionLabel</code> in prompts so they show the player's key (US-layout names).
          </li>
          <li>
            Gamepad buttons are remappable too: read <code>actionPressed("jump")</code>, not{" "}
            <code>gamepad(0).wasPressed("A")</code>, for everything you declared. Menus built with <code>engine.ui</code> keep
            the fixed D-pad, <code>A</code> and <code>B</code> fallbacks, so a remap can't lock players out.
          </li>
          <li>
            <code>input.lastDevice</code> is <code>"keyboard"</code>, <code>"mouse"</code>, <code>"touch"</code> or{" "}
            <code>"gamepad"</code>: the device the player used last. <code>actionLabel(id, "auto")</code> names the gamepad
            button after they touch a controller and the key otherwise (<code>"keyboard"</code> and <code>"gamepad"</code>{" "}
            force one). A button still held when the game resumes doesn't fire <code>actionPressed</code>.
            <Code label="main.js">{ACTIONS_AUTO_JS}</Code>
          </li>
          <li>
            Keep the free-text <code>"controls"</code> string (up to 300 chars) for what actions can't describe, like mouse aiming
            or touch. It is shown next to the action list.
          </li>
        </ul>
      </section>

      <section aria-labelledby={docsSectionId(16)}>
        <DocsHeading n={16} />
        <p>
          Besides the smooth canvas fonts (<code>default</code>, <code>mono</code> and anything from <code>loadFont</code>), the
          engine draws <strong>bitmap fonts</strong>, stretchable <strong>9-slice</strong> frames and simple{" "}
          <strong>menus and buttons</strong> that work with the mouse, touch, keys and a gamepad. The Studio's{" "}
          <em>Menu &amp; HUD</em> template shows all of it in one small game.
        </p>
        <h3>The built-in pixel font</h3>
        <p>
          <code>{'drawText(text, x, y, { font: "pixel", size: 8 })'}</code> is always available: ASCII only (anything else shows as{" "}
          <code>?</code>), 8 units tall, 6 wide per character. <strong>Crispness rule:</strong> a bitmap font is drawn on whole
          game units, so it stays sharp at whole multiples of its native size (<code>pixel</code>: 8, 16, 24…). Other sizes work
          but may shimmer. Use canvas fonts for large smooth text.
        </p>
        <h3>Your own bitmap fonts</h3>
        <Code label="main.js">{FONT_JS}</Code>
        <ul>
          <li>
            Export from BMFont, Hiero, Snowb or Littera in the <strong>text</strong> (<code>.fnt</code>) or <strong>JSON</strong>{" "}
            format with <strong>PNG pages</strong> and <strong>no channel packing</strong>. XML descriptors are rejected. Page
            files are found next to the descriptor.
          </li>
          <li>
            Fonts are crisp (nearest filtering) by default; pass <code>{"{ smooth: true }"}</code> for a smooth one. Kerning
            pairs are applied. The names <code>default</code>, <code>mono</code> and <code>pixel</code> are reserved.
          </li>
          <li>
            <code>gridFont</code> cuts a fixed-size grid of glyphs (left to right, top to bottom) from any texture, with no
            descriptor needed.
          </li>
        </ul>
        <h3>9-slice frames</h3>
        <Code label="main.js">{NINESLICE_JS}</Code>
        <p>
          The corners are drawn as they are, the edges stretch in one direction and the centre in both, so one small image
          makes panels and buttons of any size. Pass <code>{"{ center: false }"}</code> to draw only the frame.
        </p>
        <h3>Menus and buttons</h3>
        <Code label="main.js">{MENU_JS}</Code>
        <ul>
          <li>
            <strong>Call widgets from <code>update</code></strong> (or a scene's <code>update</code>), every step the menu
            should be visible. <code>ui.button(...)</code> returns <code>true</code> once, in the step it is activated. The
            engine draws the widgets in screen space after your <code>render</code>, so screenshots include them.
          </li>
          <li>
            Players move between buttons with the arrows or the gamepad D-pad and activate them with Enter, Space or{" "}
            <strong>A</strong>. Declare <code>up</code>, <code>down</code> and a <code>confirm</code> action (see 15) to let
            them remap these keys. <code>Tab</code> is never used, so browser focus keeps working.
          </li>
          <li>
            Buttons shown <strong>during play</strong>, like a pause button on the HUD, should pass{" "}
            <code>{"{ nav: false }"}</code>, so the arrow keys and <code>confirm</code> keep controlling the game.
          </li>
          <li>
            Restyle everything through <code>engine.ui.theme</code>: <code>font</code>, <code>textSize</code>, colours, and{" "}
            <code>panel</code>/<code>button</code>/<code>buttonHover</code>/<code>buttonDown</code> 9-slices.
          </li>
        </ul>
        <h3>Settings and text entry (F019)</h3>
        <p>
          Four more widgets complete a settings screen: <code>ui.slider</code>, <code>ui.toggle</code>,{" "}
          <code>ui.textField</code> and <code>ui.list</code>. They are <strong>value in, value out</strong>: keep the value in
          your own state, pass it in every step and store what comes back.
        </p>
        <Code label="main.js">{SETTINGS_JS}</Code>
        <ul>
          <li>
            <code>ui.changed(id)</code> is true in the step the player changed the value; <code>ui.committed(id)</code> when
            they finished (drag released, key step, toggle flip, <code>Enter</code> in a field, row picked). Both are{" "}
            <code>false</code> before the widget&apos;s call in the step. Save on <code>committed</code>, not on every drag
            step.
          </li>
          <li>
            Slider: <code>min</code> (0), <code>max</code> (1), <code>step</code> (0 = continuous),{" "}
            <code>keyStep</code>. Toggle: a label and a switch in one rect. Text field: <code>maxLength</code> (24, up to
            256 code points), <code>placeholder</code>, <code>allow(ch)</code> per character. List: <code>rowHeight</code>{" "}
            (16), <code>selected</code> (the highlighted current row); it scrolls by whole rows with the wheel or a drag
            and returns the activated index, else <code>-1</code>.
          </li>
          <li>
            The theme gains <code>trackColor</code>, <code>fillColor</code>, <code>knobColor</code>,{" "}
            <code>fieldColor</code>, <code>fieldBorder</code>, <code>caretColor</code>, <code>placeholderColor</code>,{" "}
            <code>rowHoverColor</code>, <code>rowSelectedColor</code> and optional <code>track</code>/<code>knob</code>/
            <code>field</code> 9-slices.
          </li>
        </ul>
        <div className="pf-docs__table-wrap" role="region" aria-label="Widget navigation" tabIndex={0}>
          <table className="pf-docs__table">
            <caption>Keys and gamepad, by focused widget</caption>
            <thead>
              <tr>
                <th scope="col">Focused</th>
                <th scope="col">left / right</th>
                <th scope="col">up / down</th>
                <th scope="col">confirm</th>
                <th scope="col">Escape / B</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>button, toggle</td>
                <td>move focus</td>
                <td>move focus</td>
                <td>activate / flip</td>
                <td>clear focus</td>
              </tr>
              <tr>
                <td>slider</td>
                <td>change the value (hold repeats)</td>
                <td>move focus</td>
                <td>nothing</td>
                <td>clear focus</td>
              </tr>
              <tr>
                <td>list</td>
                <td>move focus</td>
                <td>move the cursor (hold repeats); a fresh press past either end leaves the list</td>
                <td>pick the cursor row</td>
                <td>clear focus</td>
              </tr>
              <tr>
                <td>text field</td>
                <td>move focus</td>
                <td>move focus</td>
                <td>start typing</td>
                <td>clear focus</td>
              </tr>
              <tr>
                <td>text field, typing</td>
                <td>the arrow keys move the caret</td>
                <td>save, then move focus</td>
                <td>
                  <code>Enter</code> or gamepad <strong>A</strong>: save
                </td>
                <td>put the old text back</td>
              </tr>
            </tbody>
          </table>
        </div>
        <ul>
          <li>
            <strong>Keyboard capture:</strong> while <code>engine.ui.editing</code> is set, keyboard keys don&apos;t reach
            your actions or <code>axis()</code> (<code>input.keyboardCaptured</code>), so typing a name never moves the
            player. Gamepad and mouse still count. <code>Escape</code> or gamepad <strong>B</strong> puts the old text back.
            If you read raw keys or <code>typed</code> for gameplay, check <code>engine.ui.editing</code> yourself.
          </li>
          <li>
            <strong>Escape in fullscreen:</strong> in the site&apos;s fullscreen mode the browser takes the first{" "}
            <code>Escape</code> to leave fullscreen, so the game never sees it. To cancel an edit, use gamepad{" "}
            <strong>B</strong> or press <code>Escape</code> again. <code>Enter</code>, clicking elsewhere and Up/Down still
            end editing.
          </li>
          <li>
            <strong>Touch and controller players:</strong> an on-screen keyboard opens when they start typing (see below).
          </li>
        </ul>
        <h3>On-screen keyboard (F023)</h3>
        <p>
          Every <code>ui.textField</code> has a built-in on-screen keyboard, set with the <code>keyboard</code> option. With{" "}
          <code>"auto"</code> (the default) it opens when editing starts and <code>input.lastDevice</code> is{" "}
          <code>"touch"</code> or <code>"gamepad"</code>; <code>"always"</code> opens it for every player, and{" "}
          <code>"never"</code> turns it off. It docks at the bottom of the screen (at the top when the field is down there)
          and hides as soon as the player types on a physical keyboard; a tap on the field brings it back. Its keys go only
          to the field: they never reach <code>input.textEvents</code> or your actions.
        </p>
        <div className="pf-docs__table-wrap" role="region" aria-label="On-screen keyboard" tabIndex={0}>
          <table className="pf-docs__table">
            <caption>On-screen keyboard controls</caption>
            <thead>
              <tr>
                <th scope="col">Input</th>
                <th scope="col">Effect</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>D-pad</td>
                <td>move the keyboard cursor (hold repeats)</td>
              </tr>
              <tr>
                <td>A</td>
                <td>press the cursor key</td>
              </tr>
              <tr>
                <td>B</td>
                <td>cancel: put the old text back</td>
              </tr>
              <tr>
                <td>X</td>
                <td>delete (DEL)</td>
              </tr>
              <tr>
                <td>Y</td>
                <td>space</td>
              </tr>
              <tr>
                <td>LB</td>
                <td>shift: capitals or small letters</td>
              </tr>
              <tr>
                <td>Start</td>
                <td>OK: save</td>
              </tr>
              <tr>
                <td>Tap</td>
                <td>press the key under the finger (on release)</td>
              </tr>
            </tbody>
          </table>
        </div>
        <Code label="main.js">{OSK_JS}</Code>
        <ul>
          <li>
            <code>engine.ui.keyboardRect</code> is the panel&apos;s <code>{"{ x, y, w, h }"}</code> in game units, or{" "}
            <code>null</code> when no keyboard is shown. Use it to move HUD elements, and check it if you read raw{" "}
            <code>input.mouse</code> or touches while the player types.
          </li>
          <li>
            Keys that would be rejected (<code>maxLength</code> reached, or <code>allow</code> says no) are dimmed. For small
            pixel-art games, set <code>ui.theme.font = "pixel"</code> so the labels stay crisp.
          </li>
        </ul>
        <p>
          Bundle layout: <code>.fnt</code> files are allowed next to your images (<code>assets/... png jpg webp gif svg json txt
          fnt wav mp3 ogg js css woff2 ttf</code>), and the Studio opens them as text.
        </p>
      </section>

      <div className="pf-panel pf-docs__cta">
        <div>
          <h2>Ready to ship?</h2>
          <p className="pf-muted">Upload as a draft first, play-test it, then flip the publish switch.</p>
        </div>
        <Link to={user ? "/upload" : "/register?next=%2Fupload"} className="pf-btn pf-btn--primary pf-btn--lg">
          {user ? "Upload your game" : "Create an account"}
        </Link>
      </div>
    </div>
  );
}

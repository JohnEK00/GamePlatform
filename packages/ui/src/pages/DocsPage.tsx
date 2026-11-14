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
          <li>Bundle layout</li>
          <li>game.json</li>
          <li>The game module</li>
          <li>Engine API</li>
          <li>Scores &amp; platform</li>
          <li>Achievements</li>
          <li>Save data</li>
          <li>Debug overlay</li>
          <li>Game Studio</li>
          <li>Limits &amp; rules</li>
          <li>Followers &amp; the feed</li>
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

      <section>
        <h2>1. Bundle layout</h2>
        <p>
          Upload a <code>.zip</code>. <code>game.json</code> must be at the zip root (or inside a single top-level folder, which is
          stripped).
        </p>
        <Code label="my-game.zip">{`my-game.zip
├─ game.json        required
├─ main.js          entry (ES module)
└─ assets/...       png jpg webp gif svg json txt wav mp3 ogg js css woff2 ttf`}</Code>
      </section>

      <section>
        <h2>2. game.json</h2>
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

      <section>
        <h2>3. The game module</h2>
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

      <section>
        <h2>4. Engine API at a glance</h2>
        <div className="pf-docs__grid">
          <div className="pf-panel">
            <h3>renderer</h3>
            <p>
              <code>clear(color)</code>, <code>drawSprite(tex, x, y, {"{w,h,rotation,originX,originY,frame,flipX,tint,alpha}"})</code>,{" "}
              <code>drawRect</code>, <code>drawLine</code>, <code>drawCircle</code>, <code>drawText(text, x, y, {"{size,color,align}"})</code>,{" "}
              <code>camera {"{x, y, zoom, shake()}"}</code>
            </p>
          </div>
          <div className="pf-panel">
            <h3>assets</h3>
            <p>
              <code>loadTexture</code>, <code>loadSpriteSheet(path, frameW, frameH)</code>, <code>loadSound</code>, <code>loadJSON</code>,{" "}
              <code>loadText</code> — paths are relative to your bundle.
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
        </div>
      </section>

      <section>
        <h2>5. Scores &amp; leaderboards</h2>
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

      <section>
        <h2>6. Achievements</h2>
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

      <section>
        <h2>7. Save data</h2>
        <p>
          <code>engine.storage.get(key, fallback)</code> / <code>set(key, value)</code> persist JSON values (max 256 KB per game).
          Logged-in players get <strong>cloud saves</strong> that follow them across devices and the desktop app; anonymous
          players keep their data in their browser. Players can wipe it with “Clear save data” under the game.
        </p>
      </section>

      <section>
        <h2>8. Debug overlay</h2>
        <p>
          Press <kbd>F3</kbd> while your game has focus (or set <code>engine.debug = true</code>) to toggle an overlay with FPS,
          frame time, draw calls, sprite count and active tweens, particles and physics bodies.
        </p>
      </section>

      <section>
        <h2>9. Game Studio</h2>
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

      <section>
        <h2>10. Limits &amp; rules</h2>
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

      <section>
        <h2>11. Your players can follow you</h2>
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

      <section>
        <h2>12. Publishing: tags &amp; discovery</h2>
        <p>
          Tags drive <em>More like this</em>. Use specific tags (<code>platformer</code>, <code>roguelike</code>) over generic ones
          (<code>game</code>, <code>fun</code>); rarer shared tags weigh more. <em>Trending</em> counts distinct players per day over
          the last 7 days; your own plays of your own game never count.
        </p>
      </section>

      <section>
        <h2>13. Release notes</h2>
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

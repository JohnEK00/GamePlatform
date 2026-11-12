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
          <li>Limits &amp; rules</li>
        </ol>
      </nav>

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
        <h2>5. Scores &amp; platform</h2>
        <p>
          Call <code>engine.platform.submitScore(n)</code> to post a score. If the player is logged in, Pixelforge Arcade saves it
          to the game's leaderboard (best score per player). The engine reports <code>ready</code> automatically after{" "}
          <code>load</code>, which counts a play. The arcade may pause/resume your game when the tab is hidden and toggle mute.
        </p>
      </section>

      <section>
        <h2>6. Limits &amp; rules</h2>
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

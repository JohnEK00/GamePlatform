// Starter templates for the Game Studio. Each is small but complete, written against the Pixelforge engine API
// (docs/GAME_FORMAT.md, packages/engine/README.md). No asset files are needed: graphics are shapes, sounds are synth.

export type StudioTemplate = {
  id: string;
  name: string;
  description: string;
  manifest: Record<string, unknown>;
  files: Record<string, string>;
};

const BLANK_MAIN = `// Pixelforge game module. The engine instance is passed in — no imports needed.
// Docs: /docs · Press F3 in the preview for the debug overlay.
export default {
  load(engine) {
    this.x = engine.width / 2;
    this.y = engine.height / 2;
    this.beeps = 0;
  },

  update(engine, dt) {
    const speed = 260;
    this.x += engine.input.axis("horizontal") * speed * dt;
    this.y += engine.input.axis("vertical") * speed * dt;
    this.x = engine.math.clamp(this.x, 20, engine.width - 20);
    this.y = engine.math.clamp(this.y, 20, engine.height - 20);

    if (engine.input.wasPressed("Space")) {
      engine.audio.tone({ freq: 520, freqEnd: 880, duration: 0.12 });
      engine.camera.shake(4, 0.15);
      this.beeps += 1;
      if (this.beeps === 10) engine.platform.unlockAchievement("ten_beeps");
    }
  },

  render(engine) {
    const r = engine.renderer;
    r.clear("#14162b");
    r.drawCircle(this.x, this.y, 20, "#ff7a3d");
    r.drawText("Hello, Pixelforge!", engine.width / 2, 48, { size: 32, color: "#ffffff", align: "center" });
    r.drawText("Arrows / WASD to move · Space to beep (" + this.beeps + ")", engine.width / 2, engine.height - 36, {
      size: 16,
      color: "#8b91b0",
      align: "center",
    });
  },
};
`;

const SHOOTER_MAIN = `// Arcade shooter: move with arrows/WASD (or the mouse), hold Space to fire. Don't let rocks hit you.
export default class Shooter {
  load(engine) {
    this.best = engine.storage.get("best", 0);
    this.sparks = new engine.ParticleEmitter({
      rate: 0,
      life: [0.25, 0.6],
      speed: [80, 260],
      size: [2, 5],
      sizeEnd: 0,
      color: ["#ffd166", "#ff7a3d", "#ff4f8b"],
      blend: "additive",
    });
    this.reset(engine);
  }

  reset(engine) {
    this.ship = { x: engine.width / 2, y: engine.height - 60, r: 14 };
    this.bullets = [];
    this.rocks = [];
    this.cooldown = 0;
    this.spawn = 1;
    this.score = 0;
    this.kills = 0;
    this.lives = 3;
    this.invulnerable = 0;
    this.over = false;
  }

  update(engine, dt) {
    const { input, random } = engine;
    this.sparks.update(dt);
    if (this.over) {
      if (input.wasPressed("Space") || input.mouse.pressed) this.reset(engine);
      return;
    }

    // Move
    const s = this.ship;
    s.x += input.axis("horizontal") * 340 * dt;
    s.y += input.axis("vertical") * 260 * dt;
    if (input.mouse.down) s.x += (input.mouse.x - s.x) * Math.min(1, dt * 10);
    s.x = engine.math.clamp(s.x, s.r, engine.width - s.r);
    s.y = engine.math.clamp(s.y, engine.height * 0.5, engine.height - s.r);

    // Shoot
    this.cooldown -= dt;
    if ((input.isDown("Space") || input.mouse.down) && this.cooldown <= 0) {
      this.cooldown = 0.16;
      this.bullets.push({ x: s.x, y: s.y - s.r, vy: -620 });
      engine.audio.tone({ freq: 880, freqEnd: 440, duration: 0.06, volume: 0.15 });
    }
    for (const b of this.bullets) b.y += b.vy * dt;
    this.bullets = this.bullets.filter((b) => b.y > -10 && !b.dead);

    // Spawn rocks faster over time
    this.spawn -= dt;
    if (this.spawn <= 0) {
      this.spawn = Math.max(0.25, 1.1 - this.score / 600);
      const r = random.range(12, 30);
      this.rocks.push({ x: random.range(r, engine.width - r), y: -r, r, vy: random.range(80, 160) + this.score / 8, vx: random.range(-40, 40) });
    }
    for (const k of this.rocks) {
      k.x += k.vx * dt;
      k.y += k.vy * dt;
    }

    // Collisions
    for (const k of this.rocks) {
      for (const b of this.bullets) {
        if (!b.dead && engine.math.circlesOverlap(b.x, b.y, 3, k.x, k.y, k.r)) {
          b.dead = true;
          k.dead = true;
          this.kills += 1;
          this.score += Math.round(40 - k.r);
          this.sparks.burst(18, k.x, k.y);
          engine.audio.noise({ duration: 0.18, volume: 0.25 });
          if (this.kills === 1) engine.platform.unlockAchievement("first_blood");
          if (this.kills === 50) engine.platform.unlockAchievement("rock_breaker");
        }
      }
      if (!k.dead && this.invulnerable <= 0 && engine.math.circlesOverlap(s.x, s.y, s.r * 0.8, k.x, k.y, k.r)) {
        k.dead = true;
        this.lives -= 1;
        this.invulnerable = 1.5;
        engine.camera.shake(10, 0.3);
        this.sparks.burst(30, s.x, s.y);
        engine.audio.tone({ freq: 200, freqEnd: 60, duration: 0.4, type: "sawtooth" });
        if (this.lives <= 0) this.gameOver(engine);
      }
    }
    this.rocks = this.rocks.filter((k) => !k.dead && k.y < engine.height + k.r);
    this.invulnerable -= dt;
  }

  gameOver(engine) {
    this.over = true;
    if (this.score > this.best) {
      this.best = this.score;
      engine.storage.set("best", this.best);
    }
    engine.platform.submitScore(this.score);
  }

  render(engine) {
    const r = engine.renderer;
    r.clear("#070814");
    // Starfield
    for (let i = 0; i < 60; i++) {
      const y = (i * 97 + engine.time * (20 + (i % 3) * 30)) % engine.height;
      r.drawRect((i * 151) % engine.width, y, 2, 2, i % 3 ? "#3a3f6b" : "#8b91b0");
    }
    for (const k of this.rocks) r.drawCircle(k.x, k.y, k.r, "#8a6f5a");
    for (const b of this.bullets) r.drawRect(b.x - 2, b.y - 8, 4, 12, "#ffd166");
    const s = this.ship;
    if (!this.over && (this.invulnerable <= 0 || Math.floor(engine.time * 12) % 2 === 0)) {
      r.drawTriangle(s.x, s.y - s.r, s.x - s.r, s.y + s.r, s.x + s.r, s.y + s.r, "#2fd9a6");
    }
    this.sparks.draw(r);

    r.ui(() => {
      r.drawText("Score " + this.score, 12, 10, { size: 18, color: "#ffffff" });
      r.drawText("Best " + this.best, 12, 32, { size: 14, color: "#8b91b0" });
      r.drawText("♥".repeat(Math.max(0, this.lives)), engine.width - 12, 10, { size: 18, color: "#ff4f8b", align: "right" });
      if (this.over) {
        r.drawText("GAME OVER", engine.width / 2, engine.height / 2 - 30, { size: 40, color: "#ff7a3d", align: "center" });
        r.drawText("Press Space or tap to play again", engine.width / 2, engine.height / 2 + 20, { size: 16, color: "#c3c7dc", align: "center" });
      }
    });
  }
}
`;

const PLATFORMER_MAIN = `// Platformer: arrows/WASD to run, Space/Up to jump. Collect every coin to finish the level.
const LEVEL = [
  "##############################",
  "#............................#",
  "#..........c.........c.......#",
  "#........#####.....#####.....#",
  "#..c.........................#",
  "#####................c.......#",
  "#.........c.......########...#",
  "#.......#####................#",
  "#...........................c#",
  "#..c.................#########",
  "#######......c...............#",
  "#..........#######...........#",
  "#.p..........................#",
  "##############################",
];
const TILE = 32;

export default {
  load(engine) {
    const rows = LEVEL.map((row) => row.replace(/[pc]/g, "."));
    this.map = engine.Tilemap.fromArray(rows, TILE, TILE, { "#": 1 });
    this.world = new engine.Physics({ gravity: 1400, tilemap: this.map });
    this.coins = [];
    LEVEL.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === "c") this.coins.push({ x: x * TILE + TILE / 2, y: y * TILE + TILE / 2, taken: false });
        if (row[x] === "p") this.spawn = { x: x * TILE + 6, y: y * TILE };
      }
    });
    this.player = this.world.add({ x: this.spawn.x, y: this.spawn.y, w: 20, h: 28, maxSpeedX: 260, dragX: 2200 });
    this.collected = 0;
    this.time = 0;
    this.done = false;
    engine.camera.bounds = { x: 0, y: 0, w: this.map.pixelWidth, h: this.map.pixelHeight };
  },

  update(engine, dt) {
    const { input } = engine;
    const p = this.player;
    if (!this.done) this.time += dt;

    const dir = input.axis("horizontal");
    p.ax = dir * 2400;
    const jump = input.wasPressed("Space") || input.wasPressed("ArrowUp") || input.wasPressed("KeyW");
    if (jump && p.onGround) {
      p.vy = -620;
      engine.audio.tone({ freq: 330, freqEnd: 660, duration: 0.1, volume: 0.2 });
    }
    // Variable jump height
    if (p.vy < 0 && !(input.isDown("Space") || input.isDown("ArrowUp") || input.isDown("KeyW"))) p.vy *= 0.88;

    this.world.step(dt);

    for (const c of this.coins) {
      if (!c.taken && Math.abs(p.x + p.w / 2 - c.x) < 18 && Math.abs(p.y + p.h / 2 - c.y) < 22) {
        c.taken = true;
        this.collected += 1;
        engine.audio.tone({ freq: 990, freqEnd: 1320, duration: 0.08, type: "triangle" });
        if (this.collected === 1) engine.platform.unlockAchievement("shiny");
      }
    }
    if (!this.done && this.collected === this.coins.length) {
      this.done = true;
      engine.platform.unlockAchievement("completionist");
      // Faster is better: score = 10000 - centiseconds
      engine.platform.submitScore(Math.max(0, 10000 - Math.round(this.time * 100)));
    }
    if (this.done && input.wasPressed("KeyR")) this.load(engine);

    engine.camera.follow(p.x + p.w / 2, p.y + p.h / 2, 0.15);
  },

  render(engine, alpha) {
    const r = engine.renderer;
    r.clear("#1a1c38");
    this.map.draw(r, (id, x, y) => {
      r.drawRect(x, y, TILE, TILE, "#3b4a7a");
      r.drawRect(x, y, TILE, 4, "#5f78c2");
    });
    for (const c of this.coins) {
      if (!c.taken) r.drawCircle(c.x, c.y + Math.sin(engine.time * 4 + c.x) * 3, 7, "#ffd166");
    }
    const pos = this.player.lerpPos(alpha);
    r.drawRect(pos.x, pos.y, this.player.w, this.player.h, "#ff7a3d");
    r.drawRect(pos.x + 4, pos.y + 6, 4, 4, "#1a0a00");
    r.drawRect(pos.x + 12, pos.y + 6, 4, 4, "#1a0a00");

    r.ui(() => {
      r.drawText("Coins " + this.collected + "/" + this.coins.length, 12, 10, { size: 18, color: "#ffffff" });
      r.drawText(this.time.toFixed(1) + "s", engine.width - 12, 10, { size: 18, color: "#c3c7dc", align: "right" });
      if (this.done) {
        r.drawText("LEVEL CLEAR!", engine.width / 2, engine.height / 2 - 20, { size: 40, color: "#2fd9a6", align: "center" });
        r.drawText("Press R to play again", engine.width / 2, engine.height / 2 + 24, { size: 16, color: "#c3c7dc", align: "center" });
      }
    });
  },
};
`;

const TIME_TRIAL_MAIN = `// Time trial: steer with arrows/WASD through the gates in order and reach the goal as fast as possible.
// Lower is better: game.json declares "leaderboard": { "order": "asc", "format": "time" }, and the score is milliseconds.
const GATES = [
  { x: 160, y: 120 },
  { x: 640, y: 140 },
  { x: 520, y: 460 },
  { x: 140, y: 470 },
  { x: 400, y: 300 },
];
const RADIUS = 26;

function formatTime(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = Math.floor(ms % 1000);
  return m + ":" + String(s).padStart(2, "0") + "." + String(mm).padStart(3, "0");
}

export default {
  load(engine) {
    this.best = engine.storage.get("bestMs", 0);
    this.reset(engine);
  },

  reset(engine) {
    this.x = 60;
    this.y = engine.height - 60;
    this.vx = 0;
    this.vy = 0;
    this.next = 0;
    this.ms = 0;
    this.started = false;
    this.done = false;
    this.result = null; // ScoreResultView | null
    this.board = null; // LeaderboardView | null
    this.loadingBoard = false;
  },

  async finish(engine) {
    this.done = true;
    const ms = Math.round(this.ms);
    if (!this.best || ms < this.best) {
      this.best = ms;
      engine.storage.set("bestMs", ms);
    }
    engine.audio.tone({ freq: 660, freqEnd: 1320, duration: 0.25, type: "triangle" });
    // submitScore resolves with your ranks (or null when offline, logged out or in the Studio).
    this.result = await engine.platform.submitScore(ms);
    if (typeof engine.platform.getLeaderboard === "function") {
      this.loadingBoard = true;
      this.board = await engine.platform.getLeaderboard({ period: "day", limit: 5 });
      this.loadingBoard = false;
    }
  },

  update(engine, dt) {
    const { input } = engine;
    if (this.done) {
      if (input.wasPressed("KeyR") || input.wasPressed("Space")) this.reset(engine);
      return;
    }
    const ax = input.axis("horizontal");
    const ay = input.axis("vertical");
    if (!this.started && (ax || ay)) this.started = true;
    if (!this.started) return;

    this.ms += dt * 1000;
    const accel = 1400;
    this.vx = (this.vx + ax * accel * dt) * Math.pow(0.08, dt);
    this.vy = (this.vy + ay * accel * dt) * Math.pow(0.08, dt);
    this.x = engine.math.clamp(this.x + this.vx * dt, 12, engine.width - 12);
    this.y = engine.math.clamp(this.y + this.vy * dt, 12, engine.height - 12);

    const g = GATES[this.next];
    if (Math.hypot(this.x - g.x, this.y - g.y) < RADIUS + 10) {
      this.next += 1;
      engine.audio.tone({ freq: 440 + this.next * 110, duration: 0.08 });
      if (this.next === GATES.length) this.finish(engine);
    }
  },

  render(engine) {
    const r = engine.renderer;
    r.clear("#101326");
    GATES.forEach((g, i) => {
      const color = i < this.next ? "#2a3156" : i === this.next ? (i === GATES.length - 1 ? "#2fd9a6" : "#ffd166") : "#3b4a7a";
      r.drawCircle(g.x, g.y, RADIUS, color);
      r.drawText(i === GATES.length - 1 ? "GOAL" : String(i + 1), g.x, g.y - 8, { size: 16, color: "#101326", align: "center" });
    });
    r.drawCircle(this.x, this.y, 12, "#ff7a3d");

    r.ui(() => {
      r.drawText(formatTime(this.ms), 12, 10, { size: 22, color: "#ffffff" });
      if (this.best) r.drawText("Best " + formatTime(this.best), engine.width - 12, 10, { size: 16, color: "#c3c7dc", align: "right" });
      if (!this.started && !this.done)
        r.drawText("Move to start the clock", engine.width / 2, engine.height - 40, { size: 16, color: "#8b91b0", align: "center" });
      if (!this.done) return;

      const cx = engine.width / 2;
      r.drawRect(cx - 200, 90, 400, 380, "rgba(10, 11, 19, 0.88)");
      r.drawText("FINISHED " + formatTime(this.ms), cx, 110, { size: 28, color: "#2fd9a6", align: "center" });
      if (this.result && this.result.personalBest)
        r.drawText("NEW BEST!  #" + this.result.ranks.day + " today", cx, 150, { size: 16, color: "#ffd166", align: "center" });
      r.drawText("Today's top 5", cx, 190, { size: 16, color: "#c3c7dc", align: "center" });
      if (this.loadingBoard) r.drawText("Loading…", cx, 225, { size: 14, color: "#8b91b0", align: "center" });
      else if (!this.board || this.board.entries.length === 0)
        r.drawText("No leaderboard available", cx, 225, { size: 14, color: "#8b91b0", align: "center" });
      else
        this.board.entries.forEach((e, i) => {
          const y = 225 + i * 30;
          const c = e.isMe ? "#ff7a3d" : "#eceef8";
          r.drawText("#" + e.rank + "  " + e.name, cx - 170, y, { size: 16, color: c });
          r.drawText(e.display, cx + 170, y, { size: 16, color: c, align: "right" });
        });
      r.drawText("Press R or Space to race again", cx, 430, { size: 14, color: "#8b91b0", align: "center" });
    });
  },
};
`;

export const STUDIO_TEMPLATES: StudioTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description: "A moving dot, a beep and an achievement — the smallest possible game.",
    manifest: {
      name: "My Game",
      entry: "main.js",
      width: 800,
      height: 600,
      engine: "1",
      achievements: [{ id: "ten_beeps", name: "Beep Boop", description: "Beep ten times" }],
    },
    files: { "main.js": BLANK_MAIN },
  },
  {
    id: "shooter",
    name: "Arcade shooter",
    description: "Vertical shooter with particles, screen shake, lives, high score and leaderboard submission.",
    manifest: {
      name: "Rock Blaster",
      entry: "main.js",
      width: 480,
      height: 640,
      engine: "1",
      achievements: [
        { id: "first_blood", name: "First Blood", description: "Destroy your first rock" },
        { id: "rock_breaker", name: "Rock Breaker", description: "Destroy 50 rocks in one run" },
      ],
    },
    files: { "main.js": SHOOTER_MAIN },
  },
  {
    id: "platformer",
    name: "Platformer",
    description: "Tilemap + physics platformer with coins, a timer and a speedrun score.",
    manifest: {
      name: "Coin Climber",
      entry: "main.js",
      width: 640,
      height: 360,
      engine: "1",
      achievements: [
        { id: "shiny", name: "Shiny!", description: "Collect your first coin" },
        { id: "completionist", name: "Completionist", description: "Collect every coin" },
      ],
    },
    files: { "main.js": PLATFORMER_MAIN },
  },
  {
    id: "time-trial",
    name: "Time trial",
    description: "Race through the gates against the clock. Lowest time wins, and the end screen shows today's top 5.",
    manifest: {
      name: "Gate Rush",
      entry: "main.js",
      width: 800,
      height: 600,
      engine: "1",
      leaderboard: { order: "asc", format: "time", label: "Best time" },
      achievements: [],
    },
    files: { "main.js": TIME_TRIAL_MAIN },
  },
];

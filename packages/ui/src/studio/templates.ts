// Starter templates for the Game Studio. Each is small but complete, written against the Pixelforge engine API
// (docs/GAME_FORMAT.md, packages/engine/README.md). No asset files are needed: graphics are shapes or procedural
// textures (assets.createTexture, e.g. the 9-slice frames of "Menu & HUD"), text uses the built-in fonts and sounds are synth.

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

    // "beep" is declared in game.json "actions", so players can remap it (⌨ under the player).
    if (engine.input.actionPressed("beep")) {
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
    r.drawText("Arrows / WASD to move · " + engine.input.actionLabel("beep") + " to beep (" + this.beeps + ")", engine.width / 2, engine.height - 36, {
      size: 16,
      color: "#8b91b0",
      align: "center",
    });
  },
};
`;

const SHOOTER_MAIN = `// Arcade shooter: move with arrows/WASD (or the mouse), hold "fire" (Space by default) to shoot. Don't let rocks hit you.
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
      if (input.actionPressed("fire") || input.mouse.pressed) this.reset(engine);
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
    if ((input.actionDown("fire") || input.mouse.down) && this.cooldown <= 0) {
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
        r.drawText("Press " + engine.input.actionLabel("fire") + " or tap to play again", engine.width / 2, engine.height / 2 + 20, { size: 16, color: "#c3c7dc", align: "center" });
      }
    });
  }
}
`;

const PLATFORMER_MAIN = `// Platformer: arrows/A/D to run, Space/Up/W to jump (remappable actions declared in game.json). Collect every coin to finish the level.
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
    if (input.actionPressed("jump") && p.onGround) {
      p.vy = -620;
      engine.audio.tone({ freq: 330, freqEnd: 660, duration: 0.1, volume: 0.2 });
    }
    // Variable jump height
    if (p.vy < 0 && !input.actionDown("jump")) p.vy *= 0.88;

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
    if (this.done && input.actionPressed("restart")) this.load(engine);

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
        r.drawText("Press " + engine.input.actionLabel("restart") + " to play again", engine.width / 2, engine.height / 2 + 24, { size: 16, color: "#c3c7dc", align: "center" });
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
      if (input.actionPressed("restart")) this.reset(engine);
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
      r.drawText("Press " + engine.input.actionLabel("restart") + " to race again", cx, 430, { size: 14, color: "#8b91b0", align: "center" });
    });
  },
};
`;

const MENU_HUD_MAIN = `// Menu & HUD: a title menu, a settings screen, a pause menu and a crisp pixel-font HUD around a tiny star-catching game.
// Widgets come from engine.ui and are called from update, never render (/docs, section 16 "Text, fonts and menus").
// The settings screen shows a text field, a slider, a toggle and a scrolling list ("Settings and text entry").
// No asset files: the panel and button frames are 9-slices drawn procedurally with assets.createTexture.
const BTN_W = 120;
const BTN_H = 20;

// The star tints offered on the settings screen. The list shows 3 rows at a time, so it scrolls.
const STAR_COLOURS = [
  { name: "GOLD", color: "#ffd166" },
  { name: "ROSE", color: "#ff6b9a" },
  { name: "MINT", color: "#6be4a8" },
  { name: "SKY", color: "#6bc8ff" },
  { name: "LILAC", color: "#b48cff" },
  { name: "SNOW", color: "#ffffff" },
];
const NAME_MAX = 12;
// Called once per typed or pasted character: letters, digits, space, "-" and "_".
const NAME_CHAR = (ch) => /^[A-Za-z0-9 _-]$/.test(ch);

// A small framed box with rounded corners, a light top edge and a darker bottom edge.
// It is drawn once, then stretched by a NineSlice: the corners stay crisp, the middle stretches.
function frame(engine, c) {
  return engine.assets.createTexture(12, 12, (ctx, w, h) => {
    ctx.fillStyle = c.border;
    ctx.fillRect(1, 0, w - 2, h);
    ctx.fillRect(0, 1, w, h - 2);
    ctx.fillStyle = c.shade;
    ctx.fillRect(1, 1, w - 2, h - 2);
    ctx.fillStyle = c.fill;
    ctx.fillRect(1, 1, w - 2, h - 3);
    ctx.fillStyle = c.light;
    ctx.fillRect(2, 1, w - 4, 1);
  });
}

export default {
  load(engine) {
    const { ui, NineSlice } = engine;
    const panel = frame(engine, { border: "#5a6bc0", fill: "#141a2e", shade: "#0c1020", light: "#3a4470" });
    const button = frame(engine, { border: "#0c1020", fill: "#2a3358", shade: "#1e2540", light: "#5a6bc0" });
    const hover = frame(engine, { border: "#0c1020", fill: "#3a4780", shade: "#2a3358", light: "#8a9af0" });
    const down = frame(engine, { border: "#0c1020", fill: "#1e2540", shade: "#1e2540", light: "#141a2e" });

    // Theme (section 16): every widget uses the built-in "pixel" font at its native size 8 and these frames.
    ui.theme.font = "pixel";
    ui.theme.textSize = 8;
    ui.theme.panel = new NineSlice(panel, 4);
    ui.theme.button = new NineSlice(button, 4);
    ui.theme.buttonHover = new NineSlice(hover, 4);
    ui.theme.buttonDown = new NineSlice(down, 4);
    ui.theme.nineSliceScale = 1;

    // Saved settings. Check what comes back from storage: old saves may lack a key or hold something else.
    const { storage, audio } = engine;
    this.sound = storage.get("sound", true) !== false;
    const volume = Number(storage.get("volume", 1));
    this.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
    const name = storage.get("name", "");
    this.name = typeof name === "string" ? name.slice(0, NAME_MAX) : "";
    const colour = storage.get("colour", 0);
    this.colour = Number.isInteger(colour) && colour >= 0 && colour < STAR_COLOURS.length ? colour : 0;
    audio.masterVolume = this.volume;
    if (!this.sound) audio.muted = true; // never unmute here: the site's own mute button also sets audio.muted
    this.best = storage.get("best", 0);
    this.state = "title"; // title | settings | help | play | paused | over
    this.keyboard = false; // was the last menu choice made with keys or a gamepad?
    this.focusNext = null;
    this.sky = Array.from({ length: 40 }, () => ({
      x: Math.floor(Math.random() * engine.width),
      y: Math.floor(Math.random() * engine.height),
      s: Math.random() < 0.2 ? 2 : 1,
    }));
    this.reset(engine);
  },

  reset(engine) {
    this.x = engine.width / 2;
    this.stars = [];
    this.score = 0;
    this.lives = 3;
    this.spawn = 0.6;
  },

  beep(engine, freq, freqEnd = freq, duration = 0.08) {
    if (this.sound) engine.audio.tone({ freq, freqEnd, duration, volume: 0.2 });
  },

  // Switch screens. Keyboard and gamepad players land on the new menu's first button.
  go(engine, state, focus = null) {
    this.keyboard = engine.ui.focus !== null;
    this.state = state;
    this.focusNext = this.keyboard ? focus : null;
    this.beep(engine, 660);
  },

  update(engine, dt) {
    const { input } = engine;
    if (this.state === "play") {
      // "pause" is a game.json action (KeyP / Start), so players can remap it with ⌨.
      if (input.actionPressed("pause")) {
        this.state = "paused";
        this.keyboard = true;
        this.focusNext = "resume";
      } else {
        this.play(engine, dt);
      }
    } else if (this.state === "paused" && input.actionPressed("pause")) {
      this.state = "play";
    }
    const inSettings = this.state === "settings";
    this.menus(engine);
    // "pause" also leaves the settings, but not while a name is being typed (a gamepad Start would drop the edit).
    // Checked after menus() has drawn the NAME field: in the step where typing on it starts, ui.editing is only
    // set once the field's call has run, and the typed key (say P) must not count as "pause".
    if (inSettings && this.state === "settings" && input.actionPressed("pause") && !engine.ui.editing) {
      this.go(engine, "title", "settings");
    }
  },

  play(engine, dt) {
    const W = engine.width;
    const H = engine.height;
    this.x = engine.math.clamp(this.x + engine.input.axis("horizontal") * 200 * dt, 20, W - 20);

    this.spawn -= dt;
    if (this.spawn <= 0) {
      this.spawn = Math.max(0.35, 1 - this.score * 0.02);
      this.stars.push({ x: 12 + Math.random() * (W - 24), y: -6, vy: 50 + Math.min(110, this.score * 3) + Math.random() * 20 });
    }

    const top = H - 22;
    this.stars = this.stars.filter((s) => {
      s.y += s.vy * dt;
      if (s.y >= top - 3 && s.y <= top + 4 && Math.abs(s.x - this.x) <= 22) {
        this.score += 1;
        this.beep(engine, 880, 1320, 0.06);
        return false;
      }
      if (s.y > H + 6) {
        this.lives -= 1;
        engine.camera.shake(3, 0.15);
        this.beep(engine, 180, 90, 0.2);
        return false;
      }
      return true;
    });

    if (this.lives <= 0) {
      this.state = "over";
      this.focusNext = this.keyboard ? "again" : null;
      if (this.score > this.best) {
        this.best = this.score;
        engine.storage.set("best", this.best);
      }
      engine.platform.submitScore(this.score);
    }
  },

  // All widgets for the current screen. A button returns true once, in the step it is activated.
  menus(engine) {
    const { ui, input } = engine;
    const W = engine.width;
    const cx = W / 2;
    const bx = cx - BTN_W / 2;
    if (this.focusNext) {
      ui.focus = this.focusNext; // shows the focus ring; the button is declared below in this same step
      this.focusNext = null;
    }

    if (this.state === "title") {
      ui.label("STAR CATCHER", cx, 48, { size: 24, color: "#ffd166", align: "center" });
      ui.panel(bx - 12, 100, BTN_W + 24, 96);
      if (ui.button("play", "PLAY", bx, 112, BTN_W, BTN_H)) {
        this.reset(engine);
        this.go(engine, "play");
      }
      if (ui.button("settings", "SETTINGS", bx, 138, BTN_W, BTN_H)) this.go(engine, "settings", "name");
      if (ui.button("help", "HOW TO PLAY", bx, 164, BTN_W, BTN_H)) this.go(engine, "help", "back");
      ui.label("BEST " + this.best, cx, 214, { color: "#8b91b0", align: "center" });
    } else if (this.state === "settings") {
      this.settings(engine);
    } else if (this.state === "help") {
      // "auto": the player's key, or their gamepad button after they last touched a controller (F016).
      const key = (id) => input.actionLabel(id, "auto").toUpperCase();
      ui.panel(cx - 110, 60, 220, 130);
      ui.label(
        ["CATCH THE FALLING STARS.", "MISS THREE AND IT'S OVER.", "", "MOVE: LEFT / RIGHT", "CHOOSE: " + key("confirm"), "PAUSE: " + key("pause")].join("\\n"),
        cx,
        74,
        { align: "center" },
      );
      if (ui.button("back", "BACK", bx, 158, BTN_W, BTN_H)) this.go(engine, "title", "help");
    } else if (this.state === "play") {
      // A HUD button during play: nav: false keeps the arrows and "confirm" for the game itself.
      if (engine.ui.button("hud-pause", "II", W - 22, 4, 18, 14, { nav: false })) this.go(engine, "paused", "resume");
    } else if (this.state === "paused") {
      ui.panel(cx - 80, 80, 160, 100);
      ui.label("PAUSED", cx, 92, { size: 16, align: "center" });
      if (ui.button("resume", "RESUME", bx, 120, BTN_W, BTN_H)) this.go(engine, "play");
      if (ui.button("quit", "QUIT", bx, 146, BTN_W, BTN_H)) this.go(engine, "title", "play");
    } else if (this.state === "over") {
      ui.panel(cx - 80, 64, 160, 136);
      ui.label("GAME OVER", cx, 76, { size: 16, color: "#ff7a3d", align: "center" });
      ui.label(this.scoreText(), cx, 100, { align: "center" });
      ui.label("BEST " + this.best, cx, 112, { color: "#8b91b0", align: "center" });
      if (ui.button("again", "PLAY AGAIN", bx, 134, BTN_W, BTN_H)) {
        this.reset(engine);
        this.go(engine, "play");
      }
      if (ui.button("menu", "MENU", bx, 160, BTN_W, BTN_H)) this.go(engine, "title", "play");
    }
  },

  // Settings: value in, value out. Each widget takes the current value and returns the new one; save on ui.committed.
  // Keys and gamepad: up/down move between the rows, left/right change the volume, up/down move inside the list.
  settings(engine) {
    const { ui, input, audio, storage } = engine;
    const cx = engine.width / 2;
    const px = cx - 150; // panel
    const lx = px + 14; // labels
    const wx = px + 110; // widgets
    const ww = 176;
    ui.panel(px, 24, 300, 200);
    ui.label("SETTINGS", cx, 32, { size: 16, align: "center" });

    // While the name is being typed, keyboard actions pause (input.keyboardCaptured), so A/D and P only type letters.
    // Enter saves, Escape (or gamepad B) puts the old name back. In the site's fullscreen mode the browser takes the
    // first Escape to leave fullscreen: press Escape again, or use gamepad B. Enter, a click elsewhere and Up/Down
    // still end typing.
    ui.label("NAME", lx, 60);
    this.name = ui.textField("name", this.name, wx, 56, ww, 16, { maxLength: NAME_MAX, placeholder: "PLAYER", allow: NAME_CHAR });
    if (ui.committed("name")) {
      this.name = this.name.trim();
      storage.set("name", this.name);
    }

    ui.label("VOLUME", lx, 82);
    this.volume = ui.slider("volume", this.volume, wx, 80, ww - 36, 12, { min: 0, max: 1, step: 0.1 });
    ui.label(Math.round(this.volume * 100) + "%", wx + ww, 82, { align: "right" });
    if (ui.changed("volume")) audio.masterVolume = this.volume; // hear it while dragging...
    if (ui.committed("volume")) {
      storage.set("volume", this.volume); // ...but save once, when the drag ends or a key step lands
      this.beep(engine, 660);
    }

    // A toggle carries its own label; the switch sits at the right end of the rect.
    this.sound = ui.toggle("sound", this.sound, "SOUND", lx, 100, wx + ww - lx, 14);
    if (ui.committed("sound")) {
      audio.muted = !this.sound;
      storage.set("sound", this.sound);
      this.beep(engine, 660);
    }

    ui.label("STAR COLOUR", lx, 124, { color: STAR_COLOURS[this.colour].color });
    const names = STAR_COLOURS.map((c) => c.name);
    const picked = ui.list("colour", names, wx, 120, ww, 48, { rowHeight: 16, selected: this.colour });
    if (picked >= 0) {
      this.colour = picked;
      storage.set("colour", picked);
      this.beep(engine, 880);
    }

    if (ui.button("back", "BACK", cx - BTN_W / 2, 192, BTN_W, BTN_H)) this.go(engine, "title", "settings");

    // Text fields need a physical keyboard: tell touch and controller players (there is no on-screen keyboard yet).
    if (input.lastDevice === "touch" || input.lastDevice === "gamepad") {
      ui.label("Type your name with a keyboard", cx, 234, { color: "#8b91b0", align: "center" });
    }
  },

  // "MIA 120" on the HUD and the game-over screen once a name is saved, "SCORE 120" before that.
  scoreText() {
    return (this.name || "SCORE") + " " + this.score;
  },

  render(engine) {
    const r = engine.renderer;
    const W = engine.width;
    const H = engine.height;
    r.clear("#0b0e1c");
    for (const s of this.sky) r.drawRect(s.x, s.y, s.s, s.s, "#2a3358");
    if (this.state === "title" || this.state === "help" || this.state === "settings") return; // the menus are drawn by the UI layer

    r.drawRect(0, H - 8, W, 8, "#141a2e");
    const tint = STAR_COLOURS[this.colour].color;
    for (const s of this.stars) {
      const x = Math.round(s.x);
      const y = Math.round(s.y);
      r.drawRect(x - 1, y - 3, 3, 7, tint);
      r.drawRect(x - 3, y - 1, 7, 3, tint);
    }
    const bx = Math.round(this.x) - 20;
    r.drawRect(bx, H - 22, 40, 6, "#ff7a3d");
    r.drawRect(bx + 2, H - 16, 36, 2, "#b34f22");

    // HUD in screen space, so camera shake leaves it still. "pixel" at size 8 (its native size) is crisp.
    r.ui(() => {
      const hud = { font: "pixel", size: 8, color: "#ffffff" };
      r.drawText(this.scoreText(), 6, 6, hud);
      r.drawText("LIVES " + this.lives, 6, 16, { ...hud, color: this.lives === 1 ? "#ff7a3d" : "#c3c7dc" });
      r.drawText("BEST " + this.best, W / 2, 6, { ...hud, color: "#8b91b0", align: "center" });
    });
  },
};
`;

// F009: game.json "actions" (GAME_FORMAT § F009). Movement actions named left/right/up/down make
// input.axis() follow the player's remapping.
const MOVE_LEFT = { id: "left", name: "Move left", keys: ["ArrowLeft", "KeyA"], gamepad: ["Left"] };
const MOVE_RIGHT = { id: "right", name: "Move right", keys: ["ArrowRight", "KeyD"], gamepad: ["Right"] };
const MOVE_UP = { id: "up", name: "Move up", keys: ["ArrowUp", "KeyW"], gamepad: ["Up"] };
const MOVE_DOWN = { id: "down", name: "Move down", keys: ["ArrowDown", "KeyS"], gamepad: ["Down"] };
const MOVEMENT = () => [MOVE_LEFT, MOVE_RIGHT, MOVE_UP, MOVE_DOWN].map((a) => ({ ...a, keys: [...a.keys], gamepad: [...a.gamepad] }));

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
      controls: "Move the dot and beep. Remap keys with ⌨.",
      actions: [...MOVEMENT(), { id: "beep", name: "Beep", keys: ["Space"], gamepad: ["A"] }],
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
      controls: "Hold the mouse or touch to steer and fire. Remap keys with ⌨.",
      actions: [...MOVEMENT(), { id: "fire", name: "Fire", keys: ["Space", "KeyJ"], gamepad: ["A", "RT"] }],
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
      controls: "Collect every coin as fast as you can. Remap keys with ⌨.",
      actions: [
        { ...MOVE_LEFT, keys: [...MOVE_LEFT.keys], gamepad: [...MOVE_LEFT.gamepad] },
        { ...MOVE_RIGHT, keys: [...MOVE_RIGHT.keys], gamepad: [...MOVE_RIGHT.gamepad] },
        { id: "jump", name: "Jump", keys: ["Space", "ArrowUp", "KeyW"], gamepad: ["A"] },
        { id: "restart", name: "Play again", keys: ["KeyR"], gamepad: ["Start"] },
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
      controls: "Pass the gates in order; the clock starts when you move. Remap keys with ⌨.",
      actions: [...MOVEMENT(), { id: "restart", name: "Race again", keys: ["KeyR", "Space"], gamepad: ["Start"] }],
    },
    files: { "main.js": TIME_TRIAL_MAIN },
  },
  {
    id: "menu-hud",
    name: "Menu & HUD",
    description: "Title and pause menus built with engine.ui and 9-slices, plus a crisp pixel-font HUD, around a tiny star-catching game.",
    manifest: {
      name: "Star Catcher",
      entry: "main.js",
      width: 480,
      height: 270,
      engine: "1",
      achievements: [],
      controls: "Arrows or WASD to move, Enter to choose, P to pause. Remap keys with ⌨.",
      // F012: engine.ui navigates menus with the declared up/down/left/right and confirm actions, so ⌨ remaps apply.
      actions: [
        ...MOVEMENT(),
        { id: "confirm", name: "Confirm", keys: ["Enter", "Space"], gamepad: ["A"] },
        { id: "pause", name: "Pause", keys: ["KeyP"], gamepad: ["Start"] },
      ],
    },
    files: { "main.js": MENU_HUD_MAIN },
  },
];

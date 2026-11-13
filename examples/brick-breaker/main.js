// Brick Breaker — a neon brick-breaking arcade game for the Pixelforge engine.
// No imports: everything comes from the `engine` object passed to load/update/render.
// Levels live in assets/levels.json; all graphics are drawn procedurally; sounds use the built-in synth.

const W = 800;
const H = 600;
const TAU = Math.PI * 2;
const COLS = 12;
const BW = 60;
const BH = 24;
const BX = (W - COLS * BW) / 2;
const BY = 86;
const TOP = 54; // ceiling (HUD lives above it)
const PADDLE_Y = H - 46;
const PADDLE_H = 16;
const BALL_R = 7;
const BASE_SPEED = 390;
const MAX_LIVES = 5;

const COLORS = {
  r: '#ff4d6d', o: '#ff9f43', y: '#ffd93d', g: '#5cff8a', c: '#4cf2ff', b: '#4d7cff', p: '#b06bff',
  T: '#c8d0e0', H: '#ffcf5c', X: '#59627a', '*': '#ff3b3b',
};
const POINTS = { normal: 50, tough: 120, hard: 200, explosive: 80 };

const POWERS = {
  wide: { letter: 'W', color: '#4d7cff', label: 'WIDE PADDLE' },
  multi: { letter: 'M', color: '#ff5fd2', label: 'MULTI-BALL' },
  slow: { letter: 'S', color: '#5cff8a', label: 'SLOW BALL' },
  laser: { letter: 'L', color: '#ff4d6d', label: 'LASERS' },
  catch: { letter: 'C', color: '#ffd93d', label: 'CATCH' },
  life: { letter: '+', color: '#ff8fab', label: 'EXTRA LIFE' },
};
const POWER_WEIGHTS = [['wide', 5], ['multi', 4], ['slow', 3], ['laser', 4], ['catch', 3], ['life', 1]];

// Achievements are declared in game.json. `unlockAchievement` is v2; guard so older engines still run.
function unlock(engine, id) {
  if (typeof engine.platform.unlockAchievement === 'function') engine.platform.unlockAchievement(id);
}

// ------------------------------------------------------------------ procedural textures

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** Draw a texture at 2x resolution so it stays crisp on HiDPI screens. */
function makeTex(engine, w, h, draw) {
  return engine.assets.createTexture(w * 2, h * 2, (ctx) => {
    ctx.scale(2, 2);
    draw(ctx, w, h);
  }, { smooth: true });
}

function brickTex(engine, code) {
  const color = COLORS[code];
  return makeTex(engine, BW, BH, (c, w, h) => {
    const x = 2, y = 2, bw = w - 4, bh = h - 4;
    const g = c.createLinearGradient(0, y, 0, y + bh);
    g.addColorStop(0, shade(color, 1.3));
    g.addColorStop(0.55, color);
    g.addColorStop(1, shade(color, 0.5));
    roundRect(c, x, y, bw, bh, 4);
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.45)';
    c.lineWidth = 1;
    roundRect(c, x + 0.5, y + 0.5, bw - 1, bh - 1, 4);
    c.stroke();
    if (code === 'X') {
      // steel: brushed lines + rivets
      c.strokeStyle = 'rgba(255,255,255,0.08)';
      for (let i = 0; i < 6; i++) { c.beginPath(); c.moveTo(x + 4, y + 3 + i * 3); c.lineTo(x + bw - 4, y + 3 + i * 3); c.stroke(); }
      c.fillStyle = '#9aa3bd';
      for (const [rx, ry] of [[7, 7], [w - 7, 7], [7, h - 7], [w - 7, h - 7]]) { c.beginPath(); c.arc(rx, ry, 2, 0, TAU); c.fill(); }
      return;
    }
    c.fillStyle = 'rgba(255,255,255,0.3)';
    roundRect(c, x + 3, y + 2, bw - 6, bh * 0.36, 3);
    c.fill();
    if (code === '*') {
      c.save();
      roundRect(c, x + 2, y + 2, bw - 4, bh - 4, 3);
      c.clip();
      c.fillStyle = 'rgba(20,0,0,0.35)';
      for (let i = -2; i < 9; i++) { c.beginPath(); c.moveTo(x + i * 9, y + bh); c.lineTo(x + i * 9 + 5, y + bh); c.lineTo(x + i * 9 + 5 + bh, y); c.lineTo(x + i * 9 + bh, y); c.fill(); }
      c.restore();
      c.fillStyle = '#fff3c4';
      c.font = 'bold 15px sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('✸', w / 2, h / 2 + 1);
    } else if (code === 'T' || code === 'H') {
      c.strokeStyle = code === 'H' ? 'rgba(120,70,0,0.7)' : 'rgba(60,70,90,0.6)';
      c.lineWidth = 2;
      roundRect(c, x + 5, y + 5, bw - 10, bh - 10, 2);
      c.stroke();
    }
  });
}

function crackTex(engine) {
  return makeTex(engine, BW, BH, (c) => {
    c.strokeStyle = 'rgba(10,10,20,0.75)';
    c.lineWidth = 1.4;
    c.lineCap = 'round';
    const paths = [
      [[30, 2], [27, 9], [33, 13], [28, 22]],
      [[27, 9], [16, 8], [9, 14]],
      [[33, 13], [44, 16], [52, 12]],
      [[28, 22], [20, 19]],
    ];
    for (const p of paths) {
      c.beginPath();
      p.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.stroke();
    }
  });
}

function buildTextures(engine) {
  const bricks = {};
  for (const code of Object.keys(COLORS)) bricks[code] = brickTex(engine, code);

  const paddleCap = makeTex(engine, 14, PADDLE_H, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.35, '#b9f6ff');
    g.addColorStop(1, '#2a7fa8');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(w, 0); c.lineTo(h / 2, 0); c.arc(h / 2, h / 2, h / 2, -Math.PI / 2, Math.PI / 2, true); c.lineTo(w, h);
    c.closePath();
    c.fill();
    c.fillStyle = '#ff5fd2';
    c.fillRect(w - 4, 2, 3, h - 4);
  });
  const paddleMid = makeTex(engine, 8, PADDLE_H, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.35, '#b9f6ff');
    g.addColorStop(1, '#2a7fa8');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  });
  const ball = makeTex(engine, 16, 16, (c) => {
    const g = c.createRadialGradient(6, 5, 1, 8, 8, 8);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.6, '#dff7ff');
    g.addColorStop(1, '#7fb8d8');
    c.fillStyle = g;
    c.beginPath(); c.arc(8, 8, 7.5, 0, TAU); c.fill();
  });
  const glow = makeTex(engine, 32, 32, (c) => {
    const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 32, 32);
  });
  const powers = {};
  for (const [kind, p] of Object.entries(POWERS)) {
    powers[kind] = makeTex(engine, 40, 20, (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, shade(p.color, 1.4));
      g.addColorStop(0.5, p.color);
      g.addColorStop(1, shade(p.color, 0.5));
      roundRect(c, 1, 1, w - 2, h - 2, (h - 2) / 2);
      c.fillStyle = g;
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.8)';
      c.lineWidth = 1.5;
      c.stroke();
      c.fillStyle = '#10121e';
      c.font = 'bold 13px sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(p.letter, w / 2, h / 2 + 1);
    });
  }
  const bg = engine.assets.createTexture(W, H, (c) => {
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0d0b24');
    g.addColorStop(1, '#170a2a');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(120,90,255,0.07)';
    c.lineWidth = 1;
    for (let x = 0; x <= W; x += 40) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); c.stroke(); }
    for (let y = 0; y <= H; y += 40) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); c.stroke(); }
    const v = c.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    c.fillStyle = v;
    c.fillRect(0, 0, W, H);
  }, { smooth: true });
  return { bricks, crack: crackTex(engine), paddleCap, paddleMid, ball, glow, powers, bg };
}

// ------------------------------------------------------------------ helpers

function pickWeighted(rnd, table) {
  let total = 0;
  for (const [, w] of table) total += w;
  let t = rnd.range(0, total);
  for (const [k, w] of table) {
    t -= w;
    if (t <= 0) return k;
  }
  return table[0][0];
}

/** Circle vs AABB: returns { axis: 'x'|'y', overlap } or null. */
function hitRect(b, x, y, w, h) {
  const cx = Math.max(x, Math.min(b.x, x + w));
  const cy = Math.max(y, Math.min(b.y, y + h));
  const dx = b.x - cx;
  const dy = b.y - cy;
  if (dx * dx + dy * dy > b.r * b.r) return null;
  const ox = b.r + w / 2 - Math.abs(b.x - (x + w / 2));
  const oy = b.r + h / 2 - Math.abs(b.y - (y + h / 2));
  return ox < oy ? { axis: 'x', overlap: ox, sign: Math.sign(b.x - (x + w / 2)) || 1 } : { axis: 'y', overlap: oy, sign: Math.sign(b.y - (y + h / 2)) || 1 };
}

// ------------------------------------------------------------------ game

const game = {
  async load(engine) {
    const data = await engine.assets.loadJSON('assets/levels.json');
    this.levels = data.levels;
    this.tex = buildTextures(engine);
    this.shards = new engine.ParticleEmitter({
      life: [0.4, 0.9], speed: [60, 260], size: [3, 7], sizeEnd: 0, gravityY: 700, drag: 0.6,
      spin: [-8, 8], color: '#ffffff', maxParticles: 1500,
    });
    this.sparks = new engine.ParticleEmitter({
      texture: this.tex.glow, blend: 'additive', life: [0.15, 0.4], speed: [60, 240], size: [6, 12], sizeEnd: 0,
      color: ['#4cf2ff', '#ffffff', '#ff5fd2'], maxParticles: 800,
    });
    this.trail = new engine.ParticleEmitter({
      texture: this.tex.glow, blend: 'additive', life: [0.15, 0.3], speed: [0, 10], size: [12, 16], sizeEnd: 2,
      color: ['#4cf2ff', '#8ea2ff'], maxParticles: 600,
    });
    this.best = Number(engine.storage.get('best', 0)) || 0;
    this.bestLevel = Number(engine.storage.get('bestLevel', 0)) || 0;
    this.popups = [];
    this.state = 'title';
    this.stateTime = 0;
    this.lastMouseX = engine.input.mouse.x;
    this.newGame(engine);
  },

  newGame(engine) {
    this.score = 0;
    this.shownScore = 0;
    this.lives = 3;
    this.levelIndex = 0;
    this.loop = 0; // completed passes through all levels (speeds things up)
    this.powerCount = 0;
    this.paddle = { x: W / 2, w: 110, targetW: 110, vx: 0, glow: 0 };
    this.effects = { wide: 0, slow: 0, laser: 0, catch: 0 };
    this.lasers = [];
    this.powerups = [];
    this.balls = [];
    this.loadLevel(engine, 0);
  },

  loadLevel(engine, index) {
    this.levelIndex = index;
    const def = this.levels[index % this.levels.length];
    this.levelName = def.name;
    this.bricks = [];
    def.rows.forEach((row, r) => {
      for (let c = 0; c < Math.min(COLS, row.length); c++) {
        const code = row[c];
        if (!COLORS[code]) continue;
        const kind = code === 'X' ? 'steel' : code === '*' ? 'explosive' : code === 'T' ? 'tough' : code === 'H' ? 'hard' : 'normal';
        const hp = kind === 'tough' ? 2 : kind === 'hard' ? 3 : 1;
        const brick = {
          code, kind, col: c, row: r, x: BX + c * BW, y: BY + r * BH, hp, maxHp: hp, s: 0, flash: 0, dead: false,
        };
        this.bricks.push(brick);
        // Drop-in animation (also shows up as active tweens in the F3 overlay).
        engine.tweens.to(brick, { s: 1 }, 0.45, { delay: 0.15 + r * 0.06 + Math.abs(c - 5.5) * 0.025, ease: 'backOut' });
      }
    });
    this.grid = new Map(this.bricks.map((b) => [b.col + ',' + b.row, b]));
    this.livesLostThisLevel = 0;
    this.chain = 0;
    this.lasers = [];
    this.powerups = [];
    this.effects.slow = 0;
    this.serve(engine);
  },

  serve(engine) {
    this.balls = [this.makeBall(this.paddle.x, PADDLE_Y - BALL_R - 1, 0, 0)];
    this.balls[0].stuck = true;
    this.balls[0].stuckOffset = engine.random.range(-12, 12);
    this.balls[0].stuckTime = 0;
    this.chain = 0;
  },

  makeBall(x, y, vx, vy) {
    return { x, y, vx, vy, r: BALL_R, stuck: false, stuckOffset: 0, stuckTime: 0, speedBoost: 1 };
  },

  ballSpeed() {
    const level = 1 + this.levelIndex * 0.05 + this.loop * 0.15;
    return BASE_SPEED * level * (this.effects.slow > 0 ? 0.68 : 1);
  },

  // ---------------------------------------------------------------- update

  update(engine, dt) {
    const input = engine.input;
    if (input.wasPressed('KeyM')) engine.audio.muted = !engine.audio.muted;
    this.stateTime += dt;
    this.shards.update(dt);
    this.sparks.update(dt);
    this.trail.update(dt);
    for (const p of this.popups) { p.t -= dt; p.y -= 34 * dt; }
    this.popups = this.popups.filter((p) => p.t > 0);
    this.shownScore += (this.score - this.shownScore) * Math.min(1, dt * 10);
    if (Math.abs(this.score - this.shownScore) < 1) this.shownScore = this.score;
    for (const b of this.bricks) b.flash = Math.max(0, b.flash - dt * 5);

    const go = input.wasPressed('Space') || input.wasPressed('Enter') || input.mouse.pressed || input.gamepad(0).wasPressed('A');
    switch (this.state) {
      case 'title':
        this.updatePaddle(engine, dt);
        this.followStuck();
        if (this.stateTime > 0.3 && go) {
          this.newGame(engine);
          this.setState('play');
          engine.audio.tone({ freq: 330, freqEnd: 990, duration: 0.25, type: 'triangle', volume: 0.3 });
        }
        return;
      case 'over':
      case 'win':
        if (this.stateTime > 1.2 && go) this.setState('title');
        return;
      case 'clear':
        this.updatePaddle(engine, dt);
        if (this.stateTime > 2.2) this.nextLevel(engine);
        return;
    }

    // --- play ---
    for (const k of Object.keys(this.effects)) this.effects[k] = Math.max(0, this.effects[k] - dt);
    this.paddle.targetW = this.effects.wide > 0 ? 170 : 110;
    this.updatePaddle(engine, dt);
    this.followStuck();

    // Launch stuck balls (serve or catch power-up).
    for (const b of this.balls) {
      if (!b.stuck) continue;
      b.stuckTime += dt;
      if (go || (b.caught && b.stuckTime > 2.5)) this.launch(engine, b);
    }
    // Lasers
    if (this.effects.laser > 0) {
      this.laserCooldown = (this.laserCooldown ?? 0) - dt;
      const fire = input.isDown('Space') || input.mouse.down || input.gamepad(0).isDown('A');
      if (fire && this.laserCooldown <= 0 && !this.balls.some((b) => b.stuck && !b.caught)) {
        this.laserCooldown = 0.28;
        const p = this.paddle;
        this.lasers.push({ x: p.x - p.w / 2 + 8, y: PADDLE_Y - 4 }, { x: p.x + p.w / 2 - 8, y: PADDLE_Y - 4 });
        engine.audio.tone({ freq: 1400, freqEnd: 500, duration: 0.08, type: 'square', volume: 0.08 });
      }
    }
    this.updateLasers(engine, dt);
    this.updateBalls(engine, dt);
    this.updatePowerups(engine, dt);

    if (this.bricks.every((b) => b.dead || b.kind === 'steel')) this.levelCleared(engine);
  },

  setState(s) {
    this.state = s;
    this.stateTime = 0;
  },

  updatePaddle(engine, dt) {
    const p = this.paddle;
    const input = engine.input;
    p.w += (p.targetW - p.w) * Math.min(1, dt * 10);
    const ax = input.axis('horizontal');
    const mx = input.mouse.x;
    const moved = Math.abs(mx - this.lastMouseX) > 0.01 || input.mouse.down;
    this.lastMouseX = mx;
    const prev = p.x;
    if (ax !== 0) p.x += ax * 720 * dt;
    else if (moved && (input.mouse.inside || input.touches.length)) p.x += (mx - p.x) * Math.min(1, dt * 28);
    p.x = Math.max(p.w / 2 + 6, Math.min(W - p.w / 2 - 6, p.x));
    p.vx = (p.x - prev) / dt;
    p.glow = Math.max(0, p.glow - dt * 3);
  },

  followStuck() {
    for (const b of this.balls) {
      if (!b.stuck) continue;
      b.x = this.paddle.x + b.stuckOffset;
      b.y = PADDLE_Y - BALL_R - 1;
    }
  },

  launch(engine, b) {
    b.stuck = false;
    b.caught = false;
    const off = Math.max(-1, Math.min(1, b.stuckOffset / (this.paddle.w / 2)));
    const ang = off * 0.9 + engine.random.range(-0.12, 0.12);
    const s = this.ballSpeed();
    b.vx = Math.sin(ang) * s;
    b.vy = -Math.cos(ang) * s;
    engine.audio.tone({ freq: 520, freqEnd: 780, duration: 0.08, type: 'triangle', volume: 0.18 });
  },

  updateBalls(engine, dt) {
    const target = this.ballSpeed();
    for (const b of this.balls) {
      if (b.stuck) continue;
      // Ease the ball's speed toward the current target (slow power-up, level speed).
      let sp = Math.hypot(b.vx, b.vy) || target;
      const want = target * b.speedBoost;
      sp += (want - sp) * Math.min(1, dt * 2);
      const a = Math.atan2(b.vy, b.vx);
      b.vx = Math.cos(a) * sp;
      b.vy = Math.sin(a) * sp;
      b.speedBoost = Math.max(1, b.speedBoost - dt * 0.02);

      const steps = Math.max(1, Math.ceil((sp * dt) / 4));
      const h = dt / steps;
      for (let i = 0; i < steps && !b.lost; i++) this.stepBall(engine, b, h);
      if (engine.random.chance(0.8)) this.trail.burst(1, b.x, b.y);
    }
    const before = this.balls.length;
    this.balls = this.balls.filter((b) => !b.lost);
    if (before > 0 && this.balls.length === 0) this.loseLife(engine);
  },

  stepBall(engine, b, h) {
    b.x += b.vx * h;
    b.y += b.vy * h;
    // walls
    if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); this.wallBounce(engine, b); }
    if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx); this.wallBounce(engine, b); }
    if (b.y < TOP + b.r) { b.y = TOP + b.r; b.vy = Math.abs(b.vy); this.wallBounce(engine, b); }
    if (b.y > H + 30) { b.lost = true; return; }

    // paddle
    const p = this.paddle;
    if (b.vy > 0) {
      const hit = hitRect(b, p.x - p.w / 2, PADDLE_Y, p.w, PADDLE_H);
      if (hit && b.y < PADDLE_Y + PADDLE_H / 2) {
        const off = Math.max(-1, Math.min(1, (b.x - p.x) / (p.w / 2 + b.r)));
        const ang = off * 1.05 + Math.max(-0.15, Math.min(0.15, p.vx / 6000));
        const s = Math.hypot(b.vx, b.vy);
        b.vx = Math.sin(ang) * s;
        b.vy = -Math.abs(Math.cos(ang) * s);
        b.y = PADDLE_Y - b.r - 0.5;
        b.speedBoost = Math.min(1.35, b.speedBoost + 0.015);
        p.glow = 1;
        this.sparks.burst(8, b.x, PADDLE_Y);
        if (this.chain >= 3) this.popups.push({ x: b.x, y: PADDLE_Y - 24, t: 0.9, text: `${this.chain} CHAIN`, color: '#8ea2ff', size: 16 });
        this.chain = 0;
        if (this.effects.catch > 0) {
          b.stuck = true;
          b.caught = true;
          b.stuckTime = 0;
          b.stuckOffset = b.x - p.x;
          engine.audio.tone({ freq: 300, duration: 0.06, type: 'sine', volume: 0.2 });
        } else engine.audio.tone({ freq: 220, freqEnd: 330, duration: 0.07, type: 'square', volume: 0.14 });
        return;
      }
    }

    // bricks: resolve the deepest contact only (avoids double reflections on seams)
    let best = null;
    let bestBrick = null;
    for (const br of this.bricks) {
      if (br.dead || br.s < 0.5) continue;
      if (Math.abs(br.x + BW / 2 - b.x) > BW / 2 + b.r + 1 || Math.abs(br.y + BH / 2 - b.y) > BH / 2 + b.r + 1) continue;
      const hit = hitRect(b, br.x, br.y, BW, BH);
      if (hit && (!best || hit.overlap > best.overlap)) {
        best = hit;
        bestBrick = br;
      }
    }
    if (best) {
      if (best.axis === 'x') { b.vx = Math.abs(b.vx) * best.sign; b.x += best.overlap * best.sign; }
      else { b.vy = Math.abs(b.vy) * best.sign; b.y += best.overlap * best.sign; }
      this.fixAngle(engine, b);
      this.damageBrick(engine, bestBrick, 1, b.x, b.y);
    }
  },

  /** Prevent near-horizontal (or perfectly vertical) loops by nudging the angle. */
  fixAngle(engine, b) {
    const s = Math.hypot(b.vx, b.vy);
    if (s === 0) return;
    let a = Math.atan2(b.vy, b.vx);
    const minV = 0.32;
    const vyN = Math.sin(a);
    if (Math.abs(vyN) < minV) {
      const sy = vyN >= 0 ? 1 : -1;
      a = Math.atan2(sy * minV, Math.cos(a) >= 0 ? Math.sqrt(1 - minV * minV) : -Math.sqrt(1 - minV * minV));
    }
    if (Math.abs(Math.cos(a)) < 0.05) a += engine.random.sign() * 0.08;
    b.vx = Math.cos(a) * s;
    b.vy = Math.sin(a) * s;
  },

  wallBounce(engine, b) {
    this.fixAngle(engine, b);
    this.sparks.burst(3, b.x, b.y);
    engine.audio.tone({ freq: 180, duration: 0.04, type: 'sine', volume: 0.08 });
  },

  damageBrick(engine, br, dmg, x, y) {
    if (br.dead) return;
    br.flash = 1;
    if (br.kind === 'steel') {
      this.sparks.burst(5, x, y);
      engine.audio.tone({ freq: 1200, freqEnd: 900, duration: 0.05, type: 'triangle', volume: 0.1 });
      return;
    }
    br.hp -= dmg;
    if (br.hp > 0) {
      engine.audio.tone({ freq: 260 + br.hp * 60, duration: 0.06, type: 'square', volume: 0.12 });
      this.sparks.burst(6, x, y);
      return;
    }
    this.breakBrick(engine, br);
  },

  breakBrick(engine, br) {
    br.dead = true;
    this.chain++;
    const mult = Math.min(8, 1 + Math.floor((this.chain - 1) / 3));
    const pts = POINTS[br.kind] * mult;
    this.score += pts;
    const cx = br.x + BW / 2;
    const cy = br.y + BH / 2;
    this.popups.push({ x: cx, y: cy, t: 0.7, text: mult > 1 ? `+${pts} x${mult}` : `+${pts}`, color: mult > 1 ? '#ffd93d' : '#ffffff', size: mult > 1 ? 16 : 13 });
    this.shards.config.color = [COLORS[br.code], shade(COLORS[br.code], 1.4), '#ffffff'];
    this.shards.burst(16, cx, cy);
    this.sparks.burst(6, cx, cy);
    const semis = Math.min(this.chain - 1, 19);
    engine.audio.tone({ freq: 392 * Math.pow(2, semis / 12), freqEnd: 392 * Math.pow(2, (semis + 3) / 12), duration: 0.09, type: 'triangle', volume: 0.2 });
    engine.camera.shake(1.5 + Math.min(4, this.chain * 0.3), 0.12);

    unlock(engine, 'first_brick');
    if (this.chain >= 10) unlock(engine, 'chain_reaction');
    if (this.chain === 5 || this.chain === 10 || this.chain === 15 || this.chain === 20)
      this.popups.push({ x: W / 2, y: H / 2 + 40, t: 1.1, text: `${this.chain} HIT COMBO!`, color: '#ff9f43', size: 30 });

    if (br.kind === 'explosive') {
      engine.camera.shake(8, 0.3);
      engine.audio.noise({ duration: 0.35, volume: 0.35, filterStart: 2500, filterEnd: 150 });
      this.sparks.config.color = ['#ff9f43', '#ffd93d', '#ff3b3b'];
      this.sparks.burst(40, cx, cy);
      this.sparks.config.color = ['#4cf2ff', '#ffffff', '#ff5fd2'];
      engine.after(0.09, () => {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const n = this.grid.get(br.col + dx + ',' + (br.row + dy));
            if (n && !n.dead && n.kind !== 'steel' && this.state === 'play') this.damageBrick(engine, n, 99, n.x + BW / 2, n.y + BH / 2);
          }
      });
    }
    if (engine.random.chance(br.kind === 'normal' ? 0.11 : 0.22)) {
      let kind = pickWeighted(engine.random, POWER_WEIGHTS);
      if (kind === 'life' && this.lives >= MAX_LIVES) kind = 'wide';
      this.powerups.push({ x: cx, y: cy, kind, t: 0 });
    }
  },

  updateLasers(engine, dt) {
    for (const l of this.lasers) {
      l.y -= 760 * dt;
      if (l.y < TOP) { l.dead = true; continue; }
      for (const br of this.bricks) {
        if (br.dead || l.dead) continue;
        if (l.x >= br.x && l.x <= br.x + BW && l.y >= br.y && l.y <= br.y + BH) {
          l.dead = true;
          this.damageBrick(engine, br, 1, l.x, l.y);
        }
      }
    }
    this.lasers = this.lasers.filter((l) => !l.dead);
  },

  updatePowerups(engine, dt) {
    const p = this.paddle;
    for (const u of this.powerups) {
      u.t += dt;
      u.y += 140 * dt;
      if (u.y > H + 20) u.dead = true;
      if (!u.dead && Math.abs(u.x - p.x) < p.w / 2 + 20 && u.y + 10 > PADDLE_Y && u.y - 10 < PADDLE_Y + PADDLE_H) {
        u.dead = true;
        this.collect(engine, u);
      }
    }
    this.powerups = this.powerups.filter((u) => !u.dead);
  },

  collect(engine, u) {
    const def = POWERS[u.kind];
    this.powerCount++;
    if (this.powerCount >= 5) unlock(engine, 'power_hungry');
    this.score += 100;
    this.popups.push({ x: u.x, y: PADDLE_Y - 30, t: 1.1, text: def.label, color: def.color, size: 18 });
    engine.audio.tone({ freq: 523, freqEnd: 1046, duration: 0.25, type: 'triangle', volume: 0.28 });
    this.sparks.burst(20, u.x, PADDLE_Y);
    switch (u.kind) {
      case 'wide': this.effects.wide = 15; break;
      case 'slow': this.effects.slow = 10; break;
      case 'laser': this.effects.laser = 10; break;
      case 'catch': this.effects.catch = 12; break;
      case 'life': this.lives = Math.min(MAX_LIVES, this.lives + 1); break;
      case 'multi': {
        const extra = [];
        for (const b of this.balls.slice(0, 6)) {
          if (b.stuck) this.launch(engine, b);
          const s = Math.hypot(b.vx, b.vy);
          const a = Math.atan2(b.vy, b.vx);
          for (const d of [-0.45, 0.45]) extra.push(this.makeBall(b.x, b.y, Math.cos(a + d) * s, Math.sin(a + d) * s));
        }
        for (const b of extra) this.fixAngle(engine, b);
        this.balls.push(...extra);
        break;
      }
    }
  },

  loseLife(engine) {
    this.lives--;
    this.livesLostThisLevel++;
    this.effects.wide = this.effects.laser = this.effects.catch = this.effects.slow = 0;
    this.powerups = [];
    this.lasers = [];
    engine.camera.shake(10, 0.4);
    engine.audio.tone({ freq: 440, freqEnd: 70, duration: 0.6, type: 'sawtooth', volume: 0.3 });
    if (this.lives <= 0) {
      this.endGame(engine, 'over');
      return;
    }
    this.popups.push({ x: W / 2, y: H / 2 + 60, t: 1.2, text: `${this.lives} ${this.lives === 1 ? 'LIFE' : 'LIVES'} LEFT`, color: '#ff8fab', size: 24 });
    this.serve(engine);
  },

  levelCleared(engine) {
    const bonus = 500 * (this.levelIndex + 1) + this.lives * 100;
    this.score += bonus;
    this.clearBonus = bonus;
    this.clearFlawless = this.livesLostThisLevel === 0;
    if (this.levelIndex === 0) unlock(engine, 'wall_breaker');
    if (this.clearFlawless) unlock(engine, 'flawless');
    this.lasers = [];
    this.powerups = [];
    this.balls = [];
    engine.tweens.killTweensOf(this.paddle);
    engine.audio.tone({ freq: 523, freqEnd: 1568, duration: 0.6, type: 'triangle', volume: 0.3 });
    for (let i = 0; i < 6; i++) engine.after(i * 0.12, () => this.sparks.burst(30, engine.random.range(100, W - 100), engine.random.range(120, 300)));
    const reached = this.levelIndex + 1 + this.loop * this.levels.length;
    if (reached > this.bestLevel) {
      this.bestLevel = reached;
      engine.storage.set('bestLevel', reached);
    }
    if (this.levelIndex === this.levels.length - 1 && this.loop === 0) {
      unlock(engine, 'champion');
      this.endGame(engine, 'win');
      return;
    }
    this.setState('clear');
  },

  nextLevel(engine) {
    let next = this.levelIndex + 1;
    if (next >= this.levels.length) { next = 0; this.loop++; }
    this.loadLevel(engine, next);
    this.setState('play');
  },

  endGame(engine, state) {
    this.balls = [];
    this.newBest = this.score > this.best;
    if (this.newBest) {
      this.best = this.score;
      engine.storage.set('best', this.best);
    }
    engine.platform.submitScore(this.score);
    this.setState(state);
  },

  // ---------------------------------------------------------------- render

  render(engine) {
    const r = engine.renderer;
    const t = engine.time;
    r.drawSprite(this.tex.bg, 0, 0, { w: W, h: H });

    // side rails + ceiling
    r.drawRect(0, TOP - 4, W, 4, '#2a2050');
    r.setBlend('additive');
    r.drawRect(0, TOP - 2, W, 1, '#8ea2ff', { alpha: 0.5 });
    r.setBlend('normal');

    this.drawBricks(r, t);
    this.drawPowerups(r, t);

    // lasers
    r.setBlend('additive');
    for (const l of this.lasers) {
      r.drawRect(l.x - 1.5, l.y - 12, 3, 14, '#ff4d6d');
      r.drawSprite(this.tex.glow, l.x, l.y - 5, { w: 16, h: 28, originX: 0.5, originY: 0.5, tint: '#ff4d6d', alpha: 0.6 });
    }
    this.trail.draw(r);
    r.setBlend('normal');

    this.drawPaddle(r, t);
    for (const b of this.balls) {
      r.setBlend('additive');
      r.drawSprite(this.tex.glow, b.x, b.y, { w: 40, h: 40, originX: 0.5, originY: 0.5, tint: this.effects.slow > 0 ? '#5cff8a' : '#4cf2ff', alpha: 0.7 });
      r.setBlend('normal');
      r.drawSprite(this.tex.ball, b.x, b.y, { w: b.r * 2 + 2, h: b.r * 2 + 2, originX: 0.5, originY: 0.5 });
    }
    this.shards.draw(r);
    r.setBlend('additive');
    this.sparks.draw(r);
    r.setBlend('normal');

    r.ui(() => this.drawHud(engine, r, t));
  },

  drawBricks(r, t) {
    for (const b of this.bricks) {
      if (b.dead || b.s <= 0.01) continue;
      const s = b.s;
      const drop = (1 - Math.min(1, s)) * -40;
      const cx = b.x + BW / 2;
      const cy = b.y + BH / 2 + drop;
      const tex = this.tex.bricks[b.code];
      const pulse = b.kind === 'explosive' ? 0.85 + Math.sin(t * 8 + b.col) * 0.15 : 1;
      r.drawSprite(tex, cx, cy, { w: BW * s, h: BH * s, originX: 0.5, originY: 0.5, alpha: Math.min(1, s), tint: [pulse, pulse, pulse, 1] });
      if (b.hp < b.maxHp) r.drawSprite(this.tex.crack, cx, cy, { w: BW * s, h: BH * s, originX: 0.5, originY: 0.5, alpha: 0.5 + 0.5 * (1 - b.hp / b.maxHp) });
      if (b.flash > 0) {
        r.setBlend('additive');
        r.drawSprite(tex, cx, cy, { w: BW * s, h: BH * s, originX: 0.5, originY: 0.5, alpha: b.flash * 0.8 });
        r.setBlend('normal');
      }
    }
  },

  drawPowerups(r, t) {
    for (const u of this.powerups) {
      const def = POWERS[u.kind];
      r.setBlend('additive');
      r.drawSprite(this.tex.glow, u.x, u.y, { w: 70, h: 44, originX: 0.5, originY: 0.5, tint: def.color, alpha: 0.45 + Math.sin(t * 10) * 0.15 });
      r.setBlend('normal');
      const wob = 1 + Math.sin(u.t * 6) * 0.06;
      r.drawSprite(this.tex.powers[u.kind], u.x, u.y, { w: 40 * wob, h: 20 * wob, originX: 0.5, originY: 0.5 });
    }
  },

  drawPaddle(r, t) {
    if (this.state === 'over' || this.state === 'win') return;
    const p = this.paddle;
    const x0 = p.x - p.w / 2;
    const cap = 14;
    const tint = this.effects.catch > 0 ? '#fff6b0' : '#ffffff';
    r.setBlend('additive');
    r.drawSprite(this.tex.glow, p.x, PADDLE_Y + PADDLE_H / 2, { w: p.w + 60, h: 50, originX: 0.5, originY: 0.5, tint: this.effects.catch > 0 ? '#ffd93d' : '#4cf2ff', alpha: 0.35 + p.glow * 0.4 });
    r.setBlend('normal');
    r.drawSprite(this.tex.paddleCap, x0, PADDLE_Y, { w: cap, h: PADDLE_H, tint });
    r.drawSprite(this.tex.paddleMid, x0 + cap, PADDLE_Y, { w: Math.max(0, p.w - cap * 2), h: PADDLE_H, tint });
    r.drawSprite(this.tex.paddleCap, x0 + p.w - cap, PADDLE_Y, { w: cap, h: PADDLE_H, flipX: true, tint });
    if (this.effects.laser > 0) {
      const blink = this.effects.laser < 2 && Math.sin(t * 20) < 0 ? 0.4 : 1;
      for (const gx of [x0 + 5, x0 + p.w - 11]) r.drawRect(gx, PADDLE_Y - 6, 6, 8, '#ff4d6d', { alpha: blink });
    }
  },

  drawHud(engine, r, t) {
    r.drawRect(0, 0, W, TOP - 4, '#0a0818', { alpha: 0.85 });
    r.drawText(String(Math.round(this.shownScore)).padStart(6, '0'), 16, TOP / 2 - 2, { size: 24, baseline: 'middle', color: '#ffffff', font: 'mono' });
    r.drawText(`BEST ${Math.max(this.best, this.score)}`, 150, TOP / 2 - 2, { size: 13, baseline: 'middle', color: '#8ea2ff' });
    r.drawText(`LEVEL ${this.levelIndex + 1 + this.loop * this.levels.length} · ${this.levelName.toUpperCase()}`, W / 2, TOP / 2 - 2, { size: 15, align: 'center', baseline: 'middle', color: '#cfd6ff' });
    for (let i = 0; i < this.lives; i++) r.drawSprite(this.tex.ball, W - 22 - i * 20, TOP / 2 - 2, { w: 14, h: 14, originX: 0.5, originY: 0.5 });
    // active effects
    let ex = W - 24;
    const ey = H - 16;
    for (const [k, v] of Object.entries(this.effects)) {
      if (v <= 0) continue;
      r.drawSprite(this.tex.powers[k], ex, ey, { w: 28, h: 14, originX: 0.5, originY: 0.5, alpha: v < 2 && Math.sin(t * 20) < 0 ? 0.35 : 1 });
      ex -= 34;
    }
    if (this.chain >= 3 && this.state === 'play') {
      const mult = Math.min(8, 1 + Math.floor((this.chain - 1) / 3));
      r.drawText(`COMBO ${this.chain}  x${mult}`, 16, H - 16, { size: 15, baseline: 'middle', color: '#ffd93d', shadow: '#000' });
    }

    for (const p of this.popups) {
      r.drawText(p.text, p.x, p.y, { size: p.size ?? 14, align: 'center', baseline: 'middle', color: p.color ?? '#fff', alpha: Math.min(1, p.t * 2.5), shadow: '#000' });
    }

    const stuck = this.balls.some((b) => b.stuck && !b.caught);
    if (this.state === 'play' && stuck && this.bricks.some((b) => b.s >= 1))
      r.drawText('CLICK / SPACE TO LAUNCH', W / 2, H / 2 + 110, { size: 16, align: 'center', baseline: 'middle', color: '#cfd6ff', alpha: 0.6 + Math.sin(t * 5) * 0.4 });

    if (this.state === 'title') this.drawPanel(r, t, 'BRICK BREAKER', [
      'Break every brick. Chain hits for combo multipliers.',
      'Catch power-ups: W wide · M multi-ball · S slow · L lasers · C catch · + life',
      '',
      `Best ${this.best}   ·   Furthest level ${this.bestLevel}`,
    ], 'CLICK, TAP OR PRESS SPACE');
    else if (this.state === 'clear') this.drawPanel(r, t, 'LEVEL CLEAR!', [
      `Bonus +${this.clearBonus}${this.clearFlawless ? '   ·   FLAWLESS!' : ''}`,
    ], null);
    else if (this.state === 'over') this.drawPanel(r, t, 'GAME OVER', [
      `Score ${this.score}${this.newBest ? '   ·   NEW BEST!' : ''}`,
      `Reached level ${this.levelIndex + 1 + this.loop * this.levels.length}`,
    ], this.stateTime > 1.2 ? 'CLICK TO CONTINUE' : null);
    else if (this.state === 'win') this.drawPanel(r, t, 'YOU WIN!', [
      'All six walls are rubble. Champion!',
      `Final score ${this.score}${this.newBest ? '   ·   NEW BEST!' : ''}`,
    ], this.stateTime > 1.2 ? 'CLICK TO CONTINUE' : null);
  },

  drawPanel(r, t, title, lines, prompt) {
    const ph = 120 + lines.length * 26 + (prompt ? 30 : 0);
    const py = H / 2 - ph / 2 - 20;
    r.drawRect(W / 2 - 330, py, 660, ph, '#0b0920', { alpha: 0.88 });
    r.strokeRect(W / 2 - 330, py, 660, ph, '#6b5cff', 2, 0.8);
    const bounce = Math.sin(t * 3) * 3;
    r.drawText(title, W / 2, py + 48 + bounce, { size: 46, align: 'center', baseline: 'middle', color: '#ffffff', shadow: '#ff5fd2', shadowOffset: 3, letterSpacing: 2 });
    lines.forEach((l, i) => r.drawText(l, W / 2, py + 100 + i * 26, { size: 16, align: 'center', baseline: 'middle', color: '#cfd6ff' }));
    if (prompt) r.drawText(prompt, W / 2, py + ph - 26, { size: 16, align: 'center', baseline: 'middle', color: '#ffd93d', alpha: 0.6 + Math.sin(t * 5) * 0.4 });
  },
};

export default game;

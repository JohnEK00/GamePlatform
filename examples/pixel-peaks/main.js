// Pixel Peaks — a small platformer showing off Pixelforge's Tilemap, Physics, scenes,
// sprite sheets, particles, tweens and camera. Levels live in assets/levels.json.

const W = 480;
const H = 270;
const T = 16; // tile size

// Tile ids in the Tilemap
const GROUND = 1;
const PLATFORM = 2;
const SPIKES = 3;
const BRICK = 4;
const LEGEND = { '#': GROUND, '=': PLATFORM, '^': SPIKES, B: BRICK };

// Frames in the generated sprite sheet (16×16 each)
const F = {
  grass: 0, dirt: 1, plank: 2, spikes: 3, brick: 4,
  idle: 5, run1: 6, run2: 7, jump: 8,
  slime1: 9, slime2: 10, slimeFlat: 11,
  coin: [12, 13, 14, 13], flag: 15, heart: 16, mover: 17, heartEmpty: 18,
};

// ------------------------------------------------------------------ art

const PALETTE = {
  k: '#1a1c2c', r: '#e43b44', R: '#a22633', s: '#f7c8a0', b: '#3b5dc9', B: '#29366f', w: '#ffffff',
  y: '#feae34', Y: '#fee761', g: '#63c74d', G: '#3e8948', h: '#733e39', e: '#5a6988', l: '#c0cbdc',
};

function px(ctx, ox, oy, rows) {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = PALETTE[row[x]];
      if (c) {
        ctx.fillStyle = c;
        ctx.fillRect(ox + x, oy + y, 1, 1);
      }
    }
  });
}

const HERO_TOP = [
  '................',
  '.....kkkkkk.....',
  '....krrrrrrk....',
  '...krrrrrrrrk...',
  '...kkkkrrkkkkk..',
  '...ksskssskk....',
  '...ksskwkskk....',
  '...kssssssk.....',
  '....kkssskk.....',
  '...kbbrrbbk.....',
  '..kbbbrrbbbk....',
  '..ksbbbbbbsk....',
];
const HERO_LEGS = {
  idle: ['...kbbbbbbk.....', '...kbbkkbbk.....', '...khhk.khhk....', '...kkkk.kkkk....'],
  run1: ['...kbbbbbbk.....', '..kbbk..kbbk....', '.khhk....khhk...', '.kkk......kkk...'],
  run2: ['...kbbbbbbk.....', '....kbbbbk......', '....khhhhk......', '....kkkkkk......'],
  jump: ['..kbbbbbbbbk....', '.kbbk....kbbk...', '.khhk.....khk...', '.kkk......kk....'],
};

function drawTiles(ctx, frameXY, rnd) {
  // grass-topped ground
  let [x, y] = frameXY(F.grass);
  ctx.fillStyle = '#8f563b'; ctx.fillRect(x, y, 16, 16);
  ctx.fillStyle = '#6e3f2a';
  for (let i = 0; i < 6; i++) ctx.fillRect(x + rnd.int(0, 14), y + rnd.int(6, 14), 2, 1);
  ctx.fillStyle = PALETTE.g; ctx.fillRect(x, y, 16, 5);
  ctx.fillStyle = PALETTE.G; ctx.fillRect(x, y + 5, 16, 1);
  for (let i = 0; i < 16; i += 3) ctx.fillRect(x + i, y + 5, 1, 2);
  ctx.fillStyle = '#9de64e'; ctx.fillRect(x, y, 16, 1);
  // dirt
  [x, y] = frameXY(F.dirt);
  ctx.fillStyle = '#8f563b'; ctx.fillRect(x, y, 16, 16);
  ctx.fillStyle = '#6e3f2a';
  for (let i = 0; i < 8; i++) ctx.fillRect(x + rnd.int(0, 14), y + rnd.int(0, 14), 2, 1);
  ctx.fillStyle = '#a8704f';
  for (let i = 0; i < 4; i++) ctx.fillRect(x + rnd.int(0, 14), y + rnd.int(0, 14), 1, 1);
  // one-way plank
  [x, y] = frameXY(F.plank);
  ctx.fillStyle = '#c28569'; ctx.fillRect(x, y, 16, 6);
  ctx.fillStyle = '#e4a672'; ctx.fillRect(x, y, 16, 1);
  ctx.fillStyle = '#8a4836'; ctx.fillRect(x, y + 5, 16, 1); ctx.fillRect(x + 7, y + 1, 1, 4);
  ctx.fillStyle = '#5d2c28'; ctx.fillRect(x + 2, y + 6, 2, 3); ctx.fillRect(x + 12, y + 6, 2, 3);
  // spikes
  [x, y] = frameXY(F.spikes);
  for (let i = 0; i < 4; i++) {
    const sx = x + i * 4;
    for (let r = 0; r < 7; r++) {
      const half = Math.floor(r / 3.5 * 2) / 2;
      ctx.fillStyle = r < 2 ? PALETTE.w : PALETTE.l;
      ctx.fillRect(sx + 2 - Math.ceil(half), y + 9 + r, Math.max(1, Math.ceil(half) * 2), 1);
    }
  }
  ctx.fillStyle = PALETTE.e; ctx.fillRect(x, y + 15, 16, 1);
  // brick
  [x, y] = frameXY(F.brick);
  ctx.fillStyle = '#be4a2f'; ctx.fillRect(x, y, 16, 16);
  ctx.fillStyle = '#733e39';
  for (let r = 0; r < 4; r++) {
    ctx.fillRect(x, y + r * 4 + 3, 16, 1);
    const off = r % 2 ? 4 : 0;
    ctx.fillRect(x + off + 7, y + r * 4, 1, 3);
    if (off) ctx.fillRect(x + off - 1, y + r * 4, 1, 3);
  }
  ctx.fillStyle = '#d77643'; ctx.fillRect(x, y, 16, 1);
  // moving platform (metal)
  [x, y] = frameXY(F.mover);
  ctx.fillStyle = '#5a6988'; ctx.fillRect(x, y, 16, 7);
  ctx.fillStyle = '#c0cbdc'; ctx.fillRect(x, y, 16, 1);
  ctx.fillStyle = '#3a4466'; ctx.fillRect(x, y + 6, 16, 1);
  ctx.fillStyle = PALETTE.Y; ctx.fillRect(x + 3, y + 3, 2, 1); ctx.fillRect(x + 11, y + 3, 2, 1);
}

function drawSprites(ctx, frameXY) {
  for (const k of ['idle', 'run1', 'run2', 'jump']) {
    const [x, y] = frameXY(F[k]);
    px(ctx, x, y, HERO_TOP.concat(HERO_LEGS[k]));
  }
  const slime = (flat, squish) => {
    const rows = flat
      ? ['', '', '', '', '', '', '', '', '', '', '', '..kkkkkkkkkkkk..', '.kggggggggggggk.', 'kgGgkggggkggGggk', 'kGGGGGGGGGGGGGGk', '.kkkkkkkkkkkkkk.']
      : squish
        ? ['', '', '', '', '', '', '....kkkkkkkk....', '..kkggggggggkk..', '.kggwgggggwgggk.', '.kgwkggggwkgggk.', 'kgggggggggggggGk', 'kgggggkkgggggGGk', 'kGgggggggggggGGk', 'kGGGGGGGGGGGGGGk', '.kkkkkkkkkkkkkk.', '']
        : ['', '', '', '', '', '.....kkkkkk.....', '...kkggggggkk...', '..kggwgggggwgk..', '..kgwkggggwkgk..', '.kgggggggggggGk.', '.kgggggkkggggGk.', '.kGggggggggggGk.', 'kGGgggggggggGGGk', 'kGGGGGGGGGGGGGGk', '.kkkkkkkkkkkkkk.', ''];
    return rows;
  };
  let [x, y] = frameXY(F.slime1); px(ctx, x, y, slime(false, false));
  [x, y] = frameXY(F.slime2); px(ctx, x, y, slime(false, true));
  [x, y] = frameXY(F.slimeFlat); px(ctx, x, y, slime(true, false));
  const coinW = [8, 6, 2];
  coinW.forEach((cw, i) => {
    const [cx, cy] = frameXY(F.coin[i]);
    const left = cx + 8 - cw / 2;
    ctx.fillStyle = PALETTE.k; ctx.fillRect(left - 1, cy + 3, cw + 2, 10); ctx.fillRect(left, cy + 2, cw, 12);
    ctx.fillStyle = PALETTE.y; ctx.fillRect(left, cy + 3, cw, 10);
    ctx.fillStyle = PALETTE.Y; ctx.fillRect(left, cy + 3, Math.max(1, cw - 2), 8);
    if (cw > 4) { ctx.fillStyle = PALETTE.y; ctx.fillRect(cx + 7, cy + 5, 2, 6); }
  });
  [x, y] = frameXY(F.flag);
  ctx.fillStyle = PALETTE.l; ctx.fillRect(x + 3, y, 2, 16);
  ctx.fillStyle = PALETTE.Y; ctx.fillRect(x + 3, y, 2, 1);
  ctx.fillStyle = PALETTE.r; ctx.fillRect(x + 5, y + 1, 10, 7);
  ctx.fillStyle = PALETTE.R; ctx.fillRect(x + 5, y + 7, 10, 1);
  ctx.fillStyle = PALETTE.w; ctx.fillRect(x + 8, y + 3, 4, 3);
  const heart = ['................', '................', '...kkk...kkk....', '..krrrk.krrrk...', '.krwrrrkrrrrrk..', '.krrrrrrrrrrrk..', '.krrrrrrrrrrrk..', '..krrrrrrrrrk...', '...krrrrrrrk....', '....krrrrrk.....', '.....krrrk......', '......krk.......', '.......k........'];
  [x, y] = frameXY(F.heart); px(ctx, x, y, heart);
  [x, y] = frameXY(F.heartEmpty); px(ctx, x, y, heart.map((r) => r.replace(/[rw]/g, 'e')));
}

// ------------------------------------------------------------------ shared run state

const run = { score: 0, lives: 3, coins: 0, level: 0, best: 0 };
let art = null;
let levels = null;

// Achievements are declared in game.json. unlockAchievement is v2; guard so older engines still run.
function unlock(engine, id) {
  if (typeof engine.platform.unlockAchievement === 'function') engine.platform.unlockAchievement(id);
}

function jumpPressed(input) {
  const pad = input.gamepad(0);
  return input.wasPressed('Space') || input.wasPressed('ArrowUp') || input.wasPressed('KeyW') || input.wasPressed('KeyZ') || pad.wasPressed('A');
}
function jumpHeld(input) {
  const pad = input.gamepad(0);
  return input.isDown('Space') || input.isDown('ArrowUp') || input.isDown('KeyW') || input.isDown('KeyZ') || pad.isDown('A');
}

function drawSky(engine, level, cam) {
  const r = engine.renderer;
  const top = engine.Color.from(level.sky[0]);
  const bottom = engine.Color.from(level.sky[1]);
  r.ui(() => {
    const bands = 24;
    for (let i = 0; i < bands; i++) r.drawRect(0, (i * H) / bands, W, H / bands + 1, top.lerp(bottom, i / (bands - 1)));
    // sun
    r.drawCircle(W - 80, 60, 26, '#fff7d6', { alpha: 0.85 });
    // far mountains (parallax 0.15)
    const off1 = -(cam.x * 0.15) % 160;
    for (let i = -1; i < 5; i++) {
      const bx = off1 + i * 160;
      r.drawTriangle(bx, H, bx + 80, 110, bx + 160, H, top.lerp('#2c2a4a', 0.55), 1);
      r.drawTriangle(bx + 66, 121, bx + 80, 110, bx + 94, 121, '#ffffff', 0.8);
    }
    // near hills (parallax 0.35)
    const off2 = -(cam.x * 0.35) % 120;
    for (let i = -1; i < 6; i++) r.drawCircle(off2 + i * 120, H + 30, 90, bottom.lerp('#3e8948', 0.7));
    // clouds
    const t = engine.time;
    for (let i = 0; i < 5; i++) {
      const cx = ((i * 137 + t * (6 + i * 2) - cam.x * 0.08) % (W + 120) + W + 120) % (W + 120) - 60;
      const cy = 30 + ((i * 53) % 70);
      r.drawCircle(cx, cy, 12, '#ffffff', { alpha: 0.8 });
      r.drawCircle(cx + 14, cy - 4, 15, '#ffffff', { alpha: 0.8 });
      r.drawCircle(cx + 30, cy, 11, '#ffffff', { alpha: 0.8 });
    }
  });
}

// ------------------------------------------------------------------ scenes

class TitleScene {
  enter(engine) {
    this.t = 0;
    run.best = engine.storage.get('best', 0) || 0;
    this.cam = { x: 0 };
  }
  update(engine, dt) {
    this.t += dt;
    this.cam.x += dt * 30;
    if (engine.input.wasPressed('KeyM')) engine.audio.muted = !engine.audio.muted;
    if (this.t > 0.3 && engine.input.anyPressed()) {
      Object.assign(run, { score: 0, lives: 3, coins: 0, level: 0 });
      engine.audio.tone({ freq: 392, freqEnd: 784, duration: 0.2, type: 'square', volume: 0.2 });
      engine.scenes.replace(new PlayScene());
    }
  }
  render(engine) {
    const r = engine.renderer;
    drawSky(engine, levels[0], this.cam);
    r.ui(() => {
      const bob = Math.sin(this.t * 2) * 3;
      r.drawText('PIXEL PEAKS', W / 2, 70 + bob, { size: 44, align: 'center', baseline: 'middle', color: '#fee761', shadow: '#1a1c2c', shadowOffset: 3, letterSpacing: 2 });
      r.drawSprite(art.sheet, W / 2 - 16, 120, { frame: [F.run1, F.run2][Math.floor(this.t * 8) % 2], w: 32, h: 32 });
      for (let i = 0; i < 31; i++) r.drawSprite(art.sheet, i * 16 - ((this.cam.x * 2) % 16), 152, { frame: F.grass });
      for (let i = 0; i < 31; i++) for (let j = 1; j < 8; j++) r.drawSprite(art.sheet, i * 16 - ((this.cam.x * 2) % 16), 152 + j * 16, { frame: F.dirt });
      if (Math.floor(this.t * 2) % 2 === 0)
        r.drawText('PRESS ANY KEY OR TAP', W / 2, 200, { size: 16, align: 'center', baseline: 'middle', color: '#ffffff', shadow: '#1a1c2c' });
      r.drawText('Arrows/WASD move · Space jump · stomp slimes · reach the flag', W / 2, 232, { size: 10, align: 'center', baseline: 'middle', color: '#e8e8ff' });
      if (run.best > 0) r.drawText(`BEST ${run.best}`, W / 2, 255, { size: 11, align: 'center', baseline: 'middle', color: '#fee761' });
    });
  }
}

class MessageScene {
  // Overlay scene drawn on top of the (frozen) play scene.
  constructor(title, subtitle, onDone, minTime = 1.2) {
    this.title = title;
    this.subtitle = subtitle;
    this.onDone = onDone;
    this.minTime = minTime;
    this.overlay = true;
    this.t = 0;
    this.fade = { a: 0 };
  }
  enter(engine) {
    engine.tweens.to(this.fade, { a: 1 }, 0.35, { ease: 'quadOut' });
  }
  update(engine, dt) {
    this.t += dt;
    if (this.t > this.minTime && (engine.input.anyPressed() || this.t > this.minTime + 4)) {
      if (!this.done) {
        this.done = true;
        this.onDone(engine);
      }
    }
  }
  render(engine) {
    const r = engine.renderer;
    const a = this.fade.a;
    r.ui(() => {
      r.drawRect(0, 0, W, H, '#1a1c2c', { alpha: 0.6 * a });
      r.drawText(this.title, W / 2, H / 2 - 22 - (1 - a) * 20, { size: 32, align: 'center', baseline: 'middle', color: '#fee761', shadow: '#000', shadowOffset: 2, alpha: a });
      r.drawText(this.subtitle, W / 2, H / 2 + 14, { size: 13, align: 'center', baseline: 'middle', color: '#ffffff', alpha: a, lineHeight: 1.5 });
      if (this.t > this.minTime && Math.floor(this.t * 2) % 2 === 0)
        r.drawText('press any key', W / 2, H / 2 + 60, { size: 11, align: 'center', baseline: 'middle', color: '#c0cbdc', alpha: a });
    });
  }
}

function finishRun(engine, won) {
  const isBest = run.score > run.best;
  if (isBest) {
    run.best = run.score;
    engine.storage.set('best', run.best);
  }
  engine.platform.submitScore(run.score);
  if (won) unlock(engine, 'summit');
  const title = won ? 'YOU WIN!' : 'GAME OVER';
  const sub = `Score ${run.score}   ·   Coins ${run.coins}${isBest ? '\nNEW BEST!' : ''}`;
  engine.scenes.push(new MessageScene(title, sub, (e) => {
    e.scenes.clear();
    e.scenes.push(new TitleScene());
  }, 1.5));
}

class PlayScene {
  load(engine) {
    const def = levels[run.level];
    this.def = def;
    this.map = engine.Tilemap.fromArray(def.rows, T, T, LEGEND).setSolid([GROUND, BRICK]).setOneWay([PLATFORM]);
    this.map.solidBounds.left = this.map.solidBounds.right = true;
    this.world = new engine.Physics({ gravity: 950, tilemap: this.map });
    this.coins = [];
    this.enemies = [];
    this.movers = [];
    this.flag = null;
    this.start = { x: 32, y: 200 };
    def.rows.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        const ch = row[c];
        const x = c * T;
        const y = r * T;
        if (ch === 'P') this.start = { x: x + 3, y: y + 2 };
        else if (ch === 'o') this.coins.push({ x: x + 8, y: y + 8, taken: false, phase: (c + r) * 0.4 });
        else if (ch === 'E') {
          const b = this.world.add({ x: x + 2, y: y + 6, w: 12, h: 10, vx: -30, tag: 'enemy', maxSpeedY: 400 });
          this.enemies.push({ body: b, dir: -1, dead: 0, anim: Math.random() * 2 });
        } else if (ch === 'M' || ch === 'V') {
          const b = this.world.add({ x, y, w: T * 3, h: 7, isStatic: true, oneWay: true, tag: 'mover' });
          const vertical = ch === 'V';
          this.movers.push({ body: b, ox: x, oy: y, vertical, range: vertical ? T * 4 : T * 6, speed: vertical ? 32 : 42 });
          if (vertical) b.vy = -32;
          else b.vx = 42;
        } else if (ch === 'F') this.flag = { x, y, w: 16, h: 16 };
      }
    });
    this.player = this.world.add({ x: this.start.x, y: this.start.y, w: 10, h: 14, maxSpeedY: 520, tag: 'player' });
    this.facing = 1;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.dropTimer = 0;
    this.dead = 0;
    this.won = false;
    this.inv = 0;
    this.time = 0;
    this.anim = 0;
    this.touchMode = false;
    this.touchLatch = false;
    this.dust = new engine.ParticleEmitter({ life: [0.2, 0.45], speed: [10, 40], angle: [Math.PI, Math.PI * 2], size: [3, 4], sizeEnd: 0, color: ['#ffffff', '#e8d6c0'], gravityY: -20 });
    this.sparkle = new engine.ParticleEmitter({ life: [0.3, 0.6], speed: [30, 90], size: [3, 4], sizeEnd: 0, color: ['#fee761', '#feae34', '#ffffff'], spin: [-8, 8], gravityY: 120 });
    this.gore = new engine.ParticleEmitter({ life: [0.4, 0.8], speed: [60, 160], size: [3, 5], sizeEnd: 1, color: ['#63c74d', '#3e8948'], gravityY: 500 });
    this.cam = engine.camera;
    this.cam.zoom = 1;
    this.cam.bounds = this.map.bounds;
    this.cam.centerOn(this.player.centerX, this.player.centerY);
  }

  enter(engine) {
    this.banner = { a: 1 };
    engine.tweens.to(this.banner, { a: 0 }, 0.8, { delay: 1.4, ease: 'quadIn' });
  }

  exit(engine) {
    engine.camera.bounds = null;
    engine.camera.x = engine.camera.y = 0;
  }

  // ---- controls (keyboard / gamepad / touch buttons)
  readControls(engine) {
    const input = engine.input;
    let h = input.axis('horizontal');
    let jp = jumpPressed(input);
    let jh = jumpHeld(input);
    let down = input.isDown('ArrowDown') || input.isDown('KeyS') || input.gamepad(0).isDown('Down');
    if (input.touches.length) this.touchMode = true;
    if (this.touchMode) {
      let jumpTouch = false;
      for (const t of input.touches) {
        if (t.released) continue;
        if (t.x < 60 && t.y > H - 80) h = -1;
        else if (t.x < 130 && t.y > H - 80) h = 1;
        else if (t.x > W - 90 && t.y > H - 90) jumpTouch = true;
      }
      if (jumpTouch) {
        jh = true;
        if (!this.touchLatch) jp = true;
      }
      this.touchLatch = jumpTouch;
    }
    return { h, jp, jh, down };
  }

  update(engine, dt) {
    const input = engine.input;
    if (input.wasPressed('KeyM')) engine.audio.muted = !engine.audio.muted;
    this.time += dt;
    this.anim += dt;
    this.dust.update(dt);
    this.sparkle.update(dt);
    this.gore.update(dt);
    for (const m of this.movers) {
      const b = m.body;
      if (m.vertical) {
        if (b.y <= m.oy - m.range) b.vy = m.speed;
        else if (b.y >= m.oy) b.vy = -m.speed;
      } else {
        if (b.x >= m.ox + m.range) b.vx = -m.speed;
        else if (b.x <= m.ox) b.vx = m.speed;
      }
    }

    const p = this.player;
    if (this.dead > 0) {
      this.dead -= dt;
      if (this.dead <= 0) this.respawn(engine);
      this.world.step(dt);
      return;
    }
    if (this.won) {
      p.vx = 0;
      this.world.step(dt);
      return;
    }

    const c = this.readControls(engine);
    const maxRun = 125;
    const accel = p.onGround ? 1400 : 900;
    if (c.h !== 0) {
      p.vx = engine.math.approach(p.vx, c.h * maxRun, accel * dt);
      this.facing = Math.sign(c.h);
    } else {
      p.vx = engine.math.approach(p.vx, 0, (p.onGround ? 1600 : 500) * dt);
    }

    this.coyote = p.onGround ? 0.1 : this.coyote - dt;
    this.jumpBuffer = c.jp ? 0.12 : this.jumpBuffer - dt;
    this.dropTimer -= dt;
    p.ignoreOneWay = this.dropTimer > 0;
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      if (c.down && this.standingOnOneWay()) {
        this.dropTimer = 0.25;
        p.ignoreOneWay = true;
      } else {
        p.vy = -335;
        engine.audio.tone({ freq: 300, freqEnd: 620, duration: 0.12, type: 'square', volume: 0.12 });
        this.dust.burst(6, p.centerX, p.bottom);
      }
      this.jumpBuffer = 0;
      this.coyote = 0;
    }
    if (!c.jh && p.vy < -140) p.vy = -140; // variable jump height

    const wasAir = !p.onGround;
    const fallSpeed = p.vy;
    this.world.step(dt);
    if (wasAir && p.onGround && fallSpeed > 250) this.dust.burst(5, p.centerX, p.bottom);

    this.inv = Math.max(0, this.inv - dt);
    this.updateEnemies(engine, dt);
    this.checkPickups(engine);
    this.checkHazards(engine);

    // camera: follow with a little look-ahead
    this.cam.follow(p.centerX + this.facing * 24, p.centerY - 10, 0.12);
  }

  standingOnOneWay() {
    const p = this.player;
    const m = this.map;
    const row = m.rowAt(p.bottom + 1);
    if (m.isOneWay(m.colAt(p.x + 1), row) || m.isOneWay(m.colAt(p.right - 1), row)) return true;
    return p.ground && p.ground.oneWay;
  }

  updateEnemies(engine, dt) {
    const p = this.player;
    const m = this.map;
    for (const e of this.enemies) {
      const b = e.body;
      if (e.dead > 0) {
        e.dead -= dt;
        continue;
      }
      e.anim += dt;
      // turn around at walls, ledges and spikes
      const frontX = e.dir > 0 ? b.right + 1 : b.x - 1;
      const below = m.rowAt(b.bottom + 2);
      const ahead = m.colAt(frontX);
      const ledge = b.onGround && !m.isSolid(ahead, below) && !m.isOneWay(ahead, below);
      const spike = m.get(ahead, m.rowAt(b.centerY)) === SPIKES;
      if ((e.dir < 0 && b.touching.left) || (e.dir > 0 && b.touching.right) || ledge || spike) e.dir = -e.dir;
      b.vx = e.dir * 30;
      if (b.y > m.pixelHeight + 50) b.enabled = false;
      if (!b.enabled || this.dead > 0 || !engine.Rect.intersects(p, b)) continue;
      const stomp = p.vy > 40 && p.prevY + p.h <= b.y + 6;
      if (stomp) {
        e.dead = 0.6;
        b.enabled = false;
        p.vy = jumpHeld(engine.input) ? -330 : -220;
        this.addScore(engine, 200, b.centerX, b.y);
        unlock(engine, 'slime_stomper');
        this.gore.burst(12, b.centerX, b.centerY);
        engine.camera.shake(2, 0.15);
        engine.audio.tone({ freq: 180, freqEnd: 90, duration: 0.15, type: 'square', volume: 0.2 });
      } else if (this.inv <= 0) {
        this.die(engine);
      }
    }
  }

  checkPickups(engine) {
    const p = this.player;
    for (const c of this.coins) {
      if (c.taken) continue;
      if (Math.abs(p.centerX - c.x) < 10 && Math.abs(p.centerY - c.y) < 12) {
        c.taken = true;
        run.coins++;
        if (run.coins >= 25) unlock(engine, 'coin_collector');
        this.addScore(engine, 100, c.x, c.y - 6);
        this.sparkle.burst(10, c.x, c.y);
        engine.audio.tone({ freq: 988, duration: 0.06, type: 'square', volume: 0.12 });
        engine.after(0.06, () => engine.audio.tone({ freq: 1319, duration: 0.14, type: 'square', volume: 0.12 }));
      }
    }
    const f = this.flag;
    if (f && !this.won && p.right > f.x + 3 && p.x < f.x + 8 && p.bottom > f.y - 40 && p.y < f.y + 16) this.winLevel(engine);
  }

  checkHazards(engine) {
    const p = this.player;
    if (p.y > this.map.pixelHeight + 30) return this.die(engine, true);
    const m = this.map;
    const { c0, r0, c1, r1 } = m.tileRange(p);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        if (m.get(c, r) === SPIKES && engine.Rect.intersects(p, { x: c * T + 2, y: r * T + 9, w: 12, h: 7 })) return this.die(engine);
  }

  addScore(engine, n, x, y) {
    run.score += n;
    const pop = { x, y, a: 1, n };
    this.pops = this.pops || [];
    this.pops.push(pop);
    engine.tweens.to(pop, { y: y - 18, a: 0 }, 0.8, { ease: 'quadOut', onComplete: () => this.pops.splice(this.pops.indexOf(pop), 1) });
  }

  die(engine, fell = false) {
    if (this.dead > 0 || this.won) return;
    const p = this.player;
    run.lives--;
    this.dead = 1.2;
    this.gore.config.color = ['#e43b44', '#3b5dc9', '#f7c8a0'];
    this.gore.burst(fell ? 4 : 24, p.centerX, Math.min(p.centerY, this.map.pixelHeight));
    this.gore.config.color = ['#63c74d', '#3e8948'];
    p.vx = 0;
    p.vy = fell ? 0 : -250;
    p.enabled = !fell;
    engine.camera.shake(6, 0.35);
    engine.audio.tone({ freq: 523, freqEnd: 65, duration: 0.7, type: 'square', volume: 0.2 });
    if (run.lives <= 0) {
      this.dead = 999;
      engine.after(1.0, () => finishRun(engine, false));
    }
  }

  respawn(engine) {
    const p = this.player;
    p.enabled = true;
    p.x = this.start.x;
    p.y = this.start.y;
    p.vx = p.vy = 0;
    this.inv = 1.5;
    this.cam.centerOn(p.centerX, p.centerY);
  }

  winLevel(engine) {
    this.won = true;
    const bonus = Math.max(0, Math.floor(120 - this.time)) * 10;
    run.score += bonus;
    this.sparkle.burst(40, this.flag.x + 8, this.flag.y);
    engine.audio.tone({ freq: 523, duration: 0.12, type: 'square', volume: 0.2 });
    engine.after(0.12, () => engine.audio.tone({ freq: 659, duration: 0.12, type: 'square', volume: 0.2 }));
    engine.after(0.24, () => engine.audio.tone({ freq: 784, duration: 0.12, type: 'square', volume: 0.2 }));
    engine.after(0.36, () => engine.audio.tone({ freq: 1047, duration: 0.35, type: 'square', volume: 0.2 }));
    const last = run.level >= levels.length - 1;
    engine.after(0.8, () => {
      if (last) {
        finishRun(engine, true);
        return;
      }
      engine.scenes.push(new MessageScene('LEVEL CLEAR!', `Time bonus +${bonus}`, (e) => {
        run.level++;
        e.scenes.clear();
        e.scenes.push(new PlayScene());
      }, 0.8));
    });
  }

  // ---- render
  render(engine) {
    const r = engine.renderer;
    const m = this.map;
    drawSky(engine, this.def, this.cam);

    // tiles: ground shows grass only where nothing solid is above
    m.draw(r, (id, x, y, col, row) => {
      let frame = F.brick;
      if (id === GROUND) frame = m.get(col, row - 1) === GROUND ? F.dirt : F.grass;
      else if (id === PLATFORM) frame = F.plank;
      else if (id === SPIKES) frame = F.spikes;
      r.drawSprite(art.sheet, x, y, { frame });
    });

    for (const mv of this.movers) {
      const b = mv.body;
      for (let i = 0; i < 3; i++) r.drawSprite(art.sheet, b.x + i * T, b.y, { frame: F.mover });
    }
    if (this.flag) {
      const f = this.flag;
      r.drawSprite(art.sheet, f.x, f.y - 16, { frame: F.flag, w: 16, h: 32, flipX: Math.floor(engine.time * 3) % 2 === 0 });
    }
    for (const c of this.coins) {
      if (c.taken) continue;
      const fr = F.coin[Math.floor((engine.time + c.phase) * 8) % 4];
      r.drawSprite(art.sheet, c.x, c.y + Math.sin(engine.time * 3 + c.phase) * 1.5, { frame: fr, originX: 0.5, originY: 0.5 });
    }
    for (const e of this.enemies) {
      const b = e.body;
      if (!b.enabled && e.dead <= 0) continue;
      const frame = e.dead > 0 ? F.slimeFlat : Math.floor(e.anim * 4) % 2 ? F.slime1 : F.slime2;
      r.drawSprite(art.sheet, b.x - 2, b.bottom - 16, { frame, flipX: e.dir > 0, alpha: e.dead > 0 ? Math.min(1, e.dead * 2) : 1 });
    }

    const p = this.player;
    if (p.enabled && !(this.inv > 0 && Math.floor(this.inv * 15) % 2 === 0)) {
      let frame = F.idle;
      if (this.dead > 0) frame = F.jump;
      else if (!p.onGround) frame = F.jump;
      else if (Math.abs(p.vx) > 10) frame = Math.floor(this.anim * 10) % 2 ? F.run1 : F.run2;
      r.drawSprite(art.sheet, p.x - 3, p.y - 2, { frame, flipX: this.facing < 0, flipY: this.dead > 0 });
    }

    this.dust.draw(r);
    this.sparkle.draw(r);
    this.gore.draw(r);
    for (const pop of this.pops || []) r.drawText(`+${pop.n}`, pop.x, pop.y, { size: 9, align: 'center', color: '#fee761', alpha: pop.a, shadow: '#1a1c2c' });

    this.renderHud(engine);
  }

  renderHud(engine) {
    const r = engine.renderer;
    r.ui(() => {
      r.drawRect(0, 0, W, 20, '#1a1c2c', { alpha: 0.45 });
      for (let i = 0; i < 3; i++) r.drawSprite(art.sheet, 4 + i * 14, 2, { frame: i < run.lives ? F.heart : F.heartEmpty });
      r.drawSprite(art.sheet, 54, 2, { frame: F.coin[0] });
      r.drawText(`${run.coins}`, 70, 5, { size: 11, color: '#ffffff' });
      r.drawText(`SCORE ${run.score}`, W / 2, 5, { size: 11, align: 'center', color: '#ffffff' });
      r.drawText(`${this.time.toFixed(1)}s`, W - 6, 5, { size: 11, align: 'right', color: '#c0cbdc' });
      if (this.banner.a > 0)
        r.drawText(this.def.name, W / 2, 60, { size: 22, align: 'center', baseline: 'middle', color: '#ffffff', alpha: this.banner.a, shadow: '#1a1c2c', shadowOffset: 2 });
      if (engine.audio.muted) r.drawText('MUTED', W - 6, 24, { size: 9, align: 'right', color: '#ffffff' });
      if (this.touchMode) {
        const btn = (x, y, w, label, active) => {
          r.drawRect(x, y, w, w, '#ffffff', { alpha: active ? 0.35 : 0.18 });
          r.drawRect(x, y, w, w, '#ffffff', { outline: 2, alpha: 0.5 });
          r.drawText(label, x + w / 2, y + w / 2, { size: 18, align: 'center', baseline: 'middle', color: '#ffffff', alpha: 0.8 });
        };
        btn(8, H - 56, 48, '<', false);
        btn(70, H - 56, 48, '>', false);
        btn(W - 64, H - 64, 56, '^', false);
      }
    });
  }
}

// ------------------------------------------------------------------ game entry

export default {
  async load(engine) {
    const data = await engine.assets.loadJSON('assets/levels.json');
    levels = data.levels;
    const cols = 8;
    const rows = 3;
    const frameXY = (i) => [(i % cols) * 16, Math.floor(i / cols) * 16];
    const rnd = new engine.Random(7);
    const tex = engine.assets.createTexture(cols * 16, rows * 16, (ctx) => {
      drawTiles(ctx, frameXY, rnd);
      drawSprites(ctx, frameXY);
    });
    art = { sheet: engine.assets.spriteSheet(tex, 16, 16) };
    engine.renderer.background = '#1a1c2c';
    await engine.scenes.push(new TitleScene());
  },
};

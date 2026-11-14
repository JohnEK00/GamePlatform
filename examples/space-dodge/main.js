// Space Dodge — a neon arcade shooter for the Pixelforge engine.
// No imports: everything comes from the `engine` object passed to load/update/render.

const W = 800;
const H = 600;
const TAU = Math.PI * 2;

// Achievements are declared in game.json. unlockAchievement is v2; guard so older engines still run.
function unlock(engine, id) {
  if (typeof engine.platform.unlockAchievement === 'function') engine.platform.unlockAchievement(id);
}

/** Draw a texture at 2x resolution so it stays crisp on HiDPI screens. */
function makeTex(engine, w, h, draw) {
  return engine.assets.createTexture(w * 2, h * 2, (ctx) => {
    ctx.scale(2, 2);
    draw(ctx, w, h);
  }, { smooth: true });
}

function glow(ctx, color, blur) {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
}

function buildTextures(engine) {
  const ship = makeTex(engine, 48, 48, (c) => {
    glow(c, '#4cf2ff', 8);
    c.fillStyle = '#18233f';
    c.strokeStyle = '#4cf2ff';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(24, 4); c.lineTo(40, 38); c.lineTo(31, 34); c.lineTo(24, 42); c.lineTo(17, 34); c.lineTo(8, 38);
    c.closePath();
    c.fill(); c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = '#ff5fd2';
    c.beginPath(); c.ellipse(24, 22, 4, 7, 0, 0, TAU); c.fill();
    c.fillStyle = '#ffffff';
    c.beginPath(); c.ellipse(23, 20, 1.5, 3, 0, 0, TAU); c.fill();
  });

  const rock = (seed, r) =>
    makeTex(engine, r * 2 + 8, r * 2 + 8, (c, w, h) => {
      const rnd = new engine.Random(seed);
      const n = 11;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const rr = r * rnd.range(0.72, 1);
        pts.push([w / 2 + Math.cos(a) * rr, h / 2 + Math.sin(a) * rr]);
      }
      glow(c, '#ffb347', 6);
      c.fillStyle = '#2a1c14';
      c.strokeStyle = '#ffb347';
      c.lineWidth = 2;
      c.beginPath();
      pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.closePath();
      c.fill(); c.stroke();
      c.shadowBlur = 0;
      c.strokeStyle = 'rgba(255,179,71,0.35)';
      c.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        c.beginPath();
        c.arc(w / 2 + rnd.range(-r / 2, r / 2), h / 2 + rnd.range(-r / 2, r / 2), rnd.range(r * 0.12, r * 0.25), 0, TAU);
        c.stroke();
      }
    });

  const saucer = makeTex(engine, 56, 32, (c) => {
    glow(c, '#9dff5c', 8);
    c.fillStyle = '#16301a';
    c.strokeStyle = '#9dff5c';
    c.lineWidth = 2;
    c.beginPath(); c.ellipse(28, 20, 24, 8, 0, 0, TAU); c.fill(); c.stroke();
    c.beginPath(); c.ellipse(28, 14, 11, 9, 0, Math.PI, TAU); c.fill(); c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = '#eaffd8';
    for (let i = 0; i < 5; i++) { c.beginPath(); c.arc(12 + i * 8, 21, 1.6, 0, TAU); c.fill(); }
  });

  const power = makeTex(engine, 28, 28, (c) => {
    glow(c, '#ffe14c', 10);
    c.strokeStyle = '#ffe14c';
    c.lineWidth = 2.5;
    c.beginPath(); c.arc(14, 14, 10, 0, TAU); c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = '#ffe14c';
    c.font = 'bold 13px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('P', 14, 15);
  });

  const shield = makeTex(engine, 28, 28, (c) => {
    glow(c, '#6cf', 10);
    c.strokeStyle = '#66ccff';
    c.lineWidth = 2.5;
    c.beginPath(); c.arc(14, 14, 10, 0, TAU); c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = '#66ccff';
    c.beginPath(); c.moveTo(14, 7); c.lineTo(20, 10); c.lineTo(19, 17); c.lineTo(14, 21); c.lineTo(9, 17); c.lineTo(8, 10); c.closePath(); c.fill();
  });

  const glowDot = makeTex(engine, 16, 16, (c) => {
    const g = c.createRadialGradient(8, 8, 0, 8, 8, 8);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 16, 16);
  });

  return {
    ship, saucer, power, shield, glowDot,
    rocks: { big: [rock(1, 30), rock(2, 30), rock(3, 30)], small: [rock(4, 15), rock(5, 15), rock(6, 15)] },
  };
}

function makeStars(engine) {
  const layers = [];
  const rnd = engine.random;
  for (let l = 0; l < 3; l++) {
    const stars = [];
    for (let i = 0; i < 40 + l * 25; i++) stars.push({ x: rnd.range(0, W), y: rnd.range(0, H), tw: rnd.range(0, TAU) });
    layers.push({ speed: 20 + l * 45, size: 1 + l * 0.7, alpha: 0.35 + l * 0.25, stars });
  }
  return layers;
}

const game = {
  async load(engine) {
    this.tex = buildTextures(engine);
    this.stars = makeStars(engine);
    this.explosions = new engine.ParticleEmitter({
      texture: this.tex.glowDot, blend: 'additive', life: [0.35, 0.9], speed: [40, 260],
      size: [10, 22], sizeEnd: 0, color: ['#ffb347', '#ff5f5f', '#ffe14c'], drag: 1.5, maxParticles: 1500,
    });
    this.sparks = new engine.ParticleEmitter({
      blend: 'additive', life: [0.15, 0.35], speed: [80, 220], size: [3, 5], sizeEnd: 0,
      color: ['#4cf2ff', '#ffffff'], maxParticles: 600,
    });
    this.thrust = new engine.ParticleEmitter({
      texture: this.tex.glowDot, blend: 'additive', life: [0.15, 0.35], speed: [80, 160],
      angle: [Math.PI / 2 - 0.25, Math.PI / 2 + 0.25], size: [10, 14], sizeEnd: 0,
      color: ['#4cf2ff', '#ff5fd2'], maxParticles: 300,
    });
    this.best = engine.storage.get('best', 0) || 0;
    this.state = 'title';
    this.titleTime = 0;
    this.reset(engine);
  },

  reset(engine) {
    this.player = { x: W / 2, y: H - 90, vx: 0, vy: 0, r: 16, inv: 0, cooldown: 0, triple: 0, shield: 0 };
    this.bullets = [];
    this.enemyBullets = [];
    this.rocks = [];
    this.saucers = [];
    this.pickups = [];
    this.popups = [];
    this.score = 0;
    this.board = null; // "This week" top 5 (LeaderboardView) shown on the game-over screen
    this.serverBest = false; // submitScore result said personalBest
    this.run = (this.run || 0) + 1; // ignore late replies from a previous run
    this.lives = 3;
    this.combo = 1;
    this.comboTimer = 0;
    this.elapsed = 0;
    this.spawnTimer = 0.8;
    this.saucerTimer = 18;
    this.flash = 0;
    this.explosions.clear();
    this.sparks.clear();
  },

  // ---------------------------------------------------------------- update

  update(engine, dt) {
    const input = engine.input;
    if (input.wasPressed('KeyM')) engine.audio.muted = !engine.audio.muted;
    this.updateStars(dt * (this.state === 'play' ? 1 : 0.4));
    this.explosions.update(dt);
    this.sparks.update(dt);
    this.thrust.update(dt);
    this.flash = Math.max(0, this.flash - dt * 3);
    for (const p of this.popups) { p.t -= dt; p.y -= 30 * dt; }
    this.popups = this.popups.filter((p) => p.t > 0);

    if (this.state === 'title') {
      this.titleTime += dt;
      if (this.titleTime > 0.3 && input.anyPressed()) {
        this.reset(engine);
        this.state = 'play';
        engine.audio.tone({ freq: 220, freqEnd: 880, duration: 0.25, type: 'triangle', volume: 0.3 });
      }
      return;
    }
    if (this.state === 'over') {
      this.overTime += dt;
      if (this.overTime > 1.0 && input.anyPressed()) {
        this.reset(engine);
        this.state = 'play';
      }
      return;
    }

    this.elapsed += dt;
    this.updatePlayer(engine, dt);
    this.updateSpawns(engine, dt);
    this.updateEntities(engine, dt);
    this.collide(engine);
    this.comboTimer -= dt;
    if (this.comboTimer <= 0) this.combo = 1;
  },

  updateStars(dt) {
    for (const layer of this.stars)
      for (const s of layer.stars) {
        s.y += layer.speed * dt;
        s.tw += dt * 3;
        if (s.y > H) { s.y -= H; s.x = Math.random() * W; }
      }
  },

  updatePlayer(engine, dt) {
    const p = this.player;
    const input = engine.input;
    const accel = 2600;
    const maxSpeed = 380;
    let ax = input.axis('horizontal');
    let ay = input.axis('vertical');
    const pointer = input.mouse.down;
    if (pointer) {
      // Steer toward the pointer (a bit above the finger so it isn't hidden).
      const tx = input.mouse.x;
      const ty = input.mouse.y - (input.touches.length ? 60 : 0);
      const dx = tx - p.x;
      const dy = ty - p.y;
      p.vx = engine.math.clamp(dx * 12, -maxSpeed * 1.4, maxSpeed * 1.4);
      p.vy = engine.math.clamp(dy * 12, -maxSpeed * 1.4, maxSpeed * 1.4);
    } else {
      p.vx = ax ? engine.math.clamp(p.vx + ax * accel * dt, -maxSpeed, maxSpeed) : engine.math.approach(p.vx, 0, accel * 0.8 * dt);
      p.vy = ay ? engine.math.clamp(p.vy + ay * accel * dt, -maxSpeed, maxSpeed) : engine.math.approach(p.vy, 0, accel * 0.8 * dt);
    }
    p.x = engine.math.clamp(p.x + p.vx * dt, 24, W - 24);
    p.y = engine.math.clamp(p.y + p.vy * dt, 40, H - 30);
    p.inv = Math.max(0, p.inv - dt);
    p.triple = Math.max(0, p.triple - dt);
    p.shield = Math.max(0, p.shield - dt);
    p.cooldown -= dt;

    this.thrust.burst(1, p.x + engine.random.range(-4, 4), p.y + 20);

    const pad = input.gamepad(0);
    const firing = input.isDown('Space') || input.isDown('KeyZ') || input.isDown('KeyJ') || pointer || pad.isDown('A') || pad.isDown('RT');
    if (firing && p.cooldown <= 0) {
      p.cooldown = p.triple > 0 ? 0.12 : 0.17;
      const speed = -720;
      this.bullets.push({ x: p.x, y: p.y - 20, vx: 0, vy: speed });
      if (p.triple > 0) {
        this.bullets.push({ x: p.x - 10, y: p.y - 12, vx: -140, vy: speed });
        this.bullets.push({ x: p.x + 10, y: p.y - 12, vx: 140, vy: speed });
      }
      engine.audio.tone({ freq: 880, freqEnd: 440, duration: 0.07, type: 'square', volume: 0.12 });
    }
  },

  difficulty() {
    return 1 + this.elapsed / 40;
  },

  updateSpawns(engine, dt) {
    const rnd = engine.random;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      const d = this.difficulty();
      this.spawnTimer = Math.max(0.22, 0.95 / d) * rnd.range(0.6, 1.3);
      const big = rnd.chance(0.35);
      this.spawnRock(engine, rnd.range(30, W - 30), -40, big, rnd.range(-60, 60), rnd.range(90, 150) * Math.min(2.2, 0.8 + d * 0.3));
    }
    this.saucerTimer -= dt;
    if (this.saucerTimer <= 0) {
      this.saucerTimer = Math.max(5, 14 - this.elapsed / 15) * rnd.range(0.8, 1.2);
      const fromLeft = rnd.chance(0.5);
      this.saucers.push({
        x: fromLeft ? -40 : W + 40, y: rnd.range(70, 220), dir: fromLeft ? 1 : -1, t: 0, hp: 4,
        fire: rnd.range(0.6, 1.4), r: 22,
      });
      engine.audio.tone({ freq: 300, freqEnd: 600, duration: 0.4, type: 'sine', volume: 0.15, vibrato: 40 });
    }
  },

  spawnRock(engine, x, y, big, vx, vy) {
    const rnd = engine.random;
    this.rocks.push({
      x, y, vx, vy, big, r: big ? 28 : 14, hp: big ? 3 : 1,
      rot: rnd.angle(), spin: rnd.range(-2, 2), tex: rnd.pick(big ? this.tex.rocks.big : this.tex.rocks.small), hit: 0,
    });
  },

  updateEntities(engine, dt) {
    for (const b of this.bullets) { b.x += b.vx * dt; b.y += b.vy * dt; }
    this.bullets = this.bullets.filter((b) => b.y > -20 && b.x > -20 && b.x < W + 20 && !b.dead);
    for (const b of this.enemyBullets) { b.x += b.vx * dt; b.y += b.vy * dt; }
    this.enemyBullets = this.enemyBullets.filter((b) => b.y < H + 20 && b.y > -20 && b.x > -20 && b.x < W + 20 && !b.dead);
    for (const r of this.rocks) {
      r.x += r.vx * dt; r.y += r.vy * dt; r.rot += r.spin * dt; r.hit = Math.max(0, r.hit - dt);
      if (r.x < r.r || r.x > W - r.r) r.vx = -r.vx;
    }
    this.rocks = this.rocks.filter((r) => r.y < H + 60 && !r.dead);
    const p = this.player;
    for (const s of this.saucers) {
      s.t += dt;
      s.x += s.dir * 120 * dt;
      s.y += Math.sin(s.t * 3) * 60 * dt;
      s.fire -= dt;
      if (s.fire <= 0 && s.x > 0 && s.x < W) {
        s.fire = Math.max(0.5, 1.6 - this.elapsed / 120);
        const a = Math.atan2(p.y - s.y, p.x - s.x);
        this.enemyBullets.push({ x: s.x, y: s.y + 8, vx: Math.cos(a) * 260, vy: Math.sin(a) * 260 });
        engine.audio.tone({ freq: 520, freqEnd: 260, duration: 0.12, type: 'sawtooth', volume: 0.08 });
      }
    }
    this.saucers = this.saucers.filter((s) => !s.dead && s.x > -80 && s.x < W + 80);
    for (const k of this.pickups) { k.y += 90 * dt; k.t += dt; }
    this.pickups = this.pickups.filter((k) => k.y < H + 30 && !k.dead);
  },

  addScore(engine, base, x, y) {
    const pts = base * this.combo;
    this.score += pts;
    this.popups.push({ x, y, t: 0.8, text: this.combo > 1 ? `+${pts} x${this.combo}` : `+${pts}` });
    this.combo = Math.min(5, this.combo + 1);
    if (this.combo >= 5) unlock(engine, 'combo_master');
    this.comboTimer = 1.6;
  },

  explode(engine, x, y, n, shake) {
    this.explosions.burst(n, x, y);
    this.sparks.burst(Math.floor(n / 2), x, y);
    engine.camera.shake(shake, 0.25);
    engine.audio.noise({ duration: 0.25 + shake / 40, volume: 0.25 + shake / 60, filterStart: 3000, filterEnd: 200 });
  },

  collide(engine) {
    const ov = engine.math.circlesOverlap;
    const rnd = engine.random;
    for (const b of this.bullets) {
      for (const r of this.rocks) {
        if (r.dead || b.dead || !ov(b.x, b.y, 4, r.x, r.y, r.r)) continue;
        b.dead = true;
        r.hp--;
        r.hit = 0.08;
        this.sparks.burst(6, b.x, b.y);
        if (r.hp <= 0) {
          r.dead = true;
          this.explode(engine, r.x, r.y, r.big ? 40 : 18, r.big ? 7 : 3);
          this.addScore(engine, r.big ? 25 : 10, r.x, r.y);
          unlock(engine, 'rock_breaker');
          if (r.big) for (let i = 0; i < 2; i++) this.spawnRock(engine, r.x, r.y, false, rnd.range(-140, 140), r.vy * 0.8 + rnd.range(-20, 40));
          if (rnd.chance(r.big ? 0.12 : 0.04)) this.pickups.push({ x: r.x, y: r.y, t: 0, kind: rnd.chance(0.5) ? 'triple' : 'shield' });
        } else {
          engine.audio.tone({ freq: 200, duration: 0.05, type: 'square', volume: 0.08 });
        }
      }
      for (const s of this.saucers) {
        if (s.dead || b.dead || !ov(b.x, b.y, 4, s.x, s.y, s.r)) continue;
        b.dead = true;
        s.hp--;
        this.sparks.burst(8, b.x, b.y);
        if (s.hp <= 0) {
          s.dead = true;
          this.explode(engine, s.x, s.y, 60, 9);
          this.addScore(engine, 100, s.x, s.y);
          unlock(engine, 'close_encounter');
          this.pickups.push({ x: s.x, y: s.y, t: 0, kind: rnd.chance(0.5) ? 'triple' : 'shield' });
        }
      }
    }
    const p = this.player;
    for (const k of this.pickups) {
      if (!k.dead && ov(p.x, p.y, p.r + 6, k.x, k.y, 12)) {
        k.dead = true;
        if (k.kind === 'triple') p.triple = 8;
        else p.shield = 6;
        this.popups.push({ x: k.x, y: k.y, t: 1, text: k.kind === 'triple' ? 'TRIPLE SHOT!' : 'SHIELD!' });
        engine.audio.tone({ freq: 523, freqEnd: 1046, duration: 0.3, type: 'triangle', volume: 0.3 });
      }
    }
    if (p.inv > 0) return;
    const hitR = p.shield > 0 ? 26 : 13;
    const hazards = [...this.rocks, ...this.saucers, ...this.enemyBullets.map((b) => ({ x: b.x, y: b.y, r: 5, bullet: b }))];
    for (const h of hazards) {
      if (h.dead || !ov(p.x, p.y, hitR, h.x, h.y, h.r * 0.85)) continue;
      if (p.shield > 0) {
        // Shield destroys what it touches.
        if (h.bullet) h.bullet.dead = true;
        else { h.dead = true; this.explode(engine, h.x, h.y, 30, 5); this.addScore(engine, 10, h.x, h.y); }
        continue;
      }
      if (h.bullet) h.bullet.dead = true;
      else h.dead = true;
      this.hitPlayer(engine);
      return;
    }
  },

  hitPlayer(engine) {
    const p = this.player;
    this.lives--;
    this.combo = 1;
    this.flash = 1;
    this.explode(engine, p.x, p.y, 70, 14);
    engine.audio.tone({ freq: 400, freqEnd: 60, duration: 0.6, type: 'sawtooth', volume: 0.3 });
    if (this.lives <= 0) {
      this.state = 'over';
      this.overTime = 0;
      this.score = Math.floor(this.score);
      this.newBest = this.score > this.best;
      if (this.newBest) {
        this.best = this.score;
        engine.storage.set('best', this.best);
      }
      this.submitAndLoadBoard(engine);
      return;
    }
    p.inv = 2.2;
    p.triple = 0;
  },

  // ---------------------------------------------------------------- render

  render(engine) {
    const r = engine.renderer;
    r.clear('#05060f');
    // nebula glow
    r.setBlend('additive');
    r.drawSprite(this.tex.glowDot, W * 0.25, H * 0.3, { w: 700, h: 500, originX: 0.5, originY: 0.5, tint: '#3a1450', alpha: 0.5 });
    r.drawSprite(this.tex.glowDot, W * 0.8, H * 0.75, { w: 600, h: 500, originX: 0.5, originY: 0.5, tint: '#0f3050', alpha: 0.5 });
    for (const layer of this.stars)
      for (const s of layer.stars) {
        const a = layer.alpha * (0.7 + 0.3 * Math.sin(s.tw));
        r.drawRect(s.x, s.y, layer.size, layer.size * (this.state === 'play' ? 1 + layer.speed / 60 : 1), '#cfe3ff', { alpha: a });
      }
    r.setBlend('normal');

    if (this.state === 'title') return this.renderTitle(engine);

    this.thrust.draw(r);
    for (const k of this.pickups) {
      const s = 1 + Math.sin(k.t * 6) * 0.1;
      r.drawSprite(k.kind === 'triple' ? this.tex.power : this.tex.shield, k.x, k.y, { w: 28 * s, h: 28 * s, originX: 0.5, originY: 0.5 });
    }
    for (const rk of this.rocks) {
      const size = rk.r * 2 + 8;
      r.drawSprite(rk.tex, rk.x, rk.y, { w: size, h: size, originX: 0.5, originY: 0.5, rotation: rk.rot, tint: rk.hit > 0 ? '#ffffff' : undefined });
    }
    for (const s of this.saucers) r.drawSprite(this.tex.saucer, s.x, s.y, { w: 56, h: 32, originX: 0.5, originY: 0.5 });

    r.setBlend('additive');
    for (const b of this.bullets) {
      r.drawSprite(this.tex.glowDot, b.x, b.y, { w: 14, h: 26, originX: 0.5, originY: 0.5, tint: '#4cf2ff' });
      r.drawRect(b.x - 1.5, b.y - 8, 3, 16, '#e8ffff');
    }
    for (const b of this.enemyBullets) {
      r.drawSprite(this.tex.glowDot, b.x, b.y, { w: 18, h: 18, originX: 0.5, originY: 0.5, tint: '#9dff5c' });
    }
    r.setBlend('normal');

    const p = this.player;
    if (this.state === 'play' && (p.inv <= 0 || Math.floor(p.inv * 12) % 2 === 0)) {
      const bank = engine.math.clamp(p.vx / 380, -1, 1) * 0.25;
      r.drawSprite(this.tex.ship, p.x, p.y, { w: 48, h: 48, originX: 0.5, originY: 0.5, rotation: bank });
      if (p.shield > 0) {
        const a = p.shield < 1.5 ? (Math.sin(engine.time * 20) > 0 ? 0.8 : 0.2) : 0.8;
        r.drawCircle(p.x, p.y, 28, '#66ccff', { outline: 2, alpha: a });
        r.drawCircle(p.x, p.y, 28, '#66ccff', { alpha: 0.12 });
      }
    }
    this.explosions.draw(r);
    this.sparks.draw(r);

    for (const pp of this.popups)
      r.drawText(pp.text, pp.x, pp.y, { size: 16, align: 'center', baseline: 'middle', color: '#ffe14c', alpha: Math.min(1, pp.t * 2), shadow: '#000' });

    // HUD (screen space, unaffected by shake)
    r.ui(() => {
      if (this.flash > 0) r.drawRect(0, 0, W, H, '#ff3050', { alpha: this.flash * 0.35 });
      r.drawText(`SCORE ${Math.floor(this.score)}`, 16, 14, { size: 22, color: '#ffffff', shadow: '#000' });
      r.drawText(`BEST ${Math.max(this.best, Math.floor(this.score))}`, 16, 42, { size: 14, color: '#8ea2ff' });
      if (this.combo > 1) r.drawText(`x${this.combo}`, 16, 62, { size: 18, color: '#ffe14c' });
      for (let i = 0; i < this.lives; i++)
        r.drawSprite(this.tex.ship, W - 30 - i * 30, 28, { w: 24, h: 24, originX: 0.5, originY: 0.5 });
      if (p.triple > 0) r.drawText(`TRIPLE ${p.triple.toFixed(1)}s`, W - 16, 52, { size: 13, align: 'right', color: '#ffe14c' });
      if (engine.audio.muted) r.drawText('MUTED (M)', W / 2, 14, { size: 12, align: 'center', color: '#8899aa' });
      if (this.state === 'over') this.renderGameOver(engine);
    });
  },

  renderTitle(engine) {
    const r = engine.renderer;
    const t = engine.time;
    r.drawSprite(this.tex.ship, W / 2, H / 2 + 70 + Math.sin(t * 2) * 8, { w: 72, h: 72, originX: 0.5, originY: 0.5 });
    r.drawText('SPACE DODGE', W / 2, H / 2 - 90, { size: 64, align: 'center', baseline: 'middle', color: '#4cf2ff', shadow: '#ff5fd2', shadowOffset: 4, letterSpacing: 4 });
    r.drawText('Blast rocks. Dodge saucers. Grab power-ups.', W / 2, H / 2 - 30, { size: 18, align: 'center', baseline: 'middle', color: '#cfe3ff' });
    if (Math.floor(t * 2) % 2 === 0)
      r.drawText('PRESS ANY KEY OR TAP TO START', W / 2, H - 110, { size: 20, align: 'center', baseline: 'middle', color: '#ffe14c' });
    r.drawText('Arrows/WASD move  ·  Space fire  ·  Mouse/touch: hold to fly  ·  M mute', W / 2, H - 60, { size: 14, align: 'center', baseline: 'middle', color: '#7f8db0' });
    if (this.best > 0) r.drawText(`BEST ${this.best}`, W / 2, 40, { size: 18, align: 'center', color: '#8ea2ff' });
  },

  /**
   * Submit the score, then show the weekly top 5. Older engines return undefined from submitScore
   * and have no getLeaderboard, so both are feature-detected. A null result (offline, anonymous,
   * old host) simply shows nothing extra.
   */
  async submitAndLoadBoard(engine) {
    const run = this.run;
    const platform = engine.platform;
    let result = null;
    try {
      result = await platform.submitScore(this.score);
    } catch {
      result = null;
    }
    if (run !== this.run) return;
    if (result && result.personalBest) this.serverBest = true;
    if (typeof platform.getLeaderboard !== 'function') return;
    let board = null;
    try {
      board = await platform.getLeaderboard({ period: 'week', limit: 5 });
    } catch {
      board = null;
    }
    if (run === this.run && board && Array.isArray(board.entries)) this.board = board;
  },

  renderGameOver(engine) {
    const r = engine.renderer;
    const b = this.board;
    const y0 = b ? 110 : H / 2 - 70; // compact layout when the board is shown
    r.drawRect(0, 0, W, H, '#000', { alpha: 0.55 });
    r.drawText('GAME OVER', W / 2, y0, { size: 60, align: 'center', baseline: 'middle', color: '#ff5f5f', shadow: '#000', shadowOffset: 4 });
    r.drawText(`SCORE ${this.score}`, W / 2, y0 + 70, { size: 30, align: 'center', baseline: 'middle', color: '#fff' });
    if (this.newBest || this.serverBest) r.drawText('NEW BEST!', W / 2, y0 + 110, { size: 22, align: 'center', baseline: 'middle', color: '#ffe14c' });
    if (b) this.renderBoard(r, b, 265);
    if (this.overTime > 1 && Math.floor(engine.time * 2) % 2 === 0)
      r.drawText('PRESS ANY KEY OR TAP TO PLAY AGAIN', W / 2, b ? H - 40 : H / 2 + 100, { size: 18, align: 'center', baseline: 'middle', color: '#cfe3ff' });
  },

  /** "This week" top 5, my row highlighted; my own row is appended when I'm outside the top. */
  renderBoard(r, b, y) {
    const x0 = W / 2 - 170;
    const x1 = W / 2 + 170;
    const rowH = 26;
    const title = b.label ? `THIS WEEK · ${b.label.toUpperCase()}` : 'THIS WEEK';
    r.drawText(title, W / 2, y, { size: 16, align: 'center', baseline: 'middle', color: '#4cf2ff', letterSpacing: 2 });
    const rows = b.entries.slice(0, 5).map((e) => ({ rank: e.rank, name: e.name, display: e.display, me: !!e.isMe }));
    if (b.me && !rows.some((e) => e.me)) rows.push({ rank: b.me.rank, name: 'YOU', display: b.me.display, me: true, gap: true });
    if (rows.length === 0) {
      r.drawText('No scores this week yet - be the first!', W / 2, y + 34, { size: 14, align: 'center', baseline: 'middle', color: '#8899aa' });
      return;
    }
    let ry = y + 30;
    for (const e of rows) {
      if (e.gap) ry += 8;
      if (e.me) r.drawRect(x0 - 8, ry - rowH / 2 + 1, x1 - x0 + 16, rowH - 2, '#ffe14c', { alpha: 0.18 });
      const color = e.me ? '#ffe14c' : '#cfe3ff';
      const name = String(e.name).length > 18 ? `${String(e.name).slice(0, 17)}…` : String(e.name);
      r.drawText(`#${e.rank}`, x0, ry, { size: 15, baseline: 'middle', color });
      r.drawText(name, x0 + 50, ry, { size: 15, baseline: 'middle', color });
      r.drawText(String(e.display), x1, ry, { size: 15, align: 'right', baseline: 'middle', color });
      ry += rowH;
    }
  },
};

export default game;

// Ember Garden: a top-down night arena. You are the lamplighter of a walled garden. Moths drift in
// over the hedges in waves and snuff out the lanterns; relight them, net the moths, dash between
// them. Score ("glow") is lit-lantern-seconds plus moths netted. The night ends when every lantern
// is dark.
//
// Engine features shown here:
// - F009 actions: every control is a game.json action (keys + gamepad), read with actionPressed/
//   actionDown/axis, and the HUD and pause screen print the live bindings with keyLabel/gamepadLabel.
// - F012: a custom BMFont (assets/fonts/ember.fnt, made by packages/engine/scripts/gen-ember-assets.mjs),
//   9-slice panels and buttons (assets/ui/*.png) and engine.ui menus (mouse, keyboard, gamepad).
// - F001: submitScore's ScoreResultView on game over, and a leaderboard view with day/week/all tabs.
// - F005: a "Share screenshot" button on game over (sanitised caption, cooldown, failure messages).
// - Achievements (game.json) and engine.storage (best score, unlocks, settings, last leaderboard tab),
//   which the platform syncs as a cloud save.
// - SceneManager, Tilemap + Physics (top-down, no gravity), circle collisions, ParticleEmitter,
//   tweens/easing, camera shake and the synth (tone/noise). The engine runs update at a fixed 60 Hz.

const W = 480;
const H = 270;
const T = 16;

// ------------------------------------------------------------------ garden map

// '#' hedge, '~' pond (both solid), ':' path, '*' flowers, 'L' lantern (on a path tile), 'P' start.
const MAP = [
  '##############################',
  '#*............::............*#',
  '#...L.........::.........L...#',
  '#.....##......::......##.....#',
  '#.....#.....::::::.....#.....#',
  '#..*.......::~~~~::.......*..#',
  '#::::::L::::~~~~~~::::L::::::#',
  '#..........::~~~~::..........#',
  '#.....#.....::::::.....#.....#',
  '#.....##......::......##.....#',
  '#.....*.......::.......*.....#',
  '#...L.........::.........L...#',
  '#.............::.............#',
  '#**....##.....P:.....##....**#',
  '#.......L....::::....L.......#',
  '#*............::............*#',
  '##############################',
];
const GRASS = 1;
const PATH = 2;
const HEDGE = 3;
const WATER = 4;
const FLOWERS = 5;
const TILE_OF = { '#': HEDGE, '~': WATER, ':': PATH, '*': FLOWERS, L: PATH, P: GRASS, '.': GRASS };

// Sprite sheet frames (16×16)
const F = {
  grass: 0, grass2: 1, path: 2, hedge: 3, water: 4, water2: 5, flowers: 6, lantern: 7,
  idle: 8, walk: 9, moth1: 10, moth2: 11, net: 12,
};

// ------------------------------------------------------------------ tuning

const DIFFS = {
  calm: { name: 'CALM', drain: 0.6, count: 0.75, speed: 0.85, score: 0.75 },
  normal: { name: 'NORMAL', drain: 1, count: 1, speed: 1, score: 1 },
  swarm: { name: 'SWARM', drain: 1.35, count: 1.4, speed: 1.15, score: 1.5 },
};
const FLAMES = {
  amber: { name: 'AMBER', glow: '#ffb347', core: '#fff3b0', sparks: ['#fff3b0', '#ffd166', '#f4a340'] },
  azure: { name: 'AZURE', glow: '#5cc8ff', core: '#e6f8ff', sparks: ['#e6f8ff', '#9ee3ff', '#5cc8ff'] },
  rose: { name: 'ROSE', glow: '#ff6f9f', core: '#ffe3ee', sparks: ['#ffe3ee', '#ffadc8', '#ff6f9f'] },
};
// "Unlocked settings": saved in engine.storage, so they follow a signed-in player between devices.
const UNLOCK_RULES = {
  swarm: 'SWARM mode: reach wave 5',
  azure: 'AZURE flame: net 25 moths in one night',
  rose: 'ROSE flame: score 5000 glow in one night',
};
const PERIODS = [
  { id: 'day', label: 'TODAY' },
  { id: 'week', label: 'THIS WEEK' },
  { id: 'all', label: 'ALL TIME' },
];

const PLAYER_SPEED = 88;
const DASH_SPEED = 270;
const DASH_TIME = 0.14;
const DASH_COOLDOWN = 0.7;
const NET_TIME = 0.2;
const NET_COOLDOWN = 0.34;
const NET_REACH = 14;
const NET_RADIUS = 13;
const LIGHT_RANGE = 26;
const KINDLE_TIME = 0.45; // hold "light" this long to rekindle a dark lantern
const SHARE_COOLDOWN = 3.2; // the engine refuses shares < 3 s apart; the parent rate-limits too

// ------------------------------------------------------------------ art

const PALETTE = {
  k: '#140d1f', h: '#3a2d4a', H: '#5a4a6a', s: '#f2c79a', g: '#3e7a5a', G: '#2b5a42',
  y: '#ffd166', b: '#4a2f22', w: '#e8e0d0', m: '#c9b8e8', M: '#7d6aa3', o: '#f4a340',
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

const KEEPER_TOP = [
  '.....kkkkkk.....',
  '....khhhhhhk....',
  '...kHHHHHHHHk...',
  '..kkkkkkkkkkkk..',
  '....kssssssk....',
  '....kskssksk....',
  '....kssssssk....',
  '...kkggggggkk...',
  '..kggggyggggk...',
  '..ksgggggggGsk..',
  '...kgggggggGk...',
  '...kgggggggGk...',
  '....kGGkkGGk....',
];
const KEEPER_LEGS = {
  idle: ['....kbbk.kbbk...', '....kkkk.kkkk...', '................'],
  walk: ['...kbbk...kbbk..', '...kkk.....kkk..', '................'],
};
const MOTH = {
  up: [
    '', '', '',
    '...kk......kk...',
    '..kmmk.kk.kmmk..',
    '.kmmmmkMMkmmmmk.',
    '.kmMmmkMMkmmMmk.',
    '.kmmmmkMMkmmmmk.',
    '..kMMkkMMkkMMk..',
    '...kk.kMMk.kk...',
    '.......kk.......',
  ],
  down: [
    '', '', '',
    '......k..k......',
    '.......kk.......',
    '....kkkMMkkk....',
    '...kmmkMMkmmk...',
    '..kmMmkMMkmMmk..',
    '..kmmmkMMkmmmk..',
    '...kkkkMMkkkk...',
    '.......kk.......',
  ],
};

function drawArt(ctx, at, rnd) {
  const fill = (frame, color) => {
    const [x, y] = at(frame);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 16, 16);
    return [x, y];
  };
  const specks = (x, y, n, colors, w = 1, h = 1) => {
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(x + rnd.int(0, 16 - w), y + rnd.int(0, 16 - h), w, h);
    }
  };
  // grass (two variants)
  let [x, y] = fill(F.grass, '#1c3328');
  specks(x, y, 10, ['#25432f', '#152a20'], 1, 2);
  [x, y] = fill(F.grass2, '#1c3328');
  specks(x, y, 14, ['#25432f', '#152a20', '#2b4d36'], 1, 2);
  // flowers on grass
  [x, y] = fill(F.flowers, '#1c3328');
  specks(x, y, 8, ['#25432f', '#152a20'], 1, 2);
  for (let i = 0; i < 5; i++) {
    const fx = x + rnd.int(1, 13);
    const fy = y + rnd.int(1, 13);
    ctx.fillStyle = ['#b35c95', '#d9b44a', '#c9b8e8'][i % 3];
    ctx.fillRect(fx, fy, 2, 2);
    ctx.fillStyle = '#f2e4b0';
    ctx.fillRect(fx, fy, 1, 1);
  }
  // stone path
  [x, y] = fill(F.path, '#3b3546');
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = '#4a4458';
    const sx = x + rnd.int(0, 11);
    const sy = y + rnd.int(0, 12);
    ctx.fillRect(sx, sy, rnd.int(3, 5), rnd.int(2, 4));
  }
  specks(x, y, 6, ['#2c2736'], 2, 1);
  // hedge
  [x, y] = fill(F.hedge, '#0f2016');
  for (let i = 0; i < 9; i++) {
    const cx = x + rnd.int(2, 13);
    const cy = y + rnd.int(2, 13);
    ctx.fillStyle = '#1b3a26';
    ctx.fillRect(cx - 2, cy - 2, 5, 4);
    ctx.fillStyle = '#28553a';
    ctx.fillRect(cx - 1, cy - 2, 3, 2);
    ctx.fillStyle = '#3a7350';
    ctx.fillRect(cx, cy - 2, 1, 1);
  }
  // pond (two frames for a shimmer)
  for (const [frame, shift] of [[F.water, 0], [F.water2, 3]]) {
    [x, y] = fill(frame, '#14213d');
    ctx.fillStyle = '#22375e';
    for (let r = 0; r < 4; r++) ctx.fillRect(x + ((r * 5 + shift) % 12), y + 2 + r * 4, 4, 1);
    ctx.fillStyle = '#3a5a8a';
    ctx.fillRect(x + ((7 + shift * 2) % 13), y + 8, 2, 1);
  }
  // lantern: post, base and an iron cage with dark glass (the flame is drawn live)
  [x, y] = at(F.lantern);
  ctx.fillStyle = '#140d1f';
  ctx.fillRect(x + 6, y + 9, 4, 6);
  ctx.fillRect(x + 4, y + 14, 8, 2);
  ctx.fillStyle = '#3a2d4a';
  ctx.fillRect(x + 7, y + 9, 2, 5);
  ctx.fillRect(x + 5, y + 14, 6, 1);
  ctx.fillStyle = '#140d1f';
  ctx.fillRect(x + 4, y + 1, 8, 9);
  ctx.fillStyle = '#2a2236';
  ctx.fillRect(x + 5, y + 3, 6, 5);
  ctx.fillStyle = '#5a4a6a';
  ctx.fillRect(x + 4, y + 1, 8, 2);
  ctx.fillRect(x + 7, y + 0, 2, 1);
  ctx.fillRect(x + 7, y + 3, 2, 5);
  // keeper
  for (const k of ['idle', 'walk']) {
    [x, y] = at(F[k]);
    px(ctx, x, y, KEEPER_TOP.concat(KEEPER_LEGS[k]));
  }
  // moths
  [x, y] = at(F.moth1);
  px(ctx, x, y, MOTH.up);
  [x, y] = at(F.moth2);
  px(ctx, x, y, MOTH.down);
  // net hoop (drawn rotated around its centre)
  [x, y] = at(F.net);
  ctx.strokeStyle = '#e8e0d0';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x + 8, y + 8, 6.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(232,224,208,0.35)';
  for (let i = 3; i < 14; i += 2) for (let j = 3; j < 14; j += 2) if ((i - 8) ** 2 + (j - 8) ** 2 < 36) ctx.fillRect(x + i, y + j, 1, 1);
}

// ------------------------------------------------------------------ shared state

let art = null;
const profile = {
  best: 0,
  bestWave: 0,
  runs: 0,
  settings: { sound: true, shake: true, volume: 1, difficulty: 'normal', flame: 'amber' },
  unlocks: { swarm: false, azure: false, rose: false },
  lbPeriod: 'week',
};

const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);

/** Reads the save. Cloud data can arrive late (a second webgame:load is merged), so menus call this on enter. */
function loadProfile(engine) {
  const s = engine.storage;
  profile.best = num(s.get('best', 0));
  profile.bestWave = num(s.get('bestWave', 0));
  profile.runs = num(s.get('runs', 0));
  const u = s.get('unlocks', null);
  for (const k of Object.keys(profile.unlocks)) profile.unlocks[k] = !!(u && typeof u === 'object' && u[k] === true);
  const st = s.get('settings', null);
  if (st && typeof st === 'object') {
    profile.settings.sound = st.sound !== false;
    profile.settings.shake = st.shake !== false;
    // Saves from before the VOLUME slider have no `volume`: full volume.
    const vol = Number(st.volume);
    profile.settings.volume = st.volume !== undefined && Number.isFinite(vol) ? Math.max(0, Math.min(1, vol)) : 1;
    profile.settings.difficulty = DIFFS[st.difficulty] ? st.difficulty : 'normal';
    profile.settings.flame = FLAMES[st.flame] ? st.flame : 'amber';
  }
  // A setting is only usable while unlocked (e.g. after a save from an older version).
  if (profile.settings.difficulty === 'swarm' && !profile.unlocks.swarm) profile.settings.difficulty = 'normal';
  if (profile.settings.flame !== 'amber' && !profile.unlocks[profile.settings.flame]) profile.settings.flame = 'amber';
  const p = s.get('lbPeriod', 'week');
  profile.lbPeriod = PERIODS.some((x) => x.id === p) ? p : 'week';
  engine.audio.masterVolume = profile.settings.volume;
  // The host's webgame:mute also sets `muted`: loading only ever mutes (sound off), never un-mutes.
  if (!profile.settings.sound) engine.audio.muted = true;
}
function saveSettings(engine) {
  engine.storage.set('settings', { ...profile.settings });
}
function unlockSetting(engine, key) {
  if (profile.unlocks[key]) return false;
  profile.unlocks[key] = true;
  engine.storage.set('unlocks', { ...profile.unlocks });
  return true;
}
function toggleSound(engine) {
  profile.settings.sound = !profile.settings.sound;
  engine.audio.muted = !profile.settings.sound;
  saveSettings(engine);
  if (profile.settings.sound) engine.audio.tone({ freq: 660, duration: 0.08, type: 'triangle', volume: 0.15 });
}
const flame = () => FLAMES[profile.settings.flame];
const diff = () => DIFFS[profile.settings.difficulty];

// Achievements are declared in game.json; the engine posts each id once per session.
function unlock(engine, id) {
  if (typeof engine.platform.unlockAchievement === 'function') engine.platform.unlockAchievement(id);
}

// ------------------------------------------------------------------ binding labels (F009)

/** Label of a gamepad button; `input.gamepadLabel` is new, older engines fall back to the name. */
function padLabel(engine, name) {
  const input = engine.input;
  return typeof input.gamepadLabel === 'function' ? input.gamepadLabel(name) : name;
}
function actionOf(engine, id) {
  return engine.input.actions.find((a) => a.id === id) || null;
}
function padConnected(engine) {
  for (let i = 0; i < 4; i++) if (engine.input.gamepad(i).connected) return true;
  return false;
}
/** Short label for the HUD: the gamepad button when a pad is connected, else the first key. */
function hintLabel(engine, id) {
  const a = actionOf(engine, id);
  if (!a) return '-';
  if (padConnected(engine) && a.gamepad[0]) return padLabel(engine, a.gamepad[0]);
  return a.keys[0] ? engine.input.keyLabel(a.keys[0]) : a.gamepad[0] ? padLabel(engine, a.gamepad[0]) : '-';
}
/** Movement hint: the four first keys (they follow remapping), or the stick/D-pad on a gamepad. */
function moveHint(engine) {
  if (padConnected(engine)) return 'Stick/D-pad';
  return ['up', 'left', 'down', 'right'].map((id) => hintLabel(engine, id)).join('');
}
/** All keys / all pad buttons of an action, for the pause screen. */
function keyList(engine, a) {
  return a.keys.length ? a.keys.map((k) => engine.input.keyLabel(k)).join(' / ') : '(none)';
}
function padList(engine, a) {
  return a.gamepad.length ? a.gamepad.map((b) => padLabel(engine, b)).join(' / ') : '-';
}

// ------------------------------------------------------------------ drawing helpers

const TEXT_SMALL = { font: 'pixel', size: 8, color: '#f6e7c8', shadow: '#140d1f' };

/** Bindings contain arrows and other non-ASCII labels, so they use the canvas font, which has every glyph. */
function hintText(r, text, x, y, opts = {}) {
  r.drawText(text, x, y, { font: 'default', size: 10, color: '#e8dcc0', baseline: 'middle', ...opts });
}

function drawGround(engine, map) {
  const r = engine.renderer;
  const shimmer = Math.floor(engine.time * 2) % 2;
  map.draw(r, (id, x, y, col, row) => {
    let frame = F.grass;
    if (id === GRASS) frame = (col * 7 + row * 13) % 5 === 0 ? F.grass2 : F.grass;
    else if (id === PATH) frame = F.path;
    else if (id === HEDGE) frame = F.hedge;
    else if (id === WATER) frame = (col + row + shimmer) % 2 ? F.water : F.water2;
    else if (id === FLOWERS) frame = F.flowers;
    r.drawSprite(art.sheet, x, y, { frame });
  });
}

function flicker(t, seed) {
  return 0.9 + Math.sin(t * 9 + seed * 3.1) * 0.05 + Math.sin(t * 23 + seed) * 0.05;
}

function drawLanterns(engine, lanterns) {
  const r = engine.renderer;
  const fl = flame();
  for (const l of lanterns) {
    r.drawSprite(art.sheet, l.x, l.y, { frame: F.lantern });
    if (l.glow > 0) {
      const a = Math.min(1, 0.35 + l.glow) * flicker(engine.time, l.seed);
      r.drawRect(l.x + 5, l.y + 3, 6, 5, fl.glow, { alpha: a });
      r.drawRect(l.x + 7, l.y + 4, 2, 3, fl.core, { alpha: a });
    } else if (l.kindle > 0) {
      r.drawRect(l.x + 7, l.y + 6, 2, 2, fl.glow, { alpha: l.kindle / KINDLE_TIME });
    }
  }
}

/** Additive pools of light around each lit lantern (and the keeper's hand lamp). */
function drawGlow(engine, lanterns, keeper) {
  const r = engine.renderer;
  const fl = flame();
  r.setBlend('additive');
  for (const l of lanterns) {
    if (l.glow <= 0) continue;
    const f = flicker(engine.time, l.seed) * (0.4 + 0.6 * l.glow);
    const cx = l.x + 8;
    const cy = l.y + 6;
    r.drawCircle(cx, cy, 58 * f, fl.glow, { alpha: 0.06 });
    r.drawCircle(cx, cy, 38 * f, fl.glow, { alpha: 0.08 });
    r.drawCircle(cx, cy, 20 * f, fl.glow, { alpha: 0.12 });
  }
  if (keeper) r.drawCircle(keeper.x, keeper.y, 24, '#ffe6b0', { alpha: 0.06 });
  r.setBlend('normal');
}

function buildLanterns() {
  const out = [];
  MAP.forEach((row, ry) => {
    for (let c = 0; c < row.length; c++) if (row[c] === 'L') out.push({ x: c * T, y: ry * T, glow: 1, kindle: 0, seed: out.length * 1.7, drainers: 0 });
  });
  return out;
}

function buildMap(engine) {
  const grid = MAP.map((row) => Array.from(row, (ch) => TILE_OF[ch] ?? GRASS));
  const map = engine.Tilemap.fromArray(grid, T, T).setSolid([HEDGE, WATER]);
  map.solidBounds.left = map.solidBounds.right = map.solidBounds.top = map.solidBounds.bottom = true;
  return map;
}

// Menu helpers. Widgets are declared from update (F012); buttons focus their first entry when the menu
// opens, so Enter / gamepad A work at once, and the arrows / D-pad (the up/down/left/right actions) move.
function focusOnce(scene, engine, id) {
  if (!scene.focused) {
    scene.focused = true;
    engine.ui.focus = id;
  }
}
function menuSound(engine) {
  engine.audio.tone({ freq: 520, freqEnd: 780, duration: 0.07, type: 'triangle', volume: 0.12 });
}

/** Strips control/bidi characters and caps the length (the engine and parent sanitise again). */
function sanitizeCaption(text) {
  const clean = String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean).slice(0, 140).join('');
}

// ------------------------------------------------------------------ title

class TitleScene {
  enter(engine) {
    loadProfile(engine);
    this.t = 0;
    this.focused = false;
    this.map = buildMap(engine);
    this.lanterns = buildLanterns();
    this.moths = Array.from({ length: 4 }, (_, i) => ({ l: this.lanterns[i * 2], a: i * 1.6, r: 14 + i * 2 }));
    this.title = { y: -30, a: 0 };
    engine.tweens.to(this.title, { y: 58, a: 1 }, 0.9, { ease: 'backOut' });
  }
  update(engine, dt) {
    this.t += dt;
    for (const m of this.moths) m.a += dt * 2.4;
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    const ui = engine.ui;
    focusOnce(this, engine, 'play');
    const bx = W / 2 - 75;
    if (ui.button('play', 'PLAY', bx, 128, 150, 22, { textSize: 16 })) {
      menuSound(engine);
      engine.scenes.replace(new PlayScene());
    }
    if (ui.button('board', 'LEADERBOARD', bx, 154, 150, 22, { textSize: 16 })) {
      menuSound(engine);
      engine.scenes.push(new LeaderboardScene());
    }
    if (ui.button('settings', 'SETTINGS', bx, 180, 150, 22, { textSize: 16 })) {
      menuSound(engine);
      engine.scenes.push(new SettingsScene({ inRun: false }));
    }
  }
  render(engine) {
    const r = engine.renderer;
    drawGround(engine, this.map);
    drawLanterns(engine, this.lanterns);
    for (const m of this.moths) {
      const x = m.l.x + 8 + Math.cos(m.a) * m.r;
      const y = m.l.y + 6 + Math.sin(m.a * 1.3) * m.r * 0.6;
      r.drawSprite(art.sheet, x, y, { frame: Math.floor(this.t * 10 + m.a) % 2 ? F.moth1 : F.moth2, originX: 0.5, originY: 0.5 });
    }
    drawGlow(engine, this.lanterns, null);
    r.ui(() => {
      r.drawRect(0, 0, W, H, '#0b0816', { alpha: 0.45 });
      // The F012 BMFont at 2× its native 20 px.
      r.drawText('EMBER GARDEN', W / 2, this.title.y, { font: 'ember', size: 40, align: 'center', baseline: 'middle', color: flame().glow, alpha: this.title.a });
      r.drawText('keep the lanterns burning till dawn', W / 2, 92, { ...TEXT_SMALL, align: 'center', color: '#c9b8e8' });
      const best = profile.best > 0 ? `BEST ${profile.best}   WAVE ${profile.bestWave}   ` : '';
      r.drawText(`${best}MODE ${diff().name}`, W / 2, 110, { ...TEXT_SMALL, align: 'center', color: '#ffd166' });
      const L = (id) => hintLabel(engine, id);
      hintText(r, `${moveHint(engine)} move   ${L('light')} light   ${L('net')} net   ${L('dash')} dash   ${L('pause')} pause`, W / 2, 222, { align: 'center' });
      hintText(r, 'Moths snuff lanterns. Hold light to rekindle a dark one.', W / 2, 238, { align: 'center', color: '#a99cc4' });
      if (!profile.settings.sound) r.drawText('MUTED', W - 6, 6, { ...TEXT_SMALL, align: 'right' });
    });
  }
}

// ------------------------------------------------------------------ settings

class SettingsScene {
  constructor({ inRun }) {
    this.overlay = true;
    this.inRun = inRun; // difficulty can't change mid-run
  }
  enter(engine) {
    this.focused = false;
    this.fade = { a: 0 };
    engine.tweens.to(this.fade, { a: 1 }, 0.2, { ease: 'quadOut' });
  }
  cycle(list, current, unlocked) {
    const avail = list.filter((k) => unlocked(k));
    return avail[(avail.indexOf(current) + 1) % avail.length];
  }
  update(engine) {
    const ui = engine.ui;
    const s = profile.settings;
    focusOnce(this, engine, 'sound');
    const x = W / 2 - 100;
    let y = 68;
    const row = (id, label, opts) => {
      const hit = ui.button(id, label, x, y, 200, 18, opts);
      y += 22;
      return hit;
    };
    // F019 widgets are "value in, value out": pass the setting, store what comes back.
    if (ui.toggle('sound', s.sound, 'SOUND', x, y, 200, 18) !== s.sound) toggleSound(engine);
    y += 22;
    if (ui.toggle('shake', s.shake, 'SCREEN SHAKE', x, y, 200, 18) !== s.shake) {
      s.shake = !s.shake;
      saveSettings(engine);
      if (s.shake) engine.camera.shake(3, 0.2);
      menuSound(engine);
    }
    y += 22;
    // VOLUME: label on the left, slider on the right; applied live, saved once per drag / key step.
    ui.label('VOLUME', x, y + 9, { baseline: 'middle' });
    s.volume = ui.slider('volume', s.volume, x + 64, y + 2, 100, 14, { min: 0, max: 1, step: 0.1 });
    ui.label(`${Math.round(s.volume * 100)}%`, x + 200, y + 9, { align: 'right', baseline: 'middle' });
    if (ui.changed('volume')) engine.audio.masterVolume = s.volume;
    if (ui.committed('volume')) {
      saveSettings(engine);
      if (s.sound) engine.audio.tone({ freq: 660, duration: 0.06, type: 'triangle', volume: 0.12 });
    }
    y += 22;
    // Disabled mid-run: drawn at half alpha, skipped by keyboard/gamepad navigation.
    if (row('mode', `MODE: ${diff().name}`, { disabled: this.inRun })) {
      s.difficulty = this.cycle(Object.keys(DIFFS), s.difficulty, (k) => k !== 'swarm' || profile.unlocks.swarm);
      saveSettings(engine);
      menuSound(engine);
    }
    if (row('flame', `FLAME: ${flame().name}`)) {
      s.flame = this.cycle(Object.keys(FLAMES), s.flame, (k) => k === 'amber' || profile.unlocks[k]);
      saveSettings(engine);
      menuSound(engine);
    }
    y += 4;
    if (row('back', 'BACK') || engine.input.actionPressed('pause')) {
      menuSound(engine);
      engine.scenes.pop();
    }
  }
  render(engine) {
    const r = engine.renderer;
    const a = this.fade.a;
    r.ui(() => {
      r.drawRect(0, 0, W, H, '#0b0816', { alpha: 0.55 * a });
      engine.ui.panel(W / 2 - 130, 26, 260, 222, { alpha: a });
      r.drawText('SETTINGS', W / 2, 48, { font: 'ember', size: 20, align: 'center', baseline: 'middle', color: '#ffd166', alpha: a });
      let y = 212; // below BACK (which ends at 202)
      for (const [k, text] of Object.entries(UNLOCK_RULES)) {
        const open = profile.unlocks[k];
        r.drawText(`${open ? 'UNLOCKED' : 'LOCKED'}  ${text}`, W / 2, y, { ...TEXT_SMALL, align: 'center', color: open ? '#9fe0a8' : '#8b7fa8', alpha: a });
        y += 11;
      }
    });
  }
}

// ------------------------------------------------------------------ pause

class PauseScene {
  constructor(play) {
    this.overlay = true;
    this.play = play;
  }
  enter(engine) {
    this.focused = false;
    engine.audio.tone({ freq: 440, freqEnd: 330, duration: 0.1, type: 'triangle', volume: 0.12 });
  }
  update(engine) {
    const ui = engine.ui;
    focusOnce(this, engine, 'resume');
    const x = 40;
    if (ui.button('resume', 'RESUME', x, 70, 110, 20) || engine.input.actionPressed('pause')) {
      menuSound(engine);
      engine.scenes.pop();
      return;
    }
    if (ui.button('settings', 'SETTINGS', x, 96, 110, 20)) {
      menuSound(engine);
      engine.scenes.push(new SettingsScene({ inRun: true }));
    }
    if (ui.button('quit', 'END NIGHT', x, 122, 110, 20)) {
      menuSound(engine);
      engine.scenes.pop().then(() => this.play.endNight(engine, true));
    }
    if (engine.input.actionPressed('mute')) toggleSound(engine);
  }
  render(engine) {
    const r = engine.renderer;
    r.ui(() => {
      r.drawRect(0, 0, W, H, '#0b0816', { alpha: 0.6 });
      engine.ui.panel(24, 20, W - 48, 236);
      r.drawText('PAUSED', 95, 44, { font: 'ember', size: 20, align: 'center', baseline: 'middle', color: '#ffd166' });
      r.drawText(`GLOW ${Math.floor(this.play.score)}`, 95, 160, { ...TEXT_SMALL, align: 'center' });
      r.drawText(`WAVE ${this.play.wave}`, 95, 172, { ...TEXT_SMALL, align: 'center' });
      r.drawText(`MOTHS ${this.play.caught}`, 95, 184, { ...TEXT_SMALL, align: 'center' });
      // Live bindings (defaults + the player's ⌨ remaps), straight from input.actions.
      const x0 = 168;
      r.drawText('CONTROLS', x0, 36, { ...TEXT_SMALL, color: '#ffd166' });
      r.drawText('KEYS', x0 + 92, 36, { ...TEXT_SMALL, color: '#a99cc4' });
      r.drawText('GAMEPAD', x0 + 196, 36, { ...TEXT_SMALL, color: '#a99cc4' });
      let y = 56;
      for (const a of engine.input.actions) {
        hintText(r, a.name, x0, y);
        hintText(r, keyList(engine, a), x0 + 92, y, { color: '#ffffff' });
        hintText(r, padList(engine, a), x0 + 196, y, { color: '#ffffff' });
        y += 17;
      }
      hintText(r, 'Remap keys with the ⌨ button in the player bar.', x0, 236, { color: '#8b7fa8' });
    });
  }
}

// ------------------------------------------------------------------ play

class PlayScene {
  load(engine) {
    this.map = buildMap(engine);
    this.world = new engine.Physics({ gravity: 0, tilemap: this.map });
    this.lanterns = buildLanterns();
    // Lantern posts are small static bodies: the keeper walks around them.
    for (const l of this.lanterns) this.world.add({ x: l.x + 5, y: l.y + 11, w: 6, h: 4, isStatic: true, tag: 'post' });
    let sx = 14 * T;
    let sy = 13 * T;
    MAP.forEach((row, ry) => {
      const c = row.indexOf('P');
      if (c >= 0) [sx, sy] = [c * T + 3, ry * T + 4];
    });
    this.keeper = this.world.add({ x: sx, y: sy, w: 10, h: 10, tag: 'keeper' });
    this.face = { x: 0, y: 1 };
    this.dashT = 0;
    this.dashCd = 0;
    this.netT = 0;
    this.netCd = 0;
    this.walkAnim = 0;
    this.moths = [];
    this.score = 0;
    this.caught = 0;
    this.litSeconds = 0;
    this.combo = 0;
    this.lastCatch = -10;
    this.time = 0;
    this.wave = 0;
    this.toSpawn = 0;
    this.spawnT = 0;
    this.waveT = 0;
    this.breather = 1.2;
    this.over = false;
    this.overT = 0;
    this.relit = 0;
    this.pops = [];
    this.banner = { text: '', a: 0, s: 0.6 };
    const fl = flame();
    this.embers = new engine.ParticleEmitter({ life: [0.4, 0.9], speed: [15, 60], size: [2, 3], sizeEnd: 0, color: fl.sparks, gravityY: -50, drag: 0.6, blend: 'additive' });
    this.dust = new engine.ParticleEmitter({ life: [0.3, 0.7], speed: [15, 60], size: [2, 3], sizeEnd: 0, color: ['#c9b8e8', '#e8e0d0', '#7d6aa3'], gravityY: 25, drag: 0.5 });
    this.smoke = new engine.ParticleEmitter({ life: [0.7, 1.3], speed: [5, 20], size: [3, 4], sizeEnd: 7, color: ['#5a5266', '#3a3446'], gravityY: -18, shape: 'circle' });
    this.fireflies = new engine.ParticleEmitter({ x: W / 2, y: H / 2, spawnW: W - 40, spawnH: H - 50, rate: 2.5, life: [2, 4], speed: [3, 10], size: 2, sizeEnd: 1, color: ['#e6f7a0', '#fff3b0'], blend: 'additive', maxParticles: 40 });
    engine.camera.x = engine.camera.y = 0;
  }

  enter(engine) {
    profile.runs++;
    engine.storage.set('runs', profile.runs);
  }

  // ---- update
  update(engine, dt) {
    const input = engine.input;
    if (input.actionPressed('mute')) toggleSound(engine);
    this.updateParticles(dt);
    if (this.over) {
      // Let the last lantern's smoke play out, then show the summary over the dark garden.
      this.overT += dt;
      if (!this.summaryShown && this.overT >= this.overDelay) {
        this.summaryShown = true;
        engine.scenes.push(new GameOverScene(this, this.run));
      }
      return;
    }
    // A HUD pause button for mouse/touch players ({ nav: false } keeps arrows/confirm on the game).
    if (input.actionPressed('pause') || engine.ui.button('hud-pause', 'II', W - 22, 2, 18, 12, { nav: false })) {
      engine.scenes.push(new PauseScene(this));
      return;
    }
    this.time += dt;
    this.moveKeeper(engine, dt);
    this.updateNet(engine, dt);
    this.updateLight(engine, dt);
    this.updateMoths(engine, dt);
    this.updateLanterns(engine, dt);
    this.updateWaves(engine, dt);
  }

  updateParticles(dt) {
    this.embers.update(dt);
    this.dust.update(dt);
    this.smoke.update(dt);
    this.fireflies.update(dt);
  }

  moveKeeper(engine, dt) {
    const input = engine.input;
    const k = this.keeper;
    // axis() follows the up/down/left/right actions (and the left stick) because all four are declared.
    let mx = input.axis('horizontal');
    let my = input.axis('vertical');
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    if (len > 0.2) this.face = { x: mx / Math.max(len, 1e-6), y: my / Math.max(len, 1e-6) };
    this.dashCd -= dt;
    if (input.actionPressed('dash') && this.dashCd <= 0) {
      this.dashT = DASH_TIME;
      this.dashCd = DASH_COOLDOWN;
      engine.audio.noise({ duration: 0.12, volume: 0.12, filterStart: 3000, filterEnd: 600 });
    }
    if (this.dashT > 0) {
      this.dashT -= dt;
      k.vx = this.face.x * DASH_SPEED;
      k.vy = this.face.y * DASH_SPEED;
      this.embers.burst(2, k.centerX, k.centerY);
    } else {
      k.vx = engine.math.approach(k.vx, mx * PLAYER_SPEED, 900 * dt);
      k.vy = engine.math.approach(k.vy, my * PLAYER_SPEED, 900 * dt);
    }
    this.world.step(dt);
    this.walkAnim += Math.hypot(k.vx, k.vy) > 10 ? dt : 0;
  }

  netCenter() {
    const k = this.keeper;
    return { x: k.centerX + this.face.x * NET_REACH, y: k.centerY + this.face.y * NET_REACH };
  }

  updateNet(engine, dt) {
    this.netCd -= dt;
    if (engine.input.actionPressed('net') && this.netCd <= 0) {
      this.netT = NET_TIME;
      this.netCd = NET_COOLDOWN;
      engine.audio.noise({ duration: 0.08, volume: 0.08, filterStart: 1800, filterEnd: 400 });
    }
    if (this.netT <= 0) return;
    this.netT -= dt;
    const n = this.netCenter();
    for (const m of this.moths) {
      if (m.dead || !engine.math.circlesOverlap(n.x, n.y, NET_RADIUS, m.x, m.y, 5)) continue;
      m.dead = true;
      this.catchMoth(engine, m);
    }
    this.moths = this.moths.filter((m) => !m.dead);
  }

  catchMoth(engine, m) {
    this.caught++;
    this.combo = this.time - this.lastCatch < 1.6 ? Math.min(5, this.combo + 1) : 1;
    this.lastCatch = this.time;
    const pts = Math.round(50 * this.combo * diff().score);
    this.addScore(engine, pts, m.x, m.y - 6, this.combo > 1 ? `+${pts} x${this.combo}` : `+${pts}`);
    this.dust.burst(12, m.x, m.y);
    engine.audio.tone({ freq: 880 + this.combo * 110, freqEnd: 1320 + this.combo * 110, duration: 0.09, type: 'square', volume: 0.1 });
    if (this.caught >= 25) {
      unlock(engine, 'moth_catcher');
      if (unlockSetting(engine, 'azure')) this.showBanner(engine, 'AZURE FLAME UNLOCKED', 20);
    }
  }

  nearestLantern(x, y, pred) {
    let best = null;
    let bd = Infinity;
    for (const l of this.lanterns) {
      if (pred && !pred(l)) continue;
      const d = Math.hypot(l.x + 8 - x, l.y + 8 - y);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return { lantern: best, dist: bd };
  }

  updateLight(engine, dt) {
    const input = engine.input;
    const k = this.keeper;
    const { lantern: l, dist } = this.nearestLantern(k.centerX, k.centerY);
    this.nearLantern = l && dist < LIGHT_RANGE ? l : null;
    for (const x of this.lanterns) if (x !== this.nearLantern) x.kindle = 0;
    if (!this.nearLantern) {
      if (input.actionPressed('light')) engine.audio.tone({ freq: 160, duration: 0.05, type: 'triangle', volume: 0.08 });
      return;
    }
    const n = this.nearLantern;
    if (n.glow > 0) {
      // A lit lantern is topped up with a tap.
      if (input.actionPressed('light') && n.glow < 1) {
        n.glow = 1;
        this.embers.burst(10, n.x + 8, n.y + 5);
        engine.audio.tone({ freq: 523, freqEnd: 784, duration: 0.12, type: 'triangle', volume: 0.14 });
      }
      return;
    }
    // A dark lantern needs the light held for KINDLE_TIME.
    if (input.actionDown('light')) {
      n.kindle += dt;
      if (Math.random() < 0.4) this.embers.burst(1, n.x + 8, n.y + 6);
      if (n.kindle >= KINDLE_TIME) {
        n.kindle = 0;
        n.glow = 1;
        this.relit++;
        this.addScore(engine, Math.round(25 * diff().score), n.x + 8, n.y - 4);
        this.embers.burst(24, n.x + 8, n.y + 5);
        engine.audio.tone({ freq: 392, freqEnd: 988, duration: 0.25, type: 'triangle', volume: 0.16 });
        unlock(engine, 'first_light');
      }
    } else {
      n.kindle = Math.max(0, n.kindle - dt * 2);
    }
  }

  updateMoths(engine, dt) {
    const d = diff();
    const speed = Math.min(72, 36 + this.wave * 3) * d.speed;
    for (const l of this.lanterns) l.drainers = 0;
    for (const m of this.moths) {
      m.phase += dt;
      m.retarget -= dt;
      if (!m.target || m.target.glow <= 0 || m.retarget <= 0) {
        m.target = this.nearestLantern(m.x, m.y, (l) => l.glow > 0).lantern;
        m.retarget = 1 + Math.random();
      }
      const t = m.target;
      if (!t) {
        // Nothing left to snuff: drift.
        m.x += Math.cos(m.phase) * 20 * dt;
        m.y += Math.sin(m.phase * 1.3) * 20 * dt;
        continue;
      }
      const tx = t.x + 8;
      const ty = t.y + 5;
      const dist = Math.hypot(tx - m.x, ty - m.y);
      if (dist < 18) {
        // Orbit the flame and drain it.
        m.orbit += dt * 3.2;
        const ox = tx + Math.cos(m.orbit) * 11;
        const oy = ty + Math.sin(m.orbit) * 7;
        const k = engine.math.damp(10, dt);
        m.x = engine.math.lerp(m.x, ox, k);
        m.y = engine.math.lerp(m.y, oy, k);
        t.drainers++;
      } else {
        const nx = (tx - m.x) / dist;
        const ny = (ty - m.y) / dist;
        const flutter = Math.sin(m.phase * 7) * 0.6;
        m.x += (nx - ny * flutter) * speed * dt;
        m.y += (ny + nx * flutter) * speed * dt;
        if (dist < 30) m.orbit = Math.atan2(m.y - ty, m.x - tx);
      }
    }
  }

  updateLanterns(engine, dt) {
    const d = diff();
    const drain = 0.065 * d.drain * (1 + this.wave * 0.06);
    let lit = 0;
    for (const l of this.lanterns) {
      if (l.glow <= 0) continue;
      if (l.drainers > 0) {
        l.glow -= drain * l.drainers * dt;
        if (Math.random() < 0.08) this.dust.burst(1, l.x + 8, l.y + 5);
      }
      if (l.glow <= 0) {
        l.glow = 0;
        this.smoke.burst(14, l.x + 8, l.y + 5);
        if (profile.settings.shake) engine.camera.shake(3, 0.25);
        engine.audio.noise({ duration: 0.35, volume: 0.15, filterStart: 900, filterEnd: 120 });
        engine.audio.tone({ freq: 220, freqEnd: 110, duration: 0.3, type: 'sine', volume: 0.12 });
        continue;
      }
      lit++;
    }
    this.lit = lit;
    // Glow = lit-lantern-seconds × 10 (× the mode's multiplier).
    this.litSeconds += lit * dt;
    this.score += lit * 10 * d.score * dt;
    if (this.score >= 5000 && unlockSetting(engine, 'rose')) this.showBanner(engine, 'ROSE FLAME UNLOCKED', 20);
    if (this.score >= 10000) unlock(engine, 'ember_master');
    if (lit === 0) this.endNight(engine, false);
  }

  updateWaves(engine, dt) {
    if (this.breather > 0) {
      this.breather -= dt;
      if (this.breather <= 0) this.startWave(engine);
      return;
    }
    this.waveT += dt;
    if (this.toSpawn > 0) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        this.spawnMoth();
        this.toSpawn--;
        this.spawnT = Math.max(0.45, 2 - this.wave * 0.12) * (0.7 + Math.random() * 0.6);
      }
    } else if (this.moths.length === 0 || this.waveT > 45) {
      if (this.moths.length === 0) {
        const bonus = Math.round(100 * this.wave * diff().score);
        this.addScore(engine, bonus, W / 2, H / 2, `WAVE CLEAR +${bonus}`);
        engine.audio.tone({ freq: 523, duration: 0.1, type: 'triangle', volume: 0.14 });
        engine.audio.tone({ freq: 784, duration: 0.2, type: 'triangle', volume: 0.12, attack: 0.08 });
      }
      this.breather = 2.5;
    }
  }

  startWave(engine) {
    this.wave++;
    this.waveT = 0;
    this.toSpawn = Math.max(2, Math.round((2 + this.wave * 2) * diff().count));
    this.spawnT = 0.3;
    this.showBanner(engine, `WAVE ${this.wave}`, 40);
    engine.audio.tone({ freq: 196, freqEnd: 392, duration: 0.4, type: 'sawtooth', volume: 0.06 });
    if (this.wave >= 5 && this.lanterns.every((l) => l.glow > 0)) unlock(engine, 'full_bloom');
    if (this.wave >= 5 && unlockSetting(engine, 'swarm')) this.showBanner(engine, 'SWARM MODE UNLOCKED', 20);
    if (this.wave >= 8) unlock(engine, 'night_owl');
  }

  spawnMoth() {
    // From just outside a random edge; moths fly over the hedges.
    const side = Math.floor(Math.random() * 4);
    const along = Math.random();
    const x = side === 0 ? -10 : side === 1 ? W + 10 : 20 + along * (W - 40);
    const y = side === 2 ? 6 : side === 3 ? H + 10 : 24 + along * (H - 48);
    this.moths.push({ x, y, phase: Math.random() * 6, orbit: 0, target: null, retarget: 0, dead: false });
  }

  showBanner(engine, text, size) {
    engine.tweens.killTweensOf(this.banner);
    Object.assign(this.banner, { text, size, a: 0, s: 0.6 });
    engine.tweens.to(this.banner, { a: 1, s: 1 }, 0.35, { ease: 'backOut' });
    engine.tweens.to(this.banner, { a: 0 }, 0.5, { delay: 1.4, ease: 'quadIn' });
  }

  addScore(engine, n, x, y, text) {
    this.score += n;
    const pop = { x, y, a: 1, text: text || `+${n}` };
    this.pops.push(pop);
    engine.tweens.to(pop, { y: y - 16, a: 0 }, 0.9, { ease: 'quadOut', onComplete: () => this.pops.splice(this.pops.indexOf(pop), 1) });
  }

  /** The night ends when every lantern is dark (or the player ends it from the pause menu). */
  endNight(engine, quit) {
    if (this.over) return;
    this.over = true;
    this.keeper.vx = this.keeper.vy = 0;
    if (profile.settings.shake && !quit) engine.camera.shake(6, 0.5);
    engine.audio.tone({ freq: 392, freqEnd: 98, duration: 0.9, type: 'triangle', volume: 0.16 });
    const run = { score: Math.floor(this.score), wave: this.wave, caught: this.caught, litSeconds: Math.floor(this.litSeconds), relit: this.relit, mode: diff().name };
    const isBest = run.score > profile.best;
    if (isBest) {
      profile.best = run.score;
      engine.storage.set('best', run.score);
    }
    if (run.wave > profile.bestWave) {
      profile.bestWave = run.wave;
      engine.storage.set('bestWave', run.wave);
    }
    run.localBest = isBest;
    this.run = run;
    this.overDelay = quit ? 0 : 1.1;
  }

  // ---- render
  render(engine) {
    const r = engine.renderer;
    drawGround(engine, this.map);
    drawLanterns(engine, this.lanterns);
    this.smoke.draw(r);

    const k = this.keeper;
    const moving = Math.hypot(k.vx, k.vy) > 10;
    const frame = moving && Math.floor(this.walkAnim * 8) % 2 ? F.walk : F.idle;
    if (this.dashT > 0) r.drawSprite(art.sheet, k.centerX - this.face.x * 6, k.bottom - this.face.y * 6, { frame, originX: 0.5, originY: 1, flipX: this.face.x < 0, alpha: 0.35, tint: flame().glow });
    r.drawSprite(art.sheet, k.centerX, k.bottom + 1, { frame, originX: 0.5, originY: 1, flipX: this.face.x < 0 });

    if (this.netT > 0) {
      const n = this.netCenter();
      const swing = 1 - this.netT / NET_TIME;
      const ang = Math.atan2(this.face.y, this.face.x) + (swing - 0.5) * 1.6;
      const hx = k.centerX + Math.cos(ang) * NET_REACH;
      const hy = k.centerY + Math.sin(ang) * NET_REACH;
      r.drawLine(k.centerX, k.centerY, hx, hy, '#8a6a4a', 2);
      r.drawSprite(art.sheet, hx, hy, { frame: F.net, originX: 0.5, originY: 0.5, rotation: ang });
      r.drawCircle(n.x, n.y, NET_RADIUS, '#e8e0d0', { outline: 1, alpha: 0.15 * (1 - swing) });
    }

    for (const m of this.moths) {
      const fr = Math.floor((m.phase + m.x * 0.01) * 14) % 2 ? F.moth1 : F.moth2;
      r.drawSprite(art.sheet, m.x, m.y, { frame: fr, originX: 0.5, originY: 0.5 });
    }
    this.dust.draw(r);
    drawGlow(engine, this.lanterns, { x: k.centerX, y: k.centerY });
    this.embers.draw(r);
    this.fireflies.draw(r);

    // Interaction hint over the nearest lantern.
    const n = this.nearLantern;
    if (n && !this.over) {
      const dark = n.glow <= 0;
      if (dark || n.glow < 1) {
        r.drawText(dark ? `hold ${hintLabel(engine, 'light')}` : hintLabel(engine, 'light'), n.x + 8, n.y - 9, { font: 'default', size: 10, align: 'center', baseline: 'middle', color: dark ? '#ffd166' : '#e8dcc0', shadow: '#140d1f' });
      }
      if (dark && n.kindle > 0) {
        r.drawRect(n.x, n.y + 17, 16, 3, '#140d1f');
        r.drawRect(n.x + 1, n.y + 18, 14 * (n.kindle / KINDLE_TIME), 1, flame().glow);
      }
    }
    for (const p of this.pops) r.drawText(p.text, p.x, p.y, { ...TEXT_SMALL, align: 'center', color: '#ffd166', alpha: p.a });

    this.renderHud(engine);
  }

  renderHud(engine) {
    const r = engine.renderer;
    r.ui(() => {
      r.drawRect(0, 0, W, 16, '#0b0816', { alpha: 0.7 });
      r.drawText(`GLOW ${Math.floor(this.score)}`, 6, 4, TEXT_SMALL);
      r.drawText(`WAVE ${this.wave}`, 100, 4, { ...TEXT_SMALL, color: '#c9b8e8' });
      r.drawText(`MOTHS ${this.caught}`, 156, 4, { ...TEXT_SMALL, color: '#c9b8e8' });
      // one pip per lantern
      const fl = flame();
      const x0 = 250;
      this.lanterns.forEach((l, i) => {
        const cx = x0 + i * 12;
        r.drawCircle(cx, 8, 4, '#2a2236');
        if (l.glow > 0) r.drawCircle(cx, 8, 1 + 3 * l.glow, fl.glow);
      });
      if (this.combo > 1 && this.time - this.lastCatch < 1.6) r.drawText(`COMBO x${this.combo}`, 410, 4, { ...TEXT_SMALL, align: 'right', color: '#ffd166' });
      if (!profile.settings.sound) r.drawText('MUTED', 440, 4, { ...TEXT_SMALL, align: 'right', color: '#8b7fa8' });
      // Bottom hint bar: live bindings (keyboard, or the gamepad when one is connected).
      r.drawRect(0, H - 14, W, 14, '#0b0816', { alpha: 0.6 });
      const L = (id) => hintLabel(engine, id);
      hintText(r, `${L('light')} light (hold if dark)   ${L('net')} net   ${L('dash')} dash   ${L('pause')} pause`, W / 2, H - 7, { align: 'center' });
      if (this.banner.a > 0.01) {
        const size = this.banner.size || 40;
        r.drawText(this.banner.text, W / 2, 96, { font: 'ember', size, align: 'center', baseline: 'middle', color: flame().glow, alpha: this.banner.a, letterSpacing: (1 - this.banner.s) * 8 });
      }
    });
  }
}

// ------------------------------------------------------------------ game over

class GameOverScene {
  constructor(play, run) {
    this.overlay = true;
    this.play = play;
    this.run = run;
  }
  enter(engine) {
    this.focused = false;
    this.fade = { a: 0, y: 14 };
    engine.tweens.to(this.fade, { a: 1, y: 0 }, 0.45, { ease: 'cubicOut' });
    // F001: submitScore posts at once and resolves with the ScoreResultView, or null (anonymous player,
    // Studio, offline, older host). Older engines return undefined, so wrap it.
    this.result = undefined; // undefined = waiting, null = not ranked
    let pending;
    try {
      pending = engine.platform.submitScore(this.run.score);
    } catch {
      pending = null;
    }
    Promise.resolve(pending)
      .then((res) => (this.result = res && typeof res === 'object' ? res : null))
      .catch(() => (this.result = null));
    // F005 share state
    this.canShare = typeof engine.platform.shareScreenshot === 'function';
    this.share = 'idle'; // idle | hide | shoot | pending
    this.shareMsg = '';
    this.shareCd = 0;
    this.newUnlocks = Object.entries(profile.unlocks).filter(([, v]) => v).length;
  }
  update(engine, dt) {
    this.shareCd = Math.max(0, this.shareCd - dt);
    const ui = engine.ui;
    // While a screenshot is being taken, declare no widgets: the captured frame then has no buttons.
    if (this.share === 'hide') {
      this.share = 'shoot';
      return;
    }
    if (this.share === 'shoot') return;
    focusOnce(this, engine, 'again');
    const busy = this.share === 'pending' || this.shareCd > 0;
    // Give keyboard/gamepad players their focus back once the share button is enabled again.
    if (this.restoreFocus && !busy) {
      if (ui.focus === null) ui.focus = this.restoreFocus;
      this.restoreFocus = null;
    }
    const x = W / 2 - 152;
    if (ui.button('again', 'PLAY AGAIN', x, 196, 148, 18)) {
      menuSound(engine);
      engine.scenes.clear();
      engine.scenes.push(new PlayScene());
      return;
    }
    if (ui.button('board', 'LEADERBOARD', x + 156, 196, 148, 18)) {
      menuSound(engine);
      engine.scenes.push(new LeaderboardScene());
    }
    const label = !this.canShare ? 'SHARE UNAVAILABLE' : busy ? 'SHARING...' : 'SHARE SCREENSHOT';
    if (ui.button('share', label, x, 218, 148, 18, { disabled: !this.canShare || busy })) {
      this.restoreFocus = ui.focus;
      this.share = 'hide';
      this.shareMsg = '';
    }
    if (ui.button('title', 'TITLE', x + 156, 218, 148, 18)) {
      menuSound(engine);
      engine.scenes.clear();
      engine.scenes.push(new TitleScene());
    }
  }
  /** Called from render on the frame with no buttons, so this frame is the one captured. */
  shoot(engine) {
    this.share = 'pending';
    this.shareCd = SHARE_COOLDOWN;
    const run = this.run;
    const caption = sanitizeCaption(`Ember Garden: ${run.score} glow, wave ${run.wave}, ${run.caught} moths netted (${run.mode.toLowerCase()})`);
    let p;
    try {
      p = engine.platform.shareScreenshot({ caption });
    } catch {
      p = false;
    }
    Promise.resolve(p)
      .then((ok) => {
        // false covers: no parent, < 3 s since the last share, capture failure, parent rate limit or error.
        this.shareMsg = ok ? 'Added to your screenshot tray.' : 'Could not share right now. Try again in a moment.';
      })
      .catch(() => (this.shareMsg = 'Could not share right now. Try again in a moment.'))
      .finally(() => {
        this.share = 'idle';
        engine.audio.tone({ freq: 1200, duration: 0.05, type: 'square', volume: 0.08 });
      });
  }
  render(engine) {
    const r = engine.renderer;
    const a = this.fade.a;
    const run = this.run;
    r.ui(() => {
      r.drawRect(0, 0, W, H, '#0b0816', { alpha: 0.6 * a });
      const py = 12 + this.fade.y;
      engine.ui.panel(W / 2 - 170, py, 340, 246, { alpha: a });
      r.drawText('THE GARDEN SLEEPS', W / 2, py + 22, { font: 'ember', size: 20, align: 'center', baseline: 'middle', color: flame().glow, alpha: a });
      r.drawText(`${run.score}`, W / 2, py + 54, { font: 'ember', size: 40, align: 'center', baseline: 'middle', color: '#ffffff', alpha: a });
      r.drawText('GLOW', W / 2, py + 76, { ...TEXT_SMALL, align: 'center', color: '#c9b8e8', alpha: a });
      r.drawText(`WAVE ${run.wave}   MOTHS ${run.caught}   LANTERN-SECONDS ${run.litSeconds}   ${run.mode}`, W / 2, py + 92, { ...TEXT_SMALL, align: 'center', alpha: a });

      // F001 score-result view
      const res = this.result;
      let line1 = '';
      let line2 = '';
      let col = '#f6e7c8';
      if (res === undefined) line1 = 'Submitting score...';
      else if (res === null) {
        line1 = run.localBest ? 'NEW BEST ON THIS DEVICE!' : `BEST ${profile.best}`;
        line2 = 'Not ranked: sign in to join the leaderboard.';
        col = run.localBest ? '#ffd166' : col;
      } else {
        line1 = res.personalBest ? `NEW PERSONAL BEST: ${res.display}` : `SCORE SAVED: ${res.display}   RANK #${res.rank}`;
        const rk = res.ranks || {};
        line2 = `#${rk.day ?? '-'} today  -  #${rk.week ?? '-'} this week  -  #${rk.all ?? res.rank} all time`;
        col = res.personalBest ? '#ffd166' : col;
      }
      r.drawText(line1, W / 2, py + 114, { ...TEXT_SMALL, align: 'center', color: col, alpha: a });
      if (line2) r.drawText(line2, W / 2, py + 128, { ...TEXT_SMALL, align: 'center', color: '#c9b8e8', alpha: a });

      if (this.share === 'idle' || this.share === 'pending') {
        if (this.shareMsg) hintText(r, this.shareMsg, W / 2, py + 154, { align: 'center', color: '#9fe0a8', alpha: a });
        else hintText(r, `${hintLabel(engine, 'up')} ${hintLabel(engine, 'down')} choose   ${hintLabel(engine, 'confirm')} select`, W / 2, py + 154, { align: 'center', color: '#8b7fa8', alpha: a });
      } else {
        r.drawText('ember garden', W / 2, py + 154, { ...TEXT_SMALL, align: 'center', color: '#8b7fa8', alpha: a });
      }
    });
    if (this.share === 'shoot') this.shoot(engine);
  }
}

// ------------------------------------------------------------------ leaderboard

class LeaderboardScene {
  constructor() {
    this.overlay = true;
  }
  enter(engine) {
    this.focused = false;
    this.token = 0;
    this.select(engine, profile.lbPeriod);
  }
  select(engine, period) {
    this.period = period;
    profile.lbPeriod = period;
    engine.storage.set('lbPeriod', period); // remember the last tab
    this.view = undefined; // undefined = loading, null = unavailable
    const token = ++this.token;
    if (typeof engine.platform.getLeaderboard !== 'function') {
      this.view = null;
      return;
    }
    engine.platform
      .getLeaderboard({ period, limit: 8 })
      .then((v) => {
        if (token === this.token) this.view = v;
      })
      .catch(() => {
        if (token === this.token) this.view = null;
      });
  }
  update(engine) {
    const ui = engine.ui;
    focusOnce(this, engine, `tab-${this.period}`);
    PERIODS.forEach((p, i) => {
      const on = p.id === this.period;
      if (ui.button(`tab-${p.id}`, on ? `> ${p.label} <` : p.label, 60 + i * 122, 46, 116, 16, { textColor: on ? '#ffd166' : '#c9b8e8' }) && !on) {
        menuSound(engine);
        this.select(engine, p.id);
      }
    });
    if (ui.button('back', 'BACK', W / 2 - 50, 234, 100, 18) || engine.input.actionPressed('pause')) {
      menuSound(engine);
      engine.scenes.pop();
    }
  }
  render(engine) {
    const r = engine.renderer;
    r.ui(() => {
      r.drawRect(0, 0, W, H, '#0b0816', { alpha: 0.65 });
      engine.ui.panel(44, 8, W - 88, 254);
      r.drawText('LEADERBOARD', W / 2, 28, { font: 'ember', size: 20, align: 'center', baseline: 'middle', color: '#ffd166' });
      const v = this.view;
      const x0 = 74;
      if (v === undefined) {
        r.drawText('Loading...', W / 2, 130, { ...TEXT_SMALL, align: 'center' });
        return;
      }
      if (v === null) {
        hintText(r, 'Leaderboard unavailable here (offline, or no platform).', W / 2, 124, { align: 'center' });
        hintText(r, 'Publish the game and play it on the site to compete.', W / 2, 140, { align: 'center', color: '#8b7fa8' });
        return;
      }
      r.drawText('#', x0, 72, { ...TEXT_SMALL, color: '#8b7fa8' });
      r.drawText('PLAYER', x0 + 30, 72, { ...TEXT_SMALL, color: '#8b7fa8' });
      r.drawText((v.label || 'Score').toUpperCase().replace(/[^\x20-\x7e]/g, '?'), W - x0, 72, { ...TEXT_SMALL, align: 'right', color: '#8b7fa8' });
      if (!v.entries.length) {
        const when = { day: 'today', week: 'this week', all: 'yet' }[v.period] || 'yet';
        hintText(r, `No scores ${when} - be the first!`, W / 2, 130, { align: 'center' });
      }
      let y = 88;
      // Player names can hold any character, so rows use the canvas font.
      const rowText = (rank, name, display, me) => {
        const color = me ? '#ffd166' : '#f6e7c8';
        if (me) r.drawRect(x0 - 6, y - 7, W - 2 * x0 + 12, 14, '#ffd166', { alpha: 0.12 });
        hintText(r, `${rank}`, x0, y, { color });
        hintText(r, String(name).slice(0, 28), x0 + 30, y, { color });
        hintText(r, display, W - x0, y, { color, align: 'right' });
        y += 13;
      };
      for (const e of v.entries) rowText(e.rank, e.name, e.display, e.isMe);
      if (v.me && !v.entries.some((e) => e.isMe)) {
        r.drawLine(x0, y - 4, W - x0, y - 4, '#5a4a6a', 1);
        y += 4;
        rowText(v.me.rank, 'You', v.me.display, true);
      }
      const foot = `${v.totalPlayers} player${v.totalPlayers === 1 ? '' : 's'}${v.sample ? '  -  sample data (Studio preview)' : ''}`;
      hintText(r, foot, W / 2, 222, { align: 'center', color: '#8b7fa8' });
    });
  }
}

// ------------------------------------------------------------------ entry

export default {
  async load(engine) {
    const cols = 8;
    const frameXY = (i) => [(i % cols) * 16, Math.floor(i / cols) * 16];
    const rnd = new engine.Random(11);
    const tex = engine.assets.createTexture(cols * 16, 2 * 16, (ctx) => drawArt(ctx, frameXY, rnd));
    art = { sheet: engine.assets.spriteSheet(tex, 16, 16) };

    // F012: a BMFont for titles, plus 9-slice panel and button skins for engine.ui.
    const [, panel, button, hover, down] = await Promise.all([
      engine.assets.loadBitmapFont('ember', 'assets/fonts/ember.fnt'),
      engine.assets.loadNineSlice('assets/ui/panel.png', 4),
      engine.assets.loadNineSlice('assets/ui/button.png', 3),
      engine.assets.loadNineSlice('assets/ui/button_hover.png', 3),
      engine.assets.loadNineSlice('assets/ui/button_down.png', 3),
    ]);
    Object.assign(engine.ui.theme, {
      panel,
      button,
      buttonHover: hover,
      buttonDown: down,
      nineSliceScale: 2,
      font: 'pixel',
      textSize: 8,
      textColor: '#f6e7c8',
      disabledTextColor: '#8b7fa8',
      focusColor: '#ffd166',
      // F019 slider / toggle colours in the garden's palette.
      trackColor: '#2a1f3d',
      fillColor: '#c9773a',
      knobColor: '#ffd166',
    });
    engine.renderer.background = '#0b0816';
    loadProfile(engine);
    await engine.scenes.push(new TitleScene());
  },
};

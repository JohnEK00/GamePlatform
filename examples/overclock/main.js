// Overclock: a fast top-down action game. You are a rogue maintenance drone clearing the floors of a
// locked-down server facility of its sentry robots. One hit kills both ways. Shove sentries, grab the
// weapons they drop, throw them, slam doors into them, and when it goes wrong, reboot the floor
// with one press.
//
// Engine features shown here:
// - F009 actions: every control is a game.json action (keys, mouse buttons and gamepad), read with
//   actionPressed/actionDown/axis. The HUD and the pause screen print the live bindings with
//   keyLabel/gamepadLabel. Aiming is twin-stick: mouse cursor or gamepad right stick.
// - F012: a custom BMFont (assets/fonts/overclock.fnt, made by
//   packages/engine/scripts/gen-overclock-assets.mjs), 9-slice panels and buttons (assets/ui/*.png) and
//   engine.ui menus for the title, floor select, settings, pause, floor results, run end and leaderboard
//   (mouse, keyboard and gamepad).
// - F001: submitScore's ScoreResultView at the end of a run, and a leaderboard with day/week/all tabs.
// - F005: "Share screenshot" on the floor results and run end screens (sanitised caption, cooldown).
// - Achievements (game.json) and engine.storage (unlocked floors, best grade and score per floor, best
//   run, settings, last leaderboard tab), which the platform syncs as a cloud save.
// - Hand-authored floors (assets/floors.json) built into a Tilemap, top-down Physics bodies against
//   walls and cover, circle collisions for blows, bullets and doors, ParticleEmitters (additive sparks,
//   debris, smoke), tweens, camera follow with bounds, shake and a short hit-stop, and the synth.

const W = 480;
const H = 270;
const T = 16;

// ------------------------------------------------------------------ tiles and floor legend

const FLOOR = 1;
const GRATE = 2;
const WALL = 3;
const COVER = 4;
const DOORWAY = 5;
const LIFT = 6;
const TILE_OF = { '#': WALL, '=': COVER, ',': GRATE, D: DOORWAY, E: LIFT };
const ENEMY_OF = { m: ['clamp', false], M: ['clamp', true], s: ['picket', false], S: ['picket', true], h: ['bulwark', false], H: ['bulwark', true] };
const ITEM_OF = { w: 'wrench', n: 'nailgun', x: 'scatter' };
const passable = (id) => id !== WALL && id !== COVER;

// Sprite sheet frames (16x16). Characters and weapons face right (+x) and are drawn rotated.
const F = {
  floor: 0, floor2: 1, grate: 2, wall: 3, wallFace: 4, cover: 5, doorway: 6, lift: 7,
  drone: 8, clamp: 9, picket: 10, bulwark: 11, wrench: 12, nailgun: 13, scatter: 14, wreck: 15,
};

// ------------------------------------------------------------------ tuning

const WEAPONS = {
  wrench: { name: 'WRENCH', melee: true, reach: 21, arc: 1.15, cd: 0.28 },
  nailgun: { name: 'NAIL GUN', ammo: 8, cd: 0.13, speed: 430, pellets: 1, spread: 0.05, life: 0.8, noise: 150, auto: true },
  scatter: { name: 'SCATTER GUN', ammo: 3, cd: 0.55, speed: 370, pellets: 7, spread: 0.5, life: 0.3, noise: 320 },
};
const SHOVE = { reach: 17, arc: 1.05, cd: 0.36, stun: 1.6, push: 170 };
const KINDS = {
  // Clamp: fast melee sentry with a wrench.
  clamp: { name: 'CLAMP', size: 10, r: 5, speed: 84, view: 170, points: 100, weapon: 'wrench', melee: true, reach: 18, windup: 0.24, cd: 0.7, track: 5 },
  // Picket: slow, fires two-nail bursts from range.
  picket: { name: 'PICKET', size: 10, r: 5, speed: 54, view: 210, points: 100, weapon: 'nailgun', range: 190, windup: 0.42, cd: 1.1, track: 3.2, burst: 2, pellets: 1, spread: 0.06, bulletSpeed: 210, bulletLife: 1.3 },
  // Bulwark: heavy, shrugs off the shove, fires a scatter blast at close range.
  bulwark: { name: 'BULWARK', size: 12, r: 6, speed: 40, view: 170, points: 200, weapon: 'scatter', range: 120, windup: 0.6, cd: 1.5, track: 2.2, burst: 1, pellets: 5, spread: 0.5, bulletSpeed: 200, bulletLife: 0.65, shoveImmune: true },
};

const PLAYER_SPEED = 112;
const PLAYER_R = 5;
const COMBO_WINDOW = 3;
const SPEED_BONUS = 10; // points per second under par
const VARIETY_BONUS = 150; // points per distinct takedown method
const REACT_TIME = 0.32; // a sentry's pause between spotting you and acting ("!")
const FOV = 0.95; // half-angle of a sentry's view cone
const NEAR_SENSE = 20; // sentries notice you this close even from behind
const DOOR_LIMIT = 1.62;
const DOOR_PUSH = 7.5;
const DOOR_STUN_SPEED = 3.2;
const DOOR_STUN = 2.0;
const THROW_SPEED = 330;
const THROW_STUN = 1.8;
const RESTART_GUARD = 0.12; // ignore the restart press for this long after a death (no accidental double press)
const SHARE_COOLDOWN = 3.2; // the engine refuses shares < 3 s apart; the parent rate-limits too
const GRADES = ['S', 'A', 'B', 'C', 'D'];
const PERIODS = [
  { id: 'day', label: 'TODAY' },
  { id: 'week', label: 'THIS WEEK' },
  { id: 'all', label: 'ALL TIME' },
];
const METHOD_NAMES = { stomp: 'finisher', wrench: 'wrench', nailgun: 'nail gun', scatter: 'scatter', door: 'door', throw: 'throw' };

// ------------------------------------------------------------------ palette and art

const C = {
  ink: '#0b1016', slate0: '#151b22', slate1: '#1b2129', slate2: '#2a323d', slate3: '#3b4654', slate4: '#56657a',
  steel: '#c9d3dc', steelD: '#7d8a96', teal: '#3fc1b0', tealD: '#2a8f86', tealDD: '#123b37',
  amber: '#ffb000', amberD: '#c47a00', hot: '#ff5a3c', text: '#dfe8ee', dim: '#8a9aaa',
};

const PALETTE = {
  k: C.ink, g: C.steelD, w: '#e6f1f5', t: C.teal, T: C.tealD, a: C.amber, y: C.amber, s: C.slate4, S: C.slate3, h: C.steel,
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

const SPRITES = {
  drone: [
    '................',
    '.....kkkkk......',
    '....kgggggk.....',
    '...kkkkkkkkkk...',
    '..kTTttttttTk...',
    '..kTtkkkktttkk..',
    '.kkTtkwwktttaak.',
    '.kgTtkwwktttaak.',
    '.kgTtkwwktttaak.',
    '.kkTtkwwktttaak.',
    '..kTtkkkktttkk..',
    '..kTTttttttTk...',
    '...kkkkkkkkkk...',
    '....kgggggk.....',
    '.....kkkkk......',
  ],
  clamp: [
    '................',
    '..kkkkkkkk......',
    '.kssssssssk.kk..',
    '.ksSSSSSSskkgk..',
    '.ksSkkkkSsk.kgk.',
    '.ksSkaakSsk..kk.',
    '.ksSkaakSskk....',
    '.ksSkaakSsk.....',
    '.ksSkaakSskk....',
    '.ksSkaakSsk..kk.',
    '.ksSkkkkSsk.kgk.',
    '.ksSSSSSSskkgk..',
    '.kssssssssk.kk..',
    '..kkkkkkkk......',
  ],
  picket: [
    '................',
    '................',
    '....kkkkkk......',
    '...kssssssk.....',
    '..ksSSSSSSsk....',
    '..ksSkkkkSskkkkk',
    '..ksSkaakSsggggk',
    '..ksSkaakSsggggk',
    '..ksSkkkkSskkkkk',
    '..ksSSSSSSsk....',
    '...kssssssk.....',
    '....kkkkkk......',
    '....k....k......',
  ],
  bulwark: [
    '................',
    '.kkkkkkkkkkk....',
    'kssssssssssskkk.',
    'ksSSSSSSSSSskyk.',
    'ksSkkkkkkkSskkk.',
    'ksSkSSSSSkSskyk.',
    'ksSkSkaakSSskkk.',
    'ksSkSkaakSSskyk.',
    'ksSkSkaakSSskkk.',
    'ksSkSkaakSSskyk.',
    'ksSkSSSSSkSskkk.',
    'ksSkkkkkkkSskyk.',
    'ksSSSSSSSSSskkk.',
    'kssssssssssskyk.',
    '.kkkkkkkkkkkkkk.',
  ],
  wrench: [
    '', '', '', '', '',
    '............kk..',
    '...........khhk.',
    '.kk.......khk...',
    'khhkkkkkkkkhk...',
    'khhhhhhhhhhhk...',
    '.kk.......khk...',
    '...........khhk.',
    '............kk..',
  ],
  nailgun: [
    '', '', '', '', '',
    '...kkkkkkkkkk...',
    '..kggggggggggk..',
    '..kghhhhhhhhgkk.',
    '..kggggggggggk..',
    '..kkkktkkkkkk...',
    '.....ktk........',
    '.....ktk........',
    '.....kkk........',
  ],
  scatter: [
    '', '', '', '', '',
    'kkkkkkkkkkkkkkk.',
    'kggggggggggggggk',
    'kgyyggggghhhhhhk',
    'kggggggggggggggk',
    'kkkkkkkTkkkkkkk.',
    '.....kTTk.......',
    '.....kkkk.......',
  ],
};

function drawArt(ctx, at, rnd) {
  const tile = (frame, base) => {
    const [x, y] = at(frame);
    ctx.fillStyle = base;
    ctx.fillRect(x, y, 16, 16);
    return [x, y];
  };
  const rect = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };
  // floor plates: seams on two edges and corner rivets
  for (const [frame, stain] of [[F.floor, false], [F.floor2, true]]) {
    const [x, y] = tile(frame, C.slate1);
    rect(x, y, 16, 1, C.slate0);
    rect(x, y, 1, 16, C.slate0);
    rect(x + 2, y + 2, 1, 1, C.slate2);
    rect(x + 13, y + 13, 1, 1, C.slate2);
    if (stain) {
      for (let i = 0; i < 7; i++) rect(x + rnd.int(3, 12), y + rnd.int(3, 12), rnd.int(1, 3), 1, '#182028');
      rect(x + 6, y + 9, 4, 1, C.slate0);
    }
  }
  // grating
  {
    const [x, y] = tile(F.grate, C.slate0);
    for (let i = 1; i < 16; i += 3) rect(x + i, y, 1, 16, C.slate2);
    rect(x, y, 16, 1, C.slate2);
    rect(x, y + 15, 16, 1, C.ink);
  }
  // wall top (seen from above) and wall with its lit face (a floor tile below it)
  for (const [frame, face] of [[F.wall, false], [F.wallFace, true]]) {
    const [x, y] = tile(frame, '#323c48');
    rect(x, y, 16, 1, C.slate4);
    for (let i = 0; i < 3; i++) rect(x + rnd.int(1, 12), y + rnd.int(2, face ? 7 : 13), rnd.int(2, 4), 1, '#252c36');
    if (face) {
      rect(x, y + 10, 16, 6, '#10151b');
      rect(x, y + 10, 16, 1, C.slate4);
      rect(x, y + 12, 16, 1, C.tealDD);
    }
  }
  // cover: a console / rack on a floor plate
  {
    const [x, y] = tile(F.cover, C.slate1);
    rect(x + 1, y + 1, 14, 14, C.ink);
    rect(x + 2, y + 2, 12, 11, C.slate3);
    rect(x + 3, y + 3, 10, 5, C.tealDD);
    rect(x + 4, y + 4, 3, 1, C.teal);
    rect(x + 4, y + 6, 6, 1, C.tealD);
    rect(x + 3, y + 10, 2, 1, C.amber);
    rect(x + 7, y + 10, 6, 1, C.slate2);
    rect(x + 2, y + 13, 12, 2, '#10151b');
  }
  // doorway floor: hazard stripes on both edges
  {
    const [x, y] = tile(F.doorway, C.slate1);
    for (let i = 0; i < 16; i++) {
      const c = Math.floor(i / 2) % 2 ? C.amberD : C.ink;
      rect(x + i, y, 1, 2, c);
      rect(x + i, y + 14, 1, 2, c);
      rect(x, y + i, 2, 1, c);
      rect(x + 14, y + i, 2, 1, c);
    }
  }
  // lift pad
  {
    const [x, y] = tile(F.lift, C.slate0);
    rect(x + 1, y + 1, 14, 14, C.tealDD);
    rect(x + 2, y + 2, 12, 12, C.slate0);
    for (let i = 0; i < 3; i++) {
      rect(x + 5 + i, y + 4 + i, 1, 1, C.teal);
      rect(x + 10 - i, y + 4 + i, 1, 1, C.teal);
      rect(x + 5 + i, y + 9 + i, 1, 1, C.tealD);
      rect(x + 10 - i, y + 9 + i, 1, 1, C.tealD);
    }
  }
  for (const k of ['drone', 'clamp', 'picket', 'bulwark', 'wrench', 'nailgun', 'scatter']) {
    const [x, y] = at(F[k]);
    px(ctx, x, y, SPRITES[k]);
  }
  // a wrecked chassis (sentry corpses and the drone after a fault)
  {
    const [x, y] = at(F.wreck);
    rect(x + 3, y + 4, 9, 8, C.ink);
    rect(x + 4, y + 5, 3, 3, C.slate3);
    rect(x + 8, y + 7, 3, 4, C.slate2);
    rect(x + 1, y + 9, 3, 2, C.slate3);
    rect(x + 12, y + 3, 2, 2, C.slate2);
    rect(x + 6, y + 9, 1, 1, C.amberD);
  }
}

// ------------------------------------------------------------------ shared state

let art = null;
let FLOORS = [];
const profile = {
  unlocked: 0,
  grades: [],
  floorBest: [],
  bestRun: 0,
  runs: 0,
  settings: { sound: true, shake: true, hitstop: true, flash: true, assist: true },
  lbPeriod: 'week',
};

const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const angleDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
function turnToward(a, target, max) {
  const d = Math.atan2(Math.sin(target - a), Math.cos(target - a));
  return a + clamp(d, -max, max);
}
function gradeFor(ratio) {
  if (ratio >= 1) return 'S';
  if (ratio >= 0.8) return 'A';
  if (ratio >= 0.6) return 'B';
  if (ratio >= 0.4) return 'C';
  return 'D';
}
const betterGrade = (a, b) => (!b ? a : !a ? b : GRADES.indexOf(a) <= GRADES.indexOf(b) ? a : b);
const GRADE_COLOR = { S: C.amber, A: C.teal, B: '#9fd6ff', C: C.steel, D: C.dim };
function fmtTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/** Reads the save. Cloud data can arrive late (a second webgame:load is merged), so menus call this on enter. */
function loadProfile(engine) {
  const s = engine.storage;
  const n = FLOORS.length;
  profile.unlocked = Math.min(Math.max(0, n - 1), num(s.get('unlocked', 0)));
  const g = s.get('grades', null);
  profile.grades = Array.from({ length: n }, (_, i) => (Array.isArray(g) && GRADES.includes(g[i]) ? g[i] : null));
  const b = s.get('floorBest', null);
  profile.floorBest = Array.from({ length: n }, (_, i) => (Array.isArray(b) ? num(b[i]) : 0));
  profile.bestRun = num(s.get('bestRun', 0));
  profile.runs = num(s.get('runs', 0));
  const st = s.get('settings', null);
  if (st && typeof st === 'object') for (const k of Object.keys(profile.settings)) profile.settings[k] = st[k] !== false;
  const p = s.get('lbPeriod', 'week');
  profile.lbPeriod = PERIODS.some((x) => x.id === p) ? p : 'week';
  if (!profile.settings.sound) engine.audio.muted = true;
}
function saveSettings(engine) {
  engine.storage.set('settings', { ...profile.settings });
}
function toggleSound(engine) {
  profile.settings.sound = !profile.settings.sound;
  engine.audio.muted = !profile.settings.sound;
  saveSettings(engine);
  if (profile.settings.sound) sfx.blip(engine);
}
/** Records a cleared floor: best grade and score, and unlocks the next floor for floor select. */
function recordFloor(engine, index, total, grade) {
  const out = { newGrade: false, newBest: false, unlockedNext: false };
  const g = betterGrade(grade, profile.grades[index]);
  if (g !== profile.grades[index]) {
    profile.grades[index] = g;
    out.newGrade = true;
    engine.storage.set('grades', profile.grades.slice());
  }
  if (total > profile.floorBest[index]) {
    profile.floorBest[index] = total;
    out.newBest = true;
    engine.storage.set('floorBest', profile.floorBest.slice());
  }
  if (index + 1 < FLOORS.length && profile.unlocked < index + 1) {
    profile.unlocked = index + 1;
    out.unlockedNext = true;
    engine.storage.set('unlocked', profile.unlocked);
  }
  return out;
}

// Achievements are declared in game.json; the engine posts each id once per session.
function unlock(engine, id) {
  if (typeof engine.platform.unlockAchievement === 'function') engine.platform.unlockAchievement(id);
}

// ------------------------------------------------------------------ synth sound effects

const sfx = {
  blip: (e) => e.audio.tone({ freq: 660, freqEnd: 880, duration: 0.06, type: 'square', volume: 0.07 }),
  menu: (e) => e.audio.tone({ freq: 440, freqEnd: 660, duration: 0.06, type: 'triangle', volume: 0.12 }),
  shove: (e) => e.audio.noise({ duration: 0.08, volume: 0.12, filterStart: 1400, filterEnd: 300 }),
  swing: (e) => e.audio.noise({ duration: 0.1, volume: 0.1, filterStart: 3500, filterEnd: 800 }),
  clang: (e) => {
    e.audio.tone({ freq: 1180, freqEnd: 900, duration: 0.12, type: 'square', volume: 0.07 });
    e.audio.noise({ duration: 0.06, volume: 0.1, filterStart: 6000, filterEnd: 2000 });
  },
  nail: (e) => {
    e.audio.tone({ freq: 1500, freqEnd: 500, duration: 0.05, type: 'square', volume: 0.06 });
    e.audio.noise({ duration: 0.05, volume: 0.1, filterStart: 5000, filterEnd: 1200 });
  },
  scatter: (e) => {
    e.audio.noise({ duration: 0.35, volume: 0.24, filterStart: 2400, filterEnd: 150 });
    e.audio.tone({ freq: 120, freqEnd: 45, duration: 0.25, type: 'sawtooth', volume: 0.12 });
  },
  enemyShot: (e) => e.audio.tone({ freq: 900, freqEnd: 300, duration: 0.07, type: 'sawtooth', volume: 0.05 }),
  empty: (e) => e.audio.tone({ freq: 220, duration: 0.03, type: 'square', volume: 0.06 }),
  kill: (e, combo) => {
    e.audio.noise({ duration: 0.18, volume: 0.18, filterStart: 3000, filterEnd: 200 });
    e.audio.tone({ freq: 300 + combo * 90, freqEnd: 90, duration: 0.18, type: 'square', volume: 0.08 });
  },
  stun: (e) => e.audio.tone({ freq: 520, freqEnd: 260, duration: 0.14, type: 'triangle', volume: 0.12, vibrato: 30, vibratoRate: 30 }),
  door: (e) => e.audio.noise({ duration: 0.16, volume: 0.16, filterStart: 900, filterEnd: 120 }),
  alert: (e) => e.audio.tone({ freq: 620, freqEnd: 980, duration: 0.09, type: 'square', volume: 0.06 }),
  windup: (e) => e.audio.tone({ freq: 300, freqEnd: 520, duration: 0.12, type: 'sawtooth', volume: 0.04 }),
  pickup: (e) => e.audio.tone({ freq: 520, freqEnd: 1040, duration: 0.07, type: 'triangle', volume: 0.12 }),
  throw: (e) => e.audio.noise({ duration: 0.12, volume: 0.09, filterStart: 2500, filterEnd: 900 }),
  death: (e) => {
    e.audio.tone({ freq: 660, freqEnd: 40, duration: 0.6, type: 'sawtooth', volume: 0.14 });
    e.audio.noise({ duration: 0.5, volume: 0.2, filterStart: 2000, filterEnd: 80 });
  },
  reboot: (e) => e.audio.tone({ freq: 220, freqEnd: 880, duration: 0.14, type: 'square', volume: 0.07 }),
  lift: (e) => {
    e.audio.tone({ freq: 523, duration: 0.12, type: 'triangle', volume: 0.14 });
    e.audio.tone({ freq: 784, duration: 0.25, type: 'triangle', volume: 0.12, attack: 0.1 });
  },
};

// ------------------------------------------------------------------ binding labels (F009)

/** Label of a gamepad button; `input.gamepadLabel` is new, older engines fall back to the name. */
function padLabel(engine, name) {
  const input = engine.input;
  return typeof input.gamepadLabel === 'function' ? input.gamepadLabel(name) : name;
}
function actionOf(engine, id) {
  return engine.input.actions.find((a) => a.id === id) || null;
}
function firstPad(engine) {
  for (let i = 0; i < 4; i++) {
    const p = engine.input.gamepad(i);
    if (p.connected) return p;
  }
  return null;
}
/** Short label for the HUD: the gamepad button when a pad is connected, else the first key. */
function hintLabel(engine, id) {
  const a = actionOf(engine, id);
  if (!a) return '-';
  if (firstPad(engine) && a.gamepad[0]) return padLabel(engine, a.gamepad[0]);
  return a.keys[0] ? engine.input.keyLabel(a.keys[0]) : a.gamepad[0] ? padLabel(engine, a.gamepad[0]) : '-';
}
function moveHint(engine) {
  if (firstPad(engine)) return 'L-stick';
  return ['up', 'left', 'down', 'right'].map((id) => hintLabel(engine, id)).join('');
}
function keyList(engine, a) {
  return a.keys.length ? a.keys.map((k) => engine.input.keyLabel(k)).join(' / ') : '(none)';
}
function padList(engine, a) {
  return a.gamepad.length ? a.gamepad.map((b) => padLabel(engine, b)).join(' / ') : '-';
}

// ------------------------------------------------------------------ drawing helpers

const TEXT_SMALL = { font: 'pixel', size: 8, color: C.text, shadow: C.ink };

/** Bindings contain arrows and other non-ASCII labels, so they use the canvas font, which has every glyph. */
function hintText(r, text, x, y, opts = {}) {
  r.drawText(text, x, y, { font: 'default', size: 10, color: '#c6d3dc', baseline: 'middle', ...opts });
}
function title(r, text, x, y, size, color, alpha = 1) {
  r.drawText(text, x, y, { font: 'overclock', size, align: 'center', baseline: 'middle', color, alpha });
}

/** Layered rects at the screen edges: a vignette-style flash (death, damage) in screen space. */
function edgeFlash(r, a, color) {
  if (a <= 0.01) return;
  for (let i = 1; i <= 6; i++) {
    const t = i * 6;
    const al = a * 0.16;
    r.drawRect(0, 0, W, t, color, { alpha: al });
    r.drawRect(0, H - t, W, t, color, { alpha: al });
    r.drawRect(0, t, t, H - 2 * t, color, { alpha: al });
    r.drawRect(W - t, t, t, H - 2 * t, color, { alpha: al });
  }
}

/** Parses one floor of floors.json into tiles and spawn lists. */
function parseFloor(def) {
  const rows = def.map;
  const cols = Math.max(...rows.map((r) => r.length));
  const ch = (c, r) => (rows[r] && rows[r][c]) || '#';
  const grid = [];
  const enemies = [];
  const items = [];
  const doors = [];
  const lamps = [];
  let start = { c: 1, r: 1 };
  let lift = { c: 1, r: 1 };
  for (let r = 0; r < rows.length; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      const k = ch(c, r);
      row.push(TILE_OF[k] ?? FLOOR);
      if (k === 'P') start = { c, r };
      if (k === 'E') lift = { c, r };
      if (ENEMY_OF[k]) enemies.push({ kind: ENEMY_OF[k][0], patrol: ENEMY_OF[k][1], c, r });
      if (ITEM_OF[k]) items.push({ type: ITEM_OF[k], c, r });
      if (k === 'D') doors.push({ c, r, horizontal: ch(c - 1, r) === '#' && ch(c + 1, r) === '#' });
    }
    grid.push(row);
  }
  // Amber warning lamps on a few lit wall faces.
  for (let r = 0; r < rows.length - 1; r++)
    for (let c = 1; c < cols - 1; c++)
      if (grid[r][c] === WALL && passable(grid[r + 1][c]) && (c * 7 + r * 13) % 9 === 0) lamps.push({ x: c * T + 8, y: r * T + 11 });
  return { cols, rows: rows.length, grid, enemies, items, doors, lamps, start, lift, def };
}

function buildMap(engine, layout) {
  return engine.Tilemap.fromArray(layout.grid, T, T).setSolid([WALL, COVER]);
}

function drawTiles(engine, map) {
  const r = engine.renderer;
  map.draw(r, (id, x, y, col, row) => {
    let frame = F.floor;
    if (id === WALL) frame = row + 1 < map.rows && map.get(col, row + 1) !== WALL ? F.wallFace : F.wall;
    else if (id === COVER) frame = F.cover;
    else if (id === GRATE) frame = F.grate;
    else if (id === DOORWAY) frame = F.doorway;
    else if (id === LIFT) frame = F.lift;
    else frame = (col * 5 + row * 11) % 7 === 0 ? F.floor2 : F.floor;
    r.drawSprite(art.sheet, x, y, { frame });
  });
}

function drawLamps(engine, lamps, alarm) {
  const r = engine.renderer;
  const fast = alarm > 0;
  for (const l of lamps) {
    const on = fast ? Math.floor(engine.time * 6) % 2 === 0 : true;
    r.drawRect(l.x - 2, l.y - 1, 4, 2, on ? C.amber : C.amberD);
  }
  r.setBlend('additive');
  for (const l of lamps) {
    const pulse = fast ? (Math.floor(engine.time * 6) % 2 === 0 ? 1 : 0.25) : 0.55 + Math.sin(engine.time * 2 + l.x) * 0.15;
    r.drawCircle(l.x, l.y + 2, 18, C.amber, { alpha: 0.05 * pulse });
    r.drawCircle(l.x, l.y + 1, 7, C.amber, { alpha: 0.12 * pulse });
  }
  r.setBlend('normal');
}

function segPoint(px0, py0, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp(((px0 - ax) * dx + (py0 - ay) * dy) / l2, 0, 1) : 0;
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return { t, cx, cy, d: Math.hypot(px0 - cx, py0 - cy) };
}
function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
  if (den === 0) return false;
  const u = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
  const v = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

// Menu helpers. Widgets are declared from update (F012); a menu focuses its first entry when it opens,
// so Enter / gamepad A work at once, and the arrows / D-pad (the up/down/left/right actions) move.
function focusOnce(scene, engine, id) {
  if (!scene.focused) {
    scene.focused = true;
    engine.ui.focus = id;
  }
}

/** Strips control/bidi characters and caps the length (the engine and parent sanitise again). */
function sanitizeCaption(text) {
  const clean = String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(clean).slice(0, 140).join('');
}

/** F005 share state machine shared by the results and run-end screens. */
class Sharer {
  constructor(engine) {
    this.can = typeof engine.platform.shareScreenshot === 'function';
    this.state = 'idle'; // idle | hide | shoot | pending
    this.msg = '';
    this.cd = 0;
    this.restoreFocus = null;
  }
  get busy() {
    return this.state === 'pending' || this.cd > 0;
  }
  /** Call first in update. Returns true when no widgets may be declared this step (the captured frame). */
  hiding(dt) {
    this.cd = Math.max(0, this.cd - dt);
    if (this.state === 'hide') {
      this.state = 'shoot';
      return true;
    }
    return this.state === 'shoot';
  }
  restore(engine) {
    if (this.restoreFocus && !this.busy) {
      if (engine.ui.focus === null) engine.ui.focus = this.restoreFocus;
      this.restoreFocus = null;
    }
  }
  button(engine, x, y, w, h) {
    const label = !this.can ? 'SHARE UNAVAILABLE' : this.busy ? 'SHARING...' : 'SHARE SCREENSHOT';
    if (engine.ui.button('share', label, x, y, w, h, { disabled: !this.can || this.busy })) {
      this.restoreFocus = engine.ui.focus;
      this.state = 'hide';
      this.msg = '';
    }
  }
  /** Called from render on the frame with no buttons, so that frame is the one captured. */
  shoot(engine, caption) {
    if (this.state !== 'shoot') return;
    this.state = 'pending';
    this.cd = SHARE_COOLDOWN;
    let p;
    try {
      p = engine.platform.shareScreenshot({ caption: sanitizeCaption(caption) });
    } catch {
      p = false;
    }
    Promise.resolve(p)
      .then((ok) => {
        // false covers: no parent, < 3 s since the last share, capture failure, parent rate limit or error.
        this.msg = ok ? 'Added to your screenshot tray.' : 'Could not share right now. Try again in a moment.';
      })
      .catch(() => (this.msg = 'Could not share right now. Try again in a moment.'))
      .finally(() => {
        this.state = 'idle';
        sfx.blip(engine);
      });
  }
  get capturing() {
    return this.state === 'hide' || this.state === 'shoot';
  }
}

// ------------------------------------------------------------------ title

class TitleScene {
  constructor(opts = {}) {
    this.openFloors = !!opts.openFloors;
  }
  enter(engine) {
    loadProfile(engine);
    this.focused = false;
    this.layout = parseFloor(FLOORS[0].def);
    this.map = buildMap(engine, this.layout);
    engine.camera.bounds = null;
    engine.camera.zoom = 1;
    engine.camera.centerOn(this.layout.cols * T / 2, this.layout.rows * T / 2);
    this.sentries = this.layout.enemies.map((e, i) => ({ x: e.c * T + 8, y: e.r * T + 8, kind: e.kind, a: i * 1.3 }));
    this.head = { y: -30, a: 0 };
    engine.tweens.to(this.head, { y: 52, a: 1 }, 0.8, { ease: 'backOut' });
    if (this.openFloors) {
      this.openFloors = false;
      engine.scenes.push(new FloorSelectScene());
    }
  }
  resume(engine) {
    loadProfile(engine);
    this.focused = false;
  }
  update(engine, dt) {
    for (const s of this.sentries) s.a += dt * 0.6;
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    const ui = engine.ui;
    focusOnce(this, engine, 'run');
    const bx = W / 2 - 80;
    if (ui.button('run', 'NEW RUN', bx, 112, 160, 20, { textSize: 16 })) {
      sfx.menu(engine);
      engine.scenes.replace(new PlayScene({ mode: 'run', floor: 0, run: newRun() }));
    }
    if (ui.button('floors', 'FLOOR SELECT', bx, 136, 160, 20, { textSize: 16 })) {
      sfx.menu(engine);
      engine.scenes.push(new FloorSelectScene());
    }
    if (ui.button('board', 'LEADERBOARD', bx, 160, 160, 20, { textSize: 16 })) {
      sfx.menu(engine);
      engine.scenes.push(new LeaderboardScene());
    }
    if (ui.button('settings', 'SETTINGS', bx, 184, 160, 20, { textSize: 16 })) {
      sfx.menu(engine);
      engine.scenes.push(new SettingsScene());
    }
  }
  render(engine) {
    const r = engine.renderer;
    drawTiles(engine, this.map);
    for (const s of this.sentries) r.drawSprite(art.sheet, s.x, s.y, { frame: F[s.kind], originX: 0.5, originY: 0.5, rotation: Math.sin(s.a) * 0.9 });
    drawLamps(engine, this.layout.lamps, 0);
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.62 });
      title(r, 'OVERCLOCK', W / 2, this.head.y, 40, C.amber, this.head.a);
      r.drawText('a maintenance drone has gone off-script', W / 2, 78, { ...TEXT_SMALL, align: 'center', color: C.teal });
      const best = profile.bestRun > 0 ? `BEST RUN ${profile.bestRun}` : 'NO RUNS YET';
      r.drawText(`${best}   FLOORS OPEN ${profile.unlocked + 1}/${FLOORS.length}`, W / 2, 94, { ...TEXT_SMALL, align: 'center', color: C.steel });
      const L = (id) => hintLabel(engine, id);
      hintText(r, `${moveHint(engine)} move   aim with mouse / right stick   ${L('attack')} attack   ${L('throw')} throw   ${L('interact')} pick up`, W / 2, 226, { align: 'center' });
      hintText(r, `One hit ends you, and them. ${L('restart')} reboots the floor instantly.`, W / 2, 242, { align: 'center', color: C.dim });
      if (!profile.settings.sound) r.drawText('MUTED', W - 6, 6, { ...TEXT_SMALL, align: 'right' });
    });
  }
}

function newRun() {
  return { floors: [], reboots: 0 };
}
const runTotal = (run) => run.floors.reduce((s, f) => s + (f ? f.total : 0), 0);

// ------------------------------------------------------------------ floor select

class FloorSelectScene {
  constructor() {
    this.overlay = true;
  }
  enter(engine) {
    loadProfile(engine);
    this.focused = false;
  }
  update(engine) {
    const ui = engine.ui;
    focusOnce(this, engine, `floor-${profile.unlocked}`);
    FLOORS.forEach((f, i) => {
      const locked = i > profile.unlocked;
      if (ui.button(`floor-${i}`, locked ? `${i + 1}  LOCKED` : `${i + 1}  ${f.name}`, W / 2 - 150, 60 + i * 30, 190, 22, { disabled: locked })) {
        sfx.menu(engine);
        engine.scenes.clear();
        engine.scenes.push(new PlayScene({ mode: 'practice', floor: i }));
      }
    });
    if (ui.button('back', 'BACK', W / 2 - 50, 196, 100, 18) || engine.input.actionPressed('pause')) {
      sfx.menu(engine);
      engine.scenes.pop();
    }
    if (engine.input.actionPressed('mute')) toggleSound(engine);
  }
  render(engine) {
    const r = engine.renderer;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.5 });
      engine.ui.panel(W / 2 - 170, 18, 340, 210);
      title(r, 'FLOOR SELECT', W / 2, 38, 20, C.amber);
      FLOORS.forEach((f, i) => {
        const y = 71 + i * 30;
        const g = profile.grades[i];
        if (i > profile.unlocked) {
          r.drawText(`clear floor ${i} to open`, W / 2 + 52, y, { ...TEXT_SMALL, color: C.dim, baseline: 'middle' });
          return;
        }
        r.drawText(g || '-', W / 2 + 58, y, { font: 'overclock', size: 20, color: g ? GRADE_COLOR[g] : C.dim, align: 'center', baseline: 'middle' });
        r.drawText(profile.floorBest[i] ? `BEST ${profile.floorBest[i]}` : 'NOT CLEARED', W / 2 + 74, y - 4, { ...TEXT_SMALL, color: C.steel });
        r.drawText(`PAR ${fmtTime(f.par)}`, W / 2 + 74, y + 6, { ...TEXT_SMALL, color: C.dim });
      });
      hintText(r, 'Practice a single floor. Runs start from B4 and count for the leaderboard.', W / 2, 186, { align: 'center', color: C.dim });
    });
  }
}

// ------------------------------------------------------------------ settings

class SettingsScene {
  constructor() {
    this.overlay = true;
  }
  enter(engine) {
    this.focused = false;
    this.fade = { a: 0 };
    engine.tweens.to(this.fade, { a: 1 }, 0.2, { ease: 'quadOut' });
  }
  update(engine) {
    const ui = engine.ui;
    const s = profile.settings;
    focusOnce(this, engine, 'sound');
    const x = W / 2 - 110;
    let y = 64;
    const row = (id, label) => {
      const hit = ui.button(id, label, x, y, 220, 18);
      y += 22;
      return hit;
    };
    const flip = (k) => {
      s[k] = !s[k];
      saveSettings(engine);
      sfx.menu(engine);
    };
    if (row('sound', `SOUND: ${s.sound ? 'ON' : 'OFF'}`)) toggleSound(engine);
    if (row('shake', `SCREEN SHAKE: ${s.shake ? 'ON' : 'OFF'}`)) {
      flip('shake');
      if (s.shake) engine.camera.shake(3, 0.2);
    }
    if (row('hitstop', `HIT-STOP: ${s.hitstop ? 'ON' : 'OFF'}`)) flip('hitstop');
    if (row('flash', `FAULT FLASH: ${s.flash ? 'FULL' : 'SUBTLE'}`)) flip('flash');
    if (row('assist', `AIM ASSIST (pad/keys): ${s.assist ? 'ON' : 'OFF'}`)) flip('assist');
    y += 6;
    if (row('back', 'BACK') || engine.input.actionPressed('pause')) {
      sfx.menu(engine);
      engine.scenes.pop();
    }
  }
  render(engine) {
    const r = engine.renderer;
    const a = this.fade.a;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.55 * a });
      engine.ui.panel(W / 2 - 140, 20, 280, 232, { alpha: a });
      title(r, 'SETTINGS', W / 2, 42, 20, C.amber, a);
      hintText(r, 'Saved to your profile (cloud save when signed in).', W / 2, 236, { align: 'center', color: C.dim, alpha: a });
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
  resume() {
    this.focused = false; // back from settings: focus RESUME again
  }
  update(engine) {
    const ui = engine.ui;
    const play = this.play;
    focusOnce(this, engine, 'resume');
    const x = 34;
    if (ui.button('resume', 'RESUME', x, 66, 120, 20) || engine.input.actionPressed('pause')) {
      sfx.menu(engine);
      engine.scenes.pop();
      return;
    }
    if (ui.button('reboot', 'REBOOT FLOOR', x, 92, 120, 20)) {
      engine.scenes.pop().then(() => play.reset(engine, true));
      return;
    }
    if (ui.button('settings', 'SETTINGS', x, 118, 120, 20)) {
      sfx.menu(engine);
      engine.scenes.push(new SettingsScene());
    }
    if (ui.button('quit', play.mode === 'run' ? 'END RUN' : 'FLOOR SELECT', x, 144, 120, 20)) {
      sfx.menu(engine);
      engine.scenes.clear();
      if (play.mode === 'run') engine.scenes.push(new RunEndScene(play.run, false));
      else engine.scenes.push(new TitleScene({ openFloors: true }));
    }
    if (engine.input.actionPressed('mute')) toggleSound(engine);
  }
  render(engine) {
    const r = engine.renderer;
    const play = this.play;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.65 });
      engine.ui.panel(18, 14, W - 36, 244);
      title(r, 'PAUSED', 94, 40, 20, C.amber);
      r.drawText(play.floorDef.name, 94, 178, { ...TEXT_SMALL, align: 'center', color: C.teal });
      r.drawText(`FLOOR ${play.floorScore()}   TIME ${fmtTime(play.time)}`, 94, 190, { ...TEXT_SMALL, align: 'center' });
      if (play.mode === 'run') r.drawText(`RUN ${runTotal(play.run)}`, 94, 202, { ...TEXT_SMALL, align: 'center' });
      r.drawText(`REBOOTS ${play.reboots}`, 94, 214, { ...TEXT_SMALL, align: 'center', color: C.dim });
      // Live bindings (defaults + the player's remaps), straight from input.actions.
      const x0 = 170;
      r.drawText('CONTROLS', x0, 28, { ...TEXT_SMALL, color: C.amber });
      r.drawText('KEYS / MOUSE', x0 + 88, 28, { ...TEXT_SMALL, color: C.dim });
      r.drawText('GAMEPAD', x0 + 200, 28, { ...TEXT_SMALL, color: C.dim });
      let y = 46;
      for (const a of engine.input.actions) {
        hintText(r, a.name, x0, y);
        hintText(r, keyList(engine, a), x0 + 88, y, { color: '#ffffff' });
        hintText(r, padList(engine, a), x0 + 200, y, { color: '#ffffff' });
        y += 15;
      }
      hintText(r, 'Aim: mouse cursor or right stick.', x0, y + 2, { color: C.dim });
      hintText(r, 'Remap keys with the controls button in the player bar.', x0, 240, { color: C.dim });
    });
  }
}

// ------------------------------------------------------------------ play

class PlayScene {
  constructor(opts) {
    this.mode = opts.mode; // 'run' | 'practice'
    this.floorIndex = opts.floor;
    this.run = opts.run || null;
  }

  load(engine) {
    this.floorDef = FLOORS[this.floorIndex];
    this.layout = parseFloor(this.floorDef.def);
    this.map = buildMap(engine, this.layout);
    this.flows = new Map(); // BFS distance fields keyed by target tile; the map never changes
    this.reboots = 0;
    this.sparks = new engine.ParticleEmitter({ life: [0.12, 0.4], speed: [60, 200], size: [2, 3], sizeEnd: 0, color: ['#ffffff', '#ffe08a', C.amber], drag: 2.5, blend: 'additive', maxParticles: 400 });
    this.debris = new engine.ParticleEmitter({ life: [0.4, 0.9], speed: [30, 130], size: [2, 3], sizeEnd: 1, color: [C.slate4, C.slate3, C.steelD, C.tealD], drag: 3, spin: [-8, 8] });
    this.smoke = new engine.ParticleEmitter({ life: [0.6, 1.2], speed: [5, 25], size: [3, 4], sizeEnd: 8, color: ['#2c3540', '#1f262e'], gravityY: -10, shape: 'circle' });
    this.banner = { text: '', sub: '', a: 0, s: 0.6, size: 40 };
    this.flash = { a: 0 };
    this.reset(engine, false);
  }

  enter(engine) {
    if (this.mode === 'run' && this.floorIndex === 0) {
      profile.runs++;
      engine.storage.set('runs', profile.runs);
    }
    this.showBanner(engine, this.floorDef.name, 40, this.floorDef.brief);
  }

  /** Builds the floor from its initial state (a fresh start or an instant reboot after a fault). */
  reset(engine, reboot) {
    const L = this.layout;
    this.world = new engine.Physics({ gravity: 0, tilemap: this.map });
    const sx = L.start.c * T + T / 2;
    const sy = L.start.r * T + T / 2;
    const body = this.world.add({ x: sx - 5, y: sy - 5, w: 10, h: 10, tag: 'drone' });
    this.player = { body, x: sx, y: sy, r: PLAYER_R, aim: 0, moveAngle: 0, weapon: null, cd: 0, swing: 0, swingKind: '', dead: false, deadT: 0, walk: 0, isPlayer: true };
    this.enemies = L.enemies.map((d, i) => this.makeEnemy(d, i));
    this.doors = L.doors.map((d) => ({
      hx: d.horizontal ? d.c * T : d.c * T + T / 2,
      hy: d.horizontal ? d.r * T + T / 2 : d.r * T,
      base: d.horizontal ? 0 : Math.PI / 2,
      off: 0, w: 0, len: T, idle: 0, byPlayer: false, hit: [], contact: false, ex: 0, ey: 0,
    }));
    for (const d of this.doors) this.doorEnds(d);
    this.items = L.items.map((d) => ({ type: d.type, ammo: WEAPONS[d.type].ammo || 0, x: d.c * T + T / 2, y: d.r * T + T / 2, cool: 0, spin: 0 }));
    this.bullets = [];
    this.thrown = [];
    this.corpses = [];
    this.muzzles = [];
    this.pops = [];
    this.stats = { kills: 0, killPts: 0, stylePts: 0, bestCombo: 0, methods: new Set(), doorStuns: 0, throwStuns: 0, pickups: 0 };
    this.combo = 0;
    this.lastKill = -10;
    this.time = 0;
    this.cleared = false;
    this.finished = false;
    this.hitStop = 0;
    this.buffered = new Set(); // action presses made during a hit-stop
    this.alarm = 0;
    this.aimSrc = 'keys';
    const m = engine.input.mouse;
    this.lastMouse = { x: m.x, y: m.y };
    this.cross = { x: sx + 40, y: sy };
    engine.tweens.killTweensOf(this.flash);
    this.flash.a = 0;
    for (const e of [this.sparks, this.debris, this.smoke]) e.clear();
    const cam = engine.camera;
    cam.zoom = 1;
    cam.bounds = { x: 0, y: 0, w: L.cols * T, h: L.rows * T };
    cam.centerOn(sx, sy);
    if (reboot) {
      this.reboots++;
      if (this.run) this.run.reboots++;
      sfx.reboot(engine);
      this.sparks.burst(14, sx, sy);
    }
  }

  makeEnemy(d, i) {
    const k = KINDS[d.kind];
    const x = d.c * T + T / 2;
    const y = d.r * T + T / 2;
    const body = this.world.add({ x: x - k.size / 2, y: y - k.size / 2, w: k.size, h: k.size, tag: 'sentry' });
    const runs = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dc, dr]) => ({ dc, dr, n: this.freeRun(d.c, d.r, dc, dr) }));
    let facing;
    let patrolDir = null;
    if (d.patrol) {
      const hz = runs[0].n + runs[1].n;
      const vt = runs[2].n + runs[3].n;
      patrolDir = hz >= vt ? { x: runs[0].n >= runs[1].n ? 1 : -1, y: 0 } : { x: 0, y: runs[2].n >= runs[3].n ? 1 : -1 };
      facing = Math.atan2(patrolDir.y, patrolDir.x);
    } else {
      const best = runs.reduce((a, b) => (b.n > a.n ? b : a));
      facing = Math.atan2(best.dr, best.dc);
    }
    return {
      id: i, kind: d.kind, k, body, x, y, r: k.r, facing, post: { x, y, facing }, patrolDir,
      state: d.patrol ? 'patrol' : 'post', stunT: 0, stunBy: null, react: 0, wind: 0, cd: 0.4, burst: 0, burstT: 0,
      lastX: x, lastY: y, lost: 0, searchT: 0, tx: x, ty: y, mark: '', markT: 0, swing: 0, dead: false, seed: i * 1.37,
    };
  }

  /** Open tiles in a straight line from (c, r), stopping at walls, cover and doorways (patrols stay in their room). */
  freeRun(c, r, dc, dr) {
    const g = this.layout.grid;
    let n = 0;
    let x = c + dc;
    let y = r + dr;
    while (g[y] && g[y][x] !== undefined && passable(g[y][x]) && g[y][x] !== DOORWAY) {
      n++;
      x += dc;
      y += dr;
    }
    return n;
  }

  floorScore() {
    return this.stats.killPts + this.stats.stylePts;
  }

  // ---------------------------------------------------------------- update
  update(engine, dt) {
    const input = engine.input;
    if (input.actionPressed('mute')) toggleSound(engine);
    this.updateFx(dt);
    if (this.finished) return;
    // A HUD pause button for mouse/touch players ({ nav: false } keeps arrows/confirm on the game).
    if (input.actionPressed('pause') || engine.ui.button('hud-pause', 'II', W - 20, 1, 18, 12, { nav: false })) {
      engine.scenes.push(new PauseScene(this));
      return;
    }
    const p = this.player;
    if (p.dead) {
      // Instant reboot: one press of restart (or attack / confirm), no menus.
      p.deadT += dt;
      if (p.deadT > RESTART_GUARD && (input.actionPressed('restart') || input.actionPressed('attack') || input.actionPressed('confirm'))) this.reset(engine, true);
      return;
    }
    if (input.actionPressed('restart')) {
      this.reset(engine, true);
      return;
    }
    if (this.hitStop > 0) {
      // Frozen for a few frames: remember presses so a fast chain isn't eaten by the hit-stop.
      this.hitStop -= dt;
      for (const id of ['attack', 'throw', 'interact']) if (input.actionPressed(id)) this.buffered.add(id);
      return;
    }
    this.time += dt;
    this.alarm = Math.max(0, this.alarm - dt);
    this.updatePlayer(engine, dt);
    for (const e of this.enemies) if (!e.dead) this.updateEnemy(engine, e, dt);
    this.world.step(dt);
    this.syncPositions();
    this.updateDoors(engine, dt);
    this.separateEnemies();
    this.updateBullets(engine, dt);
    this.updateThrown(engine, dt);
    this.updateItems(engine, dt);
    if (this.cleared && !p.dead) {
      const lx = this.layout.lift.c * T;
      const ly = this.layout.lift.r * T;
      if (p.x > lx + 2 && p.x < lx + T - 2 && p.y > ly + 2 && p.y < ly + T - 2) this.finish(engine);
    }
    this.followCamera(engine);
  }

  updateFx(dt) {
    this.sparks.update(dt);
    this.debris.update(dt);
    this.smoke.update(dt);
    for (const m of this.muzzles) m.t -= dt;
    this.muzzles = this.muzzles.filter((m) => m.t > 0);
    for (const e of this.enemies) if (e.markT > 0) e.markT -= dt;
  }

  syncPositions() {
    const p = this.player;
    p.x = p.body.centerX;
    p.y = p.body.centerY;
    for (const e of this.enemies) {
      e.x = e.body.centerX;
      e.y = e.body.centerY;
    }
  }

  followCamera(engine) {
    const p = this.player;
    let lx = Math.cos(p.aim) * 28;
    let ly = Math.sin(p.aim) * 28;
    if (this.aimSrc === 'mouse') {
      lx = clamp((this.cross.x - p.x) * 0.3, -60, 60);
      ly = clamp((this.cross.y - p.y) * 0.3, -40, 40);
    }
    engine.camera.follow(p.x + lx, p.y + ly, 0.12);
  }

  // ---- player
  updatePlayer(engine, dt) {
    const input = engine.input;
    const p = this.player;
    const b = p.body;
    // axis() follows the up/down/left/right actions (and the left stick) because all four are declared.
    let mx = input.axis('horizontal');
    let my = input.axis('vertical');
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    if (len > 0.2) p.moveAngle = Math.atan2(my, mx);
    // Corner assist: pushing into a doorway's edge slides the drone around the corner instead of stopping.
    const slide = this.cornerSlide(b, mx, my);
    if (slide) {
      mx = slide.x || mx;
      my = slide.y || my;
    }
    b.vx = engine.math.approach(b.vx, mx * PLAYER_SPEED, 1500 * dt);
    b.vy = engine.math.approach(b.vy, my * PLAYER_SPEED, 1500 * dt);
    p.walk += Math.hypot(b.vx, b.vy) > 10 ? dt : 0;
    this.updateAim(engine, len > 0.2);
    p.cd -= dt;
    p.swing = Math.max(0, p.swing - dt);

    // Mouse0 is bound to "attack": ignore it while the pointer is on the HUD pause button.
    const onHud = engine.ui.hot === 'hud-pause';
    const pressed = (id) => input.actionPressed(id) || this.buffered.has(id);
    const w = p.weapon ? WEAPONS[p.weapon.type] : null;
    const wantAttack = !onHud && (w && w.auto && p.weapon.ammo > 0 ? input.actionDown('attack') || this.buffered.has('attack') : pressed('attack'));
    if (wantAttack && p.cd <= 0) this.attack(engine);
    if (pressed('throw') && !onHud) this.throwWeapon(engine);
    if (pressed('interact')) this.interact(engine);
    this.buffered.clear();
  }

  /** When a mostly straight move is blocked by up to 6 px of wall, returns the sideways direction that clears it. */
  cornerSlide(b, mx, my) {
    const free = (ox, oy) => !this.map.overlapsSolid({ x: b.x + ox, y: b.y + oy, w: b.w, h: b.h });
    const tryAxis = (along, dx, dy) => {
      if (free(dx, dy)) return null;
      for (let k = 1; k <= 6; k++)
        for (const s of [-1, 1]) {
          const sx = along === 'y' ? s * k : 0;
          const sy = along === 'x' ? s * k : 0;
          if (free(sx, sy) && free(sx + dx, sy + dy)) return along === 'y' ? { x: s * 0.8, y: 0 } : { x: 0, y: s * 0.8 };
        }
      return null;
    };
    if (Math.abs(my) > 0.5 && Math.abs(mx) < 0.3) return tryAxis('y', 0, Math.sign(my) * 2);
    if (Math.abs(mx) > 0.5 && Math.abs(my) < 0.3) return tryAxis('x', Math.sign(mx) * 2, 0);
    return null;
  }

  updateAim(engine, moving) {
    const input = engine.input;
    const p = this.player;
    const m = input.mouse;
    if (m.x !== this.lastMouse.x || m.y !== this.lastMouse.y || (m.inside && (m.pressed || m.rightPressed))) {
      this.aimSrc = 'mouse';
      this.lastMouse = { x: m.x, y: m.y };
    }
    const pad = firstPad(engine);
    if (pad && Math.hypot(pad.rightX, pad.rightY) > 0.35) {
      this.aimSrc = 'stick';
      p.aim = Math.atan2(pad.rightY, pad.rightX);
    }
    if (this.aimSrc === 'mouse') {
      const w = engine.camera.screenToWorld(m.x, m.y);
      this.cross = { x: w.x, y: w.y };
      if (Math.hypot(w.x - p.x, w.y - p.y) > 2) p.aim = Math.atan2(w.y - p.y, w.x - p.x);
    } else {
      if (this.aimSrc === 'keys' && moving) p.aim = p.moveAngle;
      this.cross = { x: p.x + Math.cos(p.aim) * 52, y: p.y + Math.sin(p.aim) * 52 };
    }
  }

  /** Aim used for attacks: with pad/keys aiming, snap to a visible sentry close to the aim line. */
  fireAngle() {
    const p = this.player;
    if (this.aimSrc === 'mouse' || !profile.settings.assist) return p.aim;
    let best = null;
    let bd = 0.35;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d > 230) continue;
      const a = Math.atan2(e.y - p.y, e.x - p.x);
      const diff = angleDiff(a, p.aim);
      if (diff < bd && this.lineClear(p.x, p.y, e.x, e.y, true, true)) {
        bd = diff;
        best = a;
      }
    }
    return best ?? p.aim;
  }

  /** Sentries in an arc in front of the drone. */
  inArc(x, y, ang, reach, arc) {
    return this.enemies.filter((e) => {
      if (e.dead) return false;
      const d = Math.hypot(e.x - x, e.y - y);
      return d < reach + e.r && (d < 6 || angleDiff(Math.atan2(e.y - y, e.x - x), ang) < arc);
    });
  }

  attack(engine) {
    const p = this.player;
    const ang = this.fireAngle();
    p.aim = ang;
    if (!p.weapon) {
      // Unarmed: shove. A shoved sentry is dazed; a dazed sentry can be finished with another shove.
      p.cd = SHOVE.cd;
      p.swing = 0.14;
      p.swingKind = 'shove';
      sfx.shove(engine);
      for (const e of this.inArc(p.x, p.y, ang, SHOVE.reach, SHOVE.arc)) {
        if (e.stunT > 0) this.killEnemy(engine, e, 'stomp');
        else if (e.k.shoveImmune) {
          sfx.clang(engine);
          this.sparks.burst(8, (p.x + e.x) / 2, (p.y + e.y) / 2);
          this.addPop(engine, 'NO EFFECT', e.x, e.y - 10, C.dim);
          p.body.vx -= Math.cos(ang) * 120;
          p.body.vy -= Math.sin(ang) * 120;
          if (e.state !== 'alert') this.alertEnemy(engine, e);
        } else this.stunEnemy(engine, e, 'shove', SHOVE.stun, Math.cos(ang) * SHOVE.push, Math.sin(ang) * SHOVE.push);
      }
      return;
    }
    const w = WEAPONS[p.weapon.type];
    if (w.melee) {
      p.cd = w.cd;
      p.swing = 0.16;
      p.swingKind = 'wrench';
      sfx.swing(engine);
      for (const e of this.inArc(p.x, p.y, ang, w.reach, w.arc)) this.killEnemy(engine, e, 'wrench');
      return;
    }
    if (p.weapon.ammo <= 0) {
      p.cd = 0.3;
      sfx.empty(engine);
      this.addPop(engine, `EMPTY - ${hintLabel(engine, 'throw').toUpperCase()} TO THROW`, p.x, p.y - 12, C.dim);
      return;
    }
    p.weapon.ammo--;
    p.cd = w.cd;
    const mx = p.x + Math.cos(ang) * 9;
    const my = p.y + Math.sin(ang) * 9;
    for (let i = 0; i < w.pellets; i++) {
      const a = ang + (w.pellets > 1 ? (i / (w.pellets - 1) - 0.5) * w.spread + (Math.random() - 0.5) * 0.06 : (Math.random() - 0.5) * w.spread);
      const sp = w.speed * (w.pellets > 1 ? 0.85 + Math.random() * 0.3 : 1);
      this.bullets.push({ x: mx, y: my, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: w.life, owner: 'player', weapon: p.weapon.type });
    }
    this.muzzles.push({ x: mx, y: my, a: ang, t: 0.06, big: w.pellets > 1 });
    p.body.vx -= Math.cos(ang) * (w.pellets > 1 ? 160 : 40);
    p.body.vy -= Math.sin(ang) * (w.pellets > 1 ? 160 : 40);
    if (p.weapon.type === 'scatter') sfx.scatter(engine);
    else sfx.nail(engine);
    this.shake(engine, w.pellets > 1 ? 4 : 1.5, 0.12);
    this.makeNoise(engine, p.x, p.y, w.noise);
  }

  throwWeapon(engine) {
    const p = this.player;
    if (!p.weapon) {
      sfx.empty(engine);
      return;
    }
    const ang = this.fireAngle();
    p.aim = ang;
    this.thrown.push({
      type: p.weapon.type, ammo: p.weapon.ammo, x: p.x + Math.cos(ang) * 6, y: p.y + Math.sin(ang) * 6,
      vx: Math.cos(ang) * THROW_SPEED, vy: Math.sin(ang) * THROW_SPEED, spin: 0,
    });
    p.weapon = null;
    p.cd = Math.max(p.cd, 0.15);
    sfx.throw(engine);
  }

  nearestItem(x, y, maxD) {
    let best = null;
    let bd = maxD;
    for (const it of this.items) {
      const d = Math.hypot(it.x - x, it.y - y);
      if (d < bd) {
        bd = d;
        best = it;
      }
    }
    return best;
  }

  interact(engine) {
    const p = this.player;
    const it = this.nearestItem(p.x, p.y, 18);
    if (!it) return;
    this.pickUp(engine, it);
  }

  pickUp(engine, it) {
    const p = this.player;
    this.items.splice(this.items.indexOf(it), 1);
    if (p.weapon) this.items.push({ type: p.weapon.type, ammo: p.weapon.ammo, x: p.x, y: p.y, cool: 0.6, spin: 0 });
    p.weapon = { type: it.type, ammo: it.ammo };
    this.stats.pickups++;
    sfx.pickup(engine);
    const w = WEAPONS[it.type];
    this.addPop(engine, w.melee ? w.name : `${w.name} x${it.ammo}`, p.x, p.y - 12, C.teal);
  }

  updateItems(engine, dt) {
    for (const it of this.items) {
      it.cool = Math.max(0, it.cool - dt);
      it.spin += dt;
    }
  }

  // ---- sentries
  alertEnemy(engine, e) {
    e.state = 'alert';
    e.react = REACT_TIME;
    e.mark = '!';
    e.markT = 0.7;
    e.lastX = this.player.x;
    e.lastY = this.player.y;
    e.lost = 0;
    this.alarm = 2;
    sfx.alert(engine);
  }

  canSee(e, dist, ang) {
    const k = e.k;
    if (dist > (e.state === 'alert' ? k.view * 1.3 : k.view)) return false;
    if (e.state !== 'alert' && dist > NEAR_SENSE && angleDiff(e.facing, ang) > FOV) return false;
    return this.lineClear(e.x, e.y, this.player.x, this.player.y, false, true);
  }

  updateEnemy(engine, e, dt) {
    const b = e.body;
    const k = e.k;
    const p = this.player;
    e.swing = Math.max(0, e.swing - dt);
    if (e.stunT > 0) {
      e.stunT -= dt;
      b.vx = engine.math.approach(b.vx, 0, 520 * dt);
      b.vy = engine.math.approach(b.vy, 0, 520 * dt);
      if (e.stunT <= 0) {
        // Back on its tracks and angry.
        e.stunBy = null;
        e.state = 'alert';
        e.react = 0.25;
        e.lastX = p.x;
        e.lastY = p.y;
        e.lost = 0;
        e.cd = Math.max(e.cd, 0.3);
      }
      return;
    }
    e.cd -= dt;
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const dist = Math.hypot(dx, dy);
    const toP = Math.atan2(dy, dx);
    const sees = !p.dead && this.canSee(e, dist, toP);
    if (sees) {
      e.lastX = p.x;
      e.lastY = p.y;
      e.lost = 0;
      if (e.state !== 'alert') this.alertEnemy(engine, e);
    }
    let vx = 0;
    let vy = 0;
    let face = null;
    let turn = 6;
    const go = (tx, ty, speed) => {
      const n = this.navDir(e.x, e.y, tx, ty);
      vx = n.x * speed;
      vy = n.y * speed;
      if (n.x || n.y) face = Math.atan2(n.y, n.x);
    };
    switch (e.state) {
      case 'post':
        face = e.post.facing + Math.sin(this.time * 0.9 + e.seed) * 0.5;
        turn = 2;
        if (Math.hypot(e.x - e.post.x, e.y - e.post.y) > 6) e.state = 'return';
        break;
      case 'patrol': {
        const d = e.patrolDir;
        const ax = e.x + d.x * (k.size / 2 + 4);
        const ay = e.y + d.y * (k.size / 2 + 4);
        const ahead = this.map.getAt(ax, ay);
        if (!passable(ahead) || ahead === DOORWAY || b.touching.left || b.touching.right || b.touching.top || b.touching.bottom) {
          d.x = -d.x;
          d.y = -d.y;
        }
        vx = d.x * k.speed * 0.45;
        vy = d.y * k.speed * 0.45;
        face = Math.atan2(d.y, d.x);
        turn = 5;
        break;
      }
      case 'investigate':
        if (e.react > 0) {
          e.react -= dt;
          face = Math.atan2(e.ty - e.y, e.tx - e.x);
          break;
        }
        if (Math.hypot(e.tx - e.x, e.ty - e.y) < 10) {
          e.state = 'search';
          e.searchT = 2.4;
          break;
        }
        go(e.tx, e.ty, k.speed * 0.75);
        break;
      case 'search':
        e.searchT -= dt;
        e.facing += dt * 2.4;
        if (e.searchT <= 0) e.state = 'return';
        break;
      case 'return':
        if (Math.hypot(e.post.x - e.x, e.post.y - e.y) < 6) {
          e.state = e.patrolDir ? 'patrol' : 'post';
          break;
        }
        go(e.post.x, e.post.y, k.speed * 0.5);
        break;
      case 'alert': {
        if (p.dead) break;
        if (e.react > 0) {
          e.react -= dt;
          face = toP;
          turn = 9;
          break;
        }
        if (e.wind > 0) {
          // Telegraphed attack: the sentry tracks you (slowly) and then commits.
          e.wind -= dt;
          face = toP;
          turn = k.track;
          if (e.wind <= 0) this.enemyStrike(engine, e);
          break;
        }
        if (e.burst > 0) {
          e.burstT -= dt;
          face = toP;
          turn = k.track;
          if (e.burstT <= 0) {
            this.enemyFire(engine, e);
            e.burst--;
            e.burstT = 0.13;
          }
          break;
        }
        if (!sees) {
          e.lost += dt;
          if (e.lost > 6 || Math.hypot(e.lastX - e.x, e.lastY - e.y) < 8) {
            e.state = 'search';
            e.searchT = 2.5;
            e.mark = '?';
            e.markT = 0.6;
            break;
          }
          go(e.lastX, e.lastY, k.speed);
          break;
        }
        if (k.melee) {
          if (dist < k.reach + 4 && e.cd <= 0) {
            e.wind = k.windup;
            sfx.windup(engine);
            break;
          }
          go(p.x, p.y, k.speed);
          if (dist < 40) face = toP;
        } else {
          const clear = this.lineClear(e.x, e.y, p.x, p.y, true, true);
          if (dist < k.range && clear && e.cd <= 0) {
            e.wind = k.windup;
            sfx.windup(engine);
            break;
          }
          if (dist > k.range * 0.7 || !clear) go(p.x, p.y, k.speed);
          face = toP;
          turn = k.track;
        }
        break;
      }
    }
    b.vx = vx;
    b.vy = vy;
    if (face !== null) e.facing = turnToward(e.facing, face, turn * dt);
  }

  enemyStrike(engine, e) {
    const k = e.k;
    const p = this.player;
    e.cd = k.cd;
    if (k.melee) {
      e.swing = 0.15;
      sfx.swing(engine);
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (!p.dead && d < k.reach + 6 && angleDiff(e.facing, Math.atan2(p.y - e.y, p.x - e.x)) < 1.1) this.killPlayer(engine, e.x, e.y);
      return;
    }
    this.enemyFire(engine, e);
    e.burst = k.burst - 1;
    e.burstT = 0.13;
  }

  enemyFire(engine, e) {
    const k = e.k;
    const n = k.pellets;
    const mx = e.x + Math.cos(e.facing) * (k.size / 2 + 3);
    const my = e.y + Math.sin(e.facing) * (k.size / 2 + 3);
    for (let i = 0; i < n; i++) {
      const a = e.facing + (n > 1 ? (i / (n - 1) - 0.5) * k.spread : (Math.random() - 0.5) * k.spread);
      this.bullets.push({ x: mx, y: my, vx: Math.cos(a) * k.bulletSpeed, vy: Math.sin(a) * k.bulletSpeed, life: k.bulletLife, owner: 'enemy', weapon: k.weapon });
    }
    this.muzzles.push({ x: mx, y: my, a: e.facing, t: 0.05, big: n > 1, enemy: true });
    if (n > 1) sfx.scatter(engine);
    else sfx.enemyShot(engine);
    this.makeNoise(engine, e.x, e.y, 110);
  }

  /** Gunfire is loud: sentries in range come to look (or, if already hunting, learn where you are). */
  makeNoise(engine, x, y, radius) {
    for (const e of this.enemies) {
      if (e.dead || e.stunT > 0) continue;
      if (Math.hypot(e.x - x, e.y - y) > radius) continue;
      if (e.state === 'alert') {
        if (e.lost > 0) {
          e.lastX = this.player.x;
          e.lastY = this.player.y;
        }
        continue;
      }
      e.state = 'investigate';
      e.tx = x;
      e.ty = y;
      e.react = 0.25;
      e.mark = '?';
      e.markT = 0.8;
    }
  }

  stunEnemy(engine, e, by, dur, kx, ky) {
    e.stunT = dur;
    e.stunBy = by;
    e.wind = 0;
    e.burst = 0;
    e.body.vx = kx;
    e.body.vy = ky;
    e.mark = '';
    sfx.stun(engine);
    this.sparks.burst(6, e.x, e.y);
  }

  doorStun(engine, e, nx, ny) {
    this.stunEnemy(engine, e, 'door', e.k.shoveImmune ? DOOR_STUN * 0.75 : DOOR_STUN, nx * 150, ny * 150);
    this.stats.doorStuns++;
    this.stats.stylePts += 60;
    this.addPop(engine, 'SLAM! +60', e.x, e.y - 10, C.amber);
    sfx.door(engine);
    this.shake(engine, 3, 0.15);
  }

  killEnemy(engine, e, method) {
    if (e.dead) return;
    e.dead = true;
    this.world.remove(e.body);
    const st = this.stats;
    // Combo: kills chained inside COMBO_WINDOW seconds multiply (x2, x3, ... up to x5).
    this.combo = this.time - this.lastKill <= COMBO_WINDOW ? this.combo + 1 : 1;
    this.lastKill = this.time;
    st.bestCombo = Math.max(st.bestCombo, this.combo);
    const mult = Math.min(5, this.combo);
    const pts = e.k.points * mult;
    st.kills++;
    st.killPts += pts;
    st.methods.add(method);
    let text = mult > 1 ? `+${pts} x${mult}` : `+${pts}`;
    // Style: finishing a sentry dazed by a door or a throw.
    if (e.stunT > 0 && (e.stunBy === 'door' || e.stunBy === 'throw')) {
      st.stylePts += 150;
      st.methods.add(e.stunBy);
      text += e.stunBy === 'door' ? '  DOOR KILL +150' : '  THROW KILL +150';
      if (e.stunBy === 'door') unlock(engine, 'swing_shift');
    }
    if (this.combo >= 4) unlock(engine, 'overclocked');
    this.addPop(engine, text, e.x, e.y - 10, mult > 1 ? C.amber : '#ffffff');
    // Drop its weapon (guns come with a fresh clip).
    const wt = e.k.weapon;
    this.items.push({ type: wt, ammo: WEAPONS[wt].ammo || 0, x: e.x, y: e.y, cool: 0.25, spin: 0 });
    this.corpses.push({ x: e.x, y: e.y, a: e.facing + Math.PI * (0.5 + Math.random()), kind: e.kind });
    this.sparks.burst(22, e.x, e.y);
    this.debris.burst(12, e.x, e.y);
    this.smoke.burst(4, e.x, e.y);
    sfx.kill(engine, mult);
    this.shake(engine, 3 + mult * 0.5, 0.15);
    if (profile.settings.hitstop) this.hitStop = 0.05 + Math.min(0.05, mult * 0.01);
    if (this.enemies.every((x) => x.dead)) {
      this.cleared = true;
      this.alarm = 0;
      this.showBanner(engine, 'FLOOR CLEAR', 20, 'Get to the lift.');
      sfx.lift(engine);
    }
  }

  killPlayer(engine, fromX, fromY) {
    const p = this.player;
    if (p.dead) return;
    p.dead = true;
    p.deadT = 0;
    p.body.vx = p.body.vy = 0;
    for (const e of this.enemies) e.body.vx = e.body.vy = 0;
    this.sparks.burst(30, p.x, p.y);
    this.debris.burst(16, p.x, p.y);
    this.smoke.burst(8, p.x, p.y);
    this.deathFrom = Math.atan2(p.y - fromY, p.x - fromX);
    sfx.death(engine);
    this.shake(engine, 7, 0.35);
    this.flash.a = 1;
    engine.tweens.killTweensOf(this.flash);
    engine.tweens.to(this.flash, { a: profile.settings.flash ? 0.35 : 0 }, 0.5, { ease: 'quadOut' });
  }

  shake(engine, i, d) {
    if (profile.settings.shake) engine.camera.shake(i, d);
  }

  // ---- navigation and sight
  /** Samples the segment every 4 px: walls always block; cover blocks shots and walking; doors block sight. */
  lineClear(x0, y0, x1, y1, blockCover, blockDoors) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const n = Math.ceil(Math.hypot(dx, dy) / 4);
    for (let i = 1; i < n; i++) {
      const id = this.map.getAt(x0 + (dx * i) / n, y0 + (dy * i) / n);
      if (id === WALL || (blockCover && id === COVER)) return false;
    }
    if (blockDoors) for (const d of this.doors) if (segIntersect(x0, y0, x1, y1, d.hx, d.hy, d.ex, d.ey)) return false;
    return true;
  }

  walkClear(x0, y0, x1, y1) {
    const d = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ox = (-(y1 - y0) / d) * 4.5;
    const oy = ((x1 - x0) / d) * 4.5;
    return this.lineClear(x0, y0, x1, y1, true, false) && this.lineClear(x0 + ox, y0 + oy, x1 + ox, y1 + oy, true, false) && this.lineClear(x0 - ox, y0 - oy, x1 - ox, y1 - oy, true, false);
  }

  /** BFS distance field (4-neighbour) from the target tile, cached: the floor layout never changes. */
  flowField(tx, ty) {
    const L = this.layout;
    const c0 = clamp(Math.floor(tx / T), 0, L.cols - 1);
    const r0 = clamp(Math.floor(ty / T), 0, L.rows - 1);
    const key = r0 * L.cols + c0;
    let f = this.flows.get(key);
    if (f) return f;
    f = new Int16Array(L.cols * L.rows).fill(-1);
    f[key] = 0;
    const q = [key];
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      const c = i % L.cols;
      const r = (i - c) / L.cols;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc;
        const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= L.cols || nr >= L.rows) continue;
        const ni = nr * L.cols + nc;
        if (f[ni] >= 0 || !passable(L.grid[nr][nc])) continue;
        f[ni] = f[i] + 1;
        q.push(ni);
      }
    }
    this.flows.set(key, f);
    return f;
  }

  /** Unit direction from (x, y) toward (tx, ty): straight when the way is open, else down the BFS field. */
  navDir(x, y, tx, ty) {
    const dd = Math.hypot(tx - x, ty - y);
    if (dd < 1) return { x: 0, y: 0 };
    if (this.walkClear(x, y, tx, ty)) return { x: (tx - x) / dd, y: (ty - y) / dd };
    const L = this.layout;
    const f = this.flowField(tx, ty);
    const c = Math.floor(x / T);
    const r = Math.floor(y / T);
    const open = (cc, rr) => cc >= 0 && rr >= 0 && cc < L.cols && rr < L.rows && passable(L.grid[rr][cc]);
    let bv = f[r * L.cols + c];
    if (bv < 0) bv = 1e9;
    let best = null;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nc = c + dc;
      const nr = r + dr;
      if (!open(nc, nr)) continue;
      if (dc && dr && (!open(c + dc, r) || !open(c, r + dr))) continue;
      const v = f[nr * L.cols + nc];
      if (v >= 0 && v < bv) {
        bv = v;
        best = { c: nc, r: nr };
      }
    }
    if (!best) return { x: (tx - x) / dd, y: (ty - y) / dd };
    const nx = best.c * T + T / 2 - x;
    const ny = best.r * T + T / 2 - y;
    const nd = Math.hypot(nx, ny) || 1;
    return { x: nx / nd, y: ny / nd };
  }

  separateEnemies() {
    const list = this.enemies.filter((e) => !e.dead);
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = a.r + b.r;
        if (d >= min || d < 0.001 || this.nearDoorway(a) || this.nearDoorway(b)) continue;
        const push = (min - d) / 2;
        this.nudge(a, (-dx / d) * push, (-dy / d) * push);
        this.nudge(b, (dx / d) * push, (dy / d) * push);
      }
  }

  nearDoorway(c) {
    for (const [ox, oy] of [[0, 0], [T, 0], [-T, 0], [0, T], [0, -T]]) if (this.map.getAt(c.x + ox, c.y + oy) === DOORWAY) return true;
    return false;
  }

  /** Moves a body directly, unless that would put it inside a wall or cover. */
  nudge(c, dx, dy) {
    const b = c.body;
    b.x += dx;
    b.y += dy;
    if (this.map.overlapsSolid(b)) {
      b.x -= dx;
      b.y -= dy;
      return;
    }
    c.x = b.centerX;
    c.y = b.centerY;
  }

  // ---- doors
  doorEnds(d) {
    const a = d.base + d.off;
    d.ex = d.hx + Math.cos(a) * d.len;
    d.ey = d.hy + Math.sin(a) * d.len;
  }

  updateDoors(engine, dt) {
    const p = this.player;
    const pushers = this.enemies.filter((e) => !e.dead && e.stunT <= 0);
    if (!p.dead) pushers.push(p);
    for (const d of this.doors) {
      const a = d.base + d.off;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      // 1) A fast swing the drone started stuns the sentries it sweeps into.
      if (d.byPlayer && Math.abs(d.w) > DOOR_STUN_SPEED) {
        for (const e of this.enemies) {
          if (e.dead || e.stunT > 0 || d.hit.includes(e)) continue;
          const q = segPoint(e.x, e.y, d.hx, d.hy, d.ex, d.ey);
          if (q.d > e.r + 3 || q.t < 0.2) continue;
          const s = Math.sign(ux * (e.y - d.hy) - uy * (e.x - d.hx)) || 1;
          if (Math.sign(d.w) !== s) continue; // the leaf is moving away from it
          d.hit.push(e);
          this.doorStun(engine, e, -uy * s, ux * s);
        }
      }
      // 2) Bodies push the leaf away from themselves (rotating by +w moves it toward the left normal).
      d.contact = false;
      for (const c of pushers) {
        if (c.stunT > 0) continue;
        const q = segPoint(c.x, c.y, d.hx, d.hy, d.ex, d.ey);
        if (q.d >= c.r) continue;
        d.contact = true;
        const s = Math.sign(ux * (c.y - d.hy) - uy * (c.x - d.hx)) || 1;
        const speed = c.isPlayer ? DOOR_PUSH : DOOR_PUSH * 0.55;
        const want = -s * speed;
        if (Math.sign(d.w) !== Math.sign(want) || Math.abs(d.w) < speed) {
          if (c.isPlayer && Math.abs(d.w) < 2) {
            d.byPlayer = true;
            d.hit = [];
            sfx.door(engine);
          } else if (!c.isPlayer) d.byPlayer = false;
          d.w = want;
        }
        if (q.d > 0.01) this.nudge(c, ((c.x - q.cx) / q.d) * (c.r - q.d), ((c.y - q.cy) / q.d) * (c.r - q.d));
      }
      d.off += d.w * dt;
      if (Math.abs(d.off) > DOOR_LIMIT) {
        d.off = Math.sign(d.off) * DOOR_LIMIT;
        d.w = -d.w * 0.25;
      }
      d.w *= Math.exp(-2.5 * dt);
      if (d.contact) d.idle = 0;
      else {
        d.idle += dt;
        // Unattended doors drift slowly shut.
        if (d.idle > 1.2 && Math.abs(d.w) < 0.8) d.off = engine.math.approach(d.off, 0, 0.9 * dt);
      }
      if (Math.abs(d.w) < 1) {
        d.byPlayer = false;
        d.hit.length = 0;
      }
      this.doorEnds(d);
    }
  }

  // ---- projectiles
  updateBullets(engine, dt) {
    const p = this.player;
    for (const b of this.bullets) {
      const steps = Math.max(1, Math.ceil((Math.hypot(b.vx, b.vy) * dt) / 4));
      for (let s = 0; s < steps && !b.dead; s++) {
        b.x += (b.vx * dt) / steps;
        b.y += (b.vy * dt) / steps;
        const id = this.map.getAt(b.x, b.y);
        if (id === WALL || id === COVER) {
          b.dead = true;
          this.sparks.burst(4, b.x - (b.vx * dt) / steps, b.y - (b.vy * dt) / steps);
          break;
        }
        for (const d of this.doors) {
          if (segPoint(b.x, b.y, d.hx, d.hy, d.ex, d.ey).d < 1.5) {
            b.dead = true;
            this.sparks.burst(3, b.x, b.y);
            break;
          }
        }
        if (b.dead) break;
        if (b.owner === 'player') {
          for (const e of this.enemies) {
            if (e.dead || !engine.math.circlesOverlap(b.x, b.y, 2, e.x, e.y, e.r + 1)) continue;
            b.dead = true;
            this.killEnemy(engine, e, b.weapon);
            break;
          }
        } else if (!p.dead && engine.math.circlesOverlap(b.x, b.y, 2, p.x, p.y, 4)) {
          b.dead = true;
          this.killPlayer(engine, b.x - b.vx, b.y - b.vy);
        }
      }
      b.life -= dt;
      if (b.life <= 0) b.dead = true;
    }
    this.bullets = this.bullets.filter((b) => !b.dead);
  }

  updateThrown(engine, dt) {
    for (const t of this.thrown) {
      t.spin += dt * 22;
      const steps = Math.max(1, Math.ceil((Math.hypot(t.vx, t.vy) * dt) / 4));
      for (let s = 0; s < steps && !t.landed; s++) {
        const ox = t.x;
        const oy = t.y;
        t.x += (t.vx * dt) / steps;
        t.y += (t.vy * dt) / steps;
        if (!passable(this.map.getAt(t.x, t.y)) || this.doors.some((d) => segPoint(t.x, t.y, d.hx, d.hy, d.ex, d.ey).d < 2)) {
          t.x = ox;
          t.y = oy;
          this.land(engine, t, true);
          break;
        }
        for (const e of this.enemies) {
          if (e.dead || e.stunT > 0 || !engine.math.circlesOverlap(t.x, t.y, 4, e.x, e.y, e.r)) continue;
          const sp = Math.hypot(t.vx, t.vy) || 1;
          this.stunEnemy(engine, e, 'throw', THROW_STUN, (t.vx / sp) * 140, (t.vy / sp) * 140);
          this.stats.throwStuns++;
          this.stats.stylePts += 40;
          this.addPop(engine, 'BONK! +40', e.x, e.y - 10, C.amber);
          if (t.type === 'wrench') unlock(engine, 'spanner');
          if (e.state !== 'alert') {
            e.state = 'alert';
            e.lastX = this.player.x;
            e.lastY = this.player.y;
          }
          t.vx *= -0.3;
          t.vy *= -0.3;
          this.land(engine, t, true);
          break;
        }
      }
      t.vx *= Math.exp(-1.4 * dt);
      t.vy *= Math.exp(-1.4 * dt);
      if (!t.landed && Math.hypot(t.vx, t.vy) < 50) this.land(engine, t, false);
    }
    this.thrown = this.thrown.filter((t) => !t.landed);
  }

  land(engine, t, hard) {
    t.landed = true;
    this.items.push({ type: t.type, ammo: t.ammo, x: t.x, y: t.y, cool: 0.5, spin: t.spin });
    if (hard) {
      sfx.clang(engine);
      this.sparks.burst(5, t.x, t.y);
    }
  }

  // ---- results
  finish(engine) {
    this.finished = true;
    this.player.body.vx = this.player.body.vy = 0;
    const st = this.stats;
    const def = this.floorDef;
    const variety = st.methods.size * VARIETY_BONUS;
    const speed = Math.max(0, Math.round((def.par - this.time) * SPEED_BONUS));
    const total = st.killPts + st.stylePts + variety + speed;
    const grade = gradeFor(total / def.target);
    const res = {
      floor: this.floorIndex, name: def.name, kills: st.kills, killPts: st.killPts, stylePts: st.stylePts,
      doorStuns: st.doorStuns, throwStuns: st.throwStuns, methods: [...st.methods], variety, speed, time: this.time, par: def.par,
      total, grade, bestCombo: st.bestCombo, reboots: this.reboots, pickups: st.pickups,
    };
    Object.assign(res, recordFloor(engine, this.floorIndex, total, grade));
    if (grade === 'S') unlock(engine, 'zero_downtime');
    if (st.pickups === 0) unlock(engine, 'hands_on');
    if (this.run) this.run.floors[this.floorIndex] = { total, grade };
    this.result = res;
    sfx.lift(engine);
    engine.scenes.push(new FloorResultsScene(this, res));
  }

  // ---------------------------------------------------------------- render
  render(engine) {
    const r = engine.renderer;
    const p = this.player;
    drawTiles(engine, this.map);
    if (this.cleared) {
      const lx = this.layout.lift.c * T + 8;
      const ly = this.layout.lift.r * T + 8;
      r.setBlend('additive');
      r.drawCircle(lx, ly, 18 + Math.sin(engine.time * 5) * 3, C.teal, { alpha: 0.18 });
      r.drawCircle(lx, ly, 8, C.teal, { alpha: 0.3 });
      r.setBlend('normal');
    }
    for (const c of this.corpses) r.drawSprite(art.sheet, c.x, c.y, { frame: F.wreck, originX: 0.5, originY: 0.5, rotation: c.a });
    for (const d of this.doors) {
      r.drawLine(d.hx, d.hy, d.ex, d.ey, C.ink, 4);
      r.drawLine(d.hx, d.hy, d.ex, d.ey, d.byPlayer && Math.abs(d.w) > DOOR_STUN_SPEED ? C.amber : C.steelD, 2);
      r.drawCircle(d.hx, d.hy, 2, C.amberD);
    }
    for (const it of this.items) {
      const bob = Math.sin(engine.time * 3 + it.x) * 0.15;
      r.drawSprite(art.sheet, it.x, it.y, { frame: F[it.type], originX: 0.5, originY: 0.5, rotation: it.spin * 0.3 + bob, alpha: it.ammo > 0 || WEAPONS[it.type].melee ? 1 : 0.55 });
    }
    this.debris.draw(r);
    this.smoke.draw(r);
    this.drawSentries(engine);
    // the drone
    if (!p.dead) {
      if (p.weapon) {
        const wx = p.x + Math.cos(p.aim) * 6;
        const wy = p.y + Math.sin(p.aim) * 6;
        const swing = p.swing > 0 ? (p.swing / 0.16 - 0.5) * 2.2 : 0;
        r.drawSprite(art.sheet, wx, wy, { frame: F[p.weapon.type], originX: 0.3, originY: 0.5, rotation: p.aim + swing, scale: 0.8 });
      }
      r.drawSprite(art.sheet, p.x, p.y, { frame: F.drone, originX: 0.5, originY: 0.5, rotation: p.aim });
      if (p.swing > 0) {
        const reach = p.swingKind === 'shove' ? SHOVE.reach : WEAPONS.wrench.reach;
        const arc = p.swingKind === 'shove' ? SHOVE.arc : WEAPONS.wrench.arc;
        r.drawPolygon(this.fan(p.x, p.y, p.aim, reach + 4, arc, 6), p.swingKind === 'shove' ? C.teal : '#ffffff', 0.25 * (p.swing / 0.16));
      }
    } else {
      r.drawSprite(art.sheet, p.x, p.y, { frame: F.wreck, originX: 0.5, originY: 0.5, rotation: this.deathFrom || 0, tint: C.tealD });
    }
    for (const t of this.thrown) r.drawSprite(art.sheet, t.x, t.y, { frame: F[t.type], originX: 0.5, originY: 0.5, rotation: t.spin });
    // projectiles and glow
    r.setBlend('additive');
    for (const b of this.bullets) {
      const col = b.owner === 'player' ? '#fff3c4' : C.hot;
      r.drawLine(b.x - b.vx * 0.018, b.y - b.vy * 0.018, b.x, b.y, col, 2, 0.9);
      r.drawCircle(b.x, b.y, 3, col, { alpha: 0.25 });
    }
    for (const m of this.muzzles) {
      const s = m.big ? 1.6 : 1;
      r.drawCircle(m.x, m.y, 9 * s, m.enemy ? C.hot : C.amber, { alpha: 0.35 });
      r.drawCircle(m.x + Math.cos(m.a) * 5 * s, m.y + Math.sin(m.a) * 5 * s, 4 * s, '#ffffff', { alpha: 0.7 });
      r.drawCircle(m.x, m.y, 30 * s, C.amber, { alpha: 0.06 });
    }
    for (const e of this.enemies) {
      if (e.dead || e.stunT > 0) continue;
      const hot = e.state === 'alert';
      r.drawCircle(e.x + Math.cos(e.facing) * 2, e.y + Math.sin(e.facing) * 2, hot ? 9 : 6, hot ? C.hot : C.amber, { alpha: hot ? 0.16 : 0.08 });
    }
    r.drawCircle(p.x, p.y, 26, C.teal, { alpha: 0.05 });
    r.setBlend('normal');
    this.sparks.draw(r);
    drawLamps(engine, this.layout.lamps, this.alarm);
    this.drawPrompts(engine);
    for (const pop of this.pops) r.drawText(pop.text, pop.x, pop.y, { ...TEXT_SMALL, align: 'center', color: pop.color, alpha: pop.a });
    // crosshair
    if (!p.dead && !this.finished) {
      const cx = this.cross.x;
      const cy = this.cross.y;
      const col = p.weapon && !WEAPONS[p.weapon.type].melee && p.weapon.ammo <= 0 ? C.dim : C.amber;
      r.drawCircle(cx, cy, 5, col, { outline: 1, alpha: 0.9 });
      r.drawLine(cx - 9, cy, cx - 6, cy, col, 1);
      r.drawLine(cx + 6, cy, cx + 9, cy, col, 1);
      r.drawLine(cx, cy - 9, cx, cy - 6, col, 1);
      r.drawLine(cx, cy + 6, cx, cy + 9, col, 1);
    }
    this.renderHud(engine);
  }

  /** A convex fan (polygon points) for view cones and swing arcs. */
  fan(x, y, ang, radius, half, n) {
    const pts = [x, y];
    for (let i = 0; i <= n; i++) {
      const a = ang - half + (2 * half * i) / n;
      pts.push(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
    }
    return pts;
  }

  drawSentries(engine) {
    const r = engine.renderer;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const k = e.k;
      if (e.stunT > 0) {
        r.drawSprite(art.sheet, e.x, e.y, { frame: F[e.kind], originX: 0.5, originY: 0.5, rotation: e.facing + Math.PI / 2, tint: '#8a9aaa' });
        for (let i = 0; i < 3; i++) {
          const a = engine.time * 6 + (i * Math.PI * 2) / 3;
          r.drawRect(e.x + Math.cos(a) * 7 - 1, e.y - 9 + Math.sin(a) * 2, 2, 2, e.stunBy === 'door' ? C.amber : C.teal);
        }
        continue;
      }
      // A short view cone shows where an unalerted sentry is looking.
      if (e.state !== 'alert') r.drawPolygon(this.fan(e.x, e.y, e.facing, 46, FOV, 6), e.state === 'post' || e.state === 'patrol' ? C.amber : C.teal, 0.07);
      // Telegraphs
      if (e.wind > 0) {
        const t = 1 - e.wind / k.windup;
        if (k.melee) r.drawPolygon(this.fan(e.x, e.y, e.facing, k.reach + 6, 1.1, 6), C.hot, 0.15 + 0.25 * t);
        else {
          const half = k.pellets > 1 ? k.spread / 2 : 0;
          for (const s of half ? [-half, half] : [0]) {
            const a = e.facing + s;
            const end = this.rayEnd(e.x, e.y, a, k.range);
            r.drawLine(e.x, e.y, end.x, end.y, C.hot, 1, 0.25 + 0.5 * t);
          }
        }
      }
      if (k.melee && e.swing > 0) r.drawPolygon(this.fan(e.x, e.y, e.facing, k.reach + 6, 1.1, 6), '#ffffff', 0.3);
      r.drawSprite(art.sheet, e.x, e.y, { frame: F[e.kind], originX: 0.5, originY: 0.5, rotation: e.facing, tint: e.wind > 0 && Math.floor(engine.time * 20) % 2 ? '#ffd0c0' : undefined });
      if (e.markT > 0) r.drawText(e.mark, e.x, e.y - 15, { font: 'overclock', size: 20, align: 'center', baseline: 'middle', color: e.mark === '!' ? C.hot : C.teal, alpha: Math.min(1, e.markT * 3) });
    }
  }

  rayEnd(x, y, a, max) {
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let d = 0;
    while (d < max) {
      d += 4;
      const id = this.map.getAt(x + dx * d, y + dy * d);
      if (id === WALL || id === COVER) break;
    }
    return { x: x + dx * d, y: y + dy * d };
  }

  drawPrompts(engine) {
    const r = engine.renderer;
    const p = this.player;
    if (p.dead || this.finished) return;
    const it = this.nearestItem(p.x, p.y, 18);
    if (it) {
      const w = WEAPONS[it.type];
      const label = w.melee ? w.name : `${w.name} (${it.ammo})`;
      r.drawText(`${hintLabel(engine, 'interact')} ${label}`, it.x, it.y - 12, { font: 'default', size: 10, align: 'center', baseline: 'middle', color: '#ffffff', shadow: C.ink });
    }
    if (this.cleared) {
      // A chevron pointing at the lift.
      const lx = this.layout.lift.c * T + 8;
      const ly = this.layout.lift.r * T + 8;
      const a = Math.atan2(ly - p.y, lx - p.x);
      if (Math.hypot(lx - p.x, ly - p.y) > 30) {
        const cx = p.x + Math.cos(a) * 16;
        const cy = p.y + Math.sin(a) * 16;
        r.drawTriangle(cx + Math.cos(a) * 4, cy + Math.sin(a) * 4, cx + Math.cos(a + 2.4) * 4, cy + Math.sin(a + 2.4) * 4, cx + Math.cos(a - 2.4) * 4, cy + Math.sin(a - 2.4) * 4, C.teal, 0.9);
      }
    }
  }

  renderHud(engine) {
    const r = engine.renderer;
    const p = this.player;
    const L = (id) => hintLabel(engine, id);
    r.ui(() => {
      r.drawRect(0, 0, W, 14, C.ink, { alpha: 0.75 });
      r.drawText(this.floorDef.name, 6, 3, { ...TEXT_SMALL, color: C.teal });
      const runPart = this.run ? `RUN ${runTotal(this.run) - (this.run.floors[this.floorIndex]?.total || 0)} + ` : '';
      r.drawText(`${runPart}FLOOR ${this.floorScore()}`, 150, 3, TEXT_SMALL);
      const left = this.enemies.filter((e) => !e.dead).length;
      r.drawText(left ? `SENTRIES ${left}/${this.enemies.length}` : 'LIFT OPEN', 330, 3, { ...TEXT_SMALL, color: left ? C.amber : C.teal });
      r.drawText(fmtTime(this.time), W - 26, 3, { ...TEXT_SMALL, align: 'right', color: this.time > this.floorDef.par ? C.dim : C.text });
      // combo
      const since = this.time - this.lastKill;
      if (this.combo > 1 && since <= COMBO_WINDOW) {
        r.drawText(`COMBO x${Math.min(5, this.combo)}`, W - 8, 20, { font: 'overclock', size: 20, align: 'right', color: C.amber });
        r.drawRect(W - 88, 44, 80 * (1 - since / COMBO_WINDOW), 2, C.amber);
      }
      // weapon box
      r.drawRect(4, H - 34, 120, 18, C.ink, { alpha: 0.7 });
      if (!p.weapon) r.drawText('UNARMED: SHOVE', 8, H - 29, { ...TEXT_SMALL, color: C.dim });
      else {
        const w = WEAPONS[p.weapon.type];
        r.drawSprite(art.sheet, 14, H - 25, { frame: F[p.weapon.type], originX: 0.5, originY: 0.5 });
        r.drawText(w.name, 26, H - 31, { ...TEXT_SMALL, color: C.text });
        if (!w.melee) {
          for (let i = 0; i < w.ammo; i++) r.drawRect(26 + i * 5, H - 22, 3, 4, i < p.weapon.ammo ? C.amber : C.slate3);
          if (p.weapon.ammo <= 0) r.drawText('EMPTY', 26 + w.ammo * 5 + 4, H - 23, { ...TEXT_SMALL, color: C.hot });
        }
      }
      if (!profile.settings.sound) r.drawText('MUTED', W - 6, H - 28, { ...TEXT_SMALL, align: 'right', color: C.dim });
      // Bottom hint bar: live bindings (keyboard/mouse, or the gamepad when one is connected).
      r.drawRect(0, H - 13, W, 13, C.ink, { alpha: 0.65 });
      hintText(r, `${L('attack')} attack   ${L('throw')} throw   ${L('interact')} pick up   ${L('restart')} reboot   ${L('pause')} pause`, W / 2, H - 6.5, { align: 'center' });
      if (this.banner.a > 0.01) {
        title(r, this.banner.text, W / 2, 86, this.banner.size, C.amber, this.banner.a);
        if (this.banner.sub) r.drawText(this.banner.sub, W / 2, 86 + this.banner.size / 2 + 10, { ...TEXT_SMALL, align: 'center', color: C.text, alpha: this.banner.a });
      }
      // Fault: a screen-edge flash and the one-press reboot prompt.
      edgeFlash(r, this.flash.a, C.hot);
      if (p.dead) {
        r.drawRect(0, H / 2 - 30, W, 52, C.ink, { alpha: 0.55 });
        title(r, 'SYSTEM FAULT', W / 2, H / 2 - 14, 20, C.hot);
        const pad = firstPad(engine);
        const press = pad ? `${L('restart')} / ${L('confirm')}` : `${L('restart')} / ${L('attack')}`;
        hintText(r, `${press} to reboot the floor`, W / 2, H / 2 + 8, { align: 'center', color: '#ffffff' });
      }
    });
  }

  showBanner(engine, text, size, sub = '') {
    engine.tweens.killTweensOf(this.banner);
    Object.assign(this.banner, { text, size, sub, a: 0, s: 0.6 });
    engine.tweens.to(this.banner, { a: 1, s: 1 }, 0.3, { ease: 'backOut' });
    engine.tweens.to(this.banner, { a: 0 }, 0.5, { delay: 1.8, ease: 'quadIn' });
  }

  addPop(engine, text, x, y, color) {
    const pop = { x, y, a: 1, text, color };
    this.pops.push(pop);
    engine.tweens.to(pop, { y: y - 14, a: 0 }, 0.9, {
      ease: 'quadOut',
      onComplete: () => {
        const i = this.pops.indexOf(pop); // a reboot may have replaced the list
        if (i >= 0) this.pops.splice(i, 1);
      },
    });
  }
}

// ------------------------------------------------------------------ floor results

class FloorResultsScene {
  constructor(play, res) {
    this.overlay = true;
    this.play = play;
    this.res = res;
  }
  enter(engine) {
    this.focused = false;
    this.t = { v: 0, stamp: 0 };
    engine.tweens.to(this.t, { v: 1 }, 1.2, { ease: 'linear' });
    engine.tweens.to(this.t, { stamp: 1 }, 0.35, { delay: 1.25, ease: 'backOut', onStart: () => sfx.kill(engine, 3) });
    this.sharer = new Sharer(engine);
    this.isLast = this.play.floorIndex + 1 >= FLOORS.length;
  }
  update(engine, dt) {
    const ui = engine.ui;
    const play = this.play;
    // While a screenshot is taken, declare no widgets: the captured frame then has no buttons.
    if (this.sharer.hiding(dt)) return;
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    // Skip the count-up with confirm / attack.
    if (this.t.v < 1 && (engine.input.actionPressed('confirm') || engine.input.actionPressed('attack'))) {
      engine.tweens.killTweensOf(this.t);
      this.t.v = 1;
      this.t.stamp = 1;
      this.focused = false; // no widgets this step clears the focus; give it back next step
      return;
    }
    focusOnce(this, engine, 'next');
    this.sharer.restore(engine);
    const x = W / 2 - 152;
    const y = 214;
    const nextLabel = play.mode === 'run' ? (this.isLast ? 'FINISH RUN' : 'NEXT FLOOR') : 'FLOOR SELECT';
    if (ui.button('next', nextLabel, x, y, 148, 18)) {
      sfx.menu(engine);
      engine.scenes.clear();
      if (play.mode !== 'run') engine.scenes.push(new TitleScene({ openFloors: true }));
      else if (this.isLast) engine.scenes.push(new RunEndScene(play.run, true));
      else engine.scenes.push(new PlayScene({ mode: 'run', floor: play.floorIndex + 1, run: play.run }));
      return;
    }
    if (ui.button('retry', 'RETRY FLOOR', x + 156, y, 148, 18)) {
      sfx.menu(engine);
      engine.scenes.pop().then(() => play.reset(engine, false));
      return;
    }
    this.sharer.button(engine, x, y + 22, 148, 18);
    if (ui.button('quit', play.mode === 'run' ? 'END RUN' : 'TITLE', x + 156, y + 22, 148, 18)) {
      sfx.menu(engine);
      engine.scenes.clear();
      engine.scenes.push(play.mode === 'run' ? new RunEndScene(play.run, false) : new TitleScene());
    }
  }
  render(engine) {
    const r = engine.renderer;
    const res = this.res;
    const play = this.play;
    const v = this.t.v;
    // Rows count up one after another.
    const part = (i, n) => Math.round(n * clamp(v * 5 - i, 0, 1));
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.7 });
      engine.ui.panel(W / 2 - 170, 6, 340, 258);
      title(r, `${res.name} CLEAR`, W / 2, 26, 20, C.teal);
      const x0 = W / 2 - 150;
      const x1 = W / 2 + 40;
      let y = 48;
      const row = (label, detail, value, color = C.text) => {
        r.drawText(label, x0, y, { ...TEXT_SMALL, color: C.dim });
        r.drawText(detail, x0 + 64, y, { ...TEXT_SMALL, color: C.steelD });
        r.drawText(String(value), x1, y, { ...TEXT_SMALL, align: 'right', color });
        y += 14;
      };
      row('SENTRIES', `${res.kills} down, best combo x${Math.min(5, res.bestCombo)}`, part(0, res.killPts));
      row('STYLE', `${res.doorStuns} slams, ${res.throwStuns} throws`, part(1, res.stylePts));
      row('VARIETY', `${res.methods.length} x ${VARIETY_BONUS} (${res.methods.map((m) => METHOD_NAMES[m] || m).join(', ') || 'none'})`.slice(0, 40), part(2, res.variety));
      row('SPEED', `${fmtTime(res.time)} / par ${fmtTime(res.par)}`, part(3, res.speed));
      r.drawLine(x0, y - 4, x1, y - 4, C.slate3, 1);
      y += 2;
      r.drawText('TOTAL', x0, y, { ...TEXT_SMALL, color: C.amber });
      r.drawText(String(part(4, res.total)), x1, y, { ...TEXT_SMALL, align: 'right', color: C.amber });
      y += 16;
      if (play.mode === 'run') r.drawText(`RUN TOTAL ${runTotal(play.run)}`, x0, y, { ...TEXT_SMALL, color: C.text });
      else r.drawText('PRACTICE: not ranked', x0, y, { ...TEXT_SMALL, color: C.dim });
      r.drawText(`REBOOTS ${res.reboots}`, x1, y, { ...TEXT_SMALL, align: 'right', color: C.dim });
      y += 14;
      const notes = [];
      if (res.newGrade || res.newBest) notes.push('NEW FLOOR BEST');
      if (res.unlockedNext) notes.push(`FLOOR ${res.floor + 2} UNLOCKED IN FLOOR SELECT`);
      if (notes.length) r.drawText(notes.join('   '), x0, y, { ...TEXT_SMALL, color: C.teal });
      // grade stamp
      const s = this.t.stamp;
      if (s > 0) {
        r.drawText('GRADE', W / 2 + 112, 52, { ...TEXT_SMALL, align: 'center', color: C.dim, alpha: Math.min(1, s) });
        r.drawText(res.grade, W / 2 + 112, 96, { font: 'overclock', size: Math.round(40 + (1 - Math.min(1, s)) * 40), align: 'center', baseline: 'middle', color: GRADE_COLOR[res.grade], alpha: Math.min(1, s) });
        r.drawText(`target ${play.floorDef.target}`, W / 2 + 112, 128, { ...TEXT_SMALL, align: 'center', color: C.dim, alpha: Math.min(1, s) });
      }
      const sh = this.sharer;
      if (sh.capturing) r.drawText('overclock', W / 2, 232, { ...TEXT_SMALL, align: 'center', color: C.dim });
      else if (sh.msg) hintText(r, sh.msg, W / 2, 202, { align: 'center', color: C.teal });
      else hintText(r, `${hintLabel(engine, 'up')} ${hintLabel(engine, 'down')} choose   ${hintLabel(engine, 'confirm')} select`, W / 2, 202, { align: 'center', color: C.dim });
    });
    this.sharer.shoot(engine, `Overclock: ${res.name} cleared, grade ${res.grade}, ${res.total} pts in ${fmtTime(res.time)}`);
  }
}

// ------------------------------------------------------------------ run end (complete or ended early)

class RunEndScene {
  constructor(run, complete) {
    this.run = run || newRun();
    this.complete = complete;
  }
  enter(engine) {
    this.focused = false;
    this.total = runTotal(this.run);
    this.fade = { a: 0, y: 14 };
    engine.tweens.to(this.fade, { a: 1, y: 0 }, 0.45, { ease: 'cubicOut' });
    engine.camera.bounds = null;
    engine.camera.x = engine.camera.y = 0;
    this.localBest = this.total > profile.bestRun;
    if (this.localBest) {
      profile.bestRun = this.total;
      engine.storage.set('bestRun', this.total);
    }
    if (this.complete) unlock(engine, 'facility_offline');
    // F001: submitScore posts at once and resolves with the ScoreResultView, or null (anonymous player,
    // Studio, offline, older host). An empty run is not submitted.
    this.result = undefined; // undefined = waiting, null = not ranked
    if (this.total <= 0) this.result = null;
    else {
      let pending;
      try {
        pending = engine.platform.submitScore(this.total);
      } catch {
        pending = null;
      }
      Promise.resolve(pending)
        .then((res) => (this.result = res && typeof res === 'object' ? res : null))
        .catch(() => (this.result = null));
    }
    this.sharer = new Sharer(engine);
  }
  resume(engine) {
    this.focused = false;
  }
  update(engine, dt) {
    const ui = engine.ui;
    if (this.sharer.hiding(dt)) return;
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    focusOnce(this, engine, 'again');
    this.sharer.restore(engine);
    const x = W / 2 - 152;
    if (ui.button('again', 'NEW RUN', x, 210, 148, 18)) {
      sfx.menu(engine);
      engine.scenes.clear();
      engine.scenes.push(new PlayScene({ mode: 'run', floor: 0, run: newRun() }));
      return;
    }
    if (ui.button('board', 'LEADERBOARD', x + 156, 210, 148, 18)) {
      sfx.menu(engine);
      engine.scenes.push(new LeaderboardScene());
    }
    this.sharer.button(engine, x, 232, 148, 18);
    if (ui.button('title', 'TITLE', x + 156, 232, 148, 18)) {
      sfx.menu(engine);
      engine.scenes.clear();
      engine.scenes.push(new TitleScene());
    }
  }
  render(engine) {
    const r = engine.renderer;
    const a = this.fade.a;
    const run = this.run;
    // backdrop: a slow grid scroll
    const off = (engine.time * 8) % 16;
    for (let x = -16; x < W + 16; x += 16) r.drawLine(x + off, 0, x + off, H, C.slate1, 1);
    for (let y = -16; y < H + 16; y += 16) r.drawLine(0, y + off, W, y + off, C.slate1, 1);
    r.ui(() => {
      const py = 8 + this.fade.y;
      engine.ui.panel(W / 2 - 170, py, 340, 196, { alpha: a });
      title(r, this.complete ? 'FACILITY OFFLINE' : 'RUN ENDED', W / 2, py + 20, 20, this.complete ? C.teal : C.amber, a);
      r.drawText(`${this.total}`, W / 2, py + 50, { font: 'overclock', size: 40, align: 'center', baseline: 'middle', color: '#ffffff', alpha: a });
      r.drawText('RUN SCORE', W / 2, py + 72, { ...TEXT_SMALL, align: 'center', color: C.dim, alpha: a });
      // per-floor grades
      const cw = 70;
      const x0 = W / 2 - (FLOORS.length * cw) / 2 + cw / 2;
      FLOORS.forEach((f, i) => {
        const fr = run.floors[i];
        const cx = x0 + i * cw;
        r.drawText(f.name.split(' ')[0], cx, py + 86, { ...TEXT_SMALL, align: 'center', color: C.dim, alpha: a });
        r.drawText(fr ? fr.grade : '-', cx, py + 104, { font: 'overclock', size: 20, align: 'center', baseline: 'middle', color: fr ? GRADE_COLOR[fr.grade] : C.slate4, alpha: a });
        r.drawText(fr ? String(fr.total) : '', cx, py + 120, { ...TEXT_SMALL, align: 'center', color: C.steel, alpha: a });
      });
      // F001 score-result view
      const res = this.result;
      let line1 = '';
      let line2 = '';
      let col = C.text;
      if (res === undefined) line1 = 'Submitting score...';
      else if (res === null) {
        line1 = this.total <= 0 ? 'No score this run.' : this.localBest ? 'NEW BEST ON THIS DEVICE!' : `BEST RUN ${profile.bestRun}`;
        line2 = this.total > 0 ? 'Not ranked: sign in to join the leaderboard.' : '';
        if (this.localBest) col = C.amber;
      } else {
        line1 = res.personalBest ? `NEW PERSONAL BEST: ${res.display}` : `SCORE SAVED: ${res.display}   RANK #${res.rank}`;
        const rk = res.ranks || {};
        line2 = `#${rk.day ?? '-'} today  -  #${rk.week ?? '-'} this week  -  #${rk.all ?? res.rank} all time`;
        if (res.personalBest) col = C.amber;
      }
      r.drawText(line1, W / 2, py + 140, { ...TEXT_SMALL, align: 'center', color: col, alpha: a });
      if (line2) r.drawText(line2, W / 2, py + 154, { ...TEXT_SMALL, align: 'center', color: C.steel, alpha: a });
      const sh = this.sharer;
      if (sh.capturing) r.drawText(`overclock  -  reboots ${run.reboots}`, W / 2, py + 174, { ...TEXT_SMALL, align: 'center', color: C.dim });
      else if (sh.msg) hintText(r, sh.msg, W / 2, py + 174, { align: 'center', color: C.teal, alpha: a });
      else r.drawText(`REBOOTS ${run.reboots}`, W / 2, py + 174, { ...TEXT_SMALL, align: 'center', color: C.dim, alpha: a });
    });
    const grades = FLOORS.map((_, i) => (run.floors[i] ? run.floors[i].grade : '-')).join(' ');
    this.sharer.shoot(engine, this.complete ? `Overclock: facility offline with ${this.total} pts (grades ${grades})` : `Overclock: run ended at ${this.total} pts (grades ${grades})`);
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
      if (ui.button(`tab-${p.id}`, on ? `> ${p.label} <` : p.label, 60 + i * 122, 46, 116, 16, { textColor: on ? C.amber : C.steel }) && !on) {
        sfx.menu(engine);
        this.select(engine, p.id);
      }
    });
    if (ui.button('back', 'BACK', W / 2 - 50, 234, 100, 18) || engine.input.actionPressed('pause')) {
      sfx.menu(engine);
      engine.scenes.pop();
    }
  }
  render(engine) {
    const r = engine.renderer;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.75 });
      engine.ui.panel(44, 8, W - 88, 254);
      title(r, 'LEADERBOARD', W / 2, 28, 20, C.amber);
      const v = this.view;
      const x0 = 74;
      if (v === undefined) {
        r.drawText('Loading...', W / 2, 130, { ...TEXT_SMALL, align: 'center' });
        return;
      }
      if (v === null) {
        hintText(r, 'Leaderboard unavailable here (offline, or no platform).', W / 2, 124, { align: 'center' });
        hintText(r, 'Publish the game and play it on the site to compete.', W / 2, 140, { align: 'center', color: C.dim });
        return;
      }
      r.drawText('#', x0, 72, { ...TEXT_SMALL, color: C.dim });
      r.drawText('PLAYER', x0 + 30, 72, { ...TEXT_SMALL, color: C.dim });
      r.drawText((v.label || 'Score').toUpperCase().replace(/[^\x20-\x7e]/g, '?'), W - x0, 72, { ...TEXT_SMALL, align: 'right', color: C.dim });
      if (!v.entries.length) {
        const when = { day: 'today', week: 'this week', all: 'yet' }[v.period] || 'yet';
        hintText(r, `No scores ${when} - be the first!`, W / 2, 130, { align: 'center' });
      }
      let y = 88;
      // Player names can hold any character, so rows use the canvas font.
      const rowText = (rank, name, display, me) => {
        const color = me ? C.amber : C.text;
        if (me) r.drawRect(x0 - 6, y - 7, W - 2 * x0 + 12, 14, C.amber, { alpha: 0.12 });
        hintText(r, `${rank}`, x0, y, { color });
        hintText(r, String(name).slice(0, 28), x0 + 30, y, { color });
        hintText(r, display, W - x0, y, { color, align: 'right' });
        y += 13;
      };
      for (const e of v.entries) rowText(e.rank, e.name, e.display, e.isMe);
      if (v.me && !v.entries.some((e) => e.isMe)) {
        r.drawLine(x0, y - 4, W - x0, y - 4, C.slate3, 1);
        y += 4;
        rowText(v.me.rank, 'You', v.me.display, true);
      }
      const foot = `${v.totalPlayers} player${v.totalPlayers === 1 ? '' : 's'}${v.sample ? '  -  sample data (Studio preview)' : ''}`;
      hintText(r, foot, W / 2, 222, { align: 'center', color: C.dim });
    });
  }
}

// ------------------------------------------------------------------ entry

/** Keeps only well-formed floors (a bad edit to floors.json shouldn't crash the game). */
function readFloors(json) {
  const list = json && Array.isArray(json.floors) ? json.floors : [];
  const out = [];
  for (const f of list) {
    if (!f || !Array.isArray(f.map) || f.map.length < 3 || !f.map.every((r) => typeof r === 'string')) {
      console.warn('[overclock] skipping a malformed floor in floors.json');
      continue;
    }
    if (!f.map.some((r) => r.includes('P')) || !f.map.some((r) => r.includes('E'))) {
      console.warn(`[overclock] floor "${f.name}" needs a P (start) and an E (lift)`);
      continue;
    }
    out.push({
      name: String(f.name || `FLOOR ${out.length + 1}`).toUpperCase().replace(/[^\x20-\x7e]/g, '?').slice(0, 20),
      brief: String(f.brief || '').replace(/[^\x20-\x7e]/g, '?').slice(0, 60),
      par: Number.isFinite(f.par) && f.par > 0 ? f.par : 60,
      target: Number.isFinite(f.target) && f.target > 0 ? f.target : 3000,
      def: f,
    });
  }
  return out;
}

export default {
  async load(engine) {
    const cols = 8;
    const frameXY = (i) => [(i % cols) * 16, Math.floor(i / cols) * 16];
    const rnd = new engine.Random(7);
    const tex = engine.assets.createTexture(cols * 16, 2 * 16, (ctx) => drawArt(ctx, frameXY, rnd));
    art = { sheet: engine.assets.spriteSheet(tex, 16, 16) };

    // F012: a BMFont for titles, plus 9-slice panel and button skins for engine.ui.
    const [floors, , panel, button, hover, down] = await Promise.all([
      engine.assets.loadJSON('assets/floors.json'),
      engine.assets.loadBitmapFont('overclock', 'assets/fonts/overclock.fnt'),
      engine.assets.loadNineSlice('assets/ui/panel.png', 4),
      engine.assets.loadNineSlice('assets/ui/button.png', 3),
      engine.assets.loadNineSlice('assets/ui/button_hover.png', 3),
      engine.assets.loadNineSlice('assets/ui/button_down.png', 3),
    ]);
    FLOORS = readFloors(floors);
    if (!FLOORS.length) throw new Error('assets/floors.json has no playable floors');
    Object.assign(engine.ui.theme, {
      panel,
      button,
      buttonHover: hover,
      buttonDown: down,
      nineSliceScale: 2,
      font: 'pixel',
      textSize: 8,
      textColor: C.text,
      disabledTextColor: C.slate4,
      focusColor: C.amber,
    });
    engine.renderer.background = C.ink;
    loadProfile(engine);
    await engine.scenes.push(new TitleScene());
  },
};

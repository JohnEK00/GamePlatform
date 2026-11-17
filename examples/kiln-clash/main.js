// Kiln Clash: a one-on-one versus fighting game. Animated pottery golems, fired in a mountain kiln town,
// duel on side-view stages.
//
// Structure of this file (single module, no imports; the engine instance is passed in):
//   1. data       assets/fighters.json -> runtime move tables (frame data, boxes, poses, animation keys)
//   2. input      numpad directions, the per-fighter input buffer, motion and charge detection,
//                 human controllers that read the F009 action bindings (1P, or split keyboard + 2 pads)
//   3. sim        fixed 60 Hz fighting simulation: states, moves, hit/hurt boxes, blocking, throws and techs,
//                 projectiles, hitstop, super freeze, combos with damage scaling, juggle limit, corner push,
//                 knockdown/wakeup, meter; plus the Bout (rounds, timer, KO / time over / draws)
//   4. ai         CPU opponent (3 levels, reaction-delayed perception) and the training dummy
//   5. art        procedural golems (pose skeleton), projectiles, 3 parallax stages, sparks and dust
//   6. platform   storage profile, achievements, leaderboard, screenshot sharing, synth sound effects
//   7. scenes     title, mode select, character/stage select, fight + HUD, pause/move list, training,
//                 results, arcade ladder and results, leaderboard, settings
//
// Engine features shown: F009 actions (P1 and P2 sets, live labels on HUD/pause/training), F012 bitmap font +
// 9-slice menus for mouse/keyboard/gamepad, F001 submitScore + leaderboard tabs, F005 shareScreenshot,
// achievements, engine.storage (cloud save), ParticleEmitter, tweens, camera zoom/shake and the synth.

const W = 480;
const H = 270;
const GROUND = 238; // screen y of the floor line
const STAGE_W = 760;
const WALL = 18; // stage wall inset
const EDGE = 16; // fighters stay this far inside the visible screen

// ======================================================================= 1. data

const BTN = { L: 1, M: 2, H: 4, T: 8 };
const ATK = BTN.L | BTN.M | BTN.H;
const STRENGTH = {
  L: { hitstop: 7, pushback: 10, meter: 4 },
  M: { hitstop: 9, pushback: 13, meter: 6 },
  H: { hitstop: 11, pushback: 16, meter: 8 },
  special: { hitstop: 11, pushback: 14, meter: 8 },
  super: { hitstop: 4, pushback: 4, meter: 0 },
  throw: { hitstop: 0, pushback: 0, meter: 8 },
};
const MOTIONS = ['qcf', 'qcb', 'dp', 'hcf', '360', 'qcf2', 'chargeBF', 'chargeDU'];
const NORMAL_IDS = ['5L', '5M', '5H', '2L', '2M', '2H', 'jL', 'jM', 'jH', '6M'];
const DEFAULT_RULES = {
  roundTime: 99, roundsToWin: 2, maxRounds: 5, meterMax: 100, techWindow: 10, throwStartup: 3, throwActive: 2,
  throwWhiff: 22, throwHold: 26, knockdown: 36, wakeup: 16, juggleLimit: 4, scaling: [1, 1, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3],
  superMinScale: 0.5, pressBuffer: 4, motionWindow: 14, wideWindow: 28, chargeFrames: 40, chargeGrace: 10, chainLimit: 3, prejump: 4,
};
const POSE_KEYS = ['hip', 'lean', 'head', 'dx', 'dy', 'rot'];
const POSE_DEFAULT = { hip: 0.9, lean: 8, head: 0, dx: 0, dy: 0, rot: 0, f: [35, 100], b: [25, 110], ff: [0.3, 0], fb: [-0.28, 0] };

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (fin(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const box4 = (b) => (Array.isArray(b) && b.length === 4 && b.every(fin) ? b.slice() : null);
const pair = (p, d) => (Array.isArray(p) && p.length === 2 && p.every(fin) ? p.slice() : d.slice());
const ascii = (s, max = 200) => String(s ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, max);
const isHex = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

function normPose(p) {
  const o = { ...POSE_DEFAULT, f: POSE_DEFAULT.f.slice(), b: POSE_DEFAULT.b.slice(), ff: POSE_DEFAULT.ff.slice(), fb: POSE_DEFAULT.fb.slice() };
  if (!p || typeof p !== 'object') return o;
  for (const k of POSE_KEYS) o[k] = num(p[k], o[k]);
  for (const k of ['f', 'b', 'ff', 'fb']) o[k] = pair(p[k], o[k]);
  return o;
}

/** One level deep merge (per-button overrides: `proj`/`grab` objects merge, arrays and scalars replace). */
function mergeVariant(base, over) {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b) ? { ...b, ...v } : v;
  }
  return out;
}

function normAnim(keys, poses, fallback) {
  const out = [];
  if (Array.isArray(keys))
    for (const k of keys)
      if (Array.isArray(k) && poses[k[0]] && fin(k[1]) && k[1] > 0) out.push([k[0], Math.round(k[1])]);
  return out.length ? out : [[fallback, 4]];
}

/** Builds one runtime move. `btn` is the strength for specials/supers (their `v` overrides apply). */
function buildMove(id, raw, btn, poses, rules) {
  const src = raw.v ? mergeVariant(raw, raw.v[btn]) : raw;
  const type = ['special', 'super', 'throw'].includes(src.type) ? src.type : 'normal';
  const air = type === 'normal' && id[0] === 'j';
  const strength = type === 'normal' ? id[id.length - 1] : btn;
  const sd = STRENGTH[type === 'normal' ? strength : type] || STRENGTH.M;
  const startup = Math.max(1, Math.round(num(src.startup, 5)));
  const active = Math.max(1, Math.round(num(src.active, 2)));
  const recovery = Math.max(0, Math.round(num(src.recovery, 10)));
  const total = startup + active + recovery;
  const baseDamage = Math.max(0, num(src.damage, 0));
  const base = {
    box: box4(src.box), damage: baseDamage, hitstun: num(src.hitstun, 15), blockstun: num(src.blockstun, num(src.hitstun, 15) - 4),
    pushback: num(src.pushback, sd.pushback), hitstop: num(src.hitstop, sd.hitstop), level: ['high', 'low', 'mid'].includes(src.level) ? src.level : air ? 'high' : 'mid',
    knockdown: !!src.knockdown, launch: Array.isArray(src.launch) ? pair(src.launch, [1.6, 5]) : null, meter: num(src.meter, sd.meter),
    juggle: num(src.juggle, type === 'super' ? 0 : 1),
  };
  const hitsRaw = Array.isArray(src.hits) && src.hits.length ? src.hits : base.box || src.box ? [{ at: startup, len: active }] : [];
  const hits = hitsRaw.map((h, i) => {
    const hh = h && typeof h === 'object' ? h : {};
    const damage = Math.max(0, num(hh.damage, base.damage));
    const start = Math.max(0, Math.round(num(hh.at, startup)));
    const hit = {
      ...base, idx: i, start, end: start + Math.max(1, Math.round(num(hh.len, active))), damage,
      box: box4(hh.box) || base.box, hitstun: num(hh.hitstun, base.hitstun), blockstun: num(hh.blockstun, base.blockstun),
      pushback: num(hh.pushback, base.pushback), hitstop: num(hh.hitstop, base.hitstop),
      level: ['high', 'low', 'mid'].includes(hh.level) ? hh.level : base.level,
      knockdown: hh.knockdown === undefined ? base.knockdown : !!hh.knockdown,
      launch: Array.isArray(hh.launch) ? pair(hh.launch, [1.6, 5]) : base.launch, meter: num(hh.meter, base.meter), juggle: num(hh.juggle, base.juggle),
    };
    hit.chip = num(hh.chip, num(src.chip, type === 'normal' ? 0 : Math.round(damage * (type === 'super' ? 0.25 : 0.2))));
    return hit;
  }).filter((h) => h.box);
  if (type === 'super' && hits.length > 1) {
    const last = hits[hits.length - 1];
    if (!(hitsRaw[hitsRaw.length - 1] || {}).hitstop) last.hitstop = 16;
  }
  let proj = null;
  if (src.proj && typeof src.proj === 'object') {
    const p = src.proj;
    const damage = Math.max(0, num(p.damage, 60));
    proj = {
      at: Math.round(num(p.at, startup)), x: num(p.x, 20), y: num(p.y, 36), w: Math.max(4, num(p.w, 16)), h: Math.max(4, num(p.h, 12)),
      vx: num(p.vx, 3), life: Math.round(num(p.life, 160)), hits: Math.max(1, Math.round(num(p.hits, 1))), interval: Math.max(1, Math.round(num(p.interval, 8))),
      kind: ['spark', 'orb', 'beam'].includes(p.kind) ? p.kind : 'spark', super: type === 'super',
      hit: {
        ...base, idx: 0, damage, chip: num(p.chip, Math.round(damage * 0.2)), hitstun: num(p.hitstun, 18), blockstun: num(p.blockstun, 14),
        pushback: num(p.pushback, 12), hitstop: num(p.hitstop, 9), level: ['high', 'low', 'mid'].includes(p.level) ? p.level : 'mid',
        knockdown: !!p.knockdown, launch: Array.isArray(p.launch) ? pair(p.launch, [1.6, 5]) : null, meter: num(p.meter, 6), juggle: num(p.juggle, 1),
      },
    };
  }
  let grab = null;
  if (src.grab && typeof src.grab === 'object') {
    const g = src.grab;
    grab = {
      at: Math.round(num(g.at, startup)), until: Math.round(num(g.at, startup)) + active, range: num(g.range, 24), damage: num(g.damage, 120),
      hold: Math.round(num(g.hold, rules.throwHold)), techable: type === 'throw', back: false, meter: type === 'throw' ? 8 : 12,
    };
  }
  // Cancels need contact (hit or block). Ground normals cancel into specials/supers; lights chain into lights.
  let cancel = null;
  if (src.cancel !== false && (type === 'normal' ? !air : !!src.cancel)) {
    const c = src.cancel && typeof src.cancel === 'object' ? src.cancel : {};
    const into = Array.isArray(c.into) ? c.into.filter((x) => x === 'special' || x === 'super') : type === 'normal' ? ['special', 'super'] : ['super'];
    const chain = Array.isArray(c.chain) ? c.chain.filter((x) => typeof x === 'string') : type === 'normal' && strength === 'L' ? ['5L', '2L'] : [];
    const w = Array.isArray(c.window) ? pair(c.window, [startup, total - 1]) : [startup, Math.min(total - 1, startup + active + 10)];
    cancel = { into, chain, from: w[0], to: w[1] };
  }
  // Animation keys: explicit `anim`, else windup -> strike -> hold -> settle built from `pose`.
  const crouching = type === 'normal' && id[0] === '2';
  const rest = air ? 'jump' : crouching ? 'crouch' : 'idle';
  let anim;
  if (Array.isArray(src.anim)) anim = normAnim(src.anim, poses, rest);
  else {
    const pz = Array.isArray(src.pose) ? src.pose : [rest, rest];
    const wind = poses[pz[0]] ? pz[0] : rest;
    const strike = poses[pz[1]] ? pz[1] : wind;
    const hold = active + Math.round(recovery * 0.35);
    anim = [[wind, Math.max(1, startup - 1)], [strike, 1], [strike, Math.max(1, hold)], [rest, Math.max(1, total - startup - hold)]];
  }
  // Hurtbox extensions: the attacking limb is vulnerable from the first active frame through half the recovery.
  const hurt = [];
  if (type === 'normal')
    for (const h of hits) {
      const b = h.box;
      hurt.push({ from: h.start, to: Math.min(total, h.end + Math.round(recovery * 0.5)), box: [b[0] + 2, b[1] + 1, Math.max(2, b[2] - 6), Math.max(2, b[3] - 2)] });
    }
  if (Array.isArray(src.hurt))
    for (const e of src.hurt) if (Array.isArray(e) && e.length === 6 && e.every(fin)) hurt.push({ from: e[0], to: e[1], box: e.slice(2) });
  const vel = Array.isArray(src.vel) ? src.vel.filter((v) => Array.isArray(v) && v.length === 3 && v.every(fin)).map((v) => v.slice()) : [];
  const invuln = Array.isArray(src.invuln) ? pair(src.invuln, [0, -1]) : null;
  const reach = Math.max(0, ...hits.map((h) => h.box[0] + h.box[2]), proj ? 200 : 0, grab ? grab.range + 20 : 0);
  return {
    id, name: ascii(src.name || id, 24), type, btn: strength, air, startup, active, recovery, total, hits, proj, grab, cancel, anim, hurt, vel, invuln,
    stance: ['stand', 'crouch', 'air', 'low'].includes(src.stance) ? src.stance : crouching ? 'crouch' : air ? 'air' : 'stand',
    airborne: !!src.airborne, helpless: !!src.helpless, landing: Math.round(num(src.landing, 6)), cost: type === 'super' ? rules.meterMax : 0,
    freeze: Math.round(num(src.freeze, type === 'super' ? 40 : 0)), role: typeof src.role === 'string' ? src.role : '', reach,
    level: hits[0] ? hits[0].level : proj ? proj.hit.level : 'mid', damage: hits.reduce((s, h) => s + h.damage, 0) || (proj ? proj.hit.damage * proj.hits : grab ? grab.damage : 0),
  };
}

function buildFighter(raw, poses, rules) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.moves || typeof raw.moves !== 'object') return null;
  const body = raw.body || {};
  const pal = (p, d) => {
    const o = { ...d };
    if (p && typeof p === 'object') for (const k of Object.keys(d)) if (isHex(p[k])) o[k] = p[k];
    return o;
  };
  const basePal = { clay: '#c8663b', dark: '#7d3a20', light: '#ec9a68', glaze: '#f2d27a', core: '#ff8a3c', eye: '#fff1b8' };
  const hurt = {};
  for (const k of ['stand', 'crouch', 'air', 'low']) {
    const list = raw.hurt && Array.isArray(raw.hurt[k]) ? raw.hurt[k].map(box4).filter(Boolean) : [];
    hurt[k] = list.length ? list : [[-11, 0, 22, k === 'crouch' ? 46 : k === 'low' ? 18 : 70]];
  }
  const f = {
    id: raw.id.replace(/[^a-z0-9_-]/g, '').slice(0, 16) || 'golem',
    name: ascii(raw.name || raw.id, 10).toUpperCase(), title: ascii(raw.title || '', 30), bio: ascii(raw.bio || '', 200),
    archetype: ['allrounder', 'grappler', 'rushdown', 'zoner'].includes(raw.archetype) ? raw.archetype : 'allrounder',
    health: Math.round(clamp(num(raw.health, 1000), 300, 3000)), walkF: num(raw.walkF, 2), walkB: num(raw.walkB, 1.6),
    jump: { vy: num(raw.jump?.vy, 9), vx: num(raw.jump?.vx, 2.6), gravity: clamp(num(raw.jump?.gravity, 0.5), 0.2, 1.5) },
    dash: { f: pair(raw.dash?.f, [14, 4.4]), b: Array.isArray(raw.dash?.b) && raw.dash.b.length === 3 ? raw.dash.b.slice() : [18, -4.2, 5] },
    push: clamp(num(raw.push, 12), 6, 24), stats: raw.stats || {},
    body: {
      leg: pair(body.leg, [16, 16]), torso: num(body.torso, 24), head: num(body.head, 9), arm: pair(body.arm, [13, 13]), limb: num(body.limb, 7),
      shoulders: num(body.shoulders, 20), hips: num(body.hips, 15), headStyle: body.headStyle || 'round', crest: body.crest || 'none', torsoStyle: body.torsoStyle || 'barrel',
    },
    palette: pal(raw.palette, basePal), alt: pal(raw.alt, pal(raw.palette, basePal)), hurt,
    normals: {}, sp: {}, specials: [], super: null, throw: null,
  };
  for (const id of NORMAL_IDS) if (raw.moves[id]) f.normals[id] = buildMove(id, raw.moves[id], '', poses, rules);
  for (const need of ['5L', '5M', '5H', '2L', '2M', '2H', 'jL', 'jM', 'jH'])
    if (!f.normals[need]) throw new Error(`fighters.json: ${f.id} is missing normal ${need}`);
  for (const [id, m] of Object.entries(raw.moves)) {
    if (NORMAL_IDS.includes(id) || !m || typeof m !== 'object') continue;
    f.sp[id] = { L: buildMove(id, m, 'L', poses, rules), M: buildMove(id, m, 'M', poses, rules), H: buildMove(id, m, 'H', poses, rules) };
  }
  for (const s of Array.isArray(raw.specials) ? raw.specials : [])
    if (s && f.sp[s.move] && MOTIONS.includes(s.motion) && f.sp[s.move].M.type === 'special') f.specials.push({ move: s.move, motion: s.motion, role: f.sp[s.move].M.role });
  if (raw.super && f.sp[raw.super.move] && MOTIONS.includes(raw.super.motion) && f.sp[raw.super.move].M.type === 'super')
    f.super = { move: raw.super.move, motion: raw.super.motion, role: f.sp[raw.super.move].M.role };
  const tr = raw.throw || {};
  f.throw = buildMove('throw', {
    name: 'Throw', type: 'throw', startup: rules.throwStartup, active: rules.throwActive, recovery: rules.throwWhiff, pose: ['grab', 'grab'],
    grab: { at: rules.throwStartup, range: num(tr.range, 20), damage: num(tr.damage, 110), hold: rules.techWindow },
  }, 'M', poses, rules);
  return f;
}

/** assets/fighters.json -> { rules, poses, anims, fighters }. Throws on a file that can't make a game. */
function normalizeData(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.fighters)) throw new Error('fighters.json: expected { fighters: [...] }');
  const rules = { ...DEFAULT_RULES };
  if (json.rules && typeof json.rules === 'object')
    for (const k of Object.keys(DEFAULT_RULES)) {
      if (k === 'scaling') {
        if (Array.isArray(json.rules.scaling) && json.rules.scaling.length && json.rules.scaling.every(fin)) rules.scaling = json.rules.scaling.slice();
      } else rules[k] = num(json.rules[k], rules[k]);
    }
  const poses = {};
  for (const [k, p] of Object.entries(json.poses || {})) poses[k] = normPose(p);
  for (const need of ['idle', 'crouch', 'jump']) if (!poses[need]) poses[need] = normPose(null);
  const anims = {};
  for (const [k, a] of Object.entries(json.anims || {})) anims[k] = { loop: !!(a && a.loop), keys: normAnim(a && a.keys, poses, 'idle') };
  const fighters = json.fighters.map((f) => buildFighter(f, poses, rules)).filter(Boolean);
  if (fighters.length < 2) throw new Error('fighters.json: need at least two valid fighters');
  return { rules, poses, anims, fighters };
}

// ======================================================================= 2. input

// Directions use numpad notation: 7 8 9 / 4 5 6 / 1 2 3, with 6 = right on screen. A fighter interprets them
// relative to its facing (6 = forward), so motions mirror automatically when it faces left.
const MIRROR = [0, 3, 2, 1, 6, 5, 4, 9, 8, 7];
const relDir = (d, facing) => (facing < 0 ? MIRROR[d] : d);
const dDown = (d) => d >= 1 && d <= 3;
const dUp = (d) => d >= 7;
const dBack = (d) => d === 1 || d === 4 || d === 7;
const dFwd = (d) => d === 3 || d === 6 || d === 9;
/** Opposite directions cancel (SOCD neutral). */
function makeDir(u, d, l, r) {
  const h = (r ? 1 : 0) - (l ? 1 : 0);
  const v = u && !d ? 1 : d && !u ? -1 : 0;
  return 5 + h + v * 3;
}
const MOTION_STEPS = {
  qcf: [[2], [3], [6]],
  qcb: [[2], [1], [4]],
  dp: [[6], [2], [3]],
  hcf: [[4], [2], [6]],
  qcf2: [[2], [3], [6], [2], [3], [6]],
};
const MOTION_LABEL = {
  qcf: 'QCF', qcb: 'QCB', dp: 'DP', hcf: 'HCF', 360: '360', qcf2: 'QCF x2', chargeBF: 'CHARGE B,F', chargeDU: 'CHARGE D,U',
};
// Arrows for the move list (canvas font; escapes keep this source ASCII).
const ARROW = { 1: '\u2199', 2: '\u2193', 3: '\u2198', 4: '\u2190', 6: '\u2192', 7: '\u2196', 8: '\u2191', 9: '\u2197' };
const MOTION_ARROWS = {
  qcf: '\u2193\u2198\u2192', qcb: '\u2193\u2199\u2190', dp: '\u2192\u2193\u2198', hcf: '\u2190\u2199\u2193\u2198\u2192',
  360: '\u2192\u2198\u2193\u2199\u2190\u2196\u2191 (360)', qcf2: '\u2193\u2198\u2192\u2193\u2198\u2192',
  chargeBF: '[\u2190] \u2192', chargeDU: '[\u2193] \u2191',
};

/**
 * Greedy backward subsequence match of `steps` ending at buffer index `end`, within `window` sim frames.
 * Extra directions in between are allowed (lenient), so 2,1,2,3,6 is still a quarter circle.
 */
function matchSteps(buf, end, facing, steps, window) {
  if (end < 0) return false;
  const t0 = buf[end].t;
  let s = steps.length - 1;
  for (let i = end; i >= 0 && t0 - buf[i].t <= window; i--) {
    if (steps[s].includes(relDir(buf[i].dir, facing))) {
      s--;
      if (s < 0) return true;
    }
  }
  return false;
}
/** 360: down, back, forward and up all touched inside the window, in any order. */
function match360(buf, end, window) {
  if (end < 0) return false;
  const t0 = buf[end].t;
  let m = 0;
  for (let i = end; i >= 0 && t0 - buf[i].t <= window; i--) {
    const d = buf[i].dir;
    if (d <= 3) m |= 1;
    if (d >= 7) m |= 2;
    if (d % 3 === 1) m |= 4;
    if (d % 3 === 0) m |= 8;
  }
  return m === 15;
}

/** Reads one player's controls from the effective F009 bindings (remaps apply) and raw gamepad state. */
class HumanController {
  /**
   * @param ids     action ids for up/down/left/right/light/medium/heavy/throw
   * @param pad     gamepad index, or -1 for "first connected"
   * @param padIds  action ids whose gamepad buttons are used on that pad (P2 borrows P1's layout)
   * @param exclude action ids whose keys this player must ignore (split keyboard in 2P versus)
   */
  constructor(ids, pad = -1, padIds = ids, exclude = []) {
    this.ids = ids;
    this.pad = pad;
    this.padIds = padIds;
    this.exclude = exclude;
    this.human = true;
  }
  padState(engine) {
    const inp = engine.input;
    if (this.pad >= 0) {
      const p = inp.gamepad(this.pad);
      return p && p.connected ? p : null;
    }
    for (let i = 0; i < 4; i++) {
      const p = inp.gamepad(i);
      if (p && p.connected) return p;
    }
    return null;
  }
  read(engine) {
    const inp = engine.input;
    const acts = inp.actions;
    const ex = new Set();
    for (const id of this.exclude) {
      const a = acts.find((x) => x.id === id);
      if (a) for (const k of a.keys) ex.add(k);
    }
    const pad = this.padState(engine);
    const st = (key) => {
      const a = acts.find((x) => x.id === this.ids[key]);
      const pa = acts.find((x) => x.id === this.padIds[key]);
      let down = false;
      let pressed = false;
      if (a)
        for (const k of a.keys) {
          if (ex.has(k)) continue;
          if (inp.isDown(k)) down = true;
          if (inp.wasPressed(k)) pressed = true;
        }
      if (pad && pa)
        for (const b of pa.gamepad) {
          if (pad.isDown(b)) down = true;
          if (pad.wasPressed(b)) pressed = true;
        }
      return { down, pressed };
    };
    const u = st('up');
    const d = st('down');
    const l = st('left');
    const r = st('right');
    let ax = 0;
    let ay = 0;
    if (pad) {
      ax = Math.abs(pad.leftX) > 0.5 ? sign(pad.leftX) : 0;
      ay = Math.abs(pad.leftY) > 0.5 ? sign(pad.leftY) : 0;
    }
    const dir = makeDir(u.down || ay < 0, d.down || ay > 0, l.down || ax < 0, r.down || ax > 0);
    let press = 0;
    let held = 0;
    for (const [key, bit] of [['light', BTN.L], ['medium', BTN.M], ['heavy', BTN.H], ['throw', BTN.T]]) {
      const s = st(key);
      if (s.pressed) press |= bit;
      if (s.down) held |= bit;
    }
    return { dir, press, held };
  }
}
const P1_IDS = { up: 'up', down: 'down', left: 'left', right: 'right', light: 'light', medium: 'medium', heavy: 'heavy', throw: 'throw' };
const P2_IDS = { up: 'p2-up', down: 'p2-down', left: 'p2-left', right: 'p2-right', light: 'p2-light', medium: 'p2-medium', heavy: 'p2-heavy', throw: 'p2-throw' };
const NEUTRAL = Object.freeze({ dir: 5, press: 0, held: 0 });

// ======================================================================= 3. sim

const NEUTRAL_STATES = new Set(['stand', 'crouch', 'walkF', 'walkB']);
const STUN_STATES = new Set(['hitstun', 'juggle', 'grabbed']);
const INVULN_STATES = new Set(['knockdown', 'wakeup', 'ko', 'grabbed', 'intro', 'win', 'lose']);
const NO_THROW_STATES = new Set(['hitstun', 'blockstun', 'juggle', 'knockdown', 'wakeup', 'grabbed', 'throwing', 'ko', 'tech', 'intro', 'win', 'lose', 'fall']);
const STATE_ANIM = {
  stand: 'idle', crouch: 'crouch', walkF: 'walkF', walkB: 'walkB', prejump: 'prejump', jump: 'jump', land: 'land', dash: 'dash',
  backdash: 'backdash', hitstun: 'hitstun', blockstun: 'blockstun', juggle: 'juggle', knockdown: 'knockdown', wakeup: 'wakeup',
  grabbed: 'grabbed', throwing: 'throwing', tech: 'tech', fall: 'fall', ko: 'ko', win: 'win', lose: 'lose', intro: 'intro',
};
const newStats = () => ({ damage: 0, hits: 0, maxCombo: 0, supers: 0, specials: 0, techs: 0, throws: 0, blocks: 0 });
const smooth = (u) => u * u * (3 - 2 * u);
function lerpPose(a, b, u) {
  const o = {};
  for (const k of POSE_KEYS) o[k] = lerp(a[k], b[k], u);
  for (const k of ['f', 'b', 'ff', 'fb']) o[k] = [lerp(a[k][0], b[k][0], u), lerp(a[k][1], b[k][1], u)];
  return o;
}
/** Samples animation keys at frame t: each key [pose, frames] eases from the previous pose into its own. */
function sampleAnim(keys, t, loop, from, poses) {
  let total = 0;
  for (const k of keys) total += k[1];
  let prev = from || poses[keys[0][0]];
  if (loop && t >= total) {
    t %= total;
    prev = poses[keys[keys.length - 1][0]];
  } else t = Math.min(t, total);
  let acc = 0;
  for (const [name, n] of keys) {
    const target = poses[name];
    if (t <= acc + n) return lerpPose(prev, target, smooth(clamp((t - acc) / n, 0, 1)));
    acc += n;
    prev = target;
  }
  return lerpPose(prev, prev, 0);
}
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

class Fighter {
  constructor(def, side, data, alt) {
    this.def = def;
    this.side = side;
    this.data = data;
    this.rules = data.rules;
    this.alt = !!alt;
    this.palette = alt ? def.alt : def.palette;
    this.buf = [];
    this.seq = 0;
    this.consumed = 0;
    this.meter = 0;
    this.lastDir = 5;
    this.stats = newStats();
    this.pose = lerpPose(data.poses.idle, data.poses.idle, 0);
    this.resetRound(0, 1);
  }
  resetRound(x, facing) {
    Object.assign(this, {
      x, y: 0, vx: 0, vy: 0, push: 0, facing, hp: this.def.health, hpLag: this.def.health, lagDelay: 0, state: 'stand', t: 0, dur: 0,
      move: null, airUsed: false, crouching: false, combo: 0, comboDmg: 0, juggle: 0, throwInv: 0, flash: 0, guarding: false, grab: null,
      grabSeq: 0, techable: false, chargeB: 0, chargeD: 0, relB: -999, relD: -999, chainN: 0, jumpDir: 0, jumpSerial: 0, dashSeq: 0,
      fallLanding: 10, throwBack: false, simT: 0,
    });
    this.buf.length = 0;
    this.consumed = this.seq;
    this.anim = '';
    this.setAnim('idle');
  }
  get other() {
    return this._other;
  }
  isNeutral() {
    return NEUTRAL_STATES.has(this.state);
  }
  isCrouching() {
    if (this.state === 'crouch') return true;
    if (this.state === 'move') return this.move.def.stance === 'crouch' || this.move.def.stance === 'low';
    return (this.state === 'hitstun' || this.state === 'blockstun') && this.crouching;
  }
  invulnNow() {
    if (INVULN_STATES.has(this.state)) return true;
    if (this.state === 'backdash' && this.t < this.def.dash.b[2]) return true;
    if (this.state === 'move') {
      const inv = this.move.def.invuln;
      if (inv && this.move.f >= inv[0] && this.move.f <= inv[1]) return true;
    }
    return this.state === 'juggle' && this.juggle >= this.rules.juggleLimit;
  }
  setAnim(name, keys, loop = false) {
    this.animFrom = this.pose;
    this.anim = name;
    const a = this.data.anims[name];
    this.animKeys = keys || (a ? a.keys : [['idle', 4]]);
    this.animLoop = keys ? loop : !!(a && a.loop);
    this.animT = 0;
  }
  enter(state, dur = 0) {
    this.state = state;
    this.t = 0;
    this.dur = dur;
    if (state !== 'move') this.move = null;
    if (state === 'crouch') this.crouching = true;
    else if (state === 'stand' || state === 'walkF' || state === 'walkB') this.crouching = false;
  }
  toNeutral() {
    const rd = relDir(this.lastDir, this.facing);
    const from = this.state;
    this.enter(dDown(rd) ? 'crouch' : 'stand');
    this.vx = 0;
    if (from === 'hitstun' || from === 'blockstun' || from === 'wakeup' || from === 'tech') this.throwInv = 6;
  }
  record(inp, t) {
    this.seq++;
    this.buf.push({ dir: inp.dir, press: inp.press, held: inp.held, t, seq: this.seq });
    if (this.buf.length > 64) this.buf.shift();
    this.lastDir = inp.dir;
  }
  chargeTick(t) {
    this.simT = t;
    const rd = relDir(this.lastDir, this.facing);
    const C = this.rules.chargeFrames;
    if (dBack(rd)) this.chargeB++;
    else {
      if (this.chargeB >= C) this.relB = t;
      this.chargeB = 0;
    }
    if (dDown(rd)) this.chargeD++;
    else {
      if (this.chargeD >= C) this.relD = t;
      this.chargeD = 0;
    }
  }
  chargeReady(kind) {
    const rel = kind === 'B' ? this.relB : this.relD;
    if (this.simT - rel > this.rules.chargeGrace) return false;
    // Inputs are recorded before the sim clock advances, so the release frame's entry carries t = rel - 1.
    for (let i = this.buf.length - 1; i >= 0 && this.buf[i].t >= rel - 1; i--) {
      const d = relDir(this.buf[i].dir, this.facing);
      if (kind === 'B' ? dFwd(d) : dUp(d)) return true;
    }
    return false;
  }
  motion(name, end) {
    const R = this.rules;
    switch (name) {
      case '360':
        return match360(this.buf, end, R.wideWindow);
      case 'qcf2':
        return matchSteps(this.buf, end, this.facing, MOTION_STEPS.qcf2, R.wideWindow);
      case 'chargeBF':
        return this.chargeReady('B');
      case 'chargeDU':
        return this.chargeReady('D');
      default:
        return MOTION_STEPS[name] ? matchSteps(this.buf, end, this.facing, MOTION_STEPS[name], R.motionWindow) : false;
    }
  }
  /** A fresh double tap of `d` (relative): d, neutral, d within 12 frames. */
  tapped(d) {
    const b = this.buf;
    const n = b.length;
    if (n < 3) return false;
    const cur = b[n - 1];
    if (relDir(cur.dir, this.facing) !== d || relDir(b[n - 2].dir, this.facing) === d) return false;
    let i = n - 2;
    while (i >= 0 && relDir(b[i].dir, this.facing) !== d) {
      if (cur.t - b[i].t > 12 || b[i].dir !== 5) return false;
      i--;
    }
    if (i < 0 || cur.t - b[i].t > 12 || b[i].seq <= this.dashSeq) return false;
    this.dashSeq = cur.seq;
    return true;
  }
  /** Throw input: the throw button, or light + medium pressed within `within` frames of each other. */
  throwPressed(sinceSeq, within = 3) {
    const b = this.buf;
    let mask = 0;
    const last = b[b.length - 1];
    for (let i = b.length - 1; i >= 0; i--) {
      const e = b[i];
      if (e.seq <= sinceSeq || last.t - e.t > within) break;
      mask |= e.press;
    }
    return !!(mask & BTN.T) || (mask & (BTN.L | BTN.M)) === (BTN.L | BTN.M);
  }
  startMove(sim, m, chained = false) {
    if (!m) return false;
    const opp = this.other;
    if (this.isNeutral() || this.state === 'prejump' || this.state === 'land') this.facing = sign(opp.x - this.x) || this.facing;
    if (!chained) this.chainN = 0;
    this.consumed = this.seq;
    const prev = this.move;
    this.enter('move');
    this.move = {
      def: m, f: 0, done: new Set(), contact: false, confirm: false, serial: ++sim.serial, lifted: false, back: m.type === 'throw' && this.throwBack,
      projDone: false, grabDone: false, superHit: false, cancelled: !!prev,
    };
    if (!m.air) {
      this.vx = 0;
      if (this.y <= 0) this.vy = 0;
    }
    const R = this.rules;
    if (m.type === 'super') {
      this.meter = Math.max(0, this.meter - m.cost);
      sim.superFreeze(this, m);
    } else this.meter = Math.min(R.meterMax, this.meter + (m.type === 'special' ? 3 : m.type === 'normal' ? 1 : 0));
    if (m.type === 'special') this.stats.specials++;
    this.setAnim('move:' + m.id, m.anim, false);
    sim.emit({ type: 'move', who: this.side, id: m.id, name: m.name, kind: m.type, startup: m.startup, btn: m.btn, x: this.x, y: this.y });
    return true;
  }
  /** Reads buffered presses and motions. ctx: neutral | prejump | air | cancel. */
  tryAttack(sim, ctx) {
    const R = this.rules;
    const b = this.buf;
    const n = b.length;
    if (!n) return false;
    const last = b[n - 1];
    let pi = -1;
    let mask = 0;
    for (let i = n - 1; i >= 0; i--) {
      const e = b[i];
      if (e.seq <= this.consumed || last.t - e.t > R.pressBuffer) break;
      if (e.press) {
        if (pi < 0) pi = i;
        mask |= e.press;
      }
    }
    if (pi < 0) return false;
    const atk = mask & ATK;
    const btn = atk & BTN.H ? 'H' : atk & BTN.M ? 'M' : 'L';
    const rd = relDir(last.dir, this.facing);
    const def = this.def;
    const grounded = this.y <= 0;
    const into = ctx === 'cancel' ? this.move.def.cancel.into : ['special', 'super'];
    if (grounded && atk && ctx !== 'air') {
      if (into.includes('super') && def.super && this.meter >= R.meterMax && this.motion(def.super.motion, n - 1)) {
        if (def.super.motion.startsWith('charge')) this.relB = this.relD = -999;
        return this.startMove(sim, def.sp[def.super.move][btn], ctx === 'cancel');
      }
      if (into.includes('special'))
        for (const s of def.specials) {
          if (!this.motion(s.motion, n - 1)) continue;
          const m = def.sp[s.move][btn];
          if (m.proj && sim.hasProjectile(this)) continue;
          if (s.motion === 'chargeBF') this.relB = -999;
          if (s.motion === 'chargeDU') this.relD = -999;
          return this.startMove(sim, m, ctx === 'cancel');
        }
    }
    if (ctx === 'prejump') return false;
    if (ctx === 'cancel') {
      const c = this.move.def.cancel;
      if (atk && c.chain.length && this.chainN < R.chainLimit) {
        const id = (dDown(rd) ? '2' : '5') + btn;
        if (c.chain.includes(id) && def.normals[id]) {
          this.chainN++;
          return this.startMove(sim, def.normals[id], true);
        }
      }
      return false;
    }
    if (ctx === 'air') {
      if (!atk || this.airUsed) return false;
      this.airUsed = true;
      return this.startMove(sim, def.normals['j' + btn]);
    }
    if (grounded && ((mask & BTN.T) || (mask & (BTN.L | BTN.M)) === (BTN.L | BTN.M))) {
      this.throwBack = dBack(rd);
      return this.startMove(sim, def.throw);
    }
    if (!atk) return false;
    const id = dDown(rd) ? '2' + btn : rd === 6 && btn === 'M' && def.normals['6M'] ? '6M' : '5' + btn;
    return this.startMove(sim, def.normals[id]);
  }
  /** State timers that expire before this frame's decisions. */
  progress(sim) {
    const R = this.rules;
    switch (this.state) {
      case 'prejump':
        if (this.t >= this.dur) {
          const j = this.def.jump;
          this.enter('jump');
          this.airUsed = false;
          this.jumpSerial++;
          this.vy = j.vy;
          this.vx = j.vx * this.jumpDir * this.facing;
          this.y = 0.01;
          sim.emit({ type: 'jump', who: this.side, x: this.x });
        }
        break;
      case 'land':
      case 'dash':
      case 'backdash':
      case 'tech':
      case 'blockstun':
      case 'hitstun':
      case 'wakeup':
        if (this.t >= this.dur) this.toNeutral();
        break;
      case 'throwing':
        if (this.t >= this.dur) {
          this.grab = null;
          this.toNeutral();
        }
        break;
      case 'knockdown':
        if (this.t >= this.dur) this.enter('wakeup', R.wakeup);
        break;
      case 'move':
        if (this.move.f >= this.move.def.total) {
          const m = this.move.def;
          if (this.y > 0) {
            if (m.helpless || m.airborne) {
              this.fallLanding = m.landing;
              this.enter('fall');
            } else {
              this.enter('jump');
              this.airUsed = true;
            }
          } else this.toNeutral();
        }
        break;
      default:
        break;
    }
  }
  think(sim) {
    const n = this.buf.length;
    if (!n) return;
    const rd = relDir(this.buf[n - 1].dir, this.facing);
    switch (this.state) {
      case 'stand':
      case 'crouch':
      case 'walkF':
      case 'walkB': {
        if (this.tryAttack(sim, 'neutral')) return;
        if (dUp(rd)) {
          this.jumpDir = dFwd(rd) ? 1 : dBack(rd) ? -1 : 0;
          this.enter('prejump', this.rules.prejump);
          this.vx = 0;
          return;
        }
        if (this.tapped(6)) {
          this.enter('dash', this.def.dash.f[0]);
          sim.emit({ type: 'dash', who: this.side, x: this.x });
          return;
        }
        if (this.tapped(4)) {
          this.enter('backdash', this.def.dash.b[0]);
          sim.emit({ type: 'dash', who: this.side, x: this.x });
          return;
        }
        const next = dDown(rd) ? 'crouch' : rd === 6 ? 'walkF' : rd === 4 ? 'walkB' : 'stand';
        if (next !== this.state) this.enter(next);
        return;
      }
      case 'prejump':
        this.tryAttack(sim, 'prejump');
        return;
      case 'land':
        // Buffered specials and normals come out on the last landing frame.
        if (this.t >= this.dur - 1) this.tryAttack(sim, 'neutral');
        return;
      case 'jump':
        this.tryAttack(sim, 'air');
        return;
      case 'move': {
        const m = this.move;
        // L+M a frame apart: a light/medium normal that just started becomes a throw.
        if (m.def.type === 'normal' && !m.def.air && m.f <= 2 && !m.cancelled && (m.def.btn === 'L' || m.def.btn === 'M') && this.throwPressed(this.seq - 4)) {
          this.throwBack = dBack(rd);
          this.move = null;
          this.startMove(sim, this.def.throw);
          return;
        }
        const c = m.def.cancel;
        if (c && m.contact && m.f >= c.from && m.f <= c.to) this.tryAttack(sim, 'cancel');
        return;
      }
      case 'grabbed': {
        const atk = this.other;
        if (this.techable && atk.grab && !atk.grab.done && this.t <= this.rules.techWindow && this.throwPressed(this.grabSeq, 99)) sim.tech(this, atk);
        return;
      }
      default:
        return;
    }
  }
  physics(sim) {
    const m = this.move;
    switch (this.state) {
      case 'walkF':
        this.vx = this.def.walkF * this.facing;
        break;
      case 'walkB':
        this.vx = this.guarding ? 0 : -this.def.walkB * this.facing;
        break;
      case 'dash': {
        const d = this.def.dash.f;
        this.vx = d[1] * this.facing * (this.t < d[0] - 5 ? 1 : 0.35);
        break;
      }
      case 'backdash': {
        const d = this.def.dash.b;
        this.vx = d[1] * this.facing * (this.t < d[0] - 6 ? 1 : 0.3);
        break;
      }
      case 'move':
        for (const v of m.def.vel)
          if (v[0] === m.f) {
            this.vx = v[1] * this.facing;
            if (v[2]) {
              this.vy = v[2];
              this.y = Math.max(this.y, 0.01);
              m.lifted = true;
            }
          }
        break;
      case 'grabbed': {
        const a = this.other;
        this.x = a.x + a.facing * (a.def.push + this.def.push + 2);
        this.y = a.grab && a.grab.lift ? 4 + Math.abs(Math.sin(a.t * 0.25)) * 10 : 0;
        this.vx = this.vy = 0;
        return;
      }
      case 'jump':
      case 'fall':
      case 'juggle':
        break;
      default:
        this.vx = 0;
    }
    const air = this.y > 0;
    this.x += this.vx + this.push;
    this.push *= 0.78;
    if (Math.abs(this.push) < 0.05) this.push = 0;
    if (air || this.vy > 0) {
      this.vy -= this.state === 'juggle' ? 0.45 : this.def.jump.gravity;
      this.y += this.vy;
      if (this.y <= 0) {
        this.y = 0;
        this.vy = 0;
        this.onLand(sim);
      }
    } else {
      this.y = 0;
      this.vy = 0;
    }
  }
  onLand(sim) {
    const st = this.state;
    if (st === 'jump') {
      this.enter('land', 3);
      sim.emit({ type: 'land', who: this.side, x: this.x, heavy: false });
    } else if (st === 'move') {
      const m = this.move.def;
      if (m.air) {
        this.enter('land', 3);
        sim.emit({ type: 'land', who: this.side, x: this.x, heavy: false });
      } else if (m.airborne && this.move.lifted) {
        this.enter('land', m.landing);
        sim.emit({ type: 'land', who: this.side, x: this.x, heavy: false });
      }
    } else if (st === 'fall') {
      this.enter('land', this.fallLanding);
      sim.emit({ type: 'land', who: this.side, x: this.x, heavy: false });
    } else if (st === 'juggle') {
      this.vx = 0;
      this.enter(this.hp <= 0 ? 'ko' : 'knockdown', this.rules.knockdown);
      sim.emit({ type: 'land', who: this.side, x: this.x, heavy: true });
    }
  }
  post(sim) {
    if (this.state === 'move' && this.move) this.move.f++;
    if (this.state === 'throwing' && this.grab && !this.grab.done && this.t === this.grab.exec) sim.executeThrow(this);
    this.t++;
    if (this.flash > 0) this.flash--;
    if (this.throwInv > 0) this.throwInv--;
    if (!STUN_STATES.has(this.state) && this.lagDelay > 0) this.lagDelay--;
    if (this.lagDelay <= 0 && this.hpLag > this.hp) this.hpLag = Math.max(this.hp, this.hpLag - 7);
    if (this.hpLag < this.hp) this.hpLag = this.hp;
    this.updatePose();
  }
  animName() {
    const st = this.state;
    if (st === 'move') return this.anim;
    if (st === 'throwing' && this.grab && this.grab.super) return this.anim;
    if (this.guarding && (st === 'walkB' || st === 'crouch' || st === 'stand')) return this.crouching || st === 'crouch' ? 'guardLow' : 'guard';
    if (st === 'hitstun') return this.crouching ? 'hitstunC' : 'hitstun';
    if (st === 'blockstun') return this.crouching ? 'blockstunC' : 'blockstun';
    return STATE_ANIM[st] || 'idle';
  }
  updatePose() {
    const name = this.animName();
    if (name !== this.anim) this.setAnim(name);
    const t = this.state === 'move' ? this.move.f : this.animT++;
    this.pose = sampleAnim(this.animKeys, t, this.animLoop, this.animFrom, this.data.poses);
  }
  /** Can this fighter block an attack of `level` coming from the `toward` side (+1 = attacker on the right)? */
  canBlock(level, toward) {
    if (!(this.isNeutral() || this.state === 'blockstun') || this.y > 0) return false;
    const rd = relDir(this.lastDir, toward);
    const high = rd === 4 || rd === 7;
    const low = rd === 1;
    if (level === 'high') return high;
    if (level === 'low') return low;
    return high || low;
  }
}

/** Phase of a move instance for perception and frame readouts. */
function movePhase(m) {
  const d = m.def;
  let first = Infinity;
  let last = -1;
  for (const h of d.hits) {
    first = Math.min(first, h.start);
    last = Math.max(last, h.end);
  }
  if (d.proj) {
    first = Math.min(first, d.proj.at);
    last = Math.max(last, d.proj.at + 1);
  }
  if (d.grab) {
    first = Math.min(first, d.grab.at);
    last = Math.max(last, d.grab.until);
  }
  if (last < 0) return 'recovery';
  return m.f < first ? 'startup' : m.f < last ? 'active' : 'recovery';
}

class Sim {
  constructor(data, defs, opts = {}) {
    this.data = data;
    this.rules = data.rules;
    const alt = opts.alt || [false, false];
    this.f = [new Fighter(defs[0], 0, data, alt[0]), new Fighter(defs[1], 1, data, alt[1])];
    this.f[0]._other = this.f[1];
    this.f[1]._other = this.f[0];
    this.noKO = !!opts.noKO;
    this.t = 0;
    this.frame = 0;
    this.serial = 0;
    this.events = [];
    this.resetPositions();
  }
  resetPositions() {
    this.f[0].resetRound(STAGE_W / 2 - 70, 1);
    this.f[1].resetRound(STAGE_W / 2 + 70, -1);
    this.projs = [];
    this.hitstop = 0;
    this.freezeT = 0;
    this.freezeBy = -1;
    this.camX = (STAGE_W - W) / 2;
    this.history = [[], []];
    this.adv = null;
    this.lastAdv = null;
  }
  emit(e) {
    e.frame = this.frame;
    this.events.push(e);
  }
  limits() {
    return [Math.max(WALL, this.camX + EDGE), Math.min(STAGE_W - WALL, this.camX + W - EDGE)];
  }
  step(inputs) {
    this.frame++;
    for (let i = 0; i < 2; i++) this.f[i].record(inputs[i] || NEUTRAL, this.t);
    if (this.freezeT > 0) {
      this.freezeT--;
      this.snapshot();
      return;
    }
    if (this.hitstop > 0) {
      this.hitstop--;
      this.snapshot();
      return;
    }
    this.t++;
    const fs = this.f;
    for (const f of fs) f.chargeTick(this.t);
    for (const f of fs) f.progress(this);
    this.updateGuard();
    for (const f of fs) f.think(this);
    for (const f of fs) f.physics(this);
    this.separate();
    this.face();
    this.spawnProjectiles();
    this.stepProjectiles();
    this.resolveGrabs();
    this.resolveStrikes();
    this.resolveProjectiles();
    for (const f of fs) f.post(this);
    this.combos();
    this.trackAdvantage();
    this.updateCamera();
    this.snapshot();
  }
  superFreeze(f, m) {
    this.freezeT = m.freeze;
    this.freezeBy = f.side;
    this.emit({ type: 'super', who: f.side, name: m.name, x: f.x, y: f.y, freeze: m.freeze });
  }
  hasProjectile(f) {
    return this.projs.some((p) => p.owner === f.side && !p.super && p.hits > 0);
  }
  updateGuard() {
    for (const f of this.f) {
      const o = f.other;
      const toward = sign(o.x - f.x) || f.facing;
      let threat = false;
      if (o.state === 'move' && Math.abs(o.x - f.x) < 150) {
        const ph = movePhase(o.move);
        threat = ph === 'startup' || ph === 'active';
      }
      if (!threat)
        for (const p of this.projs)
          if (p.owner === o.side && sign(f.x - p.x) === sign(p.vx) && Math.abs(f.x - p.x) < 170) threat = true;
      f.guarding = threat && f.isNeutral() && f.y <= 0 && dBack(relDir(f.lastDir, toward));
    }
  }
  separate() {
    const [a, b] = this.f;
    const [lo, hi] = this.limits();
    for (const f of this.f) if (f.state !== 'grabbed') f.x = clamp(f.x, lo, hi);
    if (a.state === 'grabbed' || b.state === 'grabbed') return;
    if (Math.abs(a.y - b.y) > 46) return; // one fighter is well above the other: they may cross
    const minD = a.def.push + b.def.push;
    const dx = b.x - a.x;
    if (Math.abs(dx) >= minD) return;
    const s = dx !== 0 ? sign(dx) : a.facing;
    const ov = minD - Math.abs(dx);
    let ax = clamp(a.x - (s * ov) / 2, lo, hi);
    let bx = clamp(b.x + (s * ov) / 2, lo, hi);
    if (Math.abs(bx - ax) < minD - 0.01) {
      // One side is against a wall: the other takes the whole push.
      if (ax === lo || ax === hi) bx = clamp(ax + s * minD, lo, hi);
      else ax = clamp(bx - s * minD, lo, hi);
    }
    a.x = ax;
    b.x = bx;
  }
  face() {
    for (const f of this.f) {
      if (!(f.isNeutral() || f.state === 'land' || f.state === 'prejump' || f.state === 'intro')) continue;
      const dx = f.other.x - f.x;
      if (Math.abs(dx) > 1) f.facing = sign(dx);
    }
  }
  worldBox(f, b) {
    return { x: f.facing > 0 ? f.x + b[0] : f.x - b[0] - b[2], y: f.y + b[1], w: b[2], h: b[3] };
  }
  hurtboxes(f) {
    if (f.invulnNow()) return [];
    let st = 'stand';
    if (f.y > 0 || f.state === 'juggle' || f.state === 'jump' || f.state === 'fall') st = 'air';
    else if (f.state === 'move') st = f.move.def.stance === 'air' ? 'stand' : f.move.def.stance;
    else if (f.isCrouching()) st = 'crouch';
    const list = f.def.hurt[st].map((b) => this.worldBox(f, b));
    if (f.state === 'move') for (const e of f.move.def.hurt) if (f.move.f >= e.from && f.move.f < e.to) list.push(this.worldBox(f, e.box));
    return list;
  }
  hitboxes(f) {
    if (f.state !== 'move') return [];
    const m = f.move;
    return m.def.hits.filter((h) => !m.done.has(h.idx) && m.f >= h.start && m.f < h.end).map((h) => this.worldBox(f, h.box));
  }
  spawnProjectiles() {
    for (const f of this.f) {
      if (f.state !== 'move') continue;
      const m = f.move;
      const p = m.def.proj;
      if (!p || m.projDone || m.f !== p.at) continue;
      m.projDone = true;
      this.projs.push({
        owner: f.side, x: f.x + f.facing * (p.x + p.w / 2), y: f.y + p.y, w: p.w, h: p.h, vx: p.vx * f.facing, life: p.life, hits: p.hits,
        interval: p.interval, cool: 0, hit: p.hit, kind: p.kind, super: p.super, id: ++this.serial, age: 0, superHit: false,
      });
      this.emit({ type: 'proj', who: f.side, kind: p.kind, super: p.super });
    }
  }
  stepProjectiles() {
    for (const p of this.projs) {
      p.x += p.vx;
      p.age++;
      p.life--;
    }
    for (let i = 0; i < this.projs.length; i++)
      for (let j = i + 1; j < this.projs.length; j++) {
        const a = this.projs[i];
        const b = this.projs[j];
        if (a.owner === b.owner || a.hits <= 0 || b.hits <= 0) continue;
        if (Math.abs(a.x - b.x) > (a.w + b.w) / 2 || Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) > (a.h + b.h) / 2) continue;
        if (a.super !== b.super) {
          const s = a.super ? a : b;
          (a.super ? b : a).hits = 0;
          s.hits--;
        } else {
          a.hits--;
          b.hits--;
        }
        this.emit({ type: 'clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + a.h / 2 });
      }
    this.projs = this.projs.filter((p) => {
      const alive = p.hits > 0 && p.life > 0 && p.x > -80 && p.x < STAGE_W + 80;
      if (!alive && p.hits > 0) this.emit({ type: 'fizzle', x: p.x, y: p.y + p.h / 2, kind: p.kind });
      return alive;
    });
  }
  throwable(d) {
    return d.y <= 0 && !NO_THROW_STATES.has(d.state) && d.throwInv <= 0 && !d.invulnNow();
  }
  resolveGrabs() {
    const cands = [];
    for (const atk of this.f) {
      const m = atk.move;
      if (atk.state !== 'move' || !m.def.grab || m.grabDone) continue;
      const g = m.def.grab;
      if (m.f < g.at || m.f >= g.until) continue;
      const d = atk.other;
      if (!this.throwable(d) && !(d.state === 'move' && d.move.def.grab && d.y <= 0 && !d.invulnNow())) continue;
      const gap = Math.abs(d.x - atk.x) - atk.def.push - d.def.push;
      if (gap > g.range) continue;
      cands.push({ atk, d, g });
    }
    if (!cands.length) return;
    if (cands.length === 2) {
      if (cands[0].g.techable && cands[1].g.techable) {
        // Both threw on the same frame: an automatic tech.
        cands[0].atk.move.grabDone = cands[1].atk.move.grabDone = true;
        this.techPair(cands[0].atk, cands[1].atk, -1);
        return;
      }
      cands.sort((p, q) => (p.g.techable ? 1 : 0) - (q.g.techable ? 1 : 0));
    }
    this.grabStart(cands[0]);
  }
  grabStart({ atk, d, g }) {
    const R = this.rules;
    const m = atk.move;
    m.grabDone = true;
    const sup = m.def.type === 'super';
    const grab = {
      other: d, g, back: !!m.back, super: sup, done: false, lift: !g.techable,
      exec: g.techable ? R.techWindow : Math.max(8, g.hold - 12), dur: g.techable ? R.techWindow + 22 : g.hold + 10,
    };
    atk.enter('throwing', grab.dur);
    atk.grab = grab;
    if (sup) atk.setAnim('throw:super', [['grab', 6], ['toss', 12], ['slam', 8], ['toss', 10], ['slam', 8], ['idle', 16]]);
    d.enter('grabbed');
    d.techable = g.techable;
    d.grabSeq = d.seq - 3;
    d.facing = -atk.facing;
    d.vx = d.vy = 0;
    d.push = 0;
    this.emit({ type: 'grab', who: atk.side, techable: g.techable, super: sup, x: (atk.x + d.x) / 2 });
  }
  executeThrow(atk) {
    const gr = atk.grab;
    const d = gr.other;
    gr.done = true;
    if (d.state !== 'grabbed') return;
    let away = atk.facing;
    if (gr.back) {
      d.x = atk.x - atk.facing * (atk.def.push + d.def.push + 2);
      away = -atk.facing;
    }
    const dmg = Math.round(gr.g.damage);
    d.hp = Math.max(this.noKO ? 1 : 0, d.hp - dmg);
    d.combo = 1;
    d.comboDmg = dmg;
    d.lagDelay = 40;
    d.flash = 4;
    d.enter('juggle');
    d.juggle = this.rules.juggleLimit;
    d.vx = away * (gr.super ? 2.8 : 2.2);
    d.vy = gr.super ? 6.5 : 5;
    d.y = 1;
    atk.meter = Math.min(this.rules.meterMax, atk.meter + gr.g.meter);
    d.meter = Math.min(this.rules.meterMax, d.meter + 4);
    atk.stats.damage += dmg;
    atk.stats.hits++;
    atk.stats.throws++;
    if (gr.super) atk.stats.supers++;
    this.hitstop = d.hp <= 0 ? 32 : gr.super ? 20 : 10;
    this.emit({ type: 'throw', who: atk.side, dmg, super: gr.super, techable: gr.g.techable, x: d.x, y: 30, ko: d.hp <= 0 });
    if (d.hp <= 0) this.emit({ type: 'ko', who: atk.side, loser: d.side });
  }
  tech(d, atk) {
    d.stats.techs++;
    this.techPair(atk, d, d.side);
  }
  techPair(a, b, by) {
    for (const f of [a, b]) {
      f.grab = null;
      f.enter('tech', 16);
      f.vx = f.vy = 0;
      f.y = 0;
    }
    const s = sign(b.x - a.x) || a.facing;
    a.push = -s * 3.6;
    b.push = s * 3.6;
    this.hitstop = 6;
    this.emit({ type: 'tech', who: by, x: (a.x + b.x) / 2, y: 40 });
  }
  resolveStrikes() {
    const found = [];
    for (const atk of this.f) {
      if (atk.state !== 'move') continue;
      const m = atk.move;
      const d = atk.other;
      const hurts = this.hurtboxes(d);
      if (!hurts.length) continue;
      for (const h of m.def.hits) {
        if (m.done.has(h.idx) || m.f < h.start || m.f >= h.end) continue;
        const hb = this.worldBox(atk, h.box);
        const hit = hurts.find((b) => overlap(hb, b));
        if (hit) {
          m.done.add(h.idx);
          found.push({ atk, d, h, m, hb, hit });
          break;
        }
      }
    }
    for (const x of found) this.applyHit(x.atk, x.d, x.h, x.m, null, x.hb, x.hit);
  }
  resolveProjectiles() {
    for (const p of this.projs) {
      if (p.hits <= 0) continue;
      if (p.cool > 0) {
        p.cool--;
        continue;
      }
      const d = this.f[1 - p.owner];
      const rect = { x: p.x - p.w / 2, y: p.y, w: p.w, h: p.h };
      const hit = this.hurtboxes(d).find((b) => overlap(rect, b));
      if (!hit) continue;
      const h = p.hits > 1 && p.hit.knockdown ? { ...p.hit, knockdown: false, launch: null } : p.hit;
      this.applyHit(this.f[p.owner], d, h, null, p, rect, hit);
      p.hits--;
      p.cool = p.interval;
    }
    this.projs = this.projs.filter((p) => p.hits > 0);
  }
  pushApart(atk, d, away, v, melee) {
    const [lo, hi] = this.limits();
    const nearWall = away > 0 ? d.x >= hi - 4 : d.x <= lo + 4;
    if (melee && nearWall) atk.push = -away * v;
    else d.push = away * v;
  }
  applyHit(atk, d, h, move, proj, hb, hurt) {
    const R = this.rules;
    const toward = proj ? -sign(proj.vx) || -d.facing : sign(atk.x - d.x) || -d.facing;
    const away = -toward;
    const pushV = h.pushback * 0.22;
    const ix = (Math.max(hb.x, hurt.x) + Math.min(hb.x + hb.w, hurt.x + hurt.w)) / 2;
    const iy = (Math.max(hb.y, hurt.y) + Math.min(hb.y + hb.h, hurt.y + hurt.h)) / 2;
    const isSuper = (move && move.def.type === 'super') || (proj && proj.super);
    const kind = move ? move.def.type : 'special';
    const strength = isSuper ? 'S' : move && move.def.type === 'normal' ? move.def.btn : 'H';
    if (d.canBlock(h.level, toward)) {
      const crouchBlock = relDir(d.lastDir, toward) === 1;
      d.enter('blockstun', Math.round(h.blockstun));
      d.crouching = crouchBlock;
      d.vx = 0;
      if (h.chip > 0) {
        d.hp = Math.max(this.noKO ? 1 : 0, d.hp - h.chip);
        d.lagDelay = 30;
      }
      this.pushApart(atk, d, away, pushV, !proj);
      atk.meter = Math.min(R.meterMax, atk.meter + Math.ceil(h.meter / 2));
      d.meter = Math.min(R.meterMax, d.meter + 2);
      d.stats.blocks++;
      this.hitstop = Math.max(this.hitstop, Math.max(4, h.hitstop - 2));
      if (move) move.contact = true;
      this.adv = { atk, d, kind: 'block', ra: -1, rd: -1, move: move ? move.def.name : 'projectile', kd: false };
      this.emit({ type: 'block', who: atk.side, x: ix, y: iy, chip: h.chip, level: h.level, low: crouchBlock, kind, strength });
      if (d.hp <= 0) {
        d.enter('juggle');
        d.vx = away * 2.4;
        d.vy = 6;
        d.y = 1;
        this.hitstop = 32;
        this.emit({ type: 'ko', who: atk.side, loser: d.side, chip: true });
      }
      return;
    }
    const inCombo = d.combo > 0 && (d.state === 'hitstun' || d.state === 'juggle');
    d.combo = inCombo ? d.combo + 1 : 1;
    if (!inCombo) {
      d.comboDmg = 0;
      d.juggle = 0;
    }
    let scale = R.scaling[Math.min(d.combo - 1, R.scaling.length - 1)];
    if (isSuper) scale = Math.max(scale, R.superMinScale);
    const dmg = Math.max(1, Math.round(h.damage * scale));
    const wasCrouch = d.isCrouching();
    const wasAir = d.y > 0 || d.state === 'juggle';
    d.hp = Math.max(this.noKO ? 1 : 0, d.hp - dmg);
    d.comboDmg += dmg;
    d.lagDelay = 40;
    d.flash = 4;
    d.grab = null;
    atk.stats.damage += dmg;
    atk.stats.hits++;
    if (isSuper && move && !move.superHit) {
      move.superHit = true;
      atk.stats.supers++;
    }
    if (isSuper && proj && !proj.superHit) {
      proj.superHit = true;
      atk.stats.supers++;
    }
    if (d.hp <= 0 || wasAir || h.knockdown || h.launch) {
      const L = d.hp <= 0 ? [2.6, 6] : h.launch || (wasAir ? [1.5, 4.2] : [2, 5]);
      d.juggle = (wasAir ? d.juggle : 0) + h.juggle;
      d.enter('juggle');
      d.vx = away * L[0];
      d.vy = L[1];
      d.y = Math.max(d.y, 1);
    } else {
      d.enter('hitstun', Math.round(h.hitstun));
      d.crouching = wasCrouch;
      d.vx = 0;
      this.pushApart(atk, d, away, pushV, !proj);
    }
    atk.meter = Math.min(R.meterMax, atk.meter + (isSuper ? 0 : h.meter));
    d.meter = Math.min(R.meterMax, d.meter + 3);
    this.hitstop = d.hp <= 0 ? 32 : Math.max(this.hitstop, h.hitstop);
    if (move) {
      move.contact = true;
      move.confirm = true;
    }
    this.adv = { atk, d, kind: 'hit', ra: -1, rd: -1, move: move ? move.def.name : 'projectile', kd: d.state === 'juggle' };
    this.emit({ type: 'hit', who: atk.side, x: ix, y: iy, dmg, combo: d.combo, scale, kind, strength, super: isSuper, ko: d.hp <= 0, proj: !!proj });
    if (d.hp <= 0) this.emit({ type: 'ko', who: atk.side, loser: d.side });
  }
  combos() {
    for (const d of this.f) {
      if (d.combo > 0 && !STUN_STATES.has(d.state)) {
        const atk = d.other;
        if (d.combo > atk.stats.maxCombo) atk.stats.maxCombo = d.combo;
        this.emit({ type: 'comboEnd', who: atk.side, hits: d.combo, dmg: d.comboDmg });
        d.combo = 0;
        d.juggle = 0;
      }
    }
  }
  trackAdvantage() {
    const a = this.adv;
    if (!a || a.res !== undefined) return;
    const ready = (f) => f.isNeutral() || f.state === 'jump';
    if (a.d.state === 'knockdown' || a.d.state === 'juggle') a.kd = true;
    if (a.ra < 0 && ready(a.atk)) a.ra = this.t;
    if (a.rd < 0 && ready(a.d)) a.rd = this.t;
    if (a.ra >= 0 && a.rd >= 0) {
      a.res = a.rd - a.ra;
      this.lastAdv = { who: a.atk.side, kind: a.kind, adv: a.res, move: a.move, kd: a.kd };
      this.emit({ type: 'adv', ...this.lastAdv });
    }
  }
  updateCamera() {
    const [a, b] = this.f;
    this.camX = clamp((a.x + b.x) / 2 - W / 2, 0, STAGE_W - W);
  }
  snapshot() {
    for (const f of this.f) {
      const m = f.state === 'move' ? f.move : null;
      const s = {
        x: f.x, y: f.y, vx: f.vx, vy: f.vy, state: f.state, air: f.y > 0, crouch: f.isCrouching(), serial: m ? m.serial : 0,
        move: m ? m.def.id : '', type: m ? m.def.type : '', phase: m ? movePhase(m) : '', level: m ? m.def.level : '', contact: m ? m.contact : false,
        reach: m ? m.def.reach : 0, left: m ? m.def.total - m.f : 0, jumpSerial: f.jumpSerial, hp: f.hp,
        projs: this.projs.filter((p) => p.owner === f.side).map((p) => ({ x: p.x, vx: p.vx, id: p.id })),
      };
      const hist = this.history[f.side];
      hist.push(s);
      if (hist.length > 40) hist.shift();
    }
  }
  /** What a fighter looked like `delay` frames ago (the CPU's reaction-delayed view of its opponent). */
  perceive(side, delay) {
    const h = this.history[side];
    return h.length ? h[Math.max(0, h.length - 1 - delay)] : null;
  }
}

/** Rounds, timer, KO / time over / draws, training upkeep. One `step` per 60 Hz update. */
class Bout {
  constructor(data, opts) {
    this.data = data;
    this.rules = data.rules;
    this.mode = opts.mode || 'versus';
    this.training = this.mode === 'training';
    this.sim = new Sim(data, opts.defs, { alt: opts.alt, noKO: this.training });
    this.round = 0;
    this.wins = [0, 0];
    this.results = [];
    this.over = false;
    this.winner = -1;
    this.events = [];
    this.sim.events = this.events;
    this.refill = [0, 0];
    this.startRound();
  }
  emit(e) {
    this.sim.emit(e);
  }
  startRound() {
    this.round++;
    this.sim.resetPositions();
    this.timer = this.rules.roundTime * 60;
    this.phaseT = 0;
    this.result = null;
    this.roundStart = this.sim.f.map((f) => ({ ...f.stats }));
    if (this.training) {
      this.phase = 'fight';
      for (const f of this.sim.f) f.meter = this.rules.meterMax;
    } else {
      this.phase = 'intro';
      for (const f of this.sim.f) f.enter('intro');
    }
    const need = this.rules.roundsToWin;
    const final = this.wins[0] === need - 1 && this.wins[1] === need - 1;
    this.emit({ type: 'roundStart', round: this.round, final });
  }
  get timeLeft() {
    return Math.max(0, Math.ceil(this.timer / 60));
  }
  step(raw) {
    const sim = this.sim;
    const inputs = this.phase === 'fight' ? raw : [NEUTRAL, NEUTRAL];
    switch (this.phase) {
      case 'intro':
        if (this.phaseT === 64) this.emit({ type: 'fightStart', round: this.round });
        if (this.phaseT >= 96) {
          for (const f of sim.f) f.enter('stand');
          this.phase = 'fight';
          this.phaseT = -1;
        }
        sim.step(inputs);
        break;
      case 'fight':
        sim.step(inputs);
        if (!this.training && sim.hitstop === 0 && sim.freezeT === 0) this.timer--;
        if (!this.training) {
          const [a, b] = sim.f;
          if (a.hp <= 0 || b.hp <= 0) this.endRound('ko');
          else if (this.timer <= 0) this.endRound('time');
        }
        break;
      case 'ko':
        // Slow motion for the first second, then the winner celebrates.
        if (this.phaseT >= 60 || this.phaseT % 2 === 0) sim.step(inputs);
        if (this.phaseT === 150) this.pose();
        if (this.phaseT >= 210) this.finishRound();
        break;
      case 'time':
        sim.step(inputs);
        if (this.phaseT === 50) this.pose();
        if (this.phaseT >= 190) this.finishRound();
        break;
      default:
        sim.step(inputs);
        break;
    }
    this.phaseT++;
    if (this.training) this.upkeep();
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }
  upkeep() {
    for (const f of this.sim.f) {
      f.meter = this.rules.meterMax;
      if (f.hp < f.def.health && f.combo === 0 && !STUN_STATES.has(f.state) && f.state !== 'knockdown') {
        this.refill[f.side]++;
        if (this.refill[f.side] > 40) {
          f.hp = f.def.health;
          f.hpLag = f.hp;
        }
      } else this.refill[f.side] = 0;
    }
  }
  pose() {
    const r = this.result;
    if (!r) return;
    this.sim.f.forEach((f, i) => {
      if (!(f.isNeutral() || f.state === 'land')) return;
      if (r.winner === i) f.enter('win');
      else if (r.winner >= 0 || r.reason === 'time') f.enter('lose');
    });
  }
  endRound(reason) {
    const [a, b] = this.sim.f;
    let winner;
    if (reason === 'ko') winner = a.hp <= 0 && b.hp <= 0 ? -1 : a.hp <= 0 ? 1 : 0;
    else {
      const ra = a.hp / a.def.health;
      const rb = b.hp / b.def.health;
      winner = Math.abs(ra - rb) < 1e-9 ? -1 : ra > rb ? 0 : 1;
    }
    const perfect = winner >= 0 && this.sim.f[winner].hp === this.sim.f[winner].def.health;
    const stats = this.sim.f.map((f, i) => {
      const s0 = this.roundStart[i];
      return { damage: f.stats.damage - s0.damage, maxCombo: f.stats.maxCombo, supers: f.stats.supers - s0.supers };
    });
    this.result = { round: this.round, winner, reason: reason === 'ko' && winner < 0 ? 'double' : reason, perfect, timeLeft: this.timeLeft, hp: [a.hp, b.hp], stats };
    this.phase = reason === 'ko' ? 'ko' : 'time';
    this.phaseT = 0;
    this.emit({ type: 'roundEnd', ...this.result });
  }
  finishRound() {
    const r = this.result;
    this.results.push(r);
    if (r.winner >= 0) this.wins[r.winner]++;
    const need = this.rules.roundsToWin;
    if (this.wins[0] >= need || this.wins[1] >= need || this.round >= this.rules.maxRounds) {
      this.over = true;
      this.phase = 'over';
      this.phaseT = 0;
      this.winner = this.wins[0] === this.wins[1] ? -1 : this.wins[0] > this.wins[1] ? 0 : 1;
      this.emit({ type: 'matchEnd', winner: this.winner, wins: this.wins.slice() });
    } else this.startRound();
  }
}

// ======================================================================= 4. ai

// The CPU sees its opponent only through Sim.perceive(side, reaction): a snapshot from `reaction` frames ago
// (position, state, move phase and level). It never reads the other player's inputs or input buffer. Every
// reactive decision (block this attack, anti-air this jump, punish this whiff) is rolled once per opponent
// action, so a lower level really does let attacks through. Specials go through the same input buffer as a
// human's: the CPU types the motion frame by frame.
const AI_LEVELS = {
  easy: { name: 'EASY', reaction: 22, guard: 0.1, block: 0.25, aa: 0.15, punish: 0.15, combo: 0.2, tech: 0.2, special: 0.2, think: 18, jump: 0.05, throwP: 0.1, mult: 1 },
  normal: { name: 'NORMAL', reaction: 14, guard: 0.3, block: 0.55, aa: 0.45, punish: 0.45, combo: 0.55, tech: 0.35, special: 0.35, think: 11, jump: 0.07, throwP: 0.22, mult: 1.5 },
  hard: { name: 'HARD', reaction: 9, guard: 0.45, block: 0.82, aa: 0.78, punish: 0.78, combo: 0.9, tech: 0.55, special: 0.45, think: 6, jump: 0.06, throwP: 0.32, mult: 2 },
};
const LEVEL_IDS = ['easy', 'normal', 'hard'];
const MACROS = { qcf: [2, 3, 6], qcb: [2, 1, 4], dp: [6, 2, 3], hcf: [4, 1, 2, 3, 6], 360: [6, 3, 2, 1, 4, 7, 8], qcf2: [2, 3, 6, 2, 3, 6] };

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class CpuController {
  constructor(level = 'normal', seed = 1) {
    this.level = AI_LEVELS[level] ? level : 'normal';
    this.p = AI_LEVELS[this.level];
    this.rng = mulberry(seed);
    this.queue = [];
    this.rolls = new Map();
    this.hold = 5;
    this.guardDir = 4;
    this.nextThink = 0;
    this.n = 0;
    this.human = false;
  }
  roll(key, p) {
    if (!this.rolls.has(key)) {
      if (this.rolls.size > 256) this.rolls.clear();
      this.rolls.set(key, this.rng() < p);
    }
    return this.rolls.get(key);
  }
  /** Relative (to the fighter's facing) queue steps: { dir, btn, n frames }. */
  push(dir, btn = 0, n = 1) {
    this.queue.push({ dir, btn, n });
  }
  motion(me, name, btn) {
    const C = me.rules.chargeFrames;
    if (name === 'chargeBF') {
      if (me.chargeB < C) return false;
      this.push(6, btn, 1);
      return true;
    }
    if (name === 'chargeDU') {
      if (me.chargeD < C) return false;
      this.push(8, btn, 1);
      return true;
    }
    const seq = MACROS[name];
    if (!seq) return false;
    seq.forEach((d, i) => this.push(d, i === seq.length - 1 ? btn : 0, i === seq.length - 1 ? 1 : 2));
    this.push(5, 0, 2);
    return true;
  }
  special(me, roles, btn = BTN.H) {
    for (const role of roles)
      for (const s of me.def.specials) if (s.role === role && this.motion(me, s.motion, btn)) return true;
    return false;
  }
  normal(id) {
    const dir = id[0] === '2' ? 2 : id === '6M' ? 6 : 5;
    const btn = BTN[id[id.length - 1]];
    this.push(dir, btn, 1);
    this.push(dir, 0, 2);
  }
  next(me) {
    const s = this.queue[0];
    if (--s.n <= 0) this.queue.shift();
    const dir = me.facing < 0 ? MIRROR[s.dir] : s.dir;
    return { dir, press: s.btn, held: s.btn };
  }
  /** Follow-up after a confirmed (or blocked) cancellable move. */
  planCombo(me, m) {
    const c = m.def.cancel;
    const full = me.meter >= me.rules.meterMax;
    if (c.into.includes('super') && full && me.def.super && this.rng() < 0.6 && this.motion(me, me.def.super.motion, BTN.H)) return true;
    if (c.into.includes('special') && this.special(me, me.def.archetype === 'zoner' ? ['antiair', 'projectile'] : ['rush', 'antiair', 'low'], BTN.H)) return true;
    if (c.chain.length && me.chainN < me.rules.chainLimit - 1) {
      this.push(2, BTN.L, 1);
      this.push(2, 0, 1);
      return true;
    }
    return false;
  }
  read(bout, side) {
    const sim = bout.sim;
    const me = sim.f[side];
    const op = me.other;
    const P = this.p;
    const R = sim.rules;
    this.n++;
    if (bout.phase !== 'fight') {
      this.queue.length = 0;
      return NEUTRAL;
    }
    if (this.queue.length) return this.next(me);
    const p = sim.perceive(op.side, P.reaction);
    if (!p) return NEUTRAL;
    const toward = sign(p.x - me.x) || me.facing;
    const rel = (d, btn = 0) => ({ dir: toward < 0 ? MIRROR[d] : d, press: btn, held: btn });
    const gap = Math.abs(p.x - me.x) - me.def.push - op.def.push;
    const zoner = me.def.archetype === 'zoner';
    const idle = zoner ? 1 : 5;

    if (me.state === 'grabbed') {
      if (me.techable && me.t >= Math.max(2, P.reaction - 6) && this.roll('tech' + me.grabSeq, P.tech)) return { dir: 5, press: BTN.T, held: BTN.T };
      return NEUTRAL;
    }
    if (me.state === 'blockstun') return rel(this.guardDir);
    if (me.state === 'move') {
      const m = me.move;
      const c = m.def.cancel;
      if (c && m.contact && m.f >= c.from && m.f <= c.to) {
        const go = m.confirm ? this.roll('combo' + m.serial, P.combo) : this.level === 'hard' && this.roll('bstr' + m.serial, 0.25);
        if (go && this.planCombo(me, m)) return this.next(me);
      }
      return rel(idle);
    }
    if (me.state === 'jump') {
      if (!me.airUsed && gap < 44 && me.vy < 3 && this.roll('air' + me.jumpSerial, 0.85)) return rel(5, gap < 20 ? BTN.M : BTN.H);
      return NEUTRAL;
    }
    if (me.state === 'wakeup' && me.t >= me.dur - 5 && gap < 40 && this.level === 'hard' && this.roll('rev' + me.jumpSerial + ':' + this.n, 0.02)) {
      if (this.special(me, ['antiair'])) return this.next(me);
    }
    if (!me.isNeutral()) return rel(idle);

    // Projectiles coming in: block, or jump over at range.
    for (const pr of p.projs) {
      if (sign(me.x - pr.x) !== sign(pr.vx)) continue;
      const d = Math.abs(me.x - pr.x);
      if (d < 120 && d > 70 && this.roll('pjj' + pr.id, P.jump * 3)) {
        this.push(9, 0, 3);
        return this.next(me);
      }
      if (d < 110 && this.roll('pj' + pr.id, P.block)) {
        this.guardDir = 4;
        return rel(4);
      }
    }
    // Jump-ins: anti-air when close enough, else block high.
    if (p.air && (p.state === 'jump' || p.state === 'move') && gap < 120 && (sign(me.x - p.x) === sign(p.vx) || gap < 50)) {
      if (this.roll('aa' + p.jumpSerial, P.aa)) {
        if (gap < 64) {
          if (this.special(me, ['antiair'])) return this.next(me);
          this.normal(me.def.id === 'gorm' ? '2H' : '5H');
          return this.next(me);
        }
        return rel(zoner ? 1 : 5);
      }
      if (this.roll('aab' + p.jumpSerial, P.block)) {
        this.guardDir = 4;
        return rel(4);
      }
    }
    // Attacks starting or active in range.
    if ((p.phase === 'startup' || p.phase === 'active') && p.type !== 'throw' && gap < p.reach + 14) {
      if (this.roll('atk' + p.serial, P.block)) {
        this.guardDir = p.level === 'low' ? 1 : p.level === 'high' ? 4 : p.crouch || this.rng() < 0.5 ? 1 : 4;
        return rel(this.guardDir);
      }
    }
    // Whiff punish.
    if (p.phase === 'recovery' && !p.contact && p.left >= 9 && this.roll('pun' + p.serial, P.punish)) {
      if (me.meter >= R.meterMax && me.def.super && gap < 50 && this.motion(me, me.def.super.motion, BTN.H)) return this.next(me);
      if (gap < 30) {
        this.normal('5M');
        return this.next(me);
      }
      if (gap < 70 && this.special(me, ['rush', 'low'])) return this.next(me);
      if (gap < 46) {
        this.normal('5H');
        return this.next(me);
      }
    }
    if (this.n < this.nextThink) return rel(this.hold);
    this.nextThink = this.n + P.think + Math.floor(this.rng() * P.think);
    this.plan(me, p, gap, sim);
    if (this.queue.length) return this.next(me);
    return rel(this.hold);
  }
  plan(me, p, gap, sim) {
    const P = this.p;
    const r = this.rng();
    const myProj = sim.hasProjectile(me);
    const R = sim.rules;
    const pressNormal = (id) => this.normal(id);
    const reachOf = (id) => {
      const m = me.def.normals[id];
      return m ? m.reach - me.def.push - 4 : 0;
    };
    const full = me.meter >= R.meterMax && me.def.super;
    if (full && gap < 40 && r < 0.12 && this.motion(me, me.def.super.motion, BTN.H)) return;
    // Close and in neutral: sometimes just guard (mostly low, sometimes high) and wait for an opening. This is
    // anticipation from position, not input reading, so mix-ups (overheads, throws) still beat it.
    if (gap < 80 && !p.air && this.rng() < P.guard) {
      this.hold = this.rng() < 0.7 ? 1 : 4;
      return;
    }
    if (p.state === 'knockdown' || p.state === 'wakeup') {
      this.hold = gap > 30 && me.def.archetype !== 'zoner' ? 6 : me.def.archetype === 'zoner' ? 4 : 1;
      return;
    }
    switch (me.def.archetype) {
      case 'grappler':
        if (gap > 90) {
          if (r < P.jump * 2) this.push(9, 0, 3);
          else this.hold = 6;
        } else if (gap > 34) {
          if (r < 0.2) this.special(me, ['rush'], gap > 60 ? BTN.H : BTN.M);
          else if (r < 0.4 && gap < reachOf('2M')) pressNormal('2M');
          else if (r < 0.48) this.push(9, 0, 3);
          else this.hold = 6;
        } else if (r < P.special + 0.1) this.special(me, ['grab'], BTN.H);
        else if (r < P.special + 0.1 + P.throwP) this.push(5, BTN.T, 1);
        else if (r < 0.75) pressNormal(r < 0.62 ? '5L' : '6M');
        else this.hold = 1;
        break;
      case 'rushdown':
        if (gap > 110) {
          if (r < 0.45) {
            this.push(6, 0, 2);
            this.push(5, 0, 2);
            this.push(6, 0, 3);
          } else if (r < 0.45 + P.jump * 2) this.push(9, 0, 3);
          else this.hold = 6;
        } else if (gap > 36) {
          if (r < 0.22) this.special(me, ['low'], BTN.M);
          else if (r < 0.32) this.push(9, 0, 3);
          else if (r < 0.45 && gap < reachOf('2M')) pressNormal('2M');
          else this.hold = 6;
        } else if (r < P.throwP) this.push(5, BTN.T, 1);
        else if (r < 0.55) pressNormal('2L');
        else if (r < 0.68) pressNormal('6M');
        else if (r < 0.8) pressNormal('5M');
        else this.hold = 1;
        break;
      case 'zoner':
        if (gap > 130) {
          if (!myProj && r < P.special * 1.6 && this.special(me, ['projectile'], r < 0.3 ? BTN.L : BTN.H)) return;
          this.hold = me.chargeB < R.chargeFrames ? 1 : r < 0.3 ? 6 : 1;
        } else if (gap > 56) {
          if (!myProj && r < P.special && this.special(me, ['projectile'], BTN.M)) return;
          if (r < 0.55 && gap < reachOf('5H')) pressNormal(r < 0.3 ? '2M' : '5H');
          else this.hold = r < 0.8 ? 4 : 1;
        } else if (r < 0.25) pressNormal('2L');
        else if (r < 0.4) {
          this.push(4, 0, 2);
          this.push(5, 0, 2);
          this.push(4, 0, 3);
        } else if (r < 0.4 + P.throwP) this.push(5, BTN.T, 1);
        else if (r < 0.7 && gap < reachOf('5M')) pressNormal('5M');
        else this.hold = 1;
        break;
      default:
        if (gap > 150) {
          if (!myProj && r < P.special * 1.4 && this.special(me, ['projectile'], r < 0.25 ? BTN.L : BTN.H)) return;
          this.hold = r < 0.75 ? 6 : 5;
        } else if (gap > 40) {
          if (!myProj && r < P.special * 0.7 && this.special(me, ['projectile'], BTN.M)) return;
          if (r < 0.4 && gap < reachOf('2M')) pressNormal('2M');
          else if (r < 0.4 + P.jump * 2) this.push(9, 0, 3);
          else this.hold = r < 0.85 ? 6 : 4;
        } else if (r < P.throwP) this.push(5, BTN.T, 1);
        else if (r < 0.5) pressNormal('2L');
        else if (r < 0.62) pressNormal('6M');
        else if (r < 0.75) pressNormal('5M');
        else this.hold = r < 0.9 ? 1 : 4;
    }
  }
}

/** Training dummy: stand, crouch, jump, block everything (correct high/low), or play as the CPU. */
class DummyController {
  constructor(settings) {
    this.s = settings;
    this.cpu = new CpuController('normal', 7);
    this.human = false;
  }
  read(bout, side) {
    const sim = bout.sim;
    const me = sim.f[side];
    const op = me.other;
    const mode = this.s.dummy;
    if (mode === 'cpu') return this.cpu.read(bout, side);
    if (me.state === 'grabbed') return this.s.tech && me.t >= 3 ? { dir: 5, press: BTN.T, held: BTN.T } : NEUTRAL;
    const toward = sign(op.x - me.x) || me.facing;
    const rel = (d) => ({ dir: toward < 0 ? MIRROR[d] : d, press: 0, held: 0 });
    switch (mode) {
      case 'crouch':
        return { dir: 2, press: 0, held: 0 };
      case 'jump':
        return { dir: 8, press: 0, held: 0 };
      case 'block': {
        let g = 1;
        if (op.y > 0 || (op.state === 'move' && op.move.def.level === 'high')) g = 4;
        return rel(g);
      }
      default:
        return NEUTRAL;
    }
  }
}

// ======================================================================= 5. art

const DEG = Math.PI / 180;
const hash = (i) => {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
function hexRgb(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
function mix(a, b, t) {
  const x = hexRgb(a);
  const y = hexRgb(b);
  const h = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${h(lerp(x[0], y[0], t))}${h(lerp(x[1], y[1], t))}${h(lerp(x[2], y[2], t))}`;
}
const luma = (c) => {
  const [r, g, b] = hexRgb(c);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};
const INK = '#120b10';

/** Pose -> joint positions in local units (x forward, y up, feet at 0). Arms are forward kinematics, legs two-bone IK. */
function skeleton(body, pose) {
  const L = body.leg[0] + body.leg[1];
  const vec = (a, len) => [Math.sin(a * DEG) * len, -Math.cos(a * DEG) * len];
  const hip = [pose.dx * L, pose.hip * L];
  const lean = pose.lean * DEG;
  const up = [Math.sin(lean), Math.cos(lean)];
  const perp = [Math.cos(lean), -Math.sin(lean)];
  const neck = [hip[0] + up[0] * body.torso, hip[1] + up[1] * body.torso];
  const hl = lean + pose.head * DEG;
  const head = [neck[0] + Math.sin(hl) * (body.head + 2), neck[1] + Math.cos(hl) * (body.head + 2)];
  const sh = [neck[0] - up[0] * 3, neck[1] - up[1] * 3];
  const arm = (a, side) => {
    const s = [sh[0] + perp[0] * side * 2, sh[1] + perp[1] * side * 2];
    const v1 = vec(a[0], body.arm[0]);
    const e = [s[0] + v1[0], s[1] + v1[1]];
    const v2 = vec(a[0] + a[1], body.arm[1]);
    return [s, e, [e[0] + v2[0], e[1] + v2[1]]];
  };
  const leg = (ft) => {
    const l1 = body.leg[0];
    const l2 = body.leg[1];
    let fx = ft[0] * L;
    let fy = ft[1] * L;
    let dx = fx - hip[0];
    let dy = fy - hip[1];
    let d = Math.hypot(dx, dy) || 0.001;
    const max = l1 + l2 - 0.01;
    if (d > max) {
      fx = hip[0] + (dx / d) * max;
      fy = hip[1] + (dy / d) * max;
      dx = fx - hip[0];
      dy = fy - hip[1];
      d = max;
    }
    d = Math.max(d, Math.abs(l1 - l2) + 0.5);
    const a = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
    const base = Math.atan2(dy, dx);
    const k1 = [hip[0] + Math.cos(base + a) * l1, hip[1] + Math.sin(base + a) * l1];
    const k2 = [hip[0] + Math.cos(base - a) * l1, hip[1] + Math.sin(base - a) * l1];
    return [hip, k1[0] > k2[0] ? k1 : k2, [fx, fy]];
  };
  const pts = { hip, neck, head, up, perp, lean: pose.lean + pose.head, armF: arm(pose.f, 1), armB: arm(pose.b, -1), legF: leg(pose.ff), legB: leg(pose.fb) };
  const rot = pose.rot * DEG;
  const lift = pose.dy * L;
  if (rot || lift) {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const tf = (p) => [p[0] * c + p[1] * s, -p[0] * s + p[1] * c + lift];
    for (const k of ['hip', 'neck', 'head']) pts[k] = tf(pts[k]);
    for (const k of ['armF', 'armB', 'legF', 'legB']) pts[k] = pts[k].map(tf);
    pts.up = [pts.up[0] * c + pts.up[1] * s, -pts.up[0] * s + pts.up[1] * c];
    pts.perp = [pts.perp[0] * c + pts.perp[1] * s, -pts.perp[0] * s + pts.perp[1] * c];
    pts.lean += pose.rot;
  }
  return pts;
}

function ellipse(r, cx, cy, rx, ry, color, alpha) {
  const pts = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
  }
  r.drawPolygon(pts, color, alpha);
}

/**
 * Draws a golem. (ox, oy) is the screen position of its root (feet), s the scale, facing +1/-1.
 * o: { flash, alpha, glow (0..1 core glow), aura (super), shadow }
 */
function drawGolem(r, def, pal, pose, ox, oy, facing, s, o = {}) {
  const b = def.body;
  const k = skeleton(b, pose);
  const P = (p) => [ox + facing * p[0] * s, oy - p[1] * s];
  const alpha = o.alpha ?? 1;
  const white = o.flash > 0;
  const clay = white ? '#fff6e8' : pal.clay;
  const dark = white ? '#f0d6c0' : pal.dark;
  const light = white ? '#ffffff' : pal.light;
  const glaze = white ? '#ffffff' : pal.glaze;
  const lw = b.limb * s;
  if (o.shadow !== false) ellipse(r, ox + facing * k.hip[0] * s * 0.3, oy + 1, (b.hips + 10) * s * 0.75, 3 * s, '#000000', 0.28 * alpha);
  const limb = (seg, color, w) => {
    const [a, c, d] = seg.map(P);
    r.drawLine(a[0], a[1], c[0], c[1], INK, w + 2.4 * s, alpha);
    r.drawLine(c[0], c[1], d[0], d[1], INK, w + 2.4 * s, alpha);
    r.drawCircle(c[0], c[1], (w + 2.4 * s) / 2, INK, { alpha, segments: 10 });
    r.drawLine(a[0], a[1], c[0], c[1], color, w, alpha);
    r.drawLine(c[0], c[1], d[0], d[1], color, w * 0.9, alpha);
    r.drawCircle(c[0], c[1], w / 2, color, { alpha, segments: 10 });
    r.drawCircle(d[0], d[1], (w * 0.62 + 1.2 * s) , INK, { alpha, segments: 10 });
    r.drawCircle(d[0], d[1], w * 0.62, color, { alpha, segments: 10 });
  };
  const backTone = mix(clay, dark, 0.55);
  limb(k.armB, backTone, lw * 0.92);
  limb(k.legB, backTone, lw);
  // torso
  const hipW = b.hips / 2;
  const shW = b.shoulders / 2;
  const at = (p, u, v) => [p[0] + k.perp[0] * u + k.up[0] * v, p[1] + k.perp[1] * u + k.up[1] * v];
  let quad;
  if (b.torsoStyle === 'vase') quad = [at(k.hip, -hipW, 0), at(k.hip, hipW, 0), at(k.hip, shW * 1.1, b.torso * 0.55), at(k.neck, shW * 0.8, 0), at(k.neck, -shW * 0.8, 0), at(k.hip, -shW * 1.1, b.torso * 0.55)];
  else if (b.torsoStyle === 'slab') quad = [at(k.hip, -hipW, 0), at(k.hip, hipW, 0), at(k.neck, shW, -2), at(k.neck, shW * 0.85, 1), at(k.neck, -shW * 0.85, 1), at(k.neck, -shW, -2)];
  else quad = [at(k.hip, -hipW, 0), at(k.hip, hipW, 0), at(k.hip, shW, b.torso * 0.7), at(k.neck, shW * 0.7, 0), at(k.neck, -shW * 0.7, 0), at(k.hip, -shW, b.torso * 0.7)];
  const cx = quad.reduce((sum, p) => sum + p[0], 0) / quad.length;
  const cy = quad.reduce((sum, p) => sum + p[1], 0) / quad.length;
  const out = [];
  const fill = [];
  for (const p of quad) {
    const d = Math.hypot(p[0] - cx, p[1] - cy) || 1;
    const q = P([p[0] + ((p[0] - cx) / d) * 1.3, p[1] + ((p[1] - cy) / d) * 1.3]);
    out.push(q[0], q[1]);
    const f = P(p);
    fill.push(f[0], f[1]);
  }
  r.drawPolygon(out, INK, alpha);
  r.drawPolygon(fill, clay, alpha);
  if (b.torsoStyle === 'barrel' || b.torsoStyle === 'vase') {
    const c = P(at(k.hip, 0, b.torso * 0.45));
    r.drawCircle(c[0], c[1], shW * 0.9 * s, clay, { alpha, segments: 16 });
  }
  // glaze band across the shoulders (dipped look) and a highlight
  const g1 = P(at(k.neck, -shW * 0.8, -1));
  const g2 = P(at(k.neck, shW * 0.8, -1));
  r.drawLine(g1[0], g1[1], g2[0], g2[1], glaze, 3 * s, alpha);
  const d1 = P(at(k.neck, shW * 0.3, -2));
  const d2 = P(at(k.neck, shW * 0.3, -6));
  r.drawLine(d1[0], d1[1], d2[0], d2[1], glaze, 1.6 * s, alpha);
  const h1 = P(at(k.hip, shW * 0.55, b.torso * 0.25));
  const h2 = P(at(k.hip, shW * 0.55, b.torso * 0.75));
  r.drawLine(h1[0], h1[1], h2[0], h2[1], light, 1.4 * s, alpha * 0.7);
  // fired cracks
  const crack = luma(pal.clay) < 0.3 ? light : dark;
  const c1 = P(at(k.hip, -hipW * 0.4, b.torso * 0.2));
  const c2 = P(at(k.hip, -hipW * 0.1, b.torso * 0.4));
  const c3 = P(at(k.hip, -hipW * 0.5, b.torso * 0.6));
  r.drawLine(c1[0], c1[1], c2[0], c2[1], crack, 1, alpha * 0.8);
  r.drawLine(c2[0], c2[1], c3[0], c3[1], crack, 1, alpha * 0.8);
  // kiln core
  const core = P(at(k.hip, shW * 0.15, b.torso * 0.55));
  const pulse = 0.75 + Math.sin((o.t || 0) * 6) * 0.25;
  r.drawCircle(core[0], core[1], 3.2 * s, INK, { alpha, segments: 12 });
  r.drawCircle(core[0], core[1], 2.4 * s, white ? '#ffffff' : pal.core, { alpha, segments: 12 });
  limb(k.legF, clay, lw);
  // head
  const hc = P(k.head);
  const hr = b.head * s;
  const fwd = (u, v) => {
    const a = k.lean * DEG;
    return [hc[0] + facing * (Math.cos(a) * u + Math.sin(a) * v) * s, hc[1] - (-Math.sin(a) * u + Math.cos(a) * v) * s];
  };
  if (b.crest === 'horns') {
    for (const side of [-1, 1]) {
      const a = fwd(side * b.head * 0.7, b.head * 0.5);
      const t = fwd(side * b.head * 1.2, b.head * 1.5);
      const c = fwd(side * b.head * 0.2, b.head * 0.8);
      r.drawTriangle(a[0], a[1], t[0], t[1], c[0], c[1], INK, alpha);
      r.drawTriangle(a[0], a[1], (t[0] + a[0]) / 2 + (t[0] - a[0]) * 0.3, (t[1] + a[1]) / 2 + (t[1] - a[1]) * 0.3, c[0], c[1], glaze, alpha);
    }
  }
  if (b.headStyle === 'block') {
    const corners = [fwd(-b.head, -b.head), fwd(b.head, -b.head), fwd(b.head, b.head * 0.9), fwd(-b.head, b.head * 0.9)];
    const oc = [fwd(-b.head - 1.3, -b.head - 1.3), fwd(b.head + 1.3, -b.head - 1.3), fwd(b.head + 1.3, b.head + 1.2), fwd(-b.head - 1.3, b.head + 1.2)];
    r.drawPolygon(oc.flat(), INK, alpha);
    r.drawPolygon(corners.flat(), clay, alpha);
  } else {
    r.drawCircle(hc[0], hc[1], hr + 1.3 * s, INK, { alpha, segments: 18 });
    r.drawCircle(hc[0], hc[1], hr, clay, { alpha, segments: 18 });
    if (b.headStyle === 'dome') {
      const j1 = fwd(-b.head * 0.9, -b.head * 0.4);
      const j2 = fwd(b.head * 0.9, -b.head * 0.4);
      r.drawLine(j1[0], j1[1], j2[0], j2[1], dark, 2 * s, alpha);
    }
    if (b.headStyle === 'vase') {
      const n1 = fwd(-b.head * 0.55, b.head * 0.95);
      const n2 = fwd(b.head * 0.55, b.head * 0.95);
      r.drawLine(n1[0], n1[1], n2[0], n2[1], INK, 4.4 * s, alpha);
      r.drawLine(n1[0], n1[1], n2[0], n2[1], glaze, 2.6 * s, alpha);
    }
  }
  if (b.crest === 'knot') {
    const t = fwd(-b.head * 0.5, b.head * 1.05);
    r.drawCircle(t[0], t[1], 3.6 * s, INK, { alpha, segments: 10 });
    r.drawCircle(t[0], t[1], 2.6 * s, dark, { alpha, segments: 10 });
  } else if (b.crest === 'plume') {
    for (let i = 0; i < 3; i++) {
      const a = fwd(-b.head * (0.2 + i * 0.35), b.head * 0.8);
      const t = fwd(-b.head * (1.2 + i * 0.4), b.head * (1.4 - i * 0.25) + Math.sin((o.t || 0) * 8 + i) * 1.5);
      r.drawLine(a[0], a[1], t[0], t[1], INK, 3.4 * s, alpha);
      r.drawLine(a[0], a[1], t[0], t[1], glaze, 1.8 * s, alpha);
    }
  } else if (b.crest === 'spout') {
    const a = fwd(b.head * 0.6, b.head * 0.1);
    const t = fwd(b.head * 1.7, b.head * 0.55);
    const c = fwd(b.head * 0.6, b.head * 0.6);
    r.drawTriangle(a[0], a[1], t[0], t[1], c[0], c[1], INK, alpha);
    r.drawTriangle(a[0], a[1] - 0.6 * s, t[0] - facing * 0.8 * s, t[1], c[0], c[1] + 0.6 * s, glaze, alpha);
  }
  // glowing eye slit
  const e1 = fwd(b.head * 0.15, b.head * 0.05);
  const e2 = fwd(b.head * 0.8, b.head * 0.05);
  r.drawLine(e1[0], e1[1], e2[0], e2[1], INK, 3 * s, alpha);
  r.drawLine(e1[0], e1[1], e2[0], e2[1], white ? '#ffffff' : pal.eye, 1.6 * s, alpha);
  limb(k.armF, clay, lw * 0.92);
  // additive glow: core, eye, and the super aura
  const glow = (o.glow ?? 0.3) * pulse;
  r.setBlend('additive');
  r.drawCircle(core[0], core[1], 7 * s, pal.core, { alpha: 0.25 * glow * alpha, segments: 14 });
  r.drawCircle((e1[0] + e2[0]) / 2, (e1[1] + e2[1]) / 2, 5 * s, pal.eye, { alpha: 0.18 * alpha, segments: 12 });
  if (o.aura > 0) {
    const ac = P(at(k.hip, 0, b.torso * 0.5));
    for (let i = 0; i < 3; i++) r.drawCircle(ac[0], ac[1], (28 + i * 10 + Math.sin((o.t || 0) * 12 + i) * 3) * s, pal.core, { alpha: 0.09 * o.aura * alpha, segments: 24 });
  }
  r.setBlend('normal');
}

function drawProjectile(r, p, pal, t) {
  const cx = p.x;
  const cy = GROUND - (p.y + p.h / 2);
  const flick = Math.sin(t * 30 + p.id) * 0.5 + 0.5;
  if (p.kind === 'beam') {
    const half = p.w / 2;
    r.setBlend('additive');
    for (let i = 0; i < 4; i++) {
      const hh = p.h / 2 - i * 4 + flick * 2;
      r.drawRect(cx - half - i * 6, cy - hh, p.w + i * 12, hh * 2, i === 3 ? '#ffffff' : pal.core, { alpha: 0.22 + i * 0.12 });
    }
    r.drawCircle(cx + sign(p.vx) * half, cy, p.h * 0.6, pal.core, { alpha: 0.5, segments: 20 });
    r.drawCircle(cx + sign(p.vx) * half, cy, p.h * 0.3, '#ffffff', { alpha: 0.8, segments: 16 });
    r.setBlend('normal');
    return;
  }
  if (p.kind === 'orb') {
    const rad = p.w / 2 + Math.sin(t * 7 + p.id) * 1.2;
    r.drawCircle(cx, cy, rad + 1.5, INK, { segments: 20 });
    r.drawCircle(cx, cy, rad, pal.glaze, { segments: 20 });
    r.drawCircle(cx - rad * 0.3, cy - rad * 0.3, rad * 0.35, '#ffffff', { alpha: 0.7, segments: 12 });
    r.setBlend('additive');
    r.drawCircle(cx, cy, rad * 1.9, pal.core, { alpha: 0.18 + flick * 0.08, segments: 22 });
    r.setBlend('normal');
    return;
  }
  // spark: a burning lump of kiln coal
  const rad = Math.max(p.w, p.h) / 2;
  r.setBlend('additive');
  r.drawCircle(cx - sign(p.vx) * 6, cy, rad * 1.1, pal.core, { alpha: 0.25, segments: 14 });
  r.drawCircle(cx, cy, rad * 1.8, pal.core, { alpha: 0.2 + flick * 0.1, segments: 18 });
  r.setBlend('normal');
  r.drawCircle(cx, cy, rad * 0.9, INK, { segments: 14 });
  r.drawCircle(cx, cy, rad * 0.7, pal.core, { segments: 14 });
  r.drawCircle(cx, cy, rad * 0.35, '#fff3c4', { segments: 10 });
}

// ---- stages: each draws in world space; a layer with parallax k is shifted by camX * (1 - k).

function skyBands(r, top, mid, bottom, horizon) {
  r.ui(() => {
    const n = 18;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const y0 = Math.floor((horizon * i) / n);
      const y1 = Math.ceil((horizon * (i + 1)) / n);
      r.drawRect(0, y0, W, y1 - y0, t < 0.6 ? mix(top, mid, t / 0.6) : mix(mid, bottom, (t - 0.6) / 0.4));
    }
    r.drawRect(0, horizon, W, H - horizon, bottom);
  });
}
function ridge(r, camX, k, seed, base, amp, color, step = 24) {
  const off = camX * (1 - k);
  const span = W + (STAGE_W - W) * k + 80;
  let px = -40;
  let py = base - hash(seed) * amp;
  for (let x = -40; x < span; x += step) {
    const nx = x + step;
    const ny = base - hash(seed + nx * 0.37) * amp - (hash(seed + nx * 0.11) > 0.8 ? amp * 0.6 : 0);
    r.drawPolygon([off + px, py, off + nx, ny, off + nx, GROUND + 4, off + px, GROUND + 4], color);
    px = nx;
    py = ny;
  }
}

const STAGES = [
  {
    id: 'kiln-town',
    name: 'KILN TOWN',
    desc: 'Dusk over the bottle kilns of the lower town.',
    thumb: ['#3a2244', '#d8703f', '#5a3a2e'],
    draw(r, camX, t) {
      skyBands(r, '#2b1b3d', '#b24f4a', '#f2a05c', 196);
      r.ui(() => {
        r.setBlend('additive');
        r.drawCircle(330 - camX * 0.04, 150, 40, '#ffcf7a', { alpha: 0.2, segments: 40 });
        r.setBlend('normal');
        r.drawCircle(330 - camX * 0.04, 150, 22, '#ffd98a', { segments: 32 });
      });
      ridge(r, camX, 0.12, 3, 150, 40, '#5b3150', 30);
      ridge(r, camX, 0.25, 9, 176, 26, '#47263f', 22);
      // the town: bottle kilns and houses
      const k = 0.5;
      const off = camX * (1 - k);
      for (let i = 0; i < 14; i++) {
        const x = off + i * 48 - 20 + hash(i) * 14;
        const base = 214;
        if (i % 3 === 1) {
          const h = 46 + hash(i + 5) * 20;
          r.drawPolygon([x - 16, base, x + 16, base, x + 7, base - h, x - 7, base - h], '#3a1f2c');
          r.drawRect(x - 4, base - h - 10, 8, 10, '#3a1f2c');
          r.drawRect(x - 3, base - 14, 6, 10, '#ff9a3c', { alpha: 0.85 });
          for (let j = 0; j < 4; j++) {
            const life = (t * 0.25 + hash(i * 7 + j)) % 1;
            r.drawCircle(x + Math.sin(life * 6 + i) * 6 * life, base - h - 12 - life * 40, 4 + life * 9, '#6b4a5a', { alpha: 0.35 * (1 - life), segments: 12 });
          }
        } else {
          const w = 30 + hash(i + 2) * 12;
          const h = 22 + hash(i + 3) * 14;
          r.drawRect(x - w / 2, base - h, w, h, '#432433');
          r.drawTriangle(x - w / 2 - 3, base - h, x + w / 2 + 3, base - h, x, base - h - 12, '#2e1824');
          if (hash(i + 9) > 0.3) r.drawRect(x - 4, base - h + 6, 6, 6, '#ffbe5c', { alpha: 0.6 + Math.sin(t * 2 + i) * 0.2 });
        }
      }
      r.drawRect(-60 + off, 212, STAGE_W + 200, 4, '#2a1620');
      // foreground: shelves of pots, lantern poles, brick floor
      for (let i = 0; i < 12; i++) {
        const x = i * 68 + 20;
        const pots = 2 + (i % 3);
        for (let j = 0; j < pots; j++) {
          const px0 = x + j * 13;
          const ph = 10 + hash(i * 3 + j) * 9;
          r.drawRect(px0, GROUND - ph - 2, 10, ph, ['#a0522d', '#7a8a8c', '#c9a46a', '#5e7b5b'][(i + j) % 4]);
          r.drawRect(px0 + 2, GROUND - ph - 5, 6, 3, INK);
        }
      }
      for (let i = 0; i < 6; i++) {
        const x = 60 + i * 130;
        r.drawRect(x - 1, GROUND - 92, 3, 92, '#2a1620');
        r.drawRect(x - 5, GROUND - 92, 11, 3, '#2a1620');
        const sway = Math.sin(t * 1.5 + i) * 2;
        r.drawRect(x + 3 + sway, GROUND - 86, 6, 9, '#ffb347');
        r.setBlend('additive');
        r.drawCircle(x + 6 + sway, GROUND - 82, 18, '#ffb347', { alpha: 0.16, segments: 18 });
        r.setBlend('normal');
      }
      r.drawRect(-40, GROUND, STAGE_W + 80, H - GROUND + 40, '#5a3a2e');
      for (let y = GROUND; y < H + 10; y += 6) {
        r.drawRect(-40, y, STAGE_W + 80, 1, '#3e271f');
        const o2 = ((y / 6) % 2) * 9;
        for (let x = -40 + o2; x < STAGE_W + 40; x += 18) r.drawRect(x, y, 1, 6, '#3e271f');
      }
      r.drawRect(-40, GROUND, STAGE_W + 80, 2, '#7a5040');
    },
  },
  {
    id: 'ash-ridge',
    name: 'ASHFALL RIDGE',
    desc: 'A stone ledge above the clouds, under falling kiln ash.',
    thumb: ['#0f1630', '#3d4f7a', '#58606e'],
    draw(r, camX, t) {
      skyBands(r, '#070b1c', '#1d2a52', '#4a5c86', 200);
      r.ui(() => {
        for (let i = 0; i < 46; i++) {
          const a = 0.4 + 0.6 * Math.abs(Math.sin(t * (0.5 + hash(i)) + i));
          r.drawRect(Math.floor(hash(i * 3) * W), Math.floor(hash(i * 5) * 140), 1, 1, '#ffffff', { alpha: a });
        }
        r.drawCircle(110 - camX * 0.03, 58, 20, '#e8ecf4', { segments: 32 });
        r.drawCircle(104 - camX * 0.03, 54, 5, '#c7cddb', { segments: 12 });
        r.setBlend('additive');
        r.drawCircle(110 - camX * 0.03, 58, 44, '#9fb4ff', { alpha: 0.12, segments: 36 });
        r.setBlend('normal');
      });
      ridge(r, camX, 0.1, 21, 150, 70, '#2c3963', 36);
      // snow caps on the far peaks
      ridge(r, camX, 0.22, 33, 182, 40, '#1c2547', 26);
      const k = 0.45;
      const off = camX * (1 - k);
      for (let i = 0; i < 18; i++) {
        const x = off + i * 40 + hash(i + 40) * 20 - 30;
        const h = 24 + hash(i + 41) * 22;
        r.drawTriangle(x - 9, 214, x + 9, 214, x, 214 - h, '#141a33');
        r.drawTriangle(x - 7, 214 - h * 0.45, x + 7, 214 - h * 0.45, x, 214 - h - 4, '#141a33');
      }
      // a distant kiln glowing on the slope
      const kx = off + 420;
      r.drawPolygon([kx - 14, 214, kx + 14, 214, kx + 6, 176, kx - 6, 176], '#10142a');
      r.setBlend('additive');
      r.drawCircle(kx, 204, 16 + Math.sin(t * 3) * 2, '#ff7a3c', { alpha: 0.35, segments: 18 });
      r.setBlend('normal');
      r.drawRect(-60 + off, 212, STAGE_W + 200, 6, '#10142a');
      // ledge
      r.drawRect(-40, GROUND - 6, STAGE_W + 80, 6, '#6c7380');
      r.drawRect(-40, GROUND, STAGE_W + 80, H - GROUND + 40, '#474d59');
      for (let i = 0; i < 40; i++) {
        const x = hash(i + 70) * STAGE_W;
        r.drawRect(x, GROUND + 4 + hash(i + 71) * 24, 10 + hash(i) * 20, 2, '#3a3f4a');
      }
      r.drawRect(-40, GROUND - 7, STAGE_W + 80, 2, '#dfe6f2');
      // falling ash (screen space so it stays dense)
      r.ui(() => {
        for (let i = 0; i < 60; i++) {
          const fall = (t * (12 + hash(i) * 14) + hash(i + 3) * H) % (H + 10);
          const x = (hash(i * 9) * W + Math.sin(t + i) * 10 - camX * 0.3 + W * 4) % W;
          r.drawRect(x, fall - 5, 2, 2, '#cfd6e6', { alpha: 0.5 });
        }
      });
    },
  },
  {
    id: 'furnace-hall',
    name: 'FURNACE HALL',
    desc: 'Under the great kiln, where every golem is first fired.',
    thumb: ['#1a0d0b', '#5a2416', '#2b1c18'],
    draw(r, camX, t) {
      skyBands(r, '#0d0706', '#24110c', '#3a1a12', 210);
      const k = 0.35;
      const off = camX * (1 - k);
      for (let y = 20; y < 214; y += 10)
        for (let x = -40 + ((y / 10) % 2) * 14; x < STAGE_W; x += 28) r.drawRect(off + x, y, 26, 8, (x + y) % 3 === 0 ? '#2e1712' : '#2a140f');
      for (let i = 0; i < 6; i++) {
        const x = off + i * 120 + 30;
        const glow = 0.55 + Math.sin(t * 2.4 + i * 1.7) * 0.2 + Math.sin(t * 7.1 + i) * 0.08;
        r.drawRect(x - 30, 110, 60, 104, '#1a0c09');
        r.drawCircle(x, 150, 24, '#1a0c09', { segments: 24 });
        r.drawRect(x - 18, 150, 36, 64, '#ff7a2a', { alpha: glow });
        r.drawCircle(x, 150, 18, '#ff9a3c', { alpha: glow, segments: 24 });
        r.setBlend('additive');
        r.drawCircle(x, 176, 50, '#ff6a1a', { alpha: 0.12 * glow, segments: 24 });
        r.setBlend('normal');
      }
      // hanging chains
      const k2 = 0.7;
      const off2 = camX * (1 - k2);
      for (let i = 0; i < 9; i++) {
        const x = off2 + i * 80 + 20;
        const sway = Math.sin(t * 0.9 + i) * 4;
        for (let j = 0; j < 9; j++) r.drawRect(x + (sway * j) / 9 - 1, j * 9, 3, 6, '#14090a');
        r.drawRect(x + sway - 5, 81, 11, 6, '#14090a');
      }
      r.drawRect(-40, GROUND, STAGE_W + 80, H - GROUND + 40, '#2b1c18');
      for (let x = -40; x < STAGE_W + 40; x += 32) r.drawRect(x, GROUND, 2, H - GROUND, '#1b110e');
      r.drawRect(-40, GROUND, STAGE_W + 80, 2, '#8a3f1e');
      r.setBlend('additive');
      for (let i = 0; i < 26; i++) {
        const life = (t * (0.18 + hash(i) * 0.2) + hash(i + 9)) % 1;
        const x = hash(i * 13) * STAGE_W + Math.sin(life * 9 + i) * 8;
        r.drawCircle(x, GROUND - life * 200, 1.4, '#ffb347', { alpha: 0.8 * (1 - life), segments: 6 });
      }
      r.setBlend('normal');
    },
  },
];

// ======================================================================= 6. platform

const SHARE_COOLDOWN = 3.2; // the engine refuses shares < 3 s apart; the parent rate-limits too
const PERIODS = [
  { id: 'day', label: 'TODAY' },
  { id: 'week', label: 'THIS WEEK' },
  { id: 'all', label: 'ALL TIME' },
];
const DUMMY_MODES = ['stand', 'crouch', 'jump', 'block', 'cpu'];
const DUMMY_LABEL = { stand: 'STAND', crouch: 'CROUCH', jump: 'JUMP', block: 'BLOCK ALL', cpu: 'CPU (NORMAL)' };
const ARCHE_LABEL = { allrounder: 'ALL-ROUNDER', grappler: 'GRAPPLER', rushdown: 'RUSHDOWN', zoner: 'ZONER' };

let DATA = null; // normalised fighters.json
const C = {
  ink: '#120b10', night: '#1c1219', ash: '#2b2026', clay: '#c8663b', ember: '#ff8a3c', gold: '#f2d27a', cream: '#f3e6d0',
  dim: '#a8968a', mute: '#6e5f58', teal: '#7ef0c8', red: '#e0483a', blue: '#7aa8ff',
};
const profile = {
  settings: { sound: true, shake: true, flash: true, level: 'normal' },
  training: { dummy: 'stand', tech: false, boxes: false, inputs: true, frames: true },
  unlocks: { alt: {} },
  wins: {},
  clears: {},
  bestArcade: 0,
  runs: 0,
  lbPeriod: 'week',
  versus: { cpu: false, level: 'normal', swap: false },
};
const unum = (v) => (fin(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Reads the save. Cloud data can arrive late (a second webgame:load is merged), so menus call this on enter. */
function loadProfile(engine) {
  const s = engine.storage;
  const st = obj(s.get('settings', null));
  for (const k of ['sound', 'shake', 'flash']) if (typeof st[k] === 'boolean') profile.settings[k] = st[k];
  if (LEVEL_IDS.includes(st.level)) profile.settings.level = st.level;
  const tr = obj(s.get('training', null));
  if (DUMMY_MODES.includes(tr.dummy)) profile.training.dummy = tr.dummy;
  for (const k of ['tech', 'boxes', 'inputs', 'frames']) if (typeof tr[k] === 'boolean') profile.training[k] = tr[k];
  const ids = DATA ? DATA.fighters.map((f) => f.id) : [];
  const un = obj(obj(s.get('unlocks', null)).alt);
  profile.unlocks.alt = {};
  for (const id of ids) if (un[id] === true) profile.unlocks.alt[id] = true;
  const wins = obj(s.get('wins', null));
  const clears = obj(s.get('clears', null));
  profile.wins = {};
  profile.clears = {};
  for (const id of ids) {
    profile.wins[id] = unum(wins[id]);
    if (LEVEL_IDS.includes(clears[id])) profile.clears[id] = clears[id];
  }
  profile.bestArcade = unum(s.get('bestArcade', 0));
  profile.runs = unum(s.get('runs', 0));
  const p = s.get('lbPeriod', 'week');
  profile.lbPeriod = PERIODS.some((x) => x.id === p) ? p : 'week';
  const vs = obj(s.get('versus', null));
  if (typeof vs.cpu === 'boolean') profile.versus.cpu = vs.cpu;
  if (typeof vs.swap === 'boolean') profile.versus.swap = vs.swap;
  if (LEVEL_IDS.includes(vs.level)) profile.versus.level = vs.level;
  engine.audio.muted = !profile.settings.sound;
}
const saveSettings = (engine) => engine.storage.set('settings', { ...profile.settings });
const saveTraining = (engine) => engine.storage.set('training', { ...profile.training });
const saveVersus = (engine) => engine.storage.set('versus', { ...profile.versus });
function toggleSound(engine) {
  profile.settings.sound = !profile.settings.sound;
  engine.audio.muted = !profile.settings.sound;
  saveSettings(engine);
  if (profile.settings.sound) sfx.blip(engine);
}
function addWin(engine, id) {
  profile.wins[id] = (profile.wins[id] || 0) + 1;
  engine.storage.set('wins', { ...profile.wins });
}
// Achievements are declared in game.json; the engine posts each id once per session.
function unlock(engine, id) {
  if (typeof engine.platform.unlockAchievement === 'function') engine.platform.unlockAchievement(id);
}

// ---- synth sound effects
const sfx = {
  blip: (e) => e.audio.tone({ freq: 660, freqEnd: 880, duration: 0.05, type: 'square', volume: 0.06 }),
  menu: (e) => e.audio.tone({ freq: 392, freqEnd: 587, duration: 0.07, type: 'triangle', volume: 0.12 }),
  back: (e) => e.audio.tone({ freq: 440, freqEnd: 300, duration: 0.08, type: 'triangle', volume: 0.1 }),
  whiff: (e, s) => e.audio.noise({ duration: s === 'H' ? 0.11 : 0.07, volume: 0.05, filterStart: 5200, filterEnd: 1600 }),
  hit: (e, s) => {
    const k = { L: 0, M: 1, H: 2, S: 3 }[s] ?? 2;
    e.audio.noise({ duration: 0.08 + k * 0.04, volume: 0.16 + k * 0.05, filterStart: 2600 - k * 400, filterEnd: 200 });
    e.audio.tone({ freq: 220 - k * 35, freqEnd: 60, duration: 0.1 + k * 0.04, type: 'square', volume: 0.07 + k * 0.02 });
  },
  block: (e) => {
    e.audio.tone({ freq: 900, freqEnd: 620, duration: 0.05, type: 'square', volume: 0.05 });
    e.audio.noise({ duration: 0.04, volume: 0.08, filterStart: 6000, filterEnd: 3000 });
  },
  proj: (e, kind) => {
    if (kind === 'beam') e.audio.tone({ freq: 160, freqEnd: 900, duration: 0.5, type: 'sawtooth', volume: 0.1, vibrato: 20, vibratoRate: 18 });
    else if (kind === 'orb') e.audio.tone({ freq: 300, freqEnd: 420, duration: 0.25, type: 'sine', volume: 0.14, vibrato: 12, vibratoRate: 9 });
    else e.audio.tone({ freq: 520, freqEnd: 260, duration: 0.18, type: 'triangle', volume: 0.12 });
  },
  special: (e) => e.audio.noise({ duration: 0.12, volume: 0.07, filterStart: 3000, filterEnd: 800 }),
  super: (e) => {
    e.audio.tone({ freq: 110, freqEnd: 880, duration: 0.6, type: 'sawtooth', volume: 0.1 });
    e.audio.tone({ freq: 220, freqEnd: 1320, duration: 0.6, type: 'triangle', volume: 0.08, attack: 0.05 });
    e.audio.noise({ duration: 0.5, volume: 0.1, filterStart: 600, filterEnd: 6000 });
  },
  grab: (e) => e.audio.tone({ freq: 180, freqEnd: 120, duration: 0.08, type: 'square', volume: 0.08 }),
  throw: (e) => {
    e.audio.noise({ duration: 0.3, volume: 0.22, filterStart: 900, filterEnd: 80 });
    e.audio.tone({ freq: 90, freqEnd: 40, duration: 0.3, type: 'sine', volume: 0.2 });
  },
  tech: (e) => {
    e.audio.tone({ freq: 1200, freqEnd: 1600, duration: 0.08, type: 'square', volume: 0.07 });
    e.audio.tone({ freq: 1800, freqEnd: 1300, duration: 0.12, type: 'triangle', volume: 0.07, attack: 0.03 });
  },
  clash: (e) => e.audio.tone({ freq: 1400, freqEnd: 1000, duration: 0.2, type: 'triangle', volume: 0.1, vibrato: 30, vibratoRate: 25 }),
  land: (e, heavy) => e.audio.noise({ duration: heavy ? 0.22 : 0.06, volume: heavy ? 0.2 : 0.05, filterStart: heavy ? 700 : 900, filterEnd: 80 }),
  dash: (e) => e.audio.noise({ duration: 0.12, volume: 0.06, filterStart: 1800, filterEnd: 500 }),
  ko: (e) => {
    e.audio.tone({ freq: 440, freqEnd: 55, duration: 1.0, type: 'sawtooth', volume: 0.14 });
    e.audio.noise({ duration: 0.8, volume: 0.25, filterStart: 3000, filterEnd: 60 });
  },
  round: (e) => {
    e.audio.tone({ freq: 392, duration: 0.14, type: 'triangle', volume: 0.14 });
    e.audio.tone({ freq: 523, duration: 0.3, type: 'triangle', volume: 0.12, attack: 0.12 });
  },
  fight: (e) => {
    for (const f of [262, 330, 392, 523]) e.audio.tone({ freq: f, duration: 0.35, type: 'square', volume: 0.05 });
    e.audio.noise({ duration: 0.25, volume: 0.1, filterStart: 4000, filterEnd: 400 });
  },
  perfect: (e) => [523, 659, 784, 1046].forEach((f, i) => e.audio.tone({ freq: f, duration: 0.12 + i * 0.05, type: 'triangle', volume: 0.1, attack: i * 0.06 })),
  time: (e) => e.audio.tone({ freq: 660, freqEnd: 330, duration: 0.5, type: 'square', volume: 0.08 }),
};

// ---- binding labels (F009). Bindings come from input.actions, so player remaps show up live.
function padLabel(engine, name) {
  return typeof engine.input.gamepadLabel === 'function' ? engine.input.gamepadLabel(name) : name;
}
function actionOf(engine, id) {
  return engine.input.actions.find((a) => a.id === id) || null;
}
function anyPad(engine) {
  for (let i = 0; i < 4; i++) {
    const p = engine.input.gamepad(i);
    if (p && p.connected) return true;
  }
  return false;
}
/** Short label: the gamepad button when a pad is connected (and `padOk`), else the first key. */
function hintLabel(engine, id, padId = id, padOk = true) {
  const a = actionOf(engine, id);
  const pa = actionOf(engine, padId);
  if (padOk && anyPad(engine) && pa && pa.gamepad[0]) return padLabel(engine, pa.gamepad[0]);
  if (a && a.keys[0]) return engine.input.keyLabel(a.keys[0]);
  if (pa && pa.gamepad[0]) return padLabel(engine, pa.gamepad[0]);
  return '-';
}
/** Button labels for one player: { L, M, H, T, dir } (P2 shows keyboard keys, and its pad uses P1's layout). */
function playerLabels(engine, side) {
  const ids = side === 1 ? P2_IDS : P1_IDS;
  const L = (k) => hintLabel(engine, ids[k], P1_IDS[k], side === 0);
  return { L: L('light'), M: L('medium'), H: L('heavy'), T: L('throw'), dir: ['up', 'left', 'down', 'right'].map((k) => L(k)).join('') };
}
function keyList(engine, a, max = 3) {
  return a.keys.length ? a.keys.slice(0, max).map((k) => engine.input.keyLabel(k)).join(' / ') : '(none)';
}
function padList(engine, a) {
  return a.gamepad.length ? a.gamepad.map((b) => padLabel(engine, b)).join(' / ') : '-';
}

// ---- text helpers
const TEXT_SMALL = { font: 'pixel', size: 8, color: C.cream, shadow: C.ink };
/** Bindings contain arrows and other non-ASCII labels, so they use the canvas font, which has every glyph. */
function hintText(r, text, x, y, opts = {}) {
  r.drawText(text, x, y, { font: 'default', size: 10, color: '#e6d6c4', baseline: 'middle', ...opts });
}
function title(r, text, x, y, size, color, alpha = 1) {
  r.drawText(text, x, y, { font: 'kiln', size, align: 'center', baseline: 'middle', color, alpha });
}
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

/** F005 share state machine: no widgets on the captured frame, a cooldown, and a result message. */
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
  get capturing() {
    return this.state === 'hide' || this.state === 'shoot';
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
      this.restoreFocus = 'share';
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
        this.msg = ok ? 'Added to your screenshot tray.' : 'Could not share right now. Try again in a moment.';
      })
      .catch(() => (this.msg = 'Could not share right now. Try again in a moment.'))
      .finally(() => {
        this.state = 'idle';
        sfx.blip(engine);
      });
  }
}

// ======================================================================= 7. scenes

const SPARK = {
  L: ['#ffffff', '#ffe9b0'], M: ['#ffffff', '#ffd27a', '#ffb347'], H: ['#ffffff', '#ffb347', '#ff7a2a'], S: ['#ffffff', '#ffe08a', '#ff5a3c', '#7ef0c8'],
};
const BLOCK_SPARK = ['#ffffff', '#bfe6ff', '#7aa8ff'];

/** The fight view: stage, golems, projectiles, particles, HUD, banners and the event -> juice mapping. */
class Arena {
  constructor(engine, bout, stage, opts = {}) {
    this.bout = bout;
    this.stage = stage;
    this.hud = opts.hud !== false;
    this.quiet = !!opts.quiet;
    this.names = opts.names || ['P1', 'P2'];
    this.sparks = new engine.ParticleEmitter({ life: [0.1, 0.32], speed: [80, 260], size: [2, 4], sizeEnd: 0, color: SPARK.M, drag: 3, blend: 'additive', maxParticles: 500 });
    this.chips = new engine.ParticleEmitter({ life: [0.35, 0.8], speed: [60, 180], size: [2, 3], sizeEnd: 1, color: ['#8a5a44'], gravityY: 420, drag: 0.8, spin: [-8, 8], maxParticles: 300 });
    this.dust = new engine.ParticleEmitter({ life: [0.3, 0.7], speed: [10, 50], angle: [Math.PI * 1.05, Math.PI * 1.95], size: [3, 5], sizeEnd: 9, color: ['#9a8478', '#7d6a60'], drag: 2, gravityY: -15, shape: 'circle', maxParticles: 200 });
    this.embers = new engine.ParticleEmitter({ life: [0.25, 0.7], speed: [20, 90], size: [1.5, 3], sizeEnd: 0, color: ['#ffb347', '#ff7a2a'], drag: 1.5, gravityY: -60, blend: 'additive', maxParticles: 300 });
    this.banner = { text: '', sub: '', a: 0, s: 1, color: C.gold };
    this.flash = { a: 0 };
    this.zoom = { z: 0 };
    this.combo = [null, null];
    this.superName = null;
    this.popups = [];
    this.t = 0;
    this.lastHit = -1;
  }
  showBanner(engine, text, sub = '', color = C.gold, hold = 0.9) {
    if (this.quiet) return;
    const b = this.banner;
    engine.tweens.killTweensOf(b);
    Object.assign(b, { text, sub, color, a: 0, s: 1.8 });
    engine.tweens.to(b, { a: 1, s: 1 }, 0.22, { ease: 'backOut' });
    engine.tweens.to(b, { a: 0 }, 0.3, { delay: 0.22 + hold, ease: 'quadIn' });
  }
  shake(engine, i, d) {
    if (profile.settings.shake && !this.quiet) engine.camera.shake(i, d);
  }
  play(engine, fn, ...args) {
    if (!this.quiet) fn(engine, ...args);
  }
  handle(engine, events) {
    const sim = this.bout.sim;
    for (const e of events) {
      switch (e.type) {
        case 'hit': {
          const x = e.x;
          const y = GROUND - e.y;
          const n = { L: 8, M: 12, H: 18, S: 20 }[e.strength] || 12;
          this.sparks.config.color = SPARK[e.strength] || SPARK.M;
          this.sparks.burst(n, x, y);
          const d = sim.f[1 - e.who];
          this.chips.config.color = [d.palette.clay, d.palette.dark, d.palette.light];
          this.chips.burst(e.strength === 'H' || e.strength === 'S' ? 6 : 2, x, y);
          this.play(engine, sfx.hit, e.strength);
          if (e.strength === 'H' || e.ko) this.shake(engine, e.ko ? 6 : 3, e.ko ? 0.5 : 0.18);
          else if (e.super) this.shake(engine, 2, 0.1);
          this.combo[e.who] = { hits: e.combo, dmg: d.comboDmg, t: 0, scale: e.scale };
          this.lastHit = 1 - e.who;
          if (e.ko) {
            this.flash.a = profile.settings.flash ? 0.8 : 0.35;
            engine.tweens.to(this.flash, { a: 0 }, 0.6);
          }
          break;
        }
        case 'block':
          this.sparks.config.color = BLOCK_SPARK;
          this.sparks.burst(6, e.x, GROUND - e.y);
          this.play(engine, sfx.block);
          if (e.chip > 0) this.popup(e.who === 0 ? sim.f[1] : sim.f[0], 'CHIP', '#bfe6ff');
          break;
        case 'move':
          if (e.kind === 'normal') this.play(engine, sfx.whiff, e.btn);
          else if (e.kind === 'special') this.play(engine, sfx.special);
          break;
        case 'proj':
          this.play(engine, sfx.proj, e.kind);
          break;
        case 'super': {
          this.play(engine, sfx.super);
          this.flash.a = profile.settings.flash ? 0.9 : 0.3;
          engine.tweens.killTweensOf(this.flash);
          engine.tweens.to(this.flash, { a: 0 }, 0.35);
          engine.tweens.killTweensOf(this.zoom);
          this.zoom.z = 0;
          engine.tweens.to(this.zoom, { z: 1 }, 0.18, { ease: 'quadOut' });
          engine.tweens.to(this.zoom, { z: 0 }, 0.3, { delay: Math.max(0.2, e.freeze / 60 - 0.2), ease: 'quadIn' });
          this.shake(engine, 3, 0.3);
          const f = sim.f[e.who];
          this.embers.config.color = [f.palette.core, '#ffffff', f.palette.glaze];
          this.embers.burst(36, f.x, GROUND - f.y - 34);
          this.superName = { text: e.name.toUpperCase(), who: e.who, t: 0 };
          break;
        }
        case 'grab':
          this.play(engine, sfx.grab);
          break;
        case 'throw':
          this.play(engine, sfx.throw);
          this.dust.burst(12, e.x, GROUND - 2);
          this.shake(engine, e.super ? 6 : 3, e.super ? 0.45 : 0.2);
          if (e.super) {
            this.flash.a = profile.settings.flash ? 0.6 : 0.25;
            engine.tweens.to(this.flash, { a: 0 }, 0.4);
          }
          break;
        case 'tech':
          this.play(engine, sfx.tech);
          this.sparks.config.color = BLOCK_SPARK;
          this.sparks.burst(14, e.x, GROUND - e.y);
          this.popups.push({ text: 'TECH!', x: e.x, y: GROUND - 84, t: 0, color: '#bfe6ff' });
          break;
        case 'clash':
          this.play(engine, sfx.clash);
          this.sparks.config.color = SPARK.S;
          this.sparks.burst(16, e.x, GROUND - e.y);
          break;
        case 'fizzle':
          this.embers.burst(8, e.x, GROUND - e.y);
          break;
        case 'land':
          this.dust.burst(e.heavy ? 14 : 5, e.x, GROUND - 2);
          this.play(engine, sfx.land, e.heavy);
          if (e.heavy) this.shake(engine, 2, 0.15);
          break;
        case 'dash':
        case 'jump':
          this.dust.burst(4, e.x, GROUND - 2);
          if (e.type === 'dash') this.play(engine, sfx.dash);
          break;
        case 'roundStart':
          if (this.bout.training) break;
          this.showBanner(engine, e.final ? 'FINAL ROUND' : `ROUND ${e.round}`, '', C.gold, 0.7);
          this.play(engine, sfx.round);
          break;
        case 'fightStart':
          this.showBanner(engine, 'FIRE!', '', C.ember, 0.35);
          this.play(engine, sfx.fight);
          break;
        case 'ko':
          this.play(engine, sfx.ko);
          break;
        case 'roundEnd': {
          let text = 'SHATTERED!';
          let sub = '';
          if (e.reason === 'double') text = 'DOUBLE SHATTER';
          else if (e.reason === 'time') {
            text = 'TIME';
            sub = e.winner < 0 ? 'DRAW' : `${this.names[e.winner]} LEADS ON HEALTH`;
            this.play(engine, sfx.time);
          }
          if (e.perfect) {
            sub = 'PERFECT';
            engine.after(0.9, () => this.play(engine, sfx.perfect));
          }
          this.showBanner(engine, text, sub, e.reason === 'time' ? C.cream : C.ember, 1.4);
          break;
        }
        case 'matchEnd':
          this.showBanner(engine, e.winner < 0 ? 'DRAW GAME' : `${this.names[e.winner]} WINS`, '', C.gold, 2.5);
          break;
        case 'comboEnd':
          if (this.combo[e.who]) this.combo[e.who].ended = true;
          break;
        default:
          break;
      }
    }
  }
  popup(f, text, color) {
    this.popups.push({ text, x: f.x, y: GROUND - f.y - 86, t: 0, color });
  }
  update(dt) {
    this.t += dt;
    this.sparks.update(dt);
    this.chips.update(dt);
    this.dust.update(dt);
    this.embers.update(dt);
    for (const c of this.combo) if (c && c.ended) c.t += dt;
    if (this.superName) this.superName.t += dt;
    for (const p of this.popups) p.t += dt;
    this.popups = this.popups.filter((p) => p.t < 0.9);
  }
  render(engine, extra) {
    const r = engine.renderer;
    const cam = engine.camera;
    const sim = this.bout.sim;
    cam.bounds = null;
    cam.x = sim.camX;
    cam.y = 0;
    cam.zoom = 1 + this.zoom.z * 0.14;
    this.stage.draw(r, sim.camX, this.t);
    if (sim.freezeT > 0) r.ui(() => r.drawRect(0, 0, W, H, '#000000', { alpha: 0.5 }));
    const order = sim.f.slice().sort((a, b) => (a.state === 'move' ? 1 : 0) - (b.state === 'move' ? 1 : 0) || (a.side === this.lastHit ? -1 : 1));
    for (const f of order) {
      const jitter = sim.hitstop > 0 && f.flash > 0 ? (sim.frame % 2 ? 1.5 : -1.5) : 0;
      const sup = f.state === 'move' && f.move.def.type === 'super';
      drawGolem(r, f.def, f.palette, f.pose, f.x + jitter, GROUND - f.y, f.facing, 1, {
        flash: f.flash > 2 ? 1 : 0, t: this.t + f.side, glow: 0.3 + (f.meter / sim.rules.meterMax) * 0.7, aura: sup || (sim.freezeT > 0 && sim.freezeBy === f.side) ? 1 : !this.bout.training && f.meter >= sim.rules.meterMax ? 0.3 : 0,
      });
    }
    for (const p of sim.projs) drawProjectile(r, p, sim.f[p.owner].palette, this.t);
    this.dust.draw(r);
    this.chips.draw(r);
    this.sparks.draw(r);
    this.embers.draw(r);
    if (extra && extra.world) extra.world(r);
    r.ui(() => {
      if (this.flash.a > 0.01) r.drawRect(0, 0, W, H, '#fff4e0', { alpha: this.flash.a });
      for (const p of this.popups) r.drawText(p.text, p.x - sim.camX, p.y - p.t * 20, { ...TEXT_SMALL, align: 'center', color: p.color, alpha: 1 - p.t / 0.9 });
      if (this.hud) this.drawHud(engine, r);
      if (extra && extra.screen) extra.screen(r);
      const b = this.banner;
      if (b.a > 0.01 && b.text) {
        r.drawRect(0, H / 2 - 30, W, 52, '#000000', { alpha: 0.45 * b.a });
        title(r, b.text, W / 2, H / 2 - 6, Math.round(40 * b.s), b.color, b.a);
        if (b.sub) r.drawText(b.sub, W / 2, H / 2 + 16, { font: 'kiln', size: 20, align: 'center', baseline: 'middle', color: C.cream, alpha: b.a });
      }
    });
  }
  drawHud(engine, r) {
    const bout = this.bout;
    const sim = bout.sim;
    const [a, b] = sim.f;
    const bw = 186;
    const bar = (f, x, right) => {
      const y = 12;
      r.drawRect(x - 2, y - 2, bw + 4, 14, C.ink);
      r.drawRect(x, y, bw, 10, '#3b1b1b');
      const ratio = clamp(f.hp / f.def.health, 0, 1);
      const lag = clamp(f.hpLag / f.def.health, 0, 1);
      const col = ratio > 0.5 ? '#f2c14e' : ratio > 0.25 ? '#ff8a3c' : '#e0483a';
      const seg = (v, color, top) => {
        const w = Math.round(bw * v);
        const sx = right ? x : x + bw - w;
        r.drawRect(sx, y, w, 10, color);
        if (top) r.drawRect(sx, y, w, 3, top, { alpha: 0.5 });
      };
      seg(lag, '#ffe7c4');
      seg(ratio, col, '#ffffff');
      r.strokeRect(x - 2, y - 2, bw + 4, 14, f.palette.glaze, 1, 0.7);
    };
    bar(a, 22, false);
    bar(b, W - 22 - bw, true);
    r.drawText(`${a.def.name}  ${this.names[0]}`, 22, 28, { ...TEXT_SMALL });
    r.drawText(`${this.names[1]}  ${b.def.name}`, W - 22, 28, { ...TEXT_SMALL, align: 'right' });
    if (!bout.training) {
      for (let i = 0; i < bout.rules.roundsToWin; i++) {
        r.drawCircle(W / 2 - 34 - i * 10, 34, 3.5, i < bout.wins[0] ? C.ember : '#3b2a2a', { segments: 10 });
        r.drawCircle(W / 2 + 34 + i * 10, 34, 3.5, i < bout.wins[1] ? C.ember : '#3b2a2a', { segments: 10 });
      }
    }
    r.drawRect(W / 2 - 18, 6, 36, 26, C.ink);
    r.strokeRect(W / 2 - 18, 6, 36, 26, C.clay, 1, 0.8);
    const tl = bout.timeLeft;
    title(r, bout.training ? '--' : String(tl).padStart(2, '0'), W / 2, 19, 20, !bout.training && tl <= 10 ? C.red : C.cream);
    const meter = (f, x, right) => {
      const y = H - 14;
      const full = f.meter >= sim.rules.meterMax;
      r.drawRect(x - 1, y - 1, 112, 8, C.ink);
      const w = Math.round((110 * f.meter) / sim.rules.meterMax);
      r.drawRect(right ? x + 110 - w : x, y, w, 6, full ? (Math.floor(this.t * 8) % 2 ? '#ffffff' : f.palette.core) : f.palette.core);
      r.drawText(full ? 'KILN READY' : 'KILN', right ? x - 4 : x + 114, y - 1, { ...TEXT_SMALL, align: right ? 'right' : 'left', color: full ? C.gold : C.dim });
    };
    meter(a, 14, false);
    meter(b, W - 124, true);
    for (const side of [0, 1]) {
      const c = this.combo[side];
      if (!c || c.hits < 2 || c.t > 1.1) continue;
      const al = clamp(1.2 - c.t, 0, 1);
      const x = side === 0 ? 18 : W - 18;
      r.drawText(`${c.hits} HITS`, x, 62, { font: 'kiln', size: 20, align: side === 0 ? 'left' : 'right', color: C.gold, alpha: al });
      r.drawText(`${c.dmg} DMG`, x, 80, { ...TEXT_SMALL, align: side === 0 ? 'left' : 'right', alpha: al });
    }
    const sn = this.superName;
    if (sn && sn.t < 1.3) {
      const al = clamp(1.3 - sn.t, 0, 1);
      r.drawText(sn.text, sn.who === 0 ? 18 : W - 18, 44, { font: 'kiln', size: 20, align: sn.who === 0 ? 'left' : 'right', color: sim.f[sn.who].palette.core, alpha: al });
    }
  }
}

function sideName(spec, i) {
  if (spec.ctrl === 'cpu') return 'CPU';
  if (spec.ctrl === 'dummy') return 'DUMMY';
  return i === 0 ? 'P1' : 'P2';
}
function makeController(spec, side, opts, seed) {
  if (spec.ctrl === 'human1') return opts.twoP ? new HumanController(P1_IDS, opts.swap ? 1 : 0, P1_IDS, Object.values(P2_IDS)) : new HumanController(P1_IDS, -1, P1_IDS, []);
  if (spec.ctrl === 'human2') return new HumanController(P2_IDS, opts.swap ? 0 : 1, P1_IDS, []);
  if (spec.ctrl === 'dummy') return new DummyController(profile.training);
  return new CpuController(spec.level || 'normal', seed + side * 7919);
}
/** Arcade ladder: the other fighters in a fixed order, then a mirror match against a glazed double. */
function newRun(fi, alt, level) {
  const n = DATA.fighters.length;
  const ladder = [];
  for (let k = 1; k < n && ladder.length < 3; k++) ladder.push({ fi: (fi + k) % n, alt: false, level, stage: ladder.length % STAGES.length });
  const boss = LEVEL_IDS[Math.min(LEVEL_IDS.length - 1, LEVEL_IDS.indexOf(level) + 1)];
  ladder.push({ fi, alt: !alt, level: boss, stage: STAGES.length - 1, boss: true });
  return { fi, alt, level, ladder, index: 0, score: 0, tally: { damage: 0, combos: 0, time: 0, perfects: 0, rounds: 0, wins: 0 }, matches: [], submitted: false, cleared: false, ended: false };
}

class FightScene {
  /** opts: { mode: arcade | versus | training, sides: [{ fi, alt, ctrl: human1 | human2 | cpu | dummy, level }], stage, run, twoP, swap } */
  constructor(opts) {
    this.opts = opts;
    this.mode = opts.mode;
  }
  enter(engine) {
    const o = this.opts;
    const defs = o.sides.map((s) => DATA.fighters[s.fi]);
    const alts = o.sides.map((s) => !!s.alt);
    if (o.sides[0].fi === o.sides[1].fi && alts[0] === alts[1]) alts[1] = !alts[1];
    this.bout = new Bout(DATA, { mode: o.mode, defs, alt: alts });
    this.seed = (engine.frame * 2654435761) >>> 0 || 1;
    this.ctrl = o.sides.map((s, i) => makeController(s, i, o, this.seed));
    this.names = o.sides.map(sideName);
    this.stage = STAGES[o.stage] || STAGES[0];
    this.arena = new Arena(engine, this.bout, this.stage, { names: this.names });
    this.endT = 0;
    this.comboBonus = 0;
    this.inputs = [];
    this.lastMove = null;
    this.prevPad = false;
    engine.camera.zoom = 1;
  }
  isHuman(side) {
    const c = this.opts.sides[side].ctrl;
    return c === 'human1' || c === 'human2';
  }
  pausePressed(engine) {
    if (engine.input.actionPressed('pause')) return true;
    if (this.opts.twoP) {
      const p = engine.input.gamepad(this.opts.swap ? 0 : 1);
      if (p && p.connected && p.wasPressed('Start')) return true;
    }
    return engine.ui.button('hud-pause', 'II', W / 2 - 8, 36, 16, 12, { nav: false });
  }
  update(engine, dt) {
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    if (!this.bout.over && this.pausePressed(engine)) {
      engine.scenes.push(new PauseScene(this));
      return;
    }
    const raw = this.ctrl.map((c, i) => (c.human ? c.read(engine) : c.read(this.bout, i)));
    if (this.mode === 'training') this.recordInput(raw[0]);
    const events = this.bout.step(raw);
    this.onEvents(engine, events);
    this.arena.handle(engine, events);
    this.arena.update(dt);
    if (this.bout.over) {
      this.endT++;
      if (this.endT === 150) this.finish(engine);
    }
  }
  recordInput(inp) {
    const h = this.inputs;
    const top = h[0];
    if (top && top.dir === inp.dir && top.held === inp.held && !inp.press) top.n++;
    else h.unshift({ dir: inp.dir, held: inp.held | inp.press, n: 1 });
    if (h.length > 14) h.length = 14;
  }
  onEvents(engine, events) {
    for (const e of events) {
      if (e.type === 'move' && e.who === 0) this.lastMove = { name: e.name, startup: e.startup, kind: e.kind };
      if (this.mode === 'training') {
        if ((e.type === 'hit' && e.super) || (e.type === 'throw' && e.super)) if (this.isHuman(e.who)) unlock(engine, 'kiln_burst');
        if (e.type === 'hit' && e.combo >= 10 && this.isHuman(e.who)) unlock(engine, 'ten_hit');
        if (e.type === 'tech' && e.who >= 0 && this.isHuman(e.who)) unlock(engine, 'clean_break');
        continue;
      }
      if (e.type === 'hit') {
        if (e.super && this.isHuman(e.who)) unlock(engine, 'kiln_burst');
        if (e.combo >= 10 && this.isHuman(e.who)) unlock(engine, 'ten_hit');
      }
      if (e.type === 'throw' && e.super && this.isHuman(e.who)) unlock(engine, 'kiln_burst');
      if (e.type === 'tech' && e.who >= 0 && this.isHuman(e.who)) unlock(engine, 'clean_break');
      if (e.type === 'roundEnd' && e.perfect && e.winner >= 0 && this.isHuman(e.winner)) unlock(engine, 'perfect_firing');
      if (e.type === 'comboEnd' && e.who === 0 && e.hits >= 3) this.comboBonus += e.hits * e.hits * 10;
    }
  }
  /** Score of this match for P1 (arcade): damage, combos, time, perfects, rounds, win; times the level multiplier. */
  tally() {
    const b = this.bout;
    const t = { damage: 0, combos: this.comboBonus, time: 0, perfects: 0, rounds: 0, wins: b.winner === 0 ? 1000 : 0 };
    for (const r of b.results) {
      t.damage += r.stats[0].damage;
      if (r.winner === 0) {
        t.time += r.timeLeft * 20;
        t.rounds += 500;
        if (r.perfect) t.perfects += 1500;
      }
    }
    const mult = AI_LEVELS[this.opts.sides[1].level || 'normal'].mult;
    const raw = t.damage + t.combos + t.time + t.perfects + t.rounds + t.wins;
    return { ...t, mult, score: Math.round(raw * mult) };
  }
  finish(engine) {
    const b = this.bout;
    if (b.winner >= 0 && this.isHuman(b.winner)) addWin(engine, DATA.fighters[this.opts.sides[b.winner].fi].id);
    let tally = null;
    if (this.mode === 'arcade') {
      const run = this.opts.run;
      tally = this.tally();
      run.score += tally.score;
      for (const k of Object.keys(run.tally)) run.tally[k] += tally[k] || 0;
      run.matches.push({ fi: this.opts.sides[1].fi, won: b.winner === 0, score: tally.score });
    }
    engine.scenes.push(new MatchResultScene(this, tally));
  }
  render(engine) {
    const train = this.mode === 'training';
    const T = profile.training;
    this.arena.render(engine, {
      world: train && T.boxes ? (r) => this.drawBoxes(r) : null,
      screen: (r) => {
        if (train) this.drawTraining(engine, r);
        else hintText(r, `${hintLabel(engine, 'pause')} pause / moves`, W / 2, H - 10, { align: 'center', color: C.mute, size: 9 });
      },
    });
  }
  drawBoxes(r) {
    const sim = this.bout.sim;
    const rect = (b, color, fill) => {
      const y = GROUND - (b.y + b.h);
      if (fill) r.drawRect(b.x, y, b.w, b.h, color, { alpha: 0.3 });
      r.strokeRect(b.x, y, b.w, b.h, color, 1, 0.9);
    };
    for (const f of sim.f) {
      for (const b of sim.hurtboxes(f)) rect(b, '#5ab0ff', false);
      for (const b of sim.hitboxes(f)) rect(b, '#ff4040', true);
      if (f.state === 'move' && f.move.def.grab && f.move.f >= f.move.def.grab.at && f.move.f < f.move.def.grab.until) {
        const g = f.move.def.grab;
        rect({ x: f.facing > 0 ? f.x + f.def.push : f.x - f.def.push - g.range, y: 0, w: g.range, h: 50 }, '#ffd040', true);
      }
      r.drawLine(f.x - f.def.push, GROUND - 1, f.x + f.def.push, GROUND - 1, '#60ff80', 2);
    }
    for (const p of sim.projs) rect({ x: p.x - p.w / 2, y: p.y, w: p.w, h: p.h }, '#ff4040', true);
  }
  drawTraining(engine, r) {
    const T = profile.training;
    const sim = this.bout.sim;
    if (T.inputs) {
      r.drawRect(6, 92, 54, 14 * this.inputs.length + 4, '#000000', { alpha: 0.35 });
      this.inputs.forEach((e, i) => {
        const y = 100 + i * 14;
        hintText(r, e.dir === 5 ? '\u2022' : ARROW[e.dir], 12, y, { color: '#ffffff', size: 11 });
        const btn = ['L', 'M', 'H', 'T'].filter((k) => e.held & BTN[k]).join('');
        r.drawText(btn, 24, y - 4, { ...TEXT_SMALL, color: C.gold });
        r.drawText(String(Math.min(99, e.n)), 56, y - 4, { ...TEXT_SMALL, align: 'right', color: C.dim });
      });
    }
    if (T.frames) {
      const x = W - 8;
      let y = 92;
      const line = (s, color = C.cream) => {
        r.drawText(s, x, y, { ...TEXT_SMALL, align: 'right', color });
        y += 11;
      };
      r.drawRect(W - 196, 86, 192, 50, '#000000', { alpha: 0.35 });
      const lm = this.lastMove;
      line(lm ? `${lm.name.toUpperCase()}  STARTUP ${lm.startup}F` : 'DO A MOVE FOR FRAME DATA', C.gold);
      const adv = sim.lastAdv;
      if (adv && adv.who === 0) line(`${adv.kind === 'hit' ? 'ON HIT' : 'ON BLOCK'} ${adv.kd ? 'KNOCKDOWN' : (adv.adv > 0 ? '+' : '') + adv.adv}`, adv.adv >= 0 || adv.kd ? C.teal : C.red);
      else line('ADVANTAGE: -', C.dim);
      const d = sim.f[1];
      const c = this.arena.combo[0];
      line(c ? `COMBO ${c.hits} HITS  ${c.dmg} DMG  x${(c.scale ?? 1).toFixed(2)}` : 'COMBO -', C.cream);
      line(`DUMMY ${DUMMY_LABEL[T.dummy]}${T.tech ? '  TECHS THROWS' : ''}  HP ${d.hp}`, C.dim);
    }
    const L = playerLabels(engine, 0);
    hintText(r, `${L.dir} move   ${L.L} light  ${L.M} medium  ${L.H} heavy  ${L.T} throw   ${hintLabel(engine, 'pause')} pause / training options`, W / 2, H - 26, { align: 'center', size: 9, color: '#e6d6c4' });
  }
}

class PauseScene {
  constructor(fight) {
    this.overlay = true;
    this.fight = fight;
  }
  enter(engine) {
    this.focused = false;
    sfx.back(engine);
  }
  resume() {
    this.focused = false;
  }
  update(engine) {
    const ui = engine.ui;
    const fight = this.fight;
    focusOnce(this, engine, 'resume');
    const x = 22;
    let y = 46;
    const btn = (id, label) => {
      const hit = ui.button(id, label, x, y, 130, 18);
      y += 22;
      return hit;
    };
    if (btn('resume', 'RESUME') || engine.input.actionPressed('pause') || engine.input.actionPressed('back')) {
      sfx.menu(engine);
      engine.scenes.pop();
      return;
    }
    if (btn('moves', 'MOVE LIST')) {
      sfx.menu(engine);
      engine.scenes.push(new MoveListScene(fight.opts.sides.map((s) => s.fi), 0, fight.opts.twoP));
    }
    if (fight.mode === 'training') {
      if (btn('training', 'TRAINING OPTIONS')) {
        sfx.menu(engine);
        engine.scenes.push(new TrainingMenuScene(fight));
      }
      if (btn('reset', 'RESET POSITIONS')) {
        sfx.menu(engine);
        resetTraining(fight);
        engine.scenes.pop();
        return;
      }
    }
    if (btn('settings', 'SETTINGS')) {
      sfx.menu(engine);
      engine.scenes.push(new SettingsScene());
    }
    if (fight.mode === 'versus' && btn('rematch', 'RESTART MATCH')) {
      sfx.menu(engine);
      engine.scenes.clear();
      engine.scenes.push(new FightScene(fight.opts));
      return;
    }
    if (fight.mode === 'arcade') {
      if (btn('forfeit', 'FORFEIT RUN')) {
        sfx.menu(engine);
        engine.scenes.clear();
        engine.scenes.push(new ArcadeResultsScene(fight.opts.run));
      }
    } else if (btn('quit', 'QUIT TO TITLE')) {
      sfx.menu(engine);
      engine.scenes.clear();
      engine.scenes.push(new TitleScene());
    }
    if (engine.input.actionPressed('mute')) toggleSound(engine);
  }
  render(engine) {
    const r = engine.renderer;
    const fight = this.fight;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.7 });
      engine.ui.panel(10, 10, W - 20, H - 20);
      title(r, 'PAUSED', 87, 30, 20, C.gold);
      // Live bindings (defaults + the player's remaps), straight from input.actions.
      const x0 = 168;
      const twoP = fight.opts.twoP;
      r.drawText('ACTION', x0, 22, { ...TEXT_SMALL, color: C.gold });
      r.drawText(twoP ? 'P1 KEYS' : 'KEYS', x0 + 84, 22, { ...TEXT_SMALL, color: C.dim });
      r.drawText('GAMEPAD', x0 + 168, 22, { ...TEXT_SMALL, color: C.dim });
      if (twoP) r.drawText('P2 KEYS', x0 + 236, 22, { ...TEXT_SMALL, color: C.dim });
      let y = 40;
      for (const a of engine.input.actions) {
        if (a.id.startsWith('p2-')) continue;
        hintText(r, a.name, x0, y, { size: 9 });
        hintText(r, keyList(engine, a, 2), x0 + 84, y, { color: '#ffffff', size: 9 });
        hintText(r, padList(engine, a), x0 + 168, y, { color: '#ffffff', size: 9 });
        if (twoP) {
          const p2 = actionOf(engine, 'p2-' + a.id);
          if (p2) hintText(r, keyList(engine, p2, 2), x0 + 236, y, { color: '#ffffff', size: 9 });
        }
        y += 13;
      }
      if (twoP) hintText(r, `P2 gamepad: pad ${fight.opts.swap ? 1 : 2}, same buttons. P1 gamepad: pad ${fight.opts.swap ? 2 : 1}.`, x0, y + 4, { color: C.dim, size: 9 });
      hintText(r, 'Remap keys with the controls button in the player bar.', x0, H - 24, { color: C.dim, size: 9 });
      const names = fight.opts.sides.map((s) => DATA.fighters[s.fi].name);
      r.drawText(`${names[0]} VS ${names[1]}`, 87, H - 40, { ...TEXT_SMALL, align: 'center', color: C.cream });
      r.drawText(fight.mode.toUpperCase() + (fight.mode === 'arcade' ? `  ${fight.opts.run.score} PTS` : ''), 87, H - 28, { ...TEXT_SMALL, align: 'center', color: C.dim });
    });
  }
}

function resetTraining(fight) {
  const sim = fight.bout.sim;
  const keep = sim.f.map((f) => f.meter);
  sim.resetPositions();
  sim.f.forEach((f, i) => (f.meter = keep[i]));
  fight.arena.combo = [null, null];
  fight.inputs.length = 0;
}

/** Move list with motions (facing right) next to the player's live button labels. */
class MoveListScene {
  constructor(fis, side, twoP) {
    this.overlay = true;
    this.fis = fis;
    this.side = side;
    this.twoP = !!twoP;
  }
  enter() {
    this.focused = false;
  }
  update(engine) {
    const ui = engine.ui;
    focusOnce(this, engine, 'ml-back');
    if (ui.button('ml-back', 'BACK', W - 112, H - 34, 90, 18) || engine.input.actionPressed('back') || engine.input.actionPressed('pause')) {
      sfx.back(engine);
      engine.scenes.pop();
      return;
    }
    if (this.fis.length > 1 && ui.button('ml-side', this.side === 0 ? 'SHOW P2 / CPU' : 'SHOW P1', W - 228, H - 34, 110, 18)) {
      sfx.menu(engine);
      this.side = 1 - this.side;
    }
  }
  render(engine) {
    const r = engine.renderer;
    const def = DATA.fighters[this.fis[this.side]];
    const lab = playerLabels(engine, this.side === 1 && this.twoP ? 1 : 0);
    const any = `${lab.L}/${lab.M}/${lab.H}`;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.82 });
      engine.ui.panel(10, 8, W - 20, H - 16);
      title(r, `${def.name} MOVE LIST`, W / 2, 24, 20, C.gold);
      r.drawText(`${ARCHE_LABEL[def.archetype]} - motions shown facing right; they mirror when facing left`, W / 2, 40, { ...TEXT_SMALL, align: 'center', color: C.dim });
      let y = 54;
      const row = (name, motion, extra = '', color = '#ffffff') => {
        r.drawText(name.toUpperCase(), 24, y - 4, { ...TEXT_SMALL, color: C.cream });
        hintText(r, `${motion}${extra ? '   ' + extra : ''}`, 152, y, { color, size: 9 });
        y += 13;
      };
      for (const s of def.specials) {
        const m = def.sp[s.move].M;
        row(m.name, `${MOTION_ARROWS[s.motion]} + ${any}`, `(${MOTION_LABEL[s.motion]}${s.motion.startsWith('charge') ? ', hold 2/3 s' : ''})`, C.gold);
      }
      if (def.super) {
        const m = def.sp[def.super.move].M;
        row(m.name, `${MOTION_ARROWS[def.super.motion]} + ${any}`, '(SUPER: 1 full KILN bar)', C.ember);
      }
      if (def.normals['6M']) row(def.normals['6M'].name, `\u2192 + ${lab.M}`, '(overhead: block standing)');
      row('Throw', `${lab.T}  or  ${lab.L} + ${lab.M} up close`, '(hold \u2190: back throw)');
      row('Throw tech', `${lab.T}  or  ${lab.L} + ${lab.M} when grabbed`);
      row('Block', 'hold \u2190 high, \u2199 low', '(overheads, jump-ins: high)');
      row('Dash / jumps', '\u2192\u2192  \u2190\u2190   /   \u2196 \u2191 \u2197', '(one air normal per jump)');
      y += 2;
      r.drawText('NORMALS  -  cancel into specials on contact; lights chain into lights', 24, y - 4, { ...TEXT_SMALL, color: C.gold });
      y += 10;
      const cols = [['5', 'STAND'], ['2', 'CROUCH'], ['j', 'AIR']];
      cols.forEach(([p, label], ci) => {
        const x = 24 + ci * 146;
        r.drawText(label, x, y - 2, { ...TEXT_SMALL, color: C.dim });
        ['L', 'M', 'H'].forEach((bb, bi) => {
          const m = def.normals[p + bb];
          hintText(r, `${lab[bb]}  ${m ? m.name : '-'}${m && m.level === 'low' ? ' (low)' : ''}`, x, y + 14 + bi * 11, { size: 9 });
        });
      });
    });
  }
}

class TrainingMenuScene {
  constructor(fight) {
    this.overlay = true;
    this.fight = fight;
  }
  enter() {
    this.focused = false;
  }
  update(engine) {
    const ui = engine.ui;
    const T = profile.training;
    focusOnce(this, engine, 'dummy');
    const x = W / 2 - 110;
    let y = 50;
    const row = (id, label) => {
      const hit = ui.button(id, label, x, y, 220, 18);
      y += 22;
      return hit;
    };
    const flip = (k) => {
      T[k] = !T[k];
      saveTraining(engine);
      sfx.menu(engine);
    };
    if (row('dummy', `DUMMY: ${DUMMY_LABEL[T.dummy]}`)) {
      T.dummy = DUMMY_MODES[(DUMMY_MODES.indexOf(T.dummy) + 1) % DUMMY_MODES.length];
      saveTraining(engine);
      sfx.menu(engine);
    }
    if (row('tech', `DUMMY TECHS THROWS: ${T.tech ? 'ON' : 'OFF'}`)) flip('tech');
    if (row('inputs', `INPUT DISPLAY: ${T.inputs ? 'ON' : 'OFF'}`)) flip('inputs');
    if (row('frames', `FRAME DATA: ${T.frames ? 'ON' : 'OFF'}`)) flip('frames');
    if (row('boxes', `HIT / HURT BOXES: ${T.boxes ? 'ON' : 'OFF'}`)) flip('boxes');
    y += 6;
    if (row('back', 'BACK') || engine.input.actionPressed('back') || engine.input.actionPressed('pause')) {
      sfx.back(engine);
      engine.scenes.pop();
    }
  }
  render(engine) {
    const r = engine.renderer;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.6 });
      engine.ui.panel(W / 2 - 140, 14, 280, 214);
      title(r, 'TRAINING', W / 2, 32, 20, C.gold);
      hintText(r, 'Infinite health and KILN meter. Saved to your profile.', W / 2, 212, { align: 'center', color: C.dim, size: 9 });
    });
  }
}

class MatchResultScene {
  constructor(fight, tally) {
    this.overlay = true;
    this.fight = fight;
    this.tally = tally;
  }
  enter(engine) {
    this.focused = false;
    this.fade = { a: 0 };
    engine.tweens.to(this.fade, { a: 1 }, 0.35, { ease: 'quadOut' });
    this.sharer = new Sharer(engine);
    const f = this.fight;
    this.defs = f.opts.sides.map((s) => DATA.fighters[s.fi]);
    this.winner = f.bout.winner;
    if (f.mode === 'arcade') {
      const run = f.opts.run;
      this.won = this.winner === 0;
      this.last = run.index >= run.ladder.length - 1;
    }
  }
  resume() {
    this.focused = false;
  }
  update(engine, dt) {
    const ui = engine.ui;
    if (this.sharer.hiding(dt)) return;
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    const f = this.fight;
    this.sharer.restore(engine);
    const x = W / 2 - 152;
    const y = H - 52;
    if (f.mode === 'arcade') {
      const run = f.opts.run;
      focusOnce(this, engine, 'next');
      const label = this.won ? (this.last ? 'FINISH THE LADDER' : 'NEXT FIGHT') : 'SEE RESULTS';
      if (ui.button('next', label, x, y, 148, 18)) {
        sfx.menu(engine);
        engine.scenes.clear();
        if (this.won && !this.last) {
          run.index++;
          engine.scenes.push(new LadderScene(run));
        } else {
          run.cleared = this.won && this.last;
          engine.scenes.push(new ArcadeResultsScene(run));
        }
        return;
      }
      this.sharer.button(engine, x + 156, y, 148, 18);
      return;
    }
    focusOnce(this, engine, 'rematch');
    if (ui.button('rematch', 'REMATCH', x, y, 148, 18)) {
      sfx.menu(engine);
      engine.scenes.clear();
      engine.scenes.push(new FightScene(f.opts));
      return;
    }
    if (ui.button('chars', 'CHARACTER SELECT', x + 156, y, 148, 18)) {
      sfx.menu(engine);
      engine.scenes.clear();
      engine.scenes.push(new TitleScene());
      engine.scenes.push(new SelectScene({ mode: f.mode, step: 0, picks: [], twoP: f.opts.twoP, swap: f.opts.swap, level: f.opts.sides[1].level }));
      return;
    }
    this.sharer.button(engine, x, y + 22, 148, 18);
    if (ui.button('title', 'TITLE', x + 156, y + 22, 148, 18) || engine.input.actionPressed('back')) {
      sfx.back(engine);
      engine.scenes.clear();
      engine.scenes.push(new TitleScene());
    }
  }
  caption() {
    const f = this.fight;
    const [a, b] = this.defs;
    const w = f.bout.wins;
    if (this.winner < 0) return `Kiln Clash: ${a.name} and ${b.name} fought to a draw (${w[0]}-${w[1]})`;
    const win = this.defs[this.winner].name;
    const lose = this.defs[1 - this.winner].name;
    const mode = f.mode === 'arcade' ? `arcade, ${AI_LEVELS[f.opts.sides[1].level].name.toLowerCase()}` : f.mode;
    return `Kiln Clash: ${win} shattered ${lose} ${Math.max(w[0], w[1])}-${Math.min(w[0], w[1])} (${mode})`;
  }
  render(engine) {
    const r = engine.renderer;
    const f = this.fight;
    const a = this.fade.a;
    const sh = this.sharer;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.55 * a });
      engine.ui.panel(W / 2 - 170, 40, 340, H - 52, { alpha: a });
      const head = this.winner < 0 ? 'DRAW GAME' : `${this.defs[this.winner].name} WINS`;
      title(r, head, W / 2, 60, 20, this.winner < 0 ? C.cream : C.gold, a);
      const sub = this.winner < 0 ? '' : `${f.names[this.winner]}  -  ${this.defs[this.winner].title}`;
      if (sh.msg && !sh.capturing) hintText(r, sh.msg, W / 2, 80, { align: 'center', color: C.teal, size: 9 });
      else r.drawText(sub, W / 2, 76, { ...TEXT_SMALL, align: 'center', color: C.dim, alpha: a });
      let y = 92;
      for (const res of f.bout.results) {
        const who = res.winner < 0 ? 'DRAW' : this.defs[res.winner].name;
        const how = res.reason === 'ko' ? 'SHATTER' : res.reason === 'double' ? 'DOUBLE SHATTER' : 'TIME';
        r.drawText(`ROUND ${res.round}   ${who}   ${how}${res.perfect ? '   PERFECT' : ''}`, W / 2, y, { ...TEXT_SMALL, align: 'center', color: res.perfect ? C.gold : C.cream, alpha: a });
        y += 11;
      }
      const s = f.bout.sim.f;
      r.drawText(`DAMAGE ${s[0].stats.damage} / ${s[1].stats.damage}    BEST COMBO ${s[0].stats.maxCombo} / ${s[1].stats.maxCombo}`, W / 2, y + 4, { ...TEXT_SMALL, align: 'center', color: C.dim, alpha: a });
      y += 18;
      if (this.tally) {
        const t = this.tally;
        r.drawText(`DAMAGE ${t.damage}  COMBOS ${t.combos}  TIME ${t.time}`, W / 2, y, { ...TEXT_SMALL, align: 'center', color: C.cream, alpha: a });
        r.drawText(`PERFECT ${t.perfects}  ROUNDS ${t.rounds}  WIN ${t.wins}`, W / 2, y + 11, { ...TEXT_SMALL, align: 'center', color: C.cream, alpha: a });
        r.drawText(`x${t.mult} = ${t.score}    RUN ${f.opts.run.score}`, W / 2, y + 24, { font: 'kiln', size: 20, align: 'center', color: C.gold, alpha: a });
      }
      if (sh.capturing) r.drawText('kiln clash', W / 2, H - 22, { ...TEXT_SMALL, align: 'center', color: C.dim });
    });
    sh.shoot(engine, this.caption());
  }
}

class LadderScene {
  constructor(run) {
    this.run = run;
  }
  enter(engine) {
    this.focused = false;
    this.t = 0;
    engine.camera.x = engine.camera.y = 0;
    engine.camera.zoom = 1;
  }
  update(engine, dt) {
    this.t += dt;
    const ui = engine.ui;
    const run = this.run;
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    focusOnce(this, engine, 'fight');
    if (ui.button('fight', 'FIGHT!', W / 2 - 70, H - 46, 140, 20, { textSize: 16 })) {
      sfx.fight(engine);
      const opp = run.ladder[run.index];
      engine.scenes.clear();
      engine.scenes.push(new FightScene({ mode: 'arcade', run, stage: opp.stage, sides: [{ fi: run.fi, alt: run.alt, ctrl: 'human1' }, { fi: opp.fi, alt: opp.alt, ctrl: 'cpu', level: opp.level }] }));
      return;
    }
    if (ui.button('forfeit', run.index > 0 ? 'END RUN' : 'BACK TO TITLE', W / 2 - 70, H - 22, 140, 16)) {
      sfx.back(engine);
      engine.scenes.clear();
      engine.scenes.push(run.index > 0 ? new ArcadeResultsScene(run) : new TitleScene());
    }
  }
  render(engine) {
    const r = engine.renderer;
    const run = this.run;
    STAGES[run.ladder[run.index].stage].draw(r, 0, this.t);
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.55 });
      title(r, `FIGHT ${run.index + 1} OF ${run.ladder.length}`, W / 2, 24, 20, C.gold);
      r.drawText(`${AI_LEVELS[run.level].name}  -  RUN SCORE ${run.score}`, W / 2, 42, { ...TEXT_SMALL, align: 'center', color: C.cream });
      const n = run.ladder.length;
      run.ladder.forEach((o, i) => {
        const x = W / 2 + (i - (n - 1) / 2) * 104;
        const def = DATA.fighters[o.fi];
        const cur = i === run.index;
        const done = i < run.index;
        engine.ui.panel(x - 46, 58, 92, 150, { alpha: cur ? 1 : 0.6 });
        const pose = sampleAnim(DATA.anims.idle.keys, (this.t * 60 + i * 13) % 56, true, null, DATA.poses);
        drawGolem(r, def, o.alt ? def.alt : def.palette, pose, x, 182, -1, cur ? 1.25 : 1, { t: this.t, alpha: done ? 0.4 : 1 });
        r.drawText(o.boss ? `${def.name} (GLAZED)` : def.name, x, 192, { ...TEXT_SMALL, align: 'center', color: cur ? C.gold : C.cream });
        r.drawText(done ? 'BEATEN' : AI_LEVELS[o.level].name, x, 202, { ...TEXT_SMALL, align: 'center', color: done ? C.teal : C.dim });
      });
      const me = DATA.fighters[run.fi];
      r.drawText(`YOU: ${me.name}`, 12, H - 40, { ...TEXT_SMALL, color: C.cream });
    });
  }
}

class ArcadeResultsScene {
  constructor(run) {
    this.run = run;
  }
  enter(engine) {
    this.focused = false;
    loadProfile(engine);
    const run = this.run;
    this.fade = { a: 0, y: 12 };
    engine.tweens.to(this.fade, { a: 1, y: 0 }, 0.45, { ease: 'cubicOut' });
    engine.camera.x = engine.camera.y = 0;
    engine.camera.zoom = 1;
    this.t = 0;
    this.sharer = new Sharer(engine);
    this.localBest = run.score > profile.bestArcade;
    if (this.localBest) {
      profile.bestArcade = run.score;
      engine.storage.set('bestArcade', run.score);
    }
    if (run.cleared && !run.ended) {
      const id = DATA.fighters[run.fi].id;
      unlock(engine, 'ladder_fired');
      if (run.level === 'hard') unlock(engine, 'hard_fired');
      this.newAlt = !profile.unlocks.alt[id];
      profile.unlocks.alt[id] = true;
      engine.storage.set('unlocks', { alt: { ...profile.unlocks.alt } });
      const prev = profile.clears[id];
      if (!prev || LEVEL_IDS.indexOf(run.level) > LEVEL_IDS.indexOf(prev)) {
        profile.clears[id] = run.level;
        engine.storage.set('clears', { ...profile.clears });
      }
    }
    run.ended = true;
    // F001: submitScore exactly once per run; it resolves with the ScoreResultView, or null (anonymous player,
    // Studio, offline, older host). An empty run is not submitted.
    this.result = undefined;
    if (run.submitted || run.score <= 0) this.result = run.result ?? null;
    else {
      run.submitted = true;
      let pending;
      try {
        pending = engine.platform.submitScore(run.score);
      } catch {
        pending = null;
      }
      Promise.resolve(pending)
        .then((res) => (this.result = run.result = res && typeof res === 'object' ? res : null))
        .catch(() => (this.result = run.result = null));
    }
  }
  resume() {
    this.focused = false;
  }
  update(engine, dt) {
    this.t += dt;
    const ui = engine.ui;
    if (this.sharer.hiding(dt)) return;
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    focusOnce(this, engine, 'again');
    this.sharer.restore(engine);
    const x = W / 2 - 152;
    if (ui.button('again', 'NEW RUN', x, H - 50, 148, 18)) {
      sfx.menu(engine);
      engine.scenes.clear();
      engine.scenes.push(new TitleScene());
      engine.scenes.push(new SelectScene({ mode: 'arcade', step: 0, picks: [] }));
      return;
    }
    if (ui.button('board', 'LEADERBOARD', x + 156, H - 50, 148, 18)) {
      sfx.menu(engine);
      engine.scenes.push(new LeaderboardScene());
    }
    this.sharer.button(engine, x, H - 28, 148, 18);
    if (ui.button('title', 'TITLE', x + 156, H - 28, 148, 18)) {
      sfx.back(engine);
      engine.scenes.clear();
      engine.scenes.push(new TitleScene());
    }
  }
  render(engine) {
    const r = engine.renderer;
    const run = this.run;
    const a = this.fade.a;
    STAGES[2].draw(r, 140, this.t);
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.6 });
      const py = 8 + this.fade.y;
      engine.ui.panel(W / 2 - 170, py, 340, 196, { alpha: a });
      const me = DATA.fighters[run.fi];
      title(r, run.cleared ? 'LADDER FIRED' : 'RUN OVER', W / 2, py + 18, 20, run.cleared ? C.gold : C.ember, a);
      r.drawText(`${me.name}  -  ${AI_LEVELS[run.level].name}  -  ${run.matches.filter((m) => m.won).length} OF ${run.ladder.length} WON`, W / 2, py + 34, { ...TEXT_SMALL, align: 'center', color: C.cream, alpha: a });
      r.drawText(String(run.score), W / 2, py + 56, { font: 'kiln', size: 40, align: 'center', baseline: 'middle', color: '#ffffff', alpha: a });
      r.drawText('ARCADE SCORE', W / 2, py + 78, { ...TEXT_SMALL, align: 'center', color: C.dim, alpha: a });
      const t = run.tally;
      r.drawText(`DAMAGE ${t.damage}  COMBOS ${t.combos}  TIME ${t.time}`, W / 2, py + 92, { ...TEXT_SMALL, align: 'center', color: C.cream, alpha: a });
      r.drawText(`PERFECTS ${t.perfects}  ROUNDS ${t.rounds}  WINS ${t.wins}  x${AI_LEVELS[run.level].mult} PER FIGHT`, W / 2, py + 104, { ...TEXT_SMALL, align: 'center', color: C.cream, alpha: a });
      const res = this.result;
      let line1 = '';
      let line2 = '';
      let col = C.cream;
      if (res === undefined) line1 = 'Submitting score...';
      else if (res === null) {
        line1 = run.score <= 0 ? 'No score this run.' : this.localBest ? 'NEW BEST ON THIS DEVICE!' : `BEST ARCADE ${profile.bestArcade}`;
        line2 = run.score > 0 ? 'Not ranked: sign in to join the leaderboard.' : '';
        if (this.localBest) col = C.gold;
      } else {
        line1 = res.personalBest ? `NEW PERSONAL BEST: ${ascii(res.display, 20)}` : `SCORE SAVED: ${ascii(res.display, 20)}   RANK #${res.rank}`;
        const rk = res.ranks || {};
        line2 = `#${rk.day ?? '-'} today  -  #${rk.week ?? '-'} this week  -  #${rk.all ?? res.rank} all time`;
        if (res.personalBest) col = C.gold;
      }
      r.drawText(line1, W / 2, py + 124, { ...TEXT_SMALL, align: 'center', color: col, alpha: a });
      if (line2) r.drawText(line2, W / 2, py + 138, { ...TEXT_SMALL, align: 'center', color: C.dim, alpha: a });
      if (this.newAlt) r.drawText(`UNLOCKED: ${me.name}'S GLAZED COLOURS`, W / 2, py + 156, { ...TEXT_SMALL, align: 'center', color: C.teal, alpha: a });
      const sh = this.sharer;
      if (sh.capturing) r.drawText('kiln clash', W / 2, py + 176, { ...TEXT_SMALL, align: 'center', color: C.dim });
      else if (sh.msg) hintText(r, sh.msg, W / 2, py + 178, { align: 'center', color: C.teal, size: 9 });
    });
    const me = DATA.fighters[run.fi].name;
    this.sharer.shoot(engine, run.cleared ? `Kiln Clash: ${me} fired through the arcade ladder on ${run.level} with ${run.score} pts` : `Kiln Clash: ${me} scored ${run.score} pts in arcade (${run.level})`);
  }
}

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
    engine.storage.set('lbPeriod', period);
    this.view = undefined;
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
      if (ui.button(`tab-${p.id}`, on ? `> ${p.label} <` : p.label, 60 + i * 122, 46, 116, 16, { textColor: on ? C.gold : C.cream }) && !on) {
        sfx.menu(engine);
        this.select(engine, p.id);
      }
    });
    if (ui.button('back', 'BACK', W / 2 - 50, 234, 100, 18) || engine.input.actionPressed('back')) {
      sfx.back(engine);
      engine.scenes.pop();
    }
  }
  render(engine) {
    const r = engine.renderer;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.78 });
      engine.ui.panel(44, 8, W - 88, 254);
      title(r, 'LEADERBOARD', W / 2, 28, 20, C.gold);
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
      r.drawText(ascii(v.label || 'Score', 24).toUpperCase(), W - x0, 72, { ...TEXT_SMALL, align: 'right', color: C.dim });
      if (!v.entries.length) {
        const when = { day: 'today', week: 'this week', all: 'yet' }[v.period] || 'yet';
        hintText(r, `No scores ${when} - be the first!`, W / 2, 130, { align: 'center' });
      }
      let y = 88;
      // Player names can hold any character, so rows use the canvas font.
      const rowText = (rank, name, display, me) => {
        const color = me ? C.gold : C.cream;
        if (me) r.drawRect(x0 - 6, y - 7, W - 2 * x0 + 12, 14, C.gold, { alpha: 0.12 });
        hintText(r, `${rank}`, x0, y, { color });
        hintText(r, String(name).slice(0, 28), x0 + 30, y, { color });
        hintText(r, String(display), W - x0, y, { color, align: 'right' });
        y += 13;
      };
      for (const e of v.entries) rowText(e.rank, e.name, e.display, e.isMe);
      if (v.me && !v.entries.some((e) => e.isMe)) {
        r.drawLine(x0, y - 4, W - x0, y - 4, C.mute, 1);
        y += 4;
        rowText(v.me.rank, 'You', v.me.display, true);
      }
      const foot = `${v.totalPlayers} player${v.totalPlayers === 1 ? '' : 's'}${v.sample ? '  -  sample data (Studio preview)' : ''}`;
      hintText(r, foot, W / 2, 222, { align: 'center', color: C.dim });
    });
  }
}

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
    let y = 60;
    const row = (id, label) => {
      const hit = ui.button(id, label, x, y, 220, 18);
      y += 22;
      return hit;
    };
    if (row('sound', `SOUND: ${s.sound ? 'ON' : 'OFF'}`)) toggleSound(engine);
    if (row('shake', `SCREEN SHAKE: ${s.shake ? 'ON' : 'OFF'}`)) {
      s.shake = !s.shake;
      saveSettings(engine);
      sfx.menu(engine);
      if (s.shake) engine.camera.shake(3, 0.2);
    }
    if (row('flash', `SUPER / KO FLASH: ${s.flash ? 'FULL' : 'SOFT'}`)) {
      s.flash = !s.flash;
      saveSettings(engine);
      sfx.menu(engine);
    }
    if (row('level', `ARCADE DIFFICULTY: ${AI_LEVELS[s.level].name}`)) {
      s.level = LEVEL_IDS[(LEVEL_IDS.indexOf(s.level) + 1) % LEVEL_IDS.length];
      saveSettings(engine);
      sfx.menu(engine);
    }
    y += 6;
    if (row('back', 'BACK') || engine.input.actionPressed('back')) {
      sfx.back(engine);
      engine.scenes.pop();
    }
  }
  render(engine) {
    const r = engine.renderer;
    const a = this.fade.a;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.6 * a });
      engine.ui.panel(W / 2 - 140, 20, 280, 220, { alpha: a });
      title(r, 'SETTINGS', W / 2, 40, 20, C.gold, a);
      hintText(r, 'Saved to your profile (cloud save when signed in).', W / 2, 224, { align: 'center', color: C.dim, alpha: a, size: 9 });
    });
  }
}

/** Character select. flow: { mode, step (0 = P1, 1 = P2 / CPU / dummy), picks, twoP, swap, level } */
class SelectScene {
  constructor(flow) {
    this.flow = flow;
    this.overlay = false;
  }
  enter(engine) {
    loadProfile(engine);
    this.focused = false;
    this.t = 0;
    this.alt = false;
    this.cur = this.flow.step === 1 ? 1 % DATA.fighters.length : 0;
    if (this.flow.mode === 'arcade' && !this.flow.level) this.flow.level = profile.settings.level;
    this.p2 = this.flow.step === 1 && this.flow.twoP ? new HumanController(P2_IDS, this.flow.swap ? 0 : 1, P1_IDS, []) : null;
    this.p2prev = 5;
    engine.camera.x = engine.camera.y = 0;
    engine.camera.zoom = 1;
  }
  resume(engine) {
    loadProfile(engine);
    this.focused = false;
  }
  heading() {
    const f = this.flow;
    if (f.step === 0) return f.mode === 'arcade' ? 'ARCADE: CHOOSE YOUR GOLEM' : f.mode === 'training' ? 'TRAINING: CHOOSE YOUR GOLEM' : 'PLAYER 1: CHOOSE';
    if (f.mode === 'training') return 'CHOOSE THE DUMMY';
    return f.twoP ? 'PLAYER 2: CHOOSE' : "CHOOSE THE CPU'S GOLEM";
  }
  update(engine, dt) {
    this.t += dt;
    const ui = engine.ui;
    const n = DATA.fighters.length;
    const flow = this.flow;
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    focusOnce(this, engine, `pick-${this.cur}`);
    const navMoved = ui.focus !== this.lastFocus; // keyboard/pad navigation already moved the cursor this step
    const sel = ui.focus || ui.hot || '';
    const m = /^pick-(\d+)$/.exec(sel);
    if (m) this.cur = Number(m[1]);
    // P2 can drive this screen with its own keys / pad in 2P versus.
    if (this.p2) {
      const inp = this.p2.read(engine);
      const h = inp.dir % 3 === 0 ? 1 : inp.dir % 3 === 1 ? -1 : 0;
      const ph = this.p2prev % 3 === 0 ? 1 : this.p2prev % 3 === 1 ? -1 : 0;
      if (h && h !== ph && !navMoved) {
        this.cur = (this.cur + h + n) % n;
        ui.focus = `pick-${this.cur}`;
        sfx.blip(engine);
      }
      this.p2prev = inp.dir;
      if (inp.press & (BTN.L | BTN.M)) {
        this.choose(engine, this.cur);
        return;
      }
    }
    this.lastFocus = ui.focus;
    const cw = 62;
    const x0 = W - 16 - n * (cw + 4);
    for (let i = 0; i < n; i++) if (ui.button(`pick-${i}`, DATA.fighters[i].name, x0 + i * (cw + 4), 196, cw, 18)) {
      this.choose(engine, i);
      return;
    }
    const def = DATA.fighters[this.cur];
    const altOk = !!profile.unlocks.alt[def.id] || flow.step === 1;
    if (!altOk) this.alt = false;
    let bx = x0;
    if (ui.button('color', `COLOR: ${this.alt ? 'GLAZED' : 'CLASSIC'}${altOk ? '' : ' (LOCKED)'}`, bx, 220, 150, 16, { disabled: !altOk })) {
      this.alt = !this.alt;
      sfx.menu(engine);
    }
    bx += 154;
    if (flow.mode === 'arcade' || (flow.mode === 'versus' && flow.step === 1 && !flow.twoP)) {
      const key = flow.mode === 'arcade' ? flow.level : profile.versus.level;
      if (ui.button('level', `CPU: ${AI_LEVELS[key].name}`, bx, 220, 104, 16)) {
        const next = LEVEL_IDS[(LEVEL_IDS.indexOf(key) + 1) % LEVEL_IDS.length];
        if (flow.mode === 'arcade') {
          flow.level = next;
          profile.settings.level = next;
          saveSettings(engine);
        } else {
          profile.versus.level = next;
          saveVersus(engine);
        }
        sfx.menu(engine);
      }
    }
    if (ui.button('moves', 'MOVE LIST', x0, 240, 150, 16)) {
      sfx.menu(engine);
      engine.scenes.push(new MoveListScene([this.cur], 0, false));
    }
    if (ui.button('back', 'BACK', x0 + 154, 240, 104, 16) || engine.input.actionPressed('back')) {
      sfx.back(engine);
      engine.scenes.pop();
    }
  }
  choose(engine, i) {
    sfx.menu(engine);
    const flow = this.flow;
    const picks = flow.picks.slice(0, flow.step);
    picks[flow.step] = { fi: i, alt: this.alt };
    if (flow.mode === 'arcade') {
      const run = newRun(i, this.alt, flow.level || 'normal');
      profile.runs++;
      engine.storage.set('runs', profile.runs);
      engine.scenes.clear();
      engine.scenes.push(new LadderScene(run));
      return;
    }
    if (flow.step === 0) engine.scenes.push(new SelectScene({ ...flow, step: 1, picks }));
    else engine.scenes.push(new StageSelectScene({ ...flow, picks }));
  }
  render(engine) {
    const r = engine.renderer;
    const def = DATA.fighters[this.cur];
    STAGES[this.cur % STAGES.length].draw(r, 120, this.t);
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.62 });
      title(r, this.heading(), W / 2, 16, 20, C.gold);
      const pose = sampleAnim(DATA.anims.idle.keys, (this.t * 60) % 56, true, null, DATA.poses);
      const pal = this.alt ? def.alt : def.palette;
      r.setBlend('additive');
      r.drawCircle(100, 150, 70, pal.core, { alpha: 0.12, segments: 32 });
      r.setBlend('normal');
      drawGolem(r, def, pal, pose, 100, 228, 1, 1.7, { t: this.t, glow: 0.8 });
      title(r, def.name, 100, 40, 20, pal.core);
      r.drawText(def.title.toUpperCase(), 100, 54, { ...TEXT_SMALL, align: 'center', color: C.cream });
      const x = W - 16 - DATA.fighters.length * 66;
      engine.ui.panel(x - 6, 30, W - x - 10, 160);
      r.drawText(ARCHE_LABEL[def.archetype], x + 2, 38, { ...TEXT_SMALL, color: C.gold });
      r.drawText(`HEALTH ${def.health}   WINS ${profile.wins[def.id] || 0}${profile.clears[def.id] ? '   CLEARED ' + AI_LEVELS[profile.clears[def.id]].name : ''}`, x + 2, 50, { ...TEXT_SMALL, color: C.dim });
      ['power', 'speed', 'range'].forEach((k, i) => {
        const v = clamp(unum(def.stats[k]), 0, 5);
        r.drawText(k.toUpperCase(), x + 2, 64 + i * 10, { ...TEXT_SMALL, color: C.cream });
        for (let j = 0; j < 5; j++) r.drawRect(x + 46 + j * 12, 64 + i * 10, 10, 6, j < v ? pal.core : '#3b2a2a');
      });
      hintText(r, def.bio, x + 2, 104, { size: 9, maxWidth: W - x - 22, baseline: 'top', lineHeight: 1.15, color: '#e6d6c4' });
      let y = 150;
      for (const s of def.specials) {
        hintText(r, `${def.sp[s.move].M.name}  ${MOTION_ARROWS[s.motion]}`, x + 2, y, { size: 9, color: C.gold });
        y += 11;
      }
      if (def.super) hintText(r, `${def.sp[def.super.move].M.name}  ${MOTION_ARROWS[def.super.motion]}`, x + 2, y, { size: 9, color: C.ember });
      if (this.p2) {
        const L = playerLabels(engine, 1);
        hintText(r, `P2: ${L.dir} / pad ${this.flow.swap ? 1 : 2} to choose, ${L.L} or ${L.M} to pick`, 100, H - 10, { align: 'center', size: 9, color: C.dim });
      }
    });
  }
}

class StageSelectScene {
  constructor(flow) {
    this.flow = flow;
  }
  enter(engine) {
    this.focused = false;
    this.t = 0;
    this.cur = 0;
  }
  resume() {
    this.focused = false;
  }
  update(engine, dt) {
    this.t += dt;
    const ui = engine.ui;
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    focusOnce(this, engine, 'stage-0');
    const m = /^stage-(\d+)$/.exec(ui.focus || ui.hot || '');
    if (m) this.cur = Number(m[1]);
    const n = STAGES.length;
    const w = 140;
    for (let i = 0; i < n; i++) {
      const x = W / 2 + (i - (n - 1) / 2) * (w + 8) - w / 2;
      if (ui.button(`stage-${i}`, STAGES[i].name, x, 186, w, 18)) {
        this.start(engine, i);
        return;
      }
    }
    if (ui.button('random', 'RANDOM', W / 2 - 152, 214, 148, 18)) {
      this.start(engine, Math.floor(Math.random() * n));
      return;
    }
    if (ui.button('back', 'BACK', W / 2 + 4, 214, 148, 18) || engine.input.actionPressed('back')) {
      sfx.back(engine);
      engine.scenes.pop();
    }
  }
  start(engine, stage) {
    sfx.fight(engine);
    const f = this.flow;
    const [a, b] = f.picks;
    let sides;
    if (f.mode === 'training') sides = [{ ...a, ctrl: 'human1' }, { ...b, ctrl: 'dummy' }];
    else sides = [{ ...a, ctrl: 'human1' }, { ...b, ctrl: f.twoP ? 'human2' : 'cpu', level: profile.versus.level }];
    engine.scenes.clear();
    engine.scenes.push(new FightScene({ mode: f.mode, stage, sides, twoP: !!f.twoP, swap: !!f.swap }));
  }
  render(engine) {
    const r = engine.renderer;
    STAGES[this.cur].draw(r, 140 + Math.sin(this.t * 0.4) * 120, this.t);
    r.ui(() => {
      r.drawRect(0, 0, W, 40, C.ink, { alpha: 0.6 });
      title(r, 'CHOOSE A STAGE', W / 2, 18, 20, C.gold);
      r.drawText(STAGES[this.cur].desc, W / 2, 34, { ...TEXT_SMALL, align: 'center', color: C.cream });
      const n = STAGES.length;
      const w = 140;
      for (let i = 0; i < n; i++) {
        const x = W / 2 + (i - (n - 1) / 2) * (w + 8) - w / 2;
        const th = STAGES[i].thumb;
        r.drawRect(x - 2, 128, w + 4, 56, C.ink);
        for (let j = 0; j < 3; j++) r.drawRect(x, 130 + j * 18, w, 18, th[j]);
        r.drawRect(x, 166, w, 2, '#000000', { alpha: 0.4 });
        if (i === this.cur) r.strokeRect(x - 3, 127, w + 6, 58, C.gold, 2, 1);
      }
    });
  }
}

class ModeScene {
  constructor() {
    this.overlay = true;
  }
  enter() {
    this.focused = false;
  }
  resume() {
    this.focused = false;
  }
  update(engine) {
    const ui = engine.ui;
    focusOnce(this, engine, 'arcade');
    const x = W / 2 - 80;
    const y = 74;
    if (ui.button('arcade', 'ARCADE', x, y, 160, 20, { textSize: 16 })) {
      sfx.menu(engine);
      engine.scenes.push(new SelectScene({ mode: 'arcade', step: 0, picks: [] }));
    }
    if (ui.button('versus', 'VERSUS', x, y + 46, 160, 20, { textSize: 16 })) {
      sfx.menu(engine);
      engine.scenes.push(new VersusSetupScene());
    }
    if (ui.button('training', 'TRAINING', x, y + 92, 160, 20, { textSize: 16 })) {
      sfx.menu(engine);
      engine.scenes.push(new SelectScene({ mode: 'training', step: 0, picks: [] }));
    }
    if (ui.button('back', 'BACK', x + 30, y + 140, 100, 16) || engine.input.actionPressed('back')) {
      sfx.back(engine);
      engine.scenes.pop();
    }
  }
  render(engine) {
    const r = engine.renderer;
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.55 });
      engine.ui.panel(W / 2 - 150, 30, 300, 210);
      title(r, 'CHOOSE A MODE', W / 2, 50, 20, C.gold);
      const t = { ...TEXT_SMALL, align: 'center', color: C.dim };
      r.drawText(`A LADDER OF 4 CPU FIGHTS. BEST ${profile.bestArcade}`, W / 2, 98, t);
      r.drawText('LOCAL 2 PLAYERS, OR YOU AGAINST THE CPU', W / 2, 144, t);
      r.drawText('DUMMY, INPUT DISPLAY, FRAME DATA', W / 2, 190, t);
    });
  }
}

class VersusSetupScene {
  constructor() {
    this.overlay = true;
  }
  enter(engine) {
    loadProfile(engine);
    this.focused = false;
  }
  resume() {
    this.focused = false;
  }
  update(engine) {
    const ui = engine.ui;
    const v = profile.versus;
    focusOnce(this, engine, 'vs2');
    const x = W / 2 - 120;
    let y = 60;
    const row = (id, label, h = 18) => {
      const hit = ui.button(id, label, x, y, 240, h);
      y += h + 6;
      return hit;
    };
    if (row('vs2', '2 PLAYERS')) {
      sfx.menu(engine);
      engine.scenes.push(new SelectScene({ mode: 'versus', step: 0, picks: [], twoP: true, swap: v.swap }));
      return;
    }
    if (row('vscpu', 'PLAYER VS CPU')) {
      sfx.menu(engine);
      engine.scenes.push(new SelectScene({ mode: 'versus', step: 0, picks: [], twoP: false }));
      return;
    }
    if (row('level', `CPU LEVEL: ${AI_LEVELS[v.level].name}`)) {
      v.level = LEVEL_IDS[(LEVEL_IDS.indexOf(v.level) + 1) % LEVEL_IDS.length];
      saveVersus(engine);
      sfx.menu(engine);
    }
    if (row('swap', `GAMEPADS: ${v.swap ? 'P1 = PAD 2, P2 = PAD 1' : 'P1 = PAD 1, P2 = PAD 2'}`)) {
      v.swap = !v.swap;
      saveVersus(engine);
      sfx.menu(engine);
    }
    y += 4;
    if (row('back', 'BACK') || engine.input.actionPressed('back')) {
      sfx.back(engine);
      engine.scenes.pop();
    }
  }
  render(engine) {
    const r = engine.renderer;
    const p1 = playerLabels(engine, 0);
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.6 });
      engine.ui.panel(W / 2 - 160, 20, 320, 236);
      title(r, 'VERSUS', W / 2, 40, 20, C.gold);
      const k = (side) => {
        const ids = side ? P2_IDS : P1_IDS;
        const a = (id) => {
          const x = actionOf(engine, ids[id]);
          return x && x.keys[0] ? engine.input.keyLabel(x.keys[0]) : '-';
        };
        return `${a('up')}${a('left')}${a('down')}${a('right')}  ${a('light')} ${a('medium')} ${a('heavy')}  throw ${a('throw')}`;
      };
      hintText(r, `P1 keys: ${k(0)}`, W / 2, 196, { align: 'center', size: 9 });
      hintText(r, `P2 keys: ${k(1)}`, W / 2, 210, { align: 'center', size: 9 });
      hintText(r, 'Each player can also use a gamepad (same buttons for both pads).', W / 2, 226, { align: 'center', size: 9, color: C.dim });
      hintText(r, `Pad buttons: ${p1.L} light  ${p1.M} medium  ${p1.H} heavy  ${p1.T} throw`, W / 2, 240, { align: 'center', size: 9, color: C.dim });
    });
  }
}

function demo() {
  const n = DATA.fighters.length;
  const a = Math.floor(Math.random() * n);
  const b = (a + 1 + Math.floor(Math.random() * (n - 1))) % n;
  const seed = Math.floor(Math.random() * 1e9) + 1;
  const bout = new Bout(DATA, { mode: 'demo', defs: [DATA.fighters[a], DATA.fighters[b]], alt: [false, Math.random() < 0.5] });
  return { bout, ctrl: [new CpuController('hard', seed), new CpuController('normal', seed + 1)], stage: STAGES[Math.floor(Math.random() * STAGES.length)] };
}

class TitleScene {
  enter(engine) {
    loadProfile(engine);
    this.focused = false;
    this.newDemo(engine);
    this.head = { y: -40, a: 0 };
    engine.tweens.to(this.head, { y: 54, a: 1 }, 0.8, { ease: 'backOut' });
    this.t = 0;
  }
  newDemo(engine) {
    this.d = demo();
    this.arena = new Arena(engine, this.d.bout, this.d.stage, { hud: false, quiet: true });
  }
  resume(engine) {
    loadProfile(engine);
    this.focused = false;
    engine.camera.zoom = 1;
  }
  update(engine, dt) {
    this.t += dt;
    const d = this.d;
    const events = d.bout.step(d.ctrl.map((c, i) => c.read(d.bout, i)));
    this.arena.handle(engine, events);
    this.arena.update(dt);
    if (d.bout.over && d.bout.phaseT > 120) this.newDemo(engine);
    if (engine.input.actionPressed('mute')) toggleSound(engine);
    const ui = engine.ui;
    focusOnce(this, engine, 'start');
    const bx = W / 2 - 80;
    if (ui.button('start', 'START', bx, 116, 160, 20, { textSize: 16 })) {
      sfx.menu(engine);
      engine.scenes.push(new ModeScene());
    }
    if (ui.button('board', 'LEADERBOARD', bx, 142, 160, 20, { textSize: 16 })) {
      sfx.menu(engine);
      engine.scenes.push(new LeaderboardScene());
    }
    if (ui.button('settings', 'SETTINGS', bx, 168, 160, 20, { textSize: 16 })) {
      sfx.menu(engine);
      engine.scenes.push(new SettingsScene());
    }
  }
  render(engine) {
    const r = engine.renderer;
    this.arena.render(engine);
    r.ui(() => {
      r.drawRect(0, 0, W, H, C.ink, { alpha: 0.5 });
      title(r, 'KILN CLASH', W / 2, this.head.y, 40, C.ember, this.head.a);
      r.drawText('pottery golems, fired for battle', W / 2, 80, { ...TEXT_SMALL, align: 'center', color: C.gold, alpha: this.head.a });
      const wins = Object.values(profile.wins).reduce((s, v) => s + v, 0);
      r.drawText(`BEST ARCADE ${profile.bestArcade}   WINS ${wins}   GLAZES ${Object.keys(profile.unlocks.alt).length}/${DATA.fighters.length}`, W / 2, 96, { ...TEXT_SMALL, align: 'center', color: C.cream });
      const L = playerLabels(engine, 0);
      hintText(r, `${L.dir} move   ${L.L} / ${L.M} / ${L.H} light / medium / heavy   ${L.T} throw   ${hintLabel(engine, 'pause')} pause`, W / 2, 222, { align: 'center', size: 9 });
      hintText(r, `Menus: mouse, ${hintLabel(engine, 'up', 'up', false)}${hintLabel(engine, 'down', 'down', false)} + ${hintLabel(engine, 'confirm')}, or D-pad + A.   ${hintLabel(engine, 'mute')} mute`, W / 2, 238, { align: 'center', size: 9, color: C.dim });
      if (!profile.settings.sound) r.drawText('MUTED', W - 6, 6, { ...TEXT_SMALL, align: 'right' });
    });
  }
}

// ======================================================================= entry

export default {
  async load(engine) {
    const [json, , panel, button, hover, down] = await Promise.all([
      engine.assets.loadJSON('assets/fighters.json'),
      engine.assets.loadBitmapFont('kiln', 'assets/fonts/kiln.fnt'),
      engine.assets.loadNineSlice('assets/ui/panel.png', 4),
      engine.assets.loadNineSlice('assets/ui/button.png', 3),
      engine.assets.loadNineSlice('assets/ui/button_hover.png', 3),
      engine.assets.loadNineSlice('assets/ui/button_down.png', 3),
    ]);
    DATA = normalizeData(json);
    Object.assign(engine.ui.theme, {
      panel, button, buttonHover: hover, buttonDown: down, nineSliceScale: 2, font: 'pixel', textSize: 8,
      textColor: C.cream, disabledTextColor: C.mute, focusColor: C.gold,
    });
    engine.renderer.background = C.ink;
    loadProfile(engine);
    await engine.scenes.push(new TitleScene());
  },
};

// Pure parts, exposed for tools and tests (the engine only uses the default export).
export const internals = {
  normalizeData, Bout, Sim, CpuController, DummyController, HumanController, matchSteps, match360, relDir, makeDir, BTN, NEUTRAL, STAGES, profile,
  get data() {
    return DATA;
  },
  scenes: { TitleScene, ModeScene, VersusSetupScene, SelectScene, StageSelectScene, LadderScene, FightScene, PauseScene, MoveListScene, TrainingMenuScene, MatchResultScene, ArcadeResultsScene, LeaderboardScene, SettingsScene },
};

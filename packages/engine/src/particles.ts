/** Pooled particle emitter. Update with emitter.update(dt), draw with emitter.draw(renderer). */
import { activity } from './debug';
import { Color, lerp, type ColorLike } from './math';
import type { BlendMode, Renderer } from './renderer';
import type { SpriteSheet, Texture } from './texture';

export type Range = number | readonly [number, number];

export interface EmitterConfig {
  x?: number;
  y?: number;
  /** Spawn area size around (x, y) (default 0 = point). */
  spawnW?: number;
  spawnH?: number;
  /** Particles per second while `emitting` (default 0 = bursts only). */
  rate?: number;
  maxParticles?: number;
  /** Lifetime seconds (default [0.4, 0.8]). */
  life?: Range;
  /** Initial speed (default [40, 120]). */
  speed?: Range;
  /** Emission direction in radians (default full circle [0, 2π]). */
  angle?: Range;
  /** Acceleration applied to particles (units/s²). */
  gravityX?: number;
  gravityY?: number;
  /** Velocity damping per second (0 = none, 1 = strong). */
  drag?: number;
  /** Start / end size (default 6 → 0). */
  size?: Range;
  sizeEnd?: Range;
  /** Start / end color (end defaults to start with alpha 0). Pass an array of colors to pick a random start color. */
  color?: ColorLike | readonly ColorLike[];
  colorEnd?: ColorLike;
  /** Angular velocity (radians/s). */
  spin?: Range;
  /** Draw shape when no texture: square or circle. */
  shape?: 'square' | 'circle';
  texture?: Texture | SpriteSheet | null;
  /** Sprite sheet frame (or random range). */
  frame?: Range;
  blend?: BlendMode;
  /** Random source (default Math.random). */
  random?: () => number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  rot: number;
  spin: number;
  c0: Color;
  frame: number;
}

export class ParticleEmitter {
  x: number;
  y: number;
  /** Continuous emission on/off (uses `rate`). */
  emitting: boolean;
  readonly config: EmitterConfig;
  private readonly pool: Particle[] = [];
  private readonly live: Particle[] = [];
  private acc = 0;
  private readonly rnd: () => number;
  private endColor: Color | null;

  constructor(config: EmitterConfig = {}) {
    this.config = { ...config };
    this.x = config.x ?? 0;
    this.y = config.y ?? 0;
    this.emitting = (config.rate ?? 0) > 0;
    this.rnd = config.random ?? Math.random;
    this.endColor = config.colorEnd !== undefined ? Color.from(config.colorEnd) : null;
  }

  /** Number of live particles. */
  get count(): number {
    return this.live.length;
  }

  private pick(r: Range | undefined, def: number): number {
    if (r === undefined) return def;
    if (typeof r === 'number') return r;
    return lerp(r[0], r[1], this.rnd());
  }

  /** Spawn `n` particles now (optionally at a different position). */
  burst(n: number, x = this.x, y = this.y): void {
    const cfg = this.config;
    const max = cfg.maxParticles ?? 1000;
    for (let i = 0; i < n && this.live.length < max; i++) {
      const p = this.pool.pop() ?? ({} as Particle);
      const ang = this.pick(cfg.angle, this.rnd() * Math.PI * 2);
      const spd = this.pick(cfg.speed ?? [40, 120], 80);
      p.x = x + (cfg.spawnW ? (this.rnd() - 0.5) * cfg.spawnW : 0);
      p.y = y + (cfg.spawnH ? (this.rnd() - 0.5) * cfg.spawnH : 0);
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.maxLife = p.life = Math.max(0.01, this.pick(cfg.life ?? [0.4, 0.8], 0.6));
      p.size0 = this.pick(cfg.size ?? 6, 6);
      p.size1 = this.pick(cfg.sizeEnd ?? 0, 0);
      p.rot = this.rnd() * Math.PI * 2;
      p.spin = this.pick(cfg.spin, 0);
      const col = cfg.color;
      p.c0 = Color.from(Array.isArray(col) && typeof col[0] !== 'number' ? (col as readonly ColorLike[])[Math.floor(this.rnd() * col.length)]! : ((col as ColorLike | undefined) ?? '#fff'));
      p.frame = Math.floor(this.pick(cfg.frame, 0));
      this.live.push(p);
    }
  }

  /** Alias of burst. */
  emit(n: number, x?: number, y?: number): void {
    this.burst(n, x, y);
  }

  update(dt: number): void {
    activity.emitter(this);
    const cfg = this.config;
    if (this.emitting && (cfg.rate ?? 0) > 0) {
      this.acc += dt * cfg.rate!;
      const n = Math.floor(this.acc);
      this.acc -= n;
      if (n > 0) this.burst(n);
    }
    const gx = cfg.gravityX ?? 0;
    const gy = cfg.gravityY ?? 0;
    const drag = Math.max(0, 1 - (cfg.drag ?? 0) * dt);
    const live = this.live;
    for (let i = live.length - 1; i >= 0; i--) {
      const p = live[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        live[i] = live[live.length - 1]!;
        live.pop();
        this.pool.push(p);
        continue;
      }
      p.vx = (p.vx + gx * dt) * drag;
      p.vy = (p.vy + gy * dt) * drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }
  }

  draw(r: Renderer): void {
    activity.emitter(this);
    if (this.live.length === 0) return;
    const cfg = this.config;
    const prevBlend = cfg.blend;
    if (prevBlend) r.setBlend(prevBlend);
    const shape = cfg.shape ?? 'square';
    for (const p of this.live) {
      const t = 1 - p.life / p.maxLife;
      const size = lerp(p.size0, p.size1, t);
      if (size <= 0) continue;
      const end = this.endColor ?? p.c0.withAlpha(0);
      const c = new Color(lerp(p.c0.r, end.r, t), lerp(p.c0.g, end.g, t), lerp(p.c0.b, end.b, t), lerp(p.c0.a, end.a, t));
      if (cfg.texture) {
        r.drawSprite(cfg.texture, p.x, p.y, { w: size, h: size, originX: 0.5, originY: 0.5, rotation: p.rot, tint: c, frame: p.frame });
      } else if (shape === 'circle') {
        r.drawCircle(p.x, p.y, size / 2, c, { segments: 10 });
      } else if (p.spin !== 0) {
        const h = size / 2;
        const cs = Math.cos(p.rot) * h;
        const sn = Math.sin(p.rot) * h;
        r.drawPolygon([p.x - cs + sn, p.y - sn - cs, p.x + cs + sn, p.y + sn - cs, p.x + cs - sn, p.y + sn + cs, p.x - cs - sn, p.y - sn + cs], c);
      } else {
        r.drawRect(p.x - size / 2, p.y - size / 2, size, size, c);
      }
    }
    if (prevBlend) r.setBlend('normal');
  }

  clear(): void {
    while (this.live.length) this.pool.push(this.live.pop()!);
  }
}

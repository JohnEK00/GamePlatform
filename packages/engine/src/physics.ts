/** Simple arcade AABB physics: gravity, velocity, drag, collision vs tilemap + static/kinematic bodies. Pure. */
import { activity } from './debug';
import { approach, Rect, type Point, type RectLike } from './math';
import type { Tilemap, TileRef } from './tilemap';

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface BodyOptions {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  vx?: number;
  vy?: number;
  /** Static bodies never move from forces/collisions; give them vx/vy to make kinematic moving platforms. */
  isStatic?: boolean;
  /** Static bodies only: collide only from above (jump-through platform). */
  oneWay?: boolean;
  /** Sensor bodies move but never collide (use physics.overlaps for triggers). */
  sensor?: boolean;
  /** Multiplier for world gravity (default 1). */
  gravityScale?: number;
  /** 0..1 velocity kept (reversed) when hitting something (default 0). */
  bounce?: number;
  /** Linear deceleration (units/s²) applied per axis when no acceleration on that axis. */
  dragX?: number;
  dragY?: number;
  maxSpeedX?: number;
  maxSpeedY?: number;
  tag?: string;
  data?: unknown;
}

export class Body implements RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  /** Acceleration (units/s²), in addition to gravity. */
  ax = 0;
  ay = 0;
  isStatic: boolean;
  oneWay: boolean;
  sensor: boolean;
  gravityScale: number;
  bounce: number;
  dragX: number;
  dragY: number;
  maxSpeedX: number;
  maxSpeedY: number;
  tag: string;
  data: unknown;
  /** Disabled bodies are skipped entirely. */
  enabled = true;
  /** When true, one-way platforms are ignored (e.g. "drop through" by pressing down). */
  ignoreOneWay = false;
  /** Contacts from the most recent step. */
  touching = { left: false, right: false, top: false, bottom: false };
  /** Standing on something (touching.bottom). */
  onGround = false;
  /** Static body this one stands on (moving platforms carry their riders). */
  ground: Body | null = null;
  /** Position before the last step (handy for render interpolation). */
  prevX: number;
  prevY: number;
  /** Called on each collision with a tile or another body. */
  onCollide: ((other: Body | TileRef, side: Side) => void) | null = null;

  constructor(o: BodyOptions = {}) {
    this.x = o.x ?? 0;
    this.y = o.y ?? 0;
    this.w = o.w ?? 16;
    this.h = o.h ?? 16;
    this.vx = o.vx ?? 0;
    this.vy = o.vy ?? 0;
    this.isStatic = o.isStatic ?? false;
    this.oneWay = o.oneWay ?? false;
    this.sensor = o.sensor ?? false;
    this.gravityScale = o.gravityScale ?? 1;
    this.bounce = o.bounce ?? 0;
    this.dragX = o.dragX ?? 0;
    this.dragY = o.dragY ?? 0;
    this.maxSpeedX = o.maxSpeedX ?? Infinity;
    this.maxSpeedY = o.maxSpeedY ?? Infinity;
    this.tag = o.tag ?? '';
    this.data = o.data;
    this.prevX = this.x;
    this.prevY = this.y;
  }

  get left(): number {
    return this.x;
  }
  get right(): number {
    return this.x + this.w;
  }
  get top(): number {
    return this.y;
  }
  get bottom(): number {
    return this.y + this.h;
  }
  get centerX(): number {
    return this.x + this.w / 2;
  }
  get centerY(): number {
    return this.y + this.h / 2;
  }
  get rect(): Rect {
    return new Rect(this.x, this.y, this.w, this.h);
  }
  /** Interpolated position for rendering between fixed steps. */
  lerpPos(alpha: number): Point {
    return { x: this.prevX + (this.x - this.prevX) * alpha, y: this.prevY + (this.y - this.prevY) * alpha };
  }
}

export interface PhysicsOptions {
  /** Gravity vector, or a number for downward gravity (units/s²). */
  gravity?: Point | number;
  tilemap?: Tilemap | null;
}

const EPS = 1e-6;

export class Physics {
  gravity: { x: number; y: number };
  tilemap: Tilemap | null;
  readonly bodies: Body[] = [];

  constructor(opts: PhysicsOptions = {}) {
    const g = opts.gravity ?? 0;
    this.gravity = typeof g === 'number' ? { x: 0, y: g } : { x: g.x, y: g.y };
    this.tilemap = opts.tilemap ?? null;
  }

  /** Add a Body (or create one from options). */
  add(b: Body | BodyOptions): Body {
    const body = b instanceof Body ? b : new Body(b);
    this.bodies.push(body);
    return body;
  }
  remove(b: Body): void {
    const i = this.bodies.indexOf(b);
    if (i >= 0) this.bodies.splice(i, 1);
  }
  clear(): void {
    this.bodies.length = 0;
  }

  /** AABB overlap between two bodies/rects. */
  overlaps(a: RectLike, b: RectLike): boolean {
    return Rect.intersects(a, b);
  }
  /** Enabled bodies overlapping a rect (optionally filtered by tag). */
  query(r: RectLike, tag?: string): Body[] {
    return this.bodies.filter((b) => b.enabled && b !== r && (tag === undefined || b.tag === tag) && Rect.intersects(r, b));
  }

  /** Advance the simulation by dt seconds. */
  step(dt: number): void {
    activity.physics(this);
    // 1) kinematic (static with velocity) bodies move first so riders can follow.
    const moved = new Map<Body, { dx: number; dy: number }>();
    for (const b of this.bodies) {
      b.prevX = b.x;
      b.prevY = b.y;
      if (!b.enabled || !b.isStatic) continue;
      if (b.vx !== 0 || b.vy !== 0) {
        const dx = b.vx * dt;
        const dy = b.vy * dt;
        b.x += dx;
        b.y += dy;
        moved.set(b, { dx, dy });
      }
    }
    // 2) dynamic bodies
    for (const b of this.bodies) {
      if (!b.enabled || b.isStatic) continue;
      this.stepBody(b, dt, moved);
    }
  }

  private stepBody(b: Body, dt: number, moved: Map<Body, { dx: number; dy: number }>): void {
    b.vx += (this.gravity.x * b.gravityScale + b.ax) * dt;
    b.vy += (this.gravity.y * b.gravityScale + b.ay) * dt;
    if (b.ax === 0 && b.dragX > 0) b.vx = approach(b.vx, 0, b.dragX * dt);
    if (b.ay === 0 && b.dragY > 0) b.vy = approach(b.vy, 0, b.dragY * dt);
    if (Math.abs(b.vx) > b.maxSpeedX) b.vx = Math.sign(b.vx) * b.maxSpeedX;
    if (Math.abs(b.vy) > b.maxSpeedY) b.vy = Math.sign(b.vy) * b.maxSpeedY;

    const dx = b.vx * dt;
    const dy = b.vy * dt;
    // Ride moving platforms: follow the carrier's displacement directly.
    const carrier = b.ground ? moved.get(b.ground) : undefined;
    if (carrier) {
      b.x += carrier.dx;
      b.y += carrier.dy;
    }

    b.touching.left = b.touching.right = b.touching.top = b.touching.bottom = false;
    b.onGround = false;
    b.ground = null;

    if (b.sensor) {
      b.x += dx;
      b.y += dy;
      return;
    }

    let maxStep = Math.max(1, Math.min(b.w, b.h) / 2);
    if (this.tilemap) maxStep = Math.min(maxStep, this.tilemap.tileW / 2, this.tilemap.tileH / 2);
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / maxStep));
    const sx = dx / steps;
    const sy = dy / steps;
    let blockX = false;
    let blockY = false;
    for (let i = 0; i < steps && !(blockX && blockY); i++) {
      if (!blockX && sx !== 0) blockX = this.moveX(b, sx);
      if (!blockY && sy !== 0) blockY = this.moveY(b, sy);
    }
    // Ground probe: resting contact even when not moving down this step.
    if (!b.touching.bottom && b.vy >= 0) {
      const probe = { x: b.x, y: b.y + b.h, w: b.w, h: 0.5 };
      if (this.groundBelow(b, probe)) {
        b.touching.bottom = true;
        b.onGround = true;
      }
    }
  }

  /** Move along X; returns true if blocked. */
  private moveX(b: Body, d: number): boolean {
    b.x += d;
    let hit: Body | TileRef | null = null;
    let limit = d > 0 ? Infinity : -Infinity;
    const tm = this.tilemap;
    if (tm) {
      for (const t of tm.solidTilesIn(b)) {
        const r = tm.tileRect(t.col, t.row);
        if (d > 0 ? r.x < limit : r.x + r.w > limit) {
          limit = d > 0 ? r.x : r.x + r.w;
          hit = t;
        }
      }
    }
    for (const o of this.bodies) {
      if (o === b || !o.enabled || !o.isStatic || o.oneWay || o.sensor || !Rect.intersects(b, o)) continue;
      if (d > 0 ? o.x < limit : o.x + o.w > limit) {
        limit = d > 0 ? o.x : o.x + o.w;
        hit = o;
      }
    }
    if (!hit) return false;
    b.x = d > 0 ? limit - b.w : limit;
    const side: Side = d > 0 ? 'right' : 'left';
    b.touching[side] = true;
    b.vx = Math.abs(b.vx) * b.bounce > 1 ? -b.vx * b.bounce : 0;
    b.onCollide?.(hit, side);
    return true;
  }

  /** Move along Y; returns true if blocked. */
  private moveY(b: Body, d: number): boolean {
    const prevBottom = b.y + b.h;
    b.y += d;
    let hit: Body | TileRef | null = null;
    let limit = d > 0 ? Infinity : -Infinity;
    const tm = this.tilemap;
    if (tm) {
      const { c0, r0, c1, r1 } = tm.tileRange(b);
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          const solid = tm.isSolid(col, row);
          const oneWay = !solid && d > 0 && !b.ignoreOneWay && tm.isOneWay(col, row);
          if (!solid && !oneWay) continue;
          const top = tm.y + row * tm.tileH;
          if (oneWay && prevBottom > top + EPS) continue;
          const edge = d > 0 ? top : top + tm.tileH;
          if (d > 0 ? edge < limit : edge > limit) {
            limit = edge;
            hit = { col, row, id: tm.get(col, row) };
          }
        }
      }
    }
    for (const o of this.bodies) {
      if (o === b || !o.enabled || !o.isStatic || o.sensor || !Rect.intersects(b, o)) continue;
      if (o.oneWay && (d < 0 || b.ignoreOneWay || prevBottom > o.y + EPS)) continue;
      const edge = d > 0 ? o.y : o.y + o.h;
      if (d > 0 ? edge < limit : edge > limit) {
        limit = edge;
        hit = o;
      }
    }
    if (!hit) return false;
    b.y = d > 0 ? limit - b.h : limit;
    const side: Side = d > 0 ? 'bottom' : 'top';
    b.touching[side] = true;
    if (d > 0) {
      b.onGround = true;
      if (hit instanceof Body) b.ground = hit;
    }
    b.vy = Math.abs(b.vy) * b.bounce > 1 ? -b.vy * b.bounce : 0;
    b.onCollide?.(hit, side);
    return true;
  }

  private groundBelow(b: Body, probe: RectLike): boolean {
    const tm = this.tilemap;
    if (tm) {
      const { c0, r0, c1, r1 } = tm.tileRange(probe);
      for (let row = r0; row <= r1; row++)
        for (let col = c0; col <= c1; col++) {
          if (tm.isSolid(col, row)) return true;
          if (!b.ignoreOneWay && tm.isOneWay(col, row) && Math.abs(tm.y + row * tm.tileH - (b.y + b.h)) < 0.01) return true;
        }
    }
    for (const o of this.bodies) {
      if (o === b || !o.enabled || !o.isStatic || o.sensor || !Rect.intersects(probe, o)) continue;
      if (o.oneWay && (b.ignoreOneWay || Math.abs(o.y - (b.y + b.h)) > 0.01)) continue;
      b.ground = o;
      return true;
    }
    return false;
  }
}

import { describe, expect, it } from 'vitest';
import { Camera } from '../src/camera';
import { Physics, Body } from '../src/physics';
import { Tilemap } from '../src/tilemap';
import { Easing, Timers, Tween, TweenManager } from '../src/tween';
import { SceneManager } from '../src/scenes';
import { ParticleEmitter } from '../src/particles';

const level = [
  '..........',
  '..........',
  '....=.....',
  '..........',
  '#........#',
  '##########',
];
const legend = { '#': 1, '=': 2 };

describe('Tilemap', () => {
  it('builds from strings and numbers', () => {
    const m = Tilemap.fromArray(level, 16, 16, legend);
    expect(m.cols).toBe(10);
    expect(m.rows).toBe(6);
    expect(m.get(0, 5)).toBe(1);
    expect(m.get(4, 2)).toBe(2);
    expect(m.get(-1, 0)).toBe(-1);
    expect(m.pixelWidth).toBe(160);
    const n = Tilemap.fromArray([[0, 1], [1, 0]], 8);
    expect(n.get(1, 0)).toBe(1);
  });
  it('maps world coords and solidity', () => {
    const m = Tilemap.fromArray(level, 16, 16, legend);
    expect(m.colAt(17)).toBe(1);
    expect(m.getAt(5, 85)).toBe(1);
    expect(m.isSolid(0, 5)).toBe(true);
    expect(m.isSolid(4, 2)).toBe(true);
    m.setOneWay([2]);
    expect(m.isSolid(4, 2)).toBe(false);
    expect(m.isOneWay(4, 2)).toBe(true);
    m.setSolid([1]);
    expect(m.isSolid(0, 5)).toBe(true);
    expect(m.isSolid(-1, 0)).toBe(false);
    m.solidBounds.left = true;
    expect(m.isSolid(-1, 0)).toBe(true);
  });
  it('queries rect overlaps, find and replace', () => {
    const m = Tilemap.fromArray(level, 16, 16, legend);
    expect(m.overlapsSolid({ x: 20, y: 60, w: 10, h: 19 })).toBe(false); // ends exactly at row 5 top (80)
    expect(m.overlapsSolid({ x: 20, y: 60, w: 10, h: 21 })).toBe(true);
    expect(m.solidTilesIn({ x: 0, y: 64, w: 20, h: 20 }).length).toBe(3);
    expect(m.find(2)).toEqual([{ col: 4, row: 2, id: 2 }]);
    expect(m.replace(2, 0)).toBe(1);
    expect(m.get(4, 2)).toBe(0);
  });
  it('loads Pixelforge and Tiled JSON', () => {
    const a = Tilemap.fromJSON({ cols: 2, rows: 2, tileW: 8, data: [1, 0, 0, 1], oneWay: [3] });
    expect(a.get(1, 1)).toBe(1);
    expect(a.oneWay.has(3)).toBe(true);
    const b = Tilemap.fromJSON({ width: 3, height: 1, tilewidth: 32, tileheight: 32, layers: [{ type: 'tilelayer', data: [0, 5, 0] }] });
    expect(b.tileW).toBe(32);
    expect(b.get(1, 0)).toBe(5);
    expect(() => Tilemap.fromJSON({})).toThrow();
  });
});

describe('Physics', () => {
  const dt = 1 / 60;
  it('falls under gravity and lands on the tilemap', () => {
    const m = Tilemap.fromArray(level, 16, 16, legend);
    const world = new Physics({ gravity: 900, tilemap: m });
    const b = world.add({ x: 20, y: 0, w: 12, h: 14 });
    for (let i = 0; i < 120; i++) world.step(dt);
    expect(b.onGround).toBe(true);
    expect(b.y + b.h).toBeCloseTo(80, 5);
    expect(b.vy).toBe(0);
  });
  it('is blocked by walls on the X axis', () => {
    const m = Tilemap.fromArray(level, 16, 16, legend);
    const world = new Physics({ gravity: 900, tilemap: m });
    const b = world.add({ x: 30, y: 60, w: 12, h: 14 });
    let side = '';
    b.onCollide = (_o, s) => {
      if (s === 'left') side = s;
    };
    b.vx = -400;
    for (let i = 0; i < 30; i++) {
      b.vx = -400;
      world.step(dt);
    }
    expect(b.x).toBeCloseTo(16, 5);
    expect(b.touching.left).toBe(true);
    expect(side).toBe('left');
  });
  it('lands on one-way platforms from above but passes from below', () => {
    const m = Tilemap.fromArray(level, 16, 16, legend).setOneWay([2]);
    const world = new Physics({ gravity: 900, tilemap: m });
    // from above
    const a = world.add({ x: 66, y: 0, w: 12, h: 12 });
    for (let i = 0; i < 60; i++) world.step(dt);
    expect(a.y + a.h).toBeCloseTo(32, 5);
    expect(a.onGround).toBe(true);
    // from below: jump up through it
    world.remove(a);
    const b = world.add({ x: 66, y: 60, w: 12, h: 12, vy: -500 });
    let minY = Infinity;
    for (let i = 0; i < 20; i++) {
      world.step(dt);
      minY = Math.min(minY, b.y);
    }
    expect(minY).toBeLessThan(32);
  });
  it('does not tunnel through thin floors at high speed', () => {
    const m = Tilemap.fromArray(level, 16, 16, legend);
    const world = new Physics({ gravity: 0, tilemap: m });
    const b = world.add({ x: 20, y: 0, w: 4, h: 4, vy: 5000 });
    world.step(dt);
    expect(b.y + b.h).toBeLessThanOrEqual(80);
  });
  it('collides with static bodies, bounces, and rides kinematic platforms', () => {
    const world = new Physics({ gravity: 900 });
    const floor = world.add({ x: 0, y: 100, w: 200, h: 10, isStatic: true });
    const ball = world.add({ x: 50, y: 0, w: 10, h: 10, bounce: 0.5 });
    let bounced = false;
    for (let i = 0; i < 60; i++) {
      world.step(dt);
      if (ball.vy < 0) bounced = true;
    }
    expect(bounced).toBe(true);
    expect(ball.y + ball.h).toBeLessThanOrEqual(100 + 1e-6);

    const w2 = new Physics({ gravity: 900 });
    const plat = w2.add(new Body({ x: 0, y: 100, w: 50, h: 8, isStatic: true, vx: 60 }));
    const rider = w2.add({ x: 10, y: 80, w: 10, h: 20 });
    for (let i = 0; i < 60; i++) w2.step(dt);
    expect(rider.onGround).toBe(true);
    expect(rider.x).toBeGreaterThan(60); // carried ~60 units to the right
    expect(plat.x).toBeCloseTo(60, 3);
    expect(floor.isStatic).toBe(true);
  });
  it('applies drag and max speed, sensors pass through', () => {
    const world = new Physics();
    const b = world.add({ vx: 100, dragX: 600, maxSpeedX: 50 });
    world.step(dt);
    expect(b.vx).toBeLessThanOrEqual(50);
    for (let i = 0; i < 10; i++) world.step(dt);
    expect(b.vx).toBe(0);
    world.add({ x: 100, y: 0, w: 10, h: 100, isStatic: true });
    const s = world.add({ x: 80, y: 10, w: 5, h: 5, vx: 600, sensor: true });
    for (let i = 0; i < 10; i++) world.step(dt);
    expect(s.x).toBeGreaterThan(120);
    expect(world.query({ x: 0, y: 0, w: 1000, h: 1000 }).length).toBe(3);
  });
});

describe('Tween / Easing / Timers', () => {
  it('easing endpoints', () => {
    for (const [name, fn] of Object.entries(Easing)) {
      expect(fn(0), name).toBeCloseTo(0, 5);
      expect(fn(1), name).toBeCloseTo(1, 5);
    }
    expect(Easing.quadIn(0.5)).toBe(0.25);
  });
  it('tweens properties with delay and completes', async () => {
    const obj = { x: 0, y: 10 };
    let done = 0;
    const t = new Tween(obj, { x: 100 }, 1, { ease: 'linear', delay: 0.5, onComplete: () => done++ });
    t.update(0.5);
    expect(obj.x).toBe(0);
    t.update(0.5);
    expect(obj.x).toBeCloseTo(50);
    expect(t.update(0.6)).toBe(false);
    expect(obj.x).toBe(100);
    expect(obj.y).toBe(10);
    expect(done).toBe(1);
    await expect(t.finished).resolves.toBeUndefined();
  });
  it('repeats with yoyo', () => {
    const obj = { a: 0 };
    const t = new Tween(obj, { a: 10 }, 1, { ease: 'linear', repeat: 1, yoyo: true });
    t.update(1);
    expect(obj.a).toBe(10);
    t.update(0.5);
    expect(obj.a).toBeCloseTo(5);
    t.update(0.5);
    expect(obj.a).toBeCloseTo(0);
    expect(t.done).toBe(true);
  });
  it('manager updates and kills tweens', () => {
    const m = new TweenManager();
    const o = { x: 0 };
    m.to(o, { x: 1 }, 1);
    expect(m.count).toBe(1);
    m.update(0.5);
    expect(o.x).toBeGreaterThan(0);
    m.killTweensOf(o);
    expect(m.count).toBe(0);
  });
  it('timers fire after/every', () => {
    const t = new Timers();
    let a = 0;
    let b = 0;
    t.after(0.1, () => a++);
    const h = t.every(0.1, () => b++);
    for (let i = 0; i < 35; i++) t.update(0.01);
    expect(a).toBe(1);
    expect(b).toBe(3);
    h.cancel();
    t.update(1);
    expect(b).toBe(3);
  });
});

describe('Camera', () => {
  it('maps screen <-> world with zoom and clamps to bounds', () => {
    const c = new Camera(200, 100);
    c.x = 50;
    c.y = 0;
    c.zoom = 2;
    const w = c.screenToWorld(100, 50);
    expect(w).toEqual({ x: 150, y: 50 });
    const s = c.worldToScreen(w.x, w.y);
    expect(s.x).toBeCloseTo(100);
    expect(c.view().w).toBe(100);
    c.zoom = 1;
    c.bounds = { x: 0, y: 0, w: 300, h: 100 };
    c.centerOn(1000, 50);
    expect(c.x).toBe(100);
    c.centerOn(-1000, 50);
    expect(c.x).toBe(0);
  });
  it('shake decays to zero', () => {
    const c = new Camera(100, 100, () => 1);
    c.shake(10, 0.1);
    c.update(0.05);
    expect(c.shakeX).toBeCloseTo(5);
    c.update(0.1);
    expect(c.shakeX).toBe(0);
  });
});

describe('SceneManager', () => {
  it('pushes, pops, replaces with lifecycle hooks', async () => {
    const log: string[] = [];
    const mk = (n: string, extra: object = {}) => ({
      load: async () => void log.push(`load ${n}`),
      enter: () => void log.push(`enter ${n}`),
      exit: () => void log.push(`exit ${n}`),
      update: () => void log.push(`update ${n}`),
      render: () => void log.push(`render ${n}`),
      ...extra,
    });
    const sm = new SceneManager({});
    await sm.push(mk('a'));
    await sm.push(mk('b', { overlay: true }));
    log.length = 0;
    sm.update(1);
    sm.render(0);
    expect(log).toEqual(['update b', 'render a', 'render b']);
    await sm.replace(mk('c'));
    expect(log.slice(3)).toEqual(['load c', 'exit b', 'enter c']);
    await sm.pop();
    expect(sm.size).toBe(1);
    await sm.clear();
    expect(sm.current).toBeUndefined();
  });
});

describe('ParticleEmitter', () => {
  it('bursts, ages and recycles particles', () => {
    const e = new ParticleEmitter({ life: 0.5, speed: 10, maxParticles: 50 });
    e.burst(100);
    expect(e.count).toBe(50);
    e.update(0.25);
    expect(e.count).toBe(50);
    e.update(0.3);
    expect(e.count).toBe(0);
    const c = new ParticleEmitter({ rate: 100, life: 10 });
    c.update(0.1);
    expect(c.count).toBe(10);
  });
});

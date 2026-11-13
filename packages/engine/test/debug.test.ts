import { describe, expect, it, vi } from 'vitest';
import { activity, debugLines, DrawCounter, FrameMeter } from '../src/debug';
import { ParticleEmitter } from '../src/particles';
import { Physics } from '../src/physics';
import { Platform, type PlatformMessage } from '../src/platform';
import { TweenManager } from '../src/tween';

describe('achievements', () => {
  it('posts webgame:achievement once per id per session', () => {
    const sent: PlatformMessage[] = [];
    const p = new Platform((m) => sent.push(m));
    expect(p.unlockAchievement('first_blood')).toBe(true);
    expect(p.unlockAchievement('first_blood')).toBe(false);
    expect(p.unlockAchievement('combo-10')).toBe(true);
    expect(sent).toEqual([
      { type: 'webgame:achievement', id: 'first_blood' },
      { type: 'webgame:achievement', id: 'combo-10' },
    ]);
    expect(p.isUnlocked('first_blood')).toBe(true);
    expect(p.achievements).toEqual(['first_blood', 'combo-10']);
  });

  it('rejects invalid ids without posting', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: PlatformMessage[] = [];
    const p = new Platform((m) => sent.push(m));
    for (const id of ['', 'Upper', 'has space', 'a'.repeat(33), 'dot.id', 42 as unknown as string, undefined as unknown as string])
      expect(p.unlockAchievement(id)).toBe(false);
    expect(p.unlockAchievement('a'.repeat(32))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(7);
    warn.mockRestore();
  });

  it('a fresh Platform (new session) can unlock again', () => {
    const sent: PlatformMessage[] = [];
    new Platform((m) => sent.push(m)).unlockAchievement('x');
    new Platform((m) => sent.push(m)).unlockAchievement('x');
    expect(sent).toHaveLength(2);
  });
});

describe('debug counters', () => {
  it('DrawCounter tracks the current and the last frame', () => {
    const c = new DrawCounter();
    c.begin();
    c.sprite();
    c.sprite(4);
    c.drawCall();
    c.drawCall();
    expect([c.drawCalls, c.sprites]).toEqual([2, 5]);
    c.end();
    c.begin();
    c.sprite();
    expect(c.last).toEqual({ drawCalls: 2, sprites: 5 });
    expect([c.drawCalls, c.sprites]).toEqual([0, 1]);
  });

  it('collects live particles and enabled bodies of updated emitters / worlds, then resets', () => {
    activity.collect();
    const em = new ParticleEmitter({ life: 10, speed: 0, random: () => 0.5 });
    em.burst(7);
    const em2 = new ParticleEmitter({ life: 10 });
    em2.burst(3);
    em.update(1 / 60);
    em.update(1 / 60); // counted once
    const world = new Physics();
    world.add({ x: 0, y: 0, w: 1, h: 1 });
    world.add({ x: 0, y: 0, w: 1, h: 1 });
    world.add({ x: 0, y: 0, w: 1, h: 1, enabled: false } as never).enabled = false;
    world.step(1 / 60);
    expect(activity.collect()).toEqual({ particles: 7, bodies: 2, emitters: 1, worlds: 1 });
    expect(activity.collect()).toEqual({ particles: 0, bodies: 0, emitters: 0, worlds: 0 });
  });

  it('counts active tweens', () => {
    const tm = new TweenManager();
    const o = { x: 0, y: 0 };
    tm.to(o, { x: 1 }, 0.1);
    tm.to(o, { y: 1 }, 1);
    expect(tm.count).toBe(2);
    tm.update(0.2);
    expect(tm.count).toBe(1);
  });

  it('FrameMeter smooths fps / frame time and ignores bogus samples', () => {
    const m = new FrameMeter(0.5);
    m.sample(0);
    m.sample(5);
    expect(m.fps).toBe(0);
    m.sample(1 / 60);
    expect(m.fps).toBeCloseTo(60);
    expect(m.frameMs).toBeCloseTo(16.67, 1);
    m.sample(1 / 30);
    expect(m.fps).toBeCloseTo(45);
    expect(m.frameMs).toBeCloseTo(25, 1);
  });

  it('formats the overlay lines', () => {
    const lines = debugLines({ fps: 59.6, frameMs: 16.71, workMs: 2.04, drawCalls: 3, sprites: 120, tweens: 2, particles: 40, bodies: 5 });
    expect(lines).toEqual(['FPS 60  16.7 ms (cpu 2.0)', 'draw calls 3  sprites 120', 'tweens 2  particles 40  bodies 5']);
  });
});

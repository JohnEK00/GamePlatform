import { describe, expect, it } from 'vitest';
import { clientToGame, combineAxis, computeLetterbox, GamepadState, InputState } from '../src/input';
import { Platform, Storage } from '../src/platform';

describe('InputState', () => {
  it('reports pressed for exactly one step', () => {
    const s = new InputState();
    s.press('Space');
    expect(s.isDown('Space')).toBe(true);
    expect(s.wasPressed('Space')).toBe(true);
    s.endStep();
    expect(s.wasPressed('Space')).toBe(false);
    expect(s.isDown('Space')).toBe(true);
    s.release('Space');
    expect(s.wasReleased('Space')).toBe(true);
    expect(s.isDown('Space')).toBe(false);
    s.endStep();
    expect(s.wasReleased('Space')).toBe(false);
  });
  it('ignores key repeat and keeps quick taps visible', () => {
    const s = new InputState();
    s.press('KeyA');
    s.endStep();
    s.press('KeyA'); // OS repeat while held
    expect(s.wasPressed('KeyA')).toBe(false);
    s.release('KeyA');
    s.endStep();
    // press + release between two steps
    s.press('KeyB');
    s.release('KeyB');
    expect(s.wasPressed('KeyB')).toBe(true);
    expect(s.wasReleased('KeyB')).toBe(true);
    expect(s.isDown('KeyB')).toBe(false);
    expect(s.anyPressed()).toBe(true);
    s.endStep();
    expect(s.anyPressed()).toBe(false);
  });
  it('releaseAll releases held keys', () => {
    const s = new InputState();
    s.press('ArrowLeft');
    s.endStep();
    s.releaseAll();
    expect(s.isDown('ArrowLeft')).toBe(false);
    expect(s.wasReleased('ArrowLeft')).toBe(true);
    expect(s.isDown('Unknown')).toBe(false);
  });
});

describe('coordinate mapping', () => {
  it('letterboxes preserving aspect', () => {
    expect(computeLetterbox(1600, 600, 800, 600)).toEqual({ width: 800, height: 600, x: 400, y: 0, scale: 1 });
    const lb = computeLetterbox(400, 1000, 800, 600);
    expect(lb.scale).toBe(0.5);
    expect(lb.height).toBe(300);
    expect(lb.y).toBe(350);
  });
  it('maps client coordinates into game coordinates', () => {
    const rect = { left: 10, top: 20, width: 400, height: 300 };
    expect(clientToGame(10, 20, rect, 800, 600)).toEqual({ x: 0, y: 0 });
    expect(clientToGame(410, 320, rect, 800, 600)).toEqual({ x: 800, y: 600 });
    // element stretched wider than the game: letterbox inside it
    const wide = { left: 0, top: 0, width: 1000, height: 300 };
    expect(clientToGame(500, 150, wide, 800, 600)).toEqual({ x: 400, y: 300 });
    expect(clientToGame(300, 0, wide, 800, 600)).toEqual({ x: 0, y: 0 });
  });
  it('combines axes with deadzone', () => {
    expect(combineAxis(true, false)).toBe(-1);
    expect(combineAxis(true, true)).toBe(0);
    expect(combineAxis(false, false, 0.1)).toBe(0);
    expect(combineAxis(false, false, 1)).toBe(1);
    expect(combineAxis(false, false, -0.6)).toBeCloseTo(-0.5);
  });
});

describe('GamepadState', () => {
  it('derives pressed/released edges between polls', () => {
    const g = new GamepadState();
    const pad = (a: boolean) =>
      ({ connected: true, id: 'pad', axes: [0.5, 0], buttons: [{ pressed: a, value: a ? 1 : 0 }] }) as unknown as Gamepad;
    g.poll(pad(false));
    g.poll(pad(true));
    expect(g.wasPressed('A')).toBe(true);
    expect(g.isDown(0)).toBe(true);
    g.poll(pad(true));
    expect(g.wasPressed('A')).toBe(false);
    g.poll(pad(false));
    expect(g.wasReleased('A')).toBe(true);
    expect(g.leftX).toBe(0.5);
    g.poll(null);
    expect(g.connected).toBe(false);
  });
});

describe('Platform & Storage', () => {
  it('posts the contract messages', () => {
    const sent: unknown[] = [];
    const p = new Platform((m) => sent.push(m));
    p.submitScore(1234);
    p.submitScore(NaN);
    p.ready();
    p.ready();
    p.error('boom');
    expect(sent).toEqual([
      { type: 'webgame:score', score: 1234, requestId: 'sc-1' },
      { type: 'webgame:ready' },
      { type: 'webgame:error', message: 'boom' },
    ]);
  });
  it('stores JSON values in memory and mirrors saves', () => {
    const sent: unknown[] = [];
    const s = new Storage('t', new Platform((m) => sent.push(m)), 0);
    expect(s.get('hi', 0)).toBe(0);
    s.set('hi', { best: 5 });
    expect(s.get('hi')).toEqual({ best: 5 });
    expect(sent).toEqual([{ type: 'webgame:save', data: { hi: { best: 5 } } }]);
    s.hydrate({ other: 3 });
    expect(s.get('other')).toBe(3);
    expect(sent).toHaveLength(1); // hydrate does not echo
    s.remove('hi');
    expect(sent[1]).toEqual({ type: 'webgame:save', data: { other: 3 } });
    s.hydrate(null);
    s.hydrate('nope');
    expect(s.snapshot()).toEqual({ other: 3 });
  });
});

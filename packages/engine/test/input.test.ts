import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseActions, type ControlAction } from '../src/actions';
import { bootActions, Engine, isOverridesObject } from '../src/engine';
import { clientToGame, combineAxis, computeLetterbox, GamepadState, Input, InputState } from '../src/input';
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

// --- F009: actions on Input -------------------------------------------------

const MOVE = parseActions([
  { id: 'left', name: 'Left', keys: ['KeyJ'], gamepad: ['Left'] },
  { id: 'right', name: 'Right', keys: ['KeyL'], gamepad: ['Right'] },
  { id: 'up', name: 'Up', keys: ['KeyI'] },
  { id: 'down', name: 'Down', keys: ['KeyK'] },
  { id: 'fire', name: 'Fire', keys: ['Space', 'KeyZ'], gamepad: ['A'] },
]).actions;

function makeInput(actions: readonly ControlAction[] = []): Input {
  const i = new Input({} as HTMLCanvasElement, 320, 180);
  i.setActions(actions);
  return i;
}
/** One fixed step the way the engine runs it (events, beginStep, read, endStep). */
function step<T>(i: Input, events: () => void, read: () => T): T {
  events();
  i.beginStep();
  const r = read();
  i.endStep();
  return r;
}
type PadButtons = Partial<Record<number, boolean>>;
function stubPad(buttons: PadButtons, axes: number[] = [0, 0]): void {
  const list = Array.from({ length: 17 }, (_, k) => ({ pressed: !!buttons[k], value: buttons[k] ? 1 : 0 }));
  vi.stubGlobal('navigator', { getGamepads: () => [{ connected: true, id: 'pad', axes, buttons: list }] });
}

describe('Input actions (F009)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exposes frozen defaults and effective actions', () => {
    const i = makeInput(MOVE);
    expect(i.defaultActions.map((a) => a.id)).toEqual(['left', 'right', 'up', 'down', 'fire']);
    expect(i.actions).toEqual(i.defaultActions);
    expect(Object.isFrozen(i.actions)).toBe(true);
    i.setOverrides({ fire: ['KeyK'] });
    expect(i.actions[4]!.keys).toEqual(['KeyK']);
    expect(i.defaultActions[4]!.keys).toEqual(['Space', 'KeyZ']);
  });

  it('actionDown / Pressed / Released follow the bound keys', () => {
    const i = makeInput(MOVE);
    const s = i.state;
    const read = (): [boolean, boolean, boolean] => [i.actionDown('fire'), i.actionPressed('fire'), i.actionReleased('fire')];
    expect(step(i, () => s.press('Space'), read)).toEqual([true, true, false]);
    expect(step(i, () => s.press('KeyZ'), read)).toEqual([true, false, false]);
    expect(step(i, () => s.release('Space'), read)).toEqual([true, false, false]);
    expect(step(i, () => s.release('KeyZ'), read)).toEqual([false, false, true]);
    expect(step(i, () => { s.press('KeyZ'); s.release('KeyZ'); }, read)).toEqual([false, true, true]);
  });

  it('overrides take effect at the next step and never leave a key stuck', () => {
    const i = makeInput(MOVE);
    const s = i.state;
    step(i, () => s.press('Space'), () => {});
    i.setOverrides({ fire: ['KeyK'] });
    // until the next beginStep the old map still answers
    expect(i.actionDown('fire')).toBe(true);
    expect(step(i, () => {}, () => i.actionDown('fire'))).toBe(false); // Space no longer counts
    expect(step(i, () => s.press('KeyK'), () => i.actionPressed('fire'))).toBe(true);
    s.release('Space');
    s.release('KeyK');
    i.setOverrides({}); // replace, not merge: back to the defaults
    expect(i.actions[4]!.keys).toEqual(['Space', 'KeyZ']);
    expect(step(i, () => {}, () => i.actionReleased('fire'))).toBe(true); // Space's release edge ends the held action
    expect(step(i, () => s.press('Space'), () => i.actionPressed('fire'))).toBe(true);
  });

  it('[] override leaves gamepad bindings working', () => {
    stubPad({ 0: true });
    const i = makeInput(MOVE);
    i.setOverrides({ fire: [] });
    expect(step(i, () => {}, () => [i.actionDown('fire'), i.actionPressed('fire')])).toEqual([true, true]);
    expect(i.actionLabel('fire')).toBe('A');
  });

  it('unknown ids return false / "" and warn once per id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const i = makeInput(MOVE);
    i.beginStep();
    expect(i.actionDown('nope')).toBe(false);
    expect(i.actionPressed('nope')).toBe(false);
    expect(i.actionReleased('nope')).toBe(false);
    expect(i.actionLabel('nope')).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    i.actionDown('other');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('actionLabel uses the first effective key, else the first gamepad button', () => {
    const i = makeInput(parseActions([
      { id: 'jump', name: 'Jump', keys: ['Space', 'ArrowUp'], gamepad: ['A'] },
      { id: 'pad', name: 'Pad', gamepad: ['Up'] },
    ]).actions);
    expect(i.actionLabel('jump')).toBe('Space');
    expect(i.actionLabel('pad')).toBe('D-pad ↑');
    i.setOverrides({ jump: ['KeyK'] });
    expect(i.actionLabel('jump')).toBe('K');
    i.setOverrides({ jump: [] });
    expect(i.actionLabel('jump')).toBe('A');
    expect(i.keyLabel('ArrowLeft')).toBe('←');
    expect(i.keyLabel('Nope')).toBe('Nope');
    expect(i.gamepadLabel('A')).toBe('A');
    expect(i.gamepadLabel('Left')).toBe('D-pad ←');
    expect(i.gamepadLabel('Start')).toBe('Start');
    expect(i.gamepadLabel('Nope')).toBe('Nope');
  });

  it('axis() follows movement actions when both exist', () => {
    const i = makeInput(MOVE);
    const s = i.state;
    expect(step(i, () => s.press('KeyJ'), () => i.axis('horizontal'))).toBe(-1);
    s.release('KeyJ');
    // legacy keys no longer apply
    expect(step(i, () => s.press('ArrowLeft'), () => i.axis('horizontal'))).toBe(0);
    expect(step(i, () => s.press('KeyK'), () => i.axis('vertical'))).toBe(1);
    s.release('KeyK');
    s.release('ArrowLeft');
    i.setOverrides({ right: ['ArrowRight'] });
    expect(step(i, () => s.press('ArrowRight'), () => i.axis('horizontal'))).toBe(1);
  });

  it('axis() with actions still uses the left stick and the bound d-pad', () => {
    stubPad({}, [-1, 0.6]);
    const i = makeInput(MOVE);
    const [h, v] = step(i, () => {}, () => [i.axis('horizontal'), i.axis('vertical')]);
    expect(h).toBe(-1);
    expect(v).toBeCloseTo(0.5);
    stubPad({ 15: true }, [0, 0]);
    expect(step(i, () => {}, () => i.axis('horizontal'))).toBe(1);
  });

  it('axis() without both movement actions keeps the legacy behaviour', () => {
    for (const actions of [[], parseActions([{ id: 'left', name: 'Left', keys: ['KeyJ'] }]).actions]) {
      const i = makeInput(actions);
      const s = i.state;
      expect(step(i, () => s.press('KeyA'), () => i.axis('horizontal'))).toBe(-1);
      s.release('KeyA');
      expect(step(i, () => s.press('KeyJ'), () => i.axis('horizontal'))).toBe(0);
      expect(step(i, () => s.press('ArrowDown'), () => i.axis('vertical'))).toBe(1);
    }
  });

  it('raw input is not remapped', () => {
    const i = makeInput(MOVE);
    i.setOverrides({ fire: ['KeyK'] });
    expect(step(i, () => i.state.press('Space'), () => [i.isDown('Space'), i.wasPressed('Space'), i.anyPressed()])).toEqual([true, true, true]);
  });
});

describe('webgame:controls message (F009)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the actions boot option is parsed leniently with prefixed warnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = bootActions([{ id: 'jump', name: 'Jump', keys: ['Escape', 'Space'] }, { id: 'bad' }]);
    expect(list).toEqual([{ id: 'jump', name: 'Jump', keys: ['Space'], gamepad: [] }]);
    expect(warn).toHaveBeenCalledTimes(2);
    for (const c of warn.mock.calls) expect(c[0]).toBe('[pixelforge] actions:');
    expect(bootActions(undefined)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('isOverridesObject accepts plain objects with at most 32 own keys', () => {
    expect(isOverridesObject({})).toBe(true);
    expect(isOverridesObject(Object.create(null))).toBe(true);
    expect(isOverridesObject([])).toBe(false);
    expect(isOverridesObject(new Date())).toBe(false);
    expect(isOverridesObject(Object.fromEntries(Array.from({ length: 33 }, (_, k) => [`a${k}`, []])))).toBe(false);
  });

  function fakeEngine(): { input: Input; send(data: unknown, source: unknown): void } {
    const e = Object.create(Engine.prototype) as Engine;
    const input = makeInput(MOVE);
    Object.assign(e, { input });
    const onMessage = (e as unknown as { onMessage(ev: { data: unknown; source: unknown }): void }).onMessage.bind(e);
    return { input, send: (data, source) => onMessage({ data, source }) };
  }

  it('accepts overrides from window.parent only', () => {
    const parent = {};
    vi.stubGlobal('window', { parent });
    const { input, send } = fakeEngine();
    send({ type: 'webgame:controls', overrides: { fire: ['KeyK'] } }, {});
    expect(input.actions[4]!.keys).toEqual(['Space', 'KeyZ']);
    send({ type: 'webgame:controls', overrides: { fire: ['KeyK'] } }, parent);
    expect(input.actions[4]!.keys).toEqual(['KeyK']);
  });

  it('ignores non-objects and objects with more than 32 keys', () => {
    const parent = {};
    vi.stubGlobal('window', { parent });
    const { input, send } = fakeEngine();
    send({ type: 'webgame:controls', overrides: { fire: ['KeyK'] } }, parent);
    const big: Record<string, string[]> = { fire: ['KeyQ'] };
    for (let k = 0; k < 32; k++) big[`x${k}`] = [];
    expect(Object.keys(big)).toHaveLength(33);
    for (const overrides of [big, null, 'fire', [['KeyQ']], undefined, new Map([['fire', ['KeyQ']]])])
      send({ type: 'webgame:controls', overrides }, parent);
    expect(input.actions[4]!.keys).toEqual(['KeyK']);
    delete big.x0; // 32 keys is fine
    send({ type: 'webgame:controls', overrides: big }, parent);
    expect(input.actions[4]!.keys).toEqual(['KeyQ']);
  });

  it('a second message replaces the first', () => {
    const parent = {};
    vi.stubGlobal('window', { parent });
    const { input, send } = fakeEngine();
    send({ type: 'webgame:controls', overrides: { fire: ['KeyK'], left: ['KeyQ'] } }, parent);
    send({ type: 'webgame:controls', overrides: { right: ['KeyE'] } }, parent);
    expect(input.actions.map((a) => a.keys)).toEqual([['KeyJ'], ['KeyE'], ['KeyI'], ['KeyK'], ['Space', 'KeyZ']]);
  });
});

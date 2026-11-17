import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseActions } from '../src/actions';
import { Input } from '../src/input';

// A minimal DOM: Node's EventTarget/Event stand in for window and KeyboardEvent (no jsdom needed).
function fakeCanvas(): HTMLCanvasElement {
  const t = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(t, { style: {}, tabIndex: -1, focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }) });
  return t as unknown as HTMLCanvasElement;
}
type KeyInit = { ctrlKey?: boolean; metaKey?: boolean; repeat?: boolean; key?: string };
function keyEvent(type: string, code: string, init: KeyInit = {}): Event {
  return Object.assign(new Event(type, { cancelable: true }), { code, key: 'x', ctrlKey: false, metaKey: false, repeat: false, ...init });
}

describe('keydown default handling (F009)', () => {
  let input: Input | null = null;
  let win: EventTarget;
  afterEach(() => {
    input?.detach();
    input = null;
    vi.unstubAllGlobals();
  });

  function setup(): Input {
    win = new EventTarget();
    vi.stubGlobal('window', Object.assign(win, { focus() {} }));
    input = new Input(fakeCanvas(), 320, 180);
    input.setActions(parseActions([
      { id: 'fire', name: 'Fire', keys: ['KeyJ', 'Mouse0'] },
      { id: 'jump', name: 'Jump', keys: ['Slash'] },
    ]).actions);
    input.attach();
    return input;
  }
  function key(code: string, init: KeyInit = {}): boolean {
    const e = keyEvent('keydown', code, init);
    win.dispatchEvent(e);
    win.dispatchEvent(keyEvent('keyup', code));
    return e.defaultPrevented;
  }

  it('prevents default for keyboard codes bound in the effective actions', () => {
    const i = setup();
    expect(key('KeyJ')).toBe(true);
    expect(key('Slash')).toBe(true); // Firefox quick find
    expect(key('Space')).toBe(true); // existing PREVENT set
    expect(key('KeyQ')).toBe(false);
    expect(key('F3')).toBe(false); // not bindable; the engine's own F3 handler deals with it
    expect(key('KeyJ', { ctrlKey: true })).toBe(false);
    expect(key('KeyJ', { metaKey: true })).toBe(false);
    i.setOverrides({ fire: ['KeyQ'] });
    expect(key('KeyQ')).toBe(true);
    expect(key('KeyJ')).toBe(false);
  });

  it('feeds key events into the action edges', () => {
    const i = setup();
    win.dispatchEvent(keyEvent('keydown', 'KeyJ', { key: 'j' }));
    i.beginStep();
    expect(i.actionPressed('fire')).toBe(true);
    i.endStep();
    win.dispatchEvent(keyEvent('keyup', 'KeyJ', { key: 'j' }));
    i.beginStep();
    expect(i.actionReleased('fire')).toBe(true);
    expect(i.actionDown('fire')).toBe(false);
  });
});

describe('cancelled releases (review 5 M2)', () => {
  let input: Input | null = null;
  let win: EventTarget;
  afterEach(() => {
    input?.detach();
    input = null;
    vi.unstubAllGlobals();
  });
  function setup(): { i: Input; canvas: HTMLCanvasElement } {
    win = new EventTarget();
    vi.stubGlobal('window', Object.assign(win, { focus() {} }));
    const canvas = fakeCanvas();
    input = new Input(canvas, 320, 180);
    input.attach();
    return { i: input, canvas };
  }
  const ptr = (type: string, init: Record<string, unknown> = {}): Event =>
    Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true, clientX: 50, clientY: 15, ...init });

  it('pointerup is a real release; pointercancel and blur are cancellations', () => {
    const { i, canvas } = setup();
    canvas.dispatchEvent(ptr('pointerdown'));
    i.beginStep();
    expect(i.mouse.pressed).toBe(true);
    i.endStep();
    win.dispatchEvent(ptr('pointerup'));
    i.beginStep();
    expect(i.mouse.released).toBe(true);
    expect(i.mouse.cancelled).toBe(false);
    i.endStep();

    canvas.dispatchEvent(ptr('pointerdown'));
    i.beginStep();
    i.endStep();
    win.dispatchEvent(ptr('pointercancel', { button: -1 })); // browsers report button -1 on cancel
    i.beginStep();
    expect(i.mouse.down).toBe(false);
    expect(i.mouse.released).toBe(true);
    expect(i.mouse.cancelled).toBe(true);
    i.endStep();
    i.beginStep();
    expect(i.mouse.cancelled).toBe(false);
    i.endStep();

    canvas.dispatchEvent(ptr('pointerdown', { pointerType: 'touch' }));
    i.beginStep();
    i.endStep();
    win.dispatchEvent(new Event('blur'));
    i.beginStep();
    expect(i.mouse.released).toBe(true);
    expect(i.mouse.cancelled).toBe(true);
    expect(i.wasReleased('Mouse0')).toBe(true);
    i.endStep();
  });
});

describe('lastDevice from DOM events and the focus latch (F016)', () => {
  let input: Input | null = null;
  let win: EventTarget;
  let buttons: boolean[] = [];
  afterEach(() => {
    input?.detach();
    input = null;
    vi.unstubAllGlobals();
  });
  function setup(): { i: Input; canvas: HTMLCanvasElement } {
    win = new EventTarget();
    vi.stubGlobal('window', Object.assign(win, { focus() {} }));
    buttons = [];
    vi.stubGlobal('navigator', {
      getGamepads: () => [{ connected: true, id: 'pad', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, k) => ({ pressed: !!buttons[k], value: 0 })) }],
    });
    const canvas = fakeCanvas();
    input = new Input(canvas, 320, 180);
    input.setActions(parseActions([{ id: 'jump', name: 'Jump', keys: ['Space'], gamepad: ['A'] }]).actions);
    input.attach();
    return { i: input, canvas };
  }
  const ptr = (type: string, pointerType: string, init: Record<string, unknown> = {}): Event =>
    Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, pointerType, button: 0, isPrimary: true, clientX: 5, clientY: 5, ...init });
  const step = (i: Input): void => {
    i.beginStep();
    i.endStep();
  };

  it('starts as "keyboard" and follows presses from each device', () => {
    const { i, canvas } = setup();
    expect(i.lastDevice).toBe('keyboard');
    canvas.dispatchEvent(ptr('pointerdown', 'mouse'));
    expect(i.lastDevice).toBe('mouse');
    win.dispatchEvent(ptr('pointerup', 'mouse'));
    win.dispatchEvent(keyEvent('keydown', 'KeyQ')); // any code, bound or not
    expect(i.lastDevice).toBe('keyboard');
    canvas.dispatchEvent(ptr('pointerdown', 'touch'));
    expect(i.lastDevice).toBe('touch');
    win.dispatchEvent(ptr('pointerup', 'touch'));
    canvas.dispatchEvent(new Event('mousedown'));
    expect(i.lastDevice).toBe('mouse');
    canvas.dispatchEvent(ptr('pointerdown', 'pen'));
    expect(i.lastDevice).toBe('touch');
    win.dispatchEvent(ptr('pointerup', 'pen'));
    canvas.dispatchEvent(new Event('mousedown'));
    canvas.dispatchEvent(new Event('touchstart'));
    expect(i.lastDevice).toBe('touch');
    // a touch's compatibility mousedown is not a mouse press
    canvas.dispatchEvent(Object.assign(new Event('mousedown'), { sourceCapabilities: { firesTouchEvents: true } }));
    expect(i.lastDevice).toBe('touch');
    step(i);
    buttons[0] = true;
    step(i);
    expect(i.lastDevice).toBe('gamepad');
  });

  it('key repeat, movement, the wheel and releases never change it', () => {
    const { i, canvas } = setup();
    win.dispatchEvent(keyEvent('keydown', 'Space'));
    canvas.dispatchEvent(ptr('pointerdown', 'mouse'));
    expect(i.lastDevice).toBe('mouse');
    win.dispatchEvent(keyEvent('keydown', 'Space', { repeat: true }));
    win.dispatchEvent(keyEvent('keyup', 'Space'));
    win.dispatchEvent(ptr('pointermove', 'mouse'));
    canvas.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { deltaY: 10, clientX: 0, clientY: 0 }));
    win.dispatchEvent(ptr('pointerup', 'mouse'));
    win.dispatchEvent(ptr('pointercancel', 'mouse', { button: -1 }));
    win.dispatchEvent(new Event('blur'));
    expect(i.lastDevice).toBe('mouse');
  });

  it('DOM events and a gamepad edge before the same step: gamepad wins', () => {
    const { i } = setup();
    step(i);
    buttons[1] = true;
    win.dispatchEvent(keyEvent('keydown', 'KeyQ'));
    expect(i.lastDevice).toBe('keyboard');
    i.beginStep();
    expect(i.lastDevice).toBe('gamepad');
    i.endStep();
  });

  it('window focus latches the gamepads: a held button is down but not pressed', () => {
    const { i } = setup();
    step(i);
    buttons[0] = true; // pressed while the page was unfocused
    win.dispatchEvent(new Event('focus'));
    i.beginStep();
    expect([i.gamepad(0).isDown('A'), i.gamepad(0).wasPressed('A'), i.actionDown('jump'), i.actionPressed('jump')]).toEqual([true, false, true, false]);
    i.endStep();
    buttons[0] = false;
    i.beginStep();
    expect(i.actionReleased('jump')).toBe(true);
    i.endStep();
    buttons[0] = true;
    i.beginStep();
    expect(i.actionPressed('jump')).toBe(true);
    i.endStep();
  });
});

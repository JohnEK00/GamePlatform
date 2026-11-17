import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseActions } from '../src/actions';
import { Engine } from '../src/engine';
import { Input } from '../src/input';

// A minimal DOM: Node's EventTarget/Event stand in for window and KeyboardEvent (no jsdom needed).
function fakeCanvas(): HTMLCanvasElement {
  const t = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(t, { style: {}, tabIndex: -1, focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }) });
  return t as unknown as HTMLCanvasElement;
}
type KeyInit = { key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; repeat?: boolean; isComposing?: boolean };
function keyEvent(type: string, code: string, init: KeyInit = {}): Event {
  return Object.assign(new Event(type, { cancelable: true }), {
    code, key: 'Unidentified', ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, ...init,
  });
}

const ACTIONS = parseActions([
  { id: 'left', name: 'Left', keys: ['KeyA'], gamepad: ['Left'] },
  { id: 'right', name: 'Right', keys: ['KeyD'], gamepad: ['Right'] },
  { id: 'jump', name: 'Jump', keys: ['KeyW'] },
  { id: 'fire', name: 'Fire', keys: ['KeyJ', 'Mouse0'], gamepad: ['A'] },
]).actions;

let input: Input | null = null;
let win: EventTarget;
afterEach(() => {
  input?.detach();
  input = null;
  vi.unstubAllGlobals();
});
function setup(extra: Record<string, unknown> = {}): Input {
  win = new EventTarget();
  vi.stubGlobal('window', Object.assign(win, { focus() {} }, extra));
  input = new Input(fakeCanvas(), 320, 180);
  input.setActions(ACTIONS);
  input.attach();
  return input;
}
/** keydown (+ keyup unless `hold`); returns whether the keydown's default was prevented. */
function key(code: string, init: KeyInit = {}, hold = false): boolean {
  const e = keyEvent('keydown', code, init);
  win.dispatchEvent(e);
  if (!hold) win.dispatchEvent(keyEvent('keyup', code, init));
  return e.defaultPrevented;
}
function paste(text: string): boolean {
  const e = Object.assign(new Event('paste', { cancelable: true }), { clipboardData: { getData: (t: string) => (t === 'text/plain' ? text : '') } });
  win.dispatchEvent(e);
  return e.defaultPrevented;
}
function step<T>(i: Input, read: () => T): T {
  i.beginStep();
  const r = read();
  i.endStep();
  return r;
}

describe('input.textEvents (F019)', () => {
  it('collects keydown text (repeats count) and editing keys, in order; [] when none', () => {
    const i = setup();
    expect(step(i, () => i.textEvents)).toEqual([]);
    key('KeyM', { key: 'M' });
    key('KeyM', { key: 'm', repeat: true });
    key('Space', { key: ' ' });
    key('Backspace', { key: 'Backspace' });
    key('ArrowLeft', { key: 'ArrowLeft' });
    key('Home', { key: 'Home' });
    key('ShiftLeft', { key: 'Shift' });
    key('Enter', { key: 'Enter' });
    const ev = step(i, () => i.textEvents);
    expect(ev).toEqual([
      { kind: 'text', text: 'M' },
      { kind: 'text', text: 'm' },
      { kind: 'text', text: ' ' },
      { kind: 'key', key: 'Backspace' },
      { kind: 'key', key: 'ArrowLeft' },
      { kind: 'key', key: 'Home' },
    ]);
    expect(Object.isFrozen(ev)).toBe(true);
    expect(step(i, () => i.textEvents)).toEqual([]);
  });

  it('ignores Ctrl/Meta shortcuts and composition; keeps AltGr characters', () => {
    const i = setup();
    key('KeyC', { key: 'c', ctrlKey: true });
    key('KeyC', { key: 'c', metaKey: true });
    key('KeyQ', { key: '@', ctrlKey: true, altKey: true }); // AltGr on Windows
    key('KeyA', { key: 'a', isComposing: true });
    key('Backspace', { key: 'Backspace', ctrlKey: true });
    key('Delete', { key: 'Delete', altKey: true });
    expect(step(i, () => i.textEvents)).toEqual([{ kind: 'text', text: '@' }]);
  });

  it('paste: newlines/tabs become spaces, filtered, 256 code points max, default prevented', () => {
    const i = setup();
    expect(paste('a\r\nb\rc\nd\te\u0007')).toBe(true);
    expect(paste('')).toBe(true);
    paste('😀'.repeat(300));
    const ev = step(i, () => i.textEvents);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toEqual({ kind: 'text', text: 'a b c d e' });
    const t = ev[1]!;
    expect(t.kind === 'text' && Array.from(t.text).length).toBe(256);
  });

  it('keeps at most 64 events per step', () => {
    const i = setup();
    for (let k = 0; k < 70; k++) key('KeyX', { key: 'x' });
    expect(step(i, () => i.textEvents.length)).toBe(64);
  });

  it('clearTextEvents drops pending events; typed is unaffected by textEvents', () => {
    const i = setup();
    key('KeyX', { key: 'x' });
    i.clearTextEvents();
    key('KeyY', { key: 'y' });
    expect(step(i, () => [i.textEvents, i.typed])).toEqual([[{ kind: 'text', text: 'y' }], 'xy']);
  });
});

describe('keyboard capture (F019)', () => {
  it('a key-only action reports actionReleased in the first captured step; keys then do not press actions', () => {
    const i = setup();
    key('KeyW', { key: 'w' }, true);
    expect(step(i, () => i.actionPressed('jump'))).toBe(true);
    i.setKeyboardCapture(true);
    expect(i.keyboardCaptured).toBe(true);
    expect(step(i, () => [i.actionDown('jump'), i.actionReleased('jump')])).toEqual([false, true]);
    expect(step(i, () => i.actionReleased('jump'))).toBe(false);
    key('KeyJ', { key: 'j' }, true);
    expect(step(i, () => [i.actionPressed('fire'), i.actionDown('fire'), i.wasPressed('KeyJ'), i.typed])).toEqual([false, false, true, 'j']);
    win.dispatchEvent(keyEvent('keyup', 'KeyJ'));
    expect(step(i, () => i.actionReleased('fire'))).toBe(false);
  });

  it('a key held when capture ends does not count until it is released', () => {
    const i = setup();
    i.setKeyboardCapture(true);
    step(i, () => {});
    key('KeyD', { key: 'd' }, true);
    step(i, () => {});
    i.setKeyboardCapture(false);
    expect(step(i, () => [i.actionDown('right'), i.actionPressed('right'), i.axis('horizontal')])).toEqual([false, false, 0]);
    expect(step(i, () => i.actionDown('right'))).toBe(false);
    win.dispatchEvent(keyEvent('keyup', 'KeyD'));
    expect(step(i, () => [i.actionDown('right'), i.actionReleased('right')])).toEqual([false, false]);
    key('KeyD', { key: 'd' }, true);
    expect(step(i, () => [i.actionPressed('right'), i.axis('horizontal')])).toEqual([true, 1]);
  });

  it('gamepad and Mouse0 still drive actions; axis() follows; raw input is unchanged', () => {
    const buttons: boolean[] = Array.from({ length: 17 }, () => false);
    vi.stubGlobal('navigator', {
      getGamepads: () => [{ connected: true, id: 'pad', axes: [0, 0], buttons: buttons.map((p) => ({ pressed: p, value: p ? 1 : 0 })) }],
    });
    const i = setup();
    i.setKeyboardCapture(true);
    step(i, () => {});
    key('KeyA', { key: 'a' }, true);
    buttons[15] = true; // D-pad right
    expect(step(i, () => [i.axis('horizontal'), i.isDown('KeyA'), i.wasPressed('KeyA'), i.actionDown('left'), i.actionPressed('right')]))
      .toEqual([1, true, true, false, true]);
    i.state.press('Mouse0');
    expect(step(i, () => i.actionPressed('fire'))).toBe(true);
  });

  it('axis() fallback ignores keyboard keys while captured (no movement actions declared)', () => {
    win = new EventTarget();
    vi.stubGlobal('window', Object.assign(win, { focus() {} }));
    const i = new Input(fakeCanvas(), 320, 180);
    i.setActions([]);
    i.state.press('ArrowRight');
    expect(step(i, () => i.axis('horizontal'))).toBe(1);
    i.setKeyboardCapture(true);
    expect(step(i, () => i.axis('horizontal'))).toBe(0);
  });

  it('prevents default for text keys and Space only while captured, never for Ctrl+V', () => {
    const i = setup();
    expect(key('KeyQ', { key: 'q' })).toBe(false);
    expect(key('Digit1', { key: '1' })).toBe(false);
    i.setKeyboardCapture(true);
    expect(key('KeyQ', { key: 'q' })).toBe(true);
    expect(key('Digit1', { key: '1' })).toBe(true);
    expect(key('Slash', { key: '/' })).toBe(true); // Firefox quick find
    expect(key('Space', { key: ' ' })).toBe(true);
    expect(key('Delete', { key: 'Delete' })).toBe(true);
    expect(key('KeyV', { key: 'v', ctrlKey: true })).toBe(false);
    expect(key('KeyV', { key: 'v', metaKey: true })).toBe(false);
    expect(key('F5', { key: 'F5' })).toBe(false);
    i.setKeyboardCapture(false);
    expect(key('KeyQ', { key: 'q' })).toBe(false);
  });
});

describe('engine pause and text events (F019)', () => {
  it('text typed while paused is discarded on resume', () => {
    const parent = {};
    const i = setup({ parent });
    const e = Object.create(Engine.prototype) as Engine;
    Object.assign(e, { input: i, pauseReasons: new Set(), audio: { setSuspended() {} }, stepper: { reset() {} } });
    const onMessage = (e as unknown as { onMessage(ev: { data: unknown; source: unknown }): void }).onMessage.bind(e);
    onMessage({ data: { type: 'webgame:pause' }, source: parent });
    key('KeyK', { key: 'k' });
    paste('secret');
    onMessage({ data: { type: 'webgame:resume' }, source: parent });
    key('KeyZ', { key: 'z' });
    expect(step(i, () => i.textEvents)).toEqual([{ kind: 'text', text: 'z' }]);
    // an author pause ends the same way
    e.pause();
    key('KeyK', { key: 'k' });
    e.resume();
    expect(step(i, () => i.textEvents)).toEqual([]);
  });
});

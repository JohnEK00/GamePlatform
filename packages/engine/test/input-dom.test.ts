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

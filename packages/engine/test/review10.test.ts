import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseActions } from '../src/actions';
import { GamepadButtons, Input } from '../src/input';
import { Ui, type TextFieldOptions, type UiRenderer } from '../src/ui';

// Review 10 M1: while the on-screen keyboard takes input, the gamepad buttons it uses never reach the
// game's actions (held ones stay latched until released), and `ui.editing` keeps reporting the field
// for the rest of the step in which the keyboard submits or closes.

type Btn = keyof typeof GamepadButtons;

function fakeCanvas(): HTMLCanvasElement {
  const t = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(t, { style: {}, tabIndex: -1, focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 480, height: 270 }) });
  return t as unknown as HTMLCanvasElement;
}

const ACTIONS = parseActions([
  { id: 'pause', name: 'Pause', keys: ['KeyP'], gamepad: ['Start'] },
  { id: 'confirm', name: 'Confirm', keys: ['Enter'], gamepad: ['A'] },
  { id: 'back', name: 'Back', keys: ['Escape'], gamepad: ['B'] },
  { id: 'fire', name: 'Fire', keys: ['KeyF'], gamepad: ['X'] },
  { id: 'jump', name: 'Jump', keys: ['KeyJ'], gamepad: ['Y'] },
  { id: 'swap', name: 'Swap', keys: ['KeyQ'], gamepad: ['LB'] },
  { id: 'dash', name: 'Dash', keys: ['KeyE'], gamepad: ['RB'] },
  { id: 'left', name: 'Left', keys: ['KeyA'], gamepad: ['Left'] },
  { id: 'right', name: 'Right', keys: ['KeyD'], gamepad: ['Right'] },
]).actions;

const renderer: UiRenderer = {
  drawNineSlice() {},
  drawRect() {},
  strokeRect() {},
  drawText() {},
  measureText: (t) => ({ width: Array.from(String(t)).length * 8, height: 8 }),
  ui: (fn) => fn(),
};
Object.assign(renderer, { width: 480, height: 270 });

let input: Input | null = null;
afterEach(() => {
  input = null;
  vi.unstubAllGlobals();
});

function setup(opts: TextFieldOptions = {}) {
  const held = new Set<Btn>();
  let connected = true;
  const snapshot = (): Gamepad => {
    const buttons = Array.from({ length: 17 }, (_, i) => {
      const on = [...held].some((b) => GamepadButtons[b] === i);
      return { pressed: on, value: on ? 1 : 0, touched: on };
    });
    return { connected: true, id: 'fake pad', index: 0, axes: [0, 0, 0, 0], buttons } as unknown as Gamepad;
  };
  vi.stubGlobal('navigator', { getGamepads: () => [connected ? snapshot() : null, null, null, null] });
  const i = new Input(fakeCanvas(), 480, 270);
  input = i;
  i.setActions(ACTIONS);
  const ui = new Ui({ input: i, renderer, warn: () => {} });
  const s = { name: '' };
  /** One engine step: input.beginStep → ui.beginStep → game → ui.endStep → input.endStep. */
  const step = <T>(game: () => T): T => {
    i.beginStep();
    ui.beginStep(1 / 60);
    const r = game();
    ui.endStep();
    i.endStep();
    return r;
  };
  const field = (): void => {
    s.name = ui.textField('name', s.name, 10, 10, 160, 16, opts);
  };
  const press = (...b: Btn[]): void => b.forEach((x) => held.add(x));
  const release = (...b: Btn[]): void => b.forEach((x) => held.delete(x));
  /** Focus NAME, press pad A on it (editing starts, the keyboard opens), release A: the keyboard is live. */
  const openWithPad = (): void => {
    step(() => {
      ui.focus = 'name';
      field();
    });
    press('A');
    step(field);
    release('A');
    step(field);
  };
  return {
    i, ui, s, step, field, press, release, openWithPad,
    disconnect: () => void (connected = false),
  };
}

describe('review 10 M1: the on-screen keyboard keeps its gamepad buttons from the game', () => {
  it('template scenario: Start submits the name, the screen stays on settings and pause does not fire', () => {
    const { i, ui, s, step, press, release, openWithPad } = setup();
    let screen = 'settings';
    // The Menu & HUD template: menus() draws NAME, then `pause` (Start) leaves the settings unless editing.
    const update = () => {
      const inSettings = screen === 'settings';
      const before = ui.editing;
      if (screen === 'settings') s.name = ui.textField('name', s.name, 10, 10, 160, 16);
      const after = ui.editing;
      const pause = i.actionPressed('pause');
      if (inSettings && screen === 'settings' && pause && !ui.editing) screen = 'title';
      return { before, after, pause, committed: ui.committed('name') };
    };
    openWithPad();
    expect(ui.keyboardRect).not.toBeNull();
    press('A');
    const typed = step(() => [i.actionPressed('confirm'), update()] as const);
    release('A');
    expect(typed[0]).toBe(false); // pad A on the live keyboard no longer reports confirm
    expect(s.name).toBe('Q');
    step(update);

    press('Start');
    const r = step(update);
    expect(r).toEqual({ before: 'name', after: 'name', pause: false, committed: true });
    expect(screen).toBe('settings');
    expect(s.name).toBe('Q');
    expect(ui.keyboardRect).toBeNull();

    // Start still held: latched, so pause doesn't fire in the next step either.
    const held = step(() => [i.actionPressed('pause'), i.actionDown('pause'), update()] as const);
    expect(held[0]).toBe(false);
    expect(held[1]).toBe(false);
    expect(held[2].after).toBeNull();
    expect(screen).toBe('settings');

    // Released and pressed again (the keyboard is closed): pause works as usual.
    release('Start');
    step(update);
    press('Start');
    step(update);
    expect(screen).toBe('title');
  });

  it('A, B, X, Y, LB, Start and the D-pad produce no action edges while the keyboard is live; they still drive it', () => {
    const { i, ui, s, step, field, press, release, openWithPad } = setup();
    openWithPad();
    const ids = ['confirm', 'back', 'fire', 'jump', 'swap', 'left', 'right', 'pause'];
    const seen: string[] = [];
    const tap = (b: Btn): void => {
      press(b);
      step(() => {
        for (const id of ids) if (i.actionPressed(id) || i.actionDown(id)) seen.push(`${b}:${id}`);
        field();
      });
      release(b);
      step(field);
    };
    tap('A'); // Q
    tap('Y'); // space
    tap('LB'); // lower case
    tap('Right'); // cursor to W
    tap('A'); // w
    tap('X'); // delete w
    tap('Left');
    tap('Down');
    tap('Up');
    expect(seen).toEqual([]);
    expect(s.name).toBe('Q ');
    expect(ui.editing).toBe('name');
    press('B'); // revert
    const r = step(() => {
      const pressed = i.actionPressed('back');
      field();
      return { pressed, editing: ui.editing };
    });
    expect(r).toEqual({ pressed: false, editing: 'name' });
    expect(s.name).toBe('');
    expect(step(() => [i.actionPressed('back'), i.actionDown('back'), ui.editing])).toEqual([false, false, null]);
  });

  it('a button the keyboard does not use (RB) still reaches its action while the keyboard is live', () => {
    const { i, step, field, press, openWithPad } = setup();
    openWithPad();
    press('RB');
    expect(step(() => [i.actionPressed('dash'), field()][0])).toBe(true);
  });

  it('a keyboard button held through the close stays latched until released (X held, then Start)', () => {
    const { i, ui, step, field, press, release, openWithPad } = setup();
    openWithPad();
    press('X');
    step(field);
    press('Start');
    step(field);
    expect(ui.editing).toBeNull();
    release('Start');
    for (let n = 0; n < 3; n++) expect(step(() => [i.actionPressed('fire'), i.actionDown('fire')])).toEqual([false, false]);
    release('X');
    step(() => {});
    press('X');
    expect(step(() => i.actionPressed('fire'))).toBe(true);
  });

  it('a D-pad direction held from before the keyboard took input is released for the game, and axis() reads 0', () => {
    const { i, ui, step, field, press } = setup();
    step(() => {
      ui.focus = 'name';
      field();
    });
    press('A');
    step(field); // editing starts, the keyboard opens at the end of this step
    press('Right'); // held as the keyboard goes live (also moves its cursor)
    const r = step(() => {
      const out = { released: i.actionReleased('right'), down: i.actionDown('right'), axis: i.axis('horizontal') };
      field();
      return out;
    });
    // `right` was never down before (the press lands in the first live step): no edge at all.
    expect(r).toEqual({ released: false, down: false, axis: 0 });
    expect(step(() => [i.actionPressed('right'), i.actionDown('right'), i.axis('horizontal'), field()].slice(0, 3))).toEqual([false, false, 0]);
  });

  it('an action held before the keyboard goes live reports actionReleased in its first live step', () => {
    const { i, ui, step, field, press } = setup();
    step(() => {
      ui.focus = 'name';
      field();
    });
    press('Right'); // the game reads it as movement (NAME is the only widget, so focus stays on it)
    step(field);
    expect(step(() => [i.actionDown('right'), field()][0])).toBe(true);
    step(() => {
      ui.editing = 'name';
      field();
    });
    step(field); // editing starts; the keyboard opens at the end of this step
    expect(ui.keyboardRect).not.toBeNull();
    const r = step(() => {
      const out = { released: i.actionReleased('right'), down: i.actionDown('right'), axis: i.axis('horizontal') };
      field();
      return out;
    });
    expect(r).toEqual({ released: true, down: false, axis: 0 });
  });

  it('assigning ui.editing in the closing step ends the hold', () => {
    const { ui, step, field, press, openWithPad } = setup();
    openWithPad();
    press('Start');
    const r = step(() => {
      field();
      const held = ui.editing;
      ui.editing = null;
      return [held, ui.editing];
    });
    expect(r).toEqual(['name', null]);
  });

  it('without the keyboard (keyboard: "never") F019 is unchanged: pad A submits and reports confirm', () => {
    const { i, ui, step, field, press, release } = setup({ keyboard: 'never' });
    step(() => {
      ui.focus = 'name';
      field();
    });
    press('A');
    step(field);
    release('A');
    step(field);
    expect(ui.keyboardRect).toBeNull();
    press('A');
    const r = step(() => {
      const confirm = i.actionPressed('confirm');
      field();
      return { confirm, editing: ui.editing, committed: ui.committed('name') };
    });
    expect(r).toEqual({ confirm: true, editing: null, committed: true });
  });

  it('a latched button counts again after a release; a disconnect drops the latch without edges', () => {
    const { i, step, field, press, release, openWithPad, disconnect } = setup();
    openWithPad();
    press('Y');
    step(field); // types a space, Y is latched
    expect(step(() => [i.actionDown('jump'), field()][0])).toBe(false);
    disconnect();
    expect(step(() => [i.actionPressed('jump'), i.actionDown('jump')])).toEqual([false, false]);
    release('Y');
    expect(input).toBe(i);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionMap, parseActions } from '../src/actions';
import { Input, InputState } from '../src/input';
import { Ui, type UiRenderer } from '../src/ui';

// Review 8 M1: the key that starts editing a text field must not fire its action in that step, and
// `ui.editing` must report the field from the start of that step (before the field's call).

function fakeCanvas(): HTMLCanvasElement {
  const t = new EventTarget() as EventTarget & Record<string, unknown>;
  Object.assign(t, { style: {}, tabIndex: -1, focus() {}, setPointerCapture() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }) });
  return t as unknown as HTMLCanvasElement;
}
function keyEvent(type: string, code: string, key: string): Event {
  return Object.assign(new Event(type, { cancelable: true }), { code, key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false });
}

const ACTIONS = parseActions([
  { id: 'pause', name: 'Pause', keys: ['KeyP'] },
  { id: 'confirm', name: 'Confirm', keys: ['Enter'] },
  { id: 'left', name: 'Left', keys: ['KeyA'] },
  { id: 'right', name: 'Right', keys: ['KeyD'] },
]).actions;

const renderer: UiRenderer = {
  drawNineSlice() {},
  drawRect() {},
  strokeRect() {},
  drawText() {},
  measureText: (t) => ({ width: Array.from(String(t)).length * 8, height: 8 }),
  ui: (fn) => fn(),
};

let input: Input | null = null;
let win: EventTarget;
afterEach(() => {
  input?.detach();
  input = null;
  vi.unstubAllGlobals();
});

function setup() {
  win = new EventTarget();
  vi.stubGlobal('window', Object.assign(win, { focus() {} }));
  const i = new Input(fakeCanvas(), 320, 180);
  input = i;
  i.setActions(ACTIONS);
  i.attach();
  const ui = new Ui({ input: i, renderer, warn: () => {} });
  /** One engine step: input.beginStep → ui.beginStep → game → ui.endStep → input.endStep. */
  const step = <T>(game: () => T): T => {
    i.beginStep();
    ui.beginStep(1 / 60);
    const r = game();
    ui.endStep();
    i.endStep();
    return r;
  };
  const down = (code: string, key: string): void => void win.dispatchEvent(keyEvent('keydown', code, key));
  const up = (code: string, key: string): void => void win.dispatchEvent(keyEvent('keyup', code, key));
  return { i, ui, step, down, up };
}

describe('review 8 M1: editing captures the keyboard from the step it starts in', () => {
  it('template scenario: focus on NAME, type "P": the letter is typed and pause does not fire', () => {
    const { i, ui, step, down, up } = setup();
    let name = '';
    let screen = 'settings';
    // The Menu & HUD template: `update()` reads pause before `menus()` draws the widgets.
    const update = (): Record<string, unknown> => {
      const seen = { editing: ui.editing, pause: i.actionPressed('pause'), captured: i.keyboardCaptured };
      if (i.actionPressed('pause') && !ui.editing) screen = 'title';
      if (screen === 'settings') name = ui.textField('name', name, 10, 10, 100, 16);
      return seen;
    };
    step(() => {
      ui.focus = 'name'; // go(engine, "settings", "name")
      update();
    });
    down('KeyP', 'P');
    const seen = step(update);
    expect(seen).toEqual({ editing: 'name', pause: false, captured: true });
    expect(screen).toBe('settings');
    expect(name).toBe('P');
    expect(ui.editing).toBe('name');
    // Held: still no action while editing; released: no actionReleased either (never pressed).
    expect(step(() => [i.actionPressed('pause'), i.actionDown('pause'), update()])).toEqual([false, false, { editing: 'name', pause: false, captured: true }]);
    up('KeyP', 'P');
    expect(step(() => [i.actionReleased('pause'), update()][0])).toBe(false);
    // A second P is typed too and still doesn't pause.
    down('KeyP', 'p');
    up('KeyP', 'p');
    step(update);
    expect([screen, name]).toEqual(['settings', 'Pp']);
  });

  it('without the fix the guard would fail: actions read before the field call already see capture', () => {
    const { i, ui, step, down } = setup();
    step(() => {
      ui.focus = 'name';
      ui.textField('name', '', 0, 0, 100, 16);
    });
    down('KeyA', 'a');
    const r = step(() => {
      const before = { editing: ui.editing, left: i.actionPressed('left'), down: i.actionDown('left'), axis: i.axis('horizontal') };
      const text = ui.textField('name', '', 0, 0, 100, 16);
      return { before, text };
    });
    expect(r).toEqual({ before: { editing: 'name', left: false, down: false, axis: 0 }, text: 'a' });
  });

  it('a key-only action held before typing reports actionReleased in the start step (release synthesis)', () => {
    const { i, ui, step, down } = setup();
    let name = '';
    down('KeyD', 'd'); // held; the field isn't focused yet, so this moves the player
    expect(
      step(() => {
        ui.focus = 'name';
        // Not a type-start: the field wasn't focused and declared in the previous step.
        name = ui.textField('name', name, 0, 0, 100, 16);
        return [i.actionPressed('right'), ui.editing];
      }),
    ).toEqual([true, null]);
    expect(name).toBe('');
    down('KeyX', 'x');
    const r = step(() => {
      const a = [i.actionDown('right'), i.actionReleased('right'), i.axis('horizontal'), ui.editing];
      name = ui.textField('name', name, 0, 0, 100, 16);
      return a;
    });
    expect(r).toEqual([false, true, 0, 'name']);
    expect(name).toBe('x');
    // Only in the first captured step.
    expect(step(() => [i.actionReleased('right'), ui.textField('name', name, 0, 0, 100, 16)])).toEqual([false, 'x']);
  });

  it('the end-of-capture latch still holds a key down through the submit until it is released', () => {
    const { i, ui, step, down, up } = setup();
    let name = '';
    const field = (): void => void (name = ui.textField('name', name, 0, 0, 100, 16));
    step(() => {
      ui.focus = 'name';
      field();
    });
    down('KeyD', 'd'); // starts editing, stays held
    step(field);
    down('Enter', 'Enter'); // submit
    up('Enter', 'Enter');
    expect(step(() => [ui.editing, field(), i.keyboardCaptured][0])).toBe('name');
    expect(ui.editing).toBe(null);
    expect(i.keyboardCaptured).toBe(false);
    expect(name).toBe('d');
    // D still held after capture ends: it doesn't count until released and pressed again.
    expect(step(() => [i.actionDown('right'), i.actionPressed('right'), i.axis('horizontal'), field()].slice(0, 3))).toEqual([false, false, 0]);
    up('KeyD', 'd');
    step(field);
    i.state.press('KeyD'); // no text event: the focused field doesn't start editing again
    expect(step(() => [i.actionPressed('right'), i.axis('horizontal'), ui.editing])).toEqual([true, 1, null]);
  });

  it('Enter on a focused field starts editing and the confirm action does not fire in that step', () => {
    const { i, ui, step, down, up } = setup();
    step(() => {
      ui.focus = 'name';
      ui.textField('name', 'Ann', 0, 0, 100, 16);
    });
    down('Enter', 'Enter');
    up('Enter', 'Enter');
    const r = step(() => {
      const a = [ui.editing, i.actionPressed('confirm'), i.keyboardCaptured];
      ui.textField('name', 'Ann', 0, 0, 100, 16);
      return a;
    });
    expect(r).toEqual(['name', false, true]);
    expect(ui.editing).toBe('name');
  });

  it('a pointer press on a field captures the same step; a key pressed with it does not fire', () => {
    const { i, ui, step, down } = setup();
    step(() => ui.textField('name', '', 10, 10, 100, 16));
    i.mouse.x = 20;
    i.mouse.y = 15;
    i.mouse.inside = true;
    i.state.press('Mouse0');
    down('KeyA', 'a');
    const r = step(() => {
      const a = [ui.editing, i.actionPressed('left'), i.keyboardCaptured];
      ui.textField('name', '', 10, 10, 100, 16);
      return a;
    });
    expect(r).toEqual(['name', false, true]);
    expect(ui.editing).toBe('name');
  });

  it('ui.editing = id in one step captures from the next step on, as it reports the id', () => {
    const { i, ui, step, down } = setup();
    step(() => {
      ui.textField('name', '', 0, 0, 100, 16);
      ui.editing = 'name';
    });
    down('KeyP', 'q');
    const r = step(() => {
      const a = [ui.editing, i.actionPressed('pause'), i.keyboardCaptured];
      ui.textField('name', '', 0, 0, 100, 16);
      return a;
    });
    expect(r).toEqual(['name', false, true]);
  });

  it('the game moving focus away before the call cancels the pending start; capture ends at endStep', () => {
    const { i, ui, step, down, up } = setup();
    let name = '';
    step(() => {
      ui.focus = 'name';
      name = ui.textField('name', name, 0, 0, 100, 16);
      ui.button('ok', 'OK', 0, 20, 40, 16);
    });
    down('KeyP', 'p');
    up('KeyP', 'p');
    const r = step(() => {
      const before = ui.editing;
      ui.focus = 'ok';
      const after = ui.editing;
      name = ui.textField('name', name, 0, 0, 100, 16);
      ui.button('ok', 'OK', 0, 20, 40, 16);
      return [before, after, ui.editing];
    });
    expect(r).toEqual(['name', null, null]);
    expect(name).toBe('');
    expect(ui.focus).toBe('ok');
    expect(i.keyboardCaptured).toBe(false);
  });

  it('ui.editing = null before the call cancels it; a disabled field never edits', () => {
    const { i, ui, step, down, up } = setup();
    step(() => {
      ui.focus = 'name';
      ui.textField('name', '', 0, 0, 100, 16);
    });
    down('KeyP', 'p');
    up('KeyP', 'p');
    expect(
      step(() => {
        ui.editing = null;
        return [ui.editing, ui.textField('name', '', 0, 0, 100, 16), ui.editing];
      }),
    ).toEqual([null, '', null]);
    expect(i.keyboardCaptured).toBe(false);
    down('KeyP', 'p');
    up('KeyP', 'p');
    expect(step(() => [ui.editing, ui.textField('name', '', 0, 0, 100, 16, { disabled: true }), ui.editing])).toEqual(['name', '', null]);
    expect(i.keyboardCaptured).toBe(false);
  });

  it('text discarded on a pause end never starts editing: the key then acts normally', () => {
    const { i, ui, step, down } = setup();
    step(() => {
      ui.focus = 'name';
      ui.textField('name', '', 0, 0, 100, 16);
    });
    down('KeyP', 'p');
    i.clearTextEvents(); // the engine does this when a pause ends
    expect(step(() => [ui.editing, i.actionPressed('pause'), i.keyboardCaptured, ui.textField('name', '', 0, 0, 100, 16)])).toEqual([null, true, false, '']);
  });
});

describe('ActionMap.update redo (review 8 M1)', () => {
  it('recomputes the same step from the previous step state', () => {
    const m = new ActionMap(ACTIONS);
    const s = new InputState();
    s.press('KeyD');
    m.update(s);
    s.endStep();
    expect(m.down('right')).toBe(true);
    s.press('KeyP');
    m.update(s);
    expect([m.pressed('pause'), m.down('right')]).toEqual([true, true]);
    const masked = { isDown: () => false, wasPressed: () => false, wasReleased: (c: string) => s.isDown(c) };
    m.update(masked, null, true);
    // P was never down before this step: no edge at all; D was: released.
    expect([m.pressed('pause'), m.released('pause'), m.down('pause')]).toEqual([false, false, false]);
    expect([m.down('right'), m.released('right')]).toEqual([false, true]);
    // A redo twice is idempotent.
    m.update(masked, null, true);
    expect([m.released('pause'), m.released('right')]).toEqual([false, true]);
  });
});

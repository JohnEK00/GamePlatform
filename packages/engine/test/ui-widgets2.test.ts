import { describe, expect, it } from 'vitest';
import { InputState } from '../src/input';
import { Ui, type UiInput, type UiRenderer } from '../src/ui';
import type { TextEvent } from '../src/uitext';

type Pad = 'Up' | 'Down' | 'Left' | 'Right' | 'A' | 'B';

/** A fake engine.input with the F019 members: held keys / pad buttons, wheel, textEvents and capture. */
function fakeInput(actions: { id: string; keys: string[] }[] = []) {
  const keys = new InputState();
  const padPressed = new Set<Pad>();
  const padHeld = new Set<Pad>();
  const capture: boolean[] = [];
  const mouse = { x: 0, y: 0, pressed: false, released: false, inside: true, down: false, cancelled: false, wheel: 0 };
  const state = { textEvents: [] as TextEvent[] };
  const input: UiInput = {
    mouse,
    actions,
    actionPressed: (id) => !!actions.find((a) => a.id === id)?.keys.some((k) => keys.wasPressed(k)),
    actionDown: (id) => !!actions.find((a) => a.id === id)?.keys.some((k) => keys.isDown(k)),
    wasPressed: (c) => keys.wasPressed(c),
    isDown: (c) => keys.isDown(c),
    gamepad: () => ({ wasPressed: (b: Pad) => padPressed.has(b), isDown: (b: Pad) => padHeld.has(b) || padPressed.has(b) }),
    get textEvents() {
      return state.textEvents;
    },
    setKeyboardCapture: (on) => capture.push(on),
  };
  return {
    input,
    mouse,
    keys,
    capture,
    tap(code: string) {
      keys.press(code);
      keys.release(code);
    },
    hold(code: string) {
      keys.press(code);
    },
    up(code: string) {
      keys.release(code);
    },
    pad(b: Pad) {
      padPressed.add(b);
    },
    padHold(b: Pad, on = true) {
      if (on) padHeld.add(b);
      else padHeld.delete(b);
    },
    type(...ev: (string | TextEvent)[]) {
      state.textEvents = ev.map((e) => (typeof e === 'string' ? { kind: 'text', text: e } : e));
    },
    end() {
      keys.endStep();
      padPressed.clear();
      state.textEvents = [];
      mouse.pressed = mouse.released = mouse.cancelled = false;
      mouse.wheel = 0;
    },
  };
}

function recorder() {
  const ops: string[] = [];
  const renderer: UiRenderer = {
    drawNineSlice: (_s, x, y, w, h) => ops.push(`9s ${x},${y},${w},${h}`),
    drawRect: (x, y, w, h, c, o) => ops.push(`rect ${x},${y},${w},${h} ${String(c)} a${o?.alpha ?? 1}`),
    strokeRect: (x, y, w, h, c, t) => ops.push(`stroke ${x},${y},${w},${h} ${String(c)} t${t}`),
    drawText: (t, x, y, o) => ops.push(`text "${t}" ${x},${y} ${String(o?.color)}`),
    measureText: (t) => ({ width: Array.from(String(t)).length * 8, height: 8 }),
    ui: (fn) => fn(),
  };
  return { renderer, ops };
}

function setup(actions: { id: string; keys: string[] }[] = []) {
  const fi = fakeInput(actions);
  const rec = recorder();
  const warnings: string[] = [];
  const ui = new Ui({ input: fi.input, renderer: rec.renderer, warn: (m) => warnings.push(m) });
  const step = <T>(body: () => T, dt = 1 / 60): T => {
    ui.beginStep(dt);
    const r = body();
    ui.endStep();
    fi.end();
    return r;
  };
  const frame = (): string[] => {
    rec.ops.length = 0;
    ui.frameStart();
    ui.drawLayer();
    return [...rec.ops];
  };
  return { ui, fi, rec, warnings, step, frame };
}

const P = '[pixelforge] ui: ';

describe('ui.slider', () => {
  // Rect 100..200 × 10..20 (h = 10): t = (mouse.x - 105) / 90.
  const sl = (ui: Ui, v: number, o = {}) => ui.slider('vol', v, 100, 10, 100, 10, o);

  it('press sets the value under the pointer; drag outside clamps; release commits once if changed', () => {
    const { ui, fi, step } = setup();
    let v = 0.5;
    Object.assign(fi.mouse, { x: 150, y: 15 });
    v = step(() => sl(ui, v));
    fi.mouse.x = 105;
    fi.mouse.pressed = fi.mouse.down = true;
    const r1 = step(() => [(v = sl(ui, v)), ui.changed('vol'), ui.committed('vol')]);
    expect(r1).toEqual([0, true, false]);
    expect(ui.active).toBe('vol');
    fi.mouse.x = 500; // outside the rect: still dragging, clamped
    expect(step(() => (v = sl(ui, v)))).toBe(1);
    fi.mouse.x = 600;
    expect(step(() => [(v = sl(ui, v)), ui.changed('vol')])).toEqual([1, false]);
    fi.mouse.released = true;
    fi.mouse.down = false;
    expect(step(() => [(v = sl(ui, v)), ui.committed('vol')])).toEqual([1, true]);
    expect(ui.active).toBeNull();
    expect(step(() => [sl(ui, v), ui.committed('vol')])).toEqual([1, false]);
  });

  it('a drag that changes nothing does not commit; a cancelled release ends the drag', () => {
    const { ui, fi, step } = setup();
    let v = 0;
    Object.assign(fi.mouse, { x: 105, y: 15 });
    step(() => sl(ui, v));
    fi.mouse.pressed = fi.mouse.down = true;
    v = step(() => sl(ui, v));
    fi.mouse.released = true;
    fi.mouse.down = false;
    expect(step(() => [(v = sl(ui, v)), ui.committed('vol')])).toEqual([0, false]);
    // cancelled
    fi.mouse.pressed = fi.mouse.down = true;
    step(() => (v = sl(ui, v)));
    fi.mouse.x = 195;
    v = step(() => sl(ui, v));
    expect(v).toBe(1);
    Object.assign(fi.mouse, { released: true, cancelled: true, down: false, x: 150 });
    expect(step(() => [(v = sl(ui, v)), ui.committed('vol')])).toEqual([1, true]);
    expect(ui.active).toBeNull();
    fi.mouse.x = 105;
    expect(step(() => sl(ui, v))).toBe(1);
  });

  it('left/right adjust by keyStep without moving focus; up/down move focus; committed per key step', () => {
    const { ui, fi, step } = setup();
    let v = 0.5;
    const body = () => {
      ui.button('a', 'A', 0, 0, 10, 10);
      v = sl(ui, v, { step: 0.1 });
      ui.button('b', 'B', 0, 40, 10, 10);
      return [v, ui.changed('vol'), ui.committed('vol')];
    };
    step(body);
    ui.focus = 'vol';
    fi.tap('ArrowRight');
    expect(step(body)).toEqual([0.6, true, true]);
    expect(ui.focus).toBe('vol');
    fi.tap('ArrowLeft');
    fi.tap('ArrowLeft');
    step(body);
    expect(v).toBe(0.5);
    fi.tap('Enter');
    expect(step(body)).toEqual([0.5, false, false]);
    fi.tap('ArrowDown');
    step(body);
    expect(ui.focus).toBe('b');
    ui.focus = 'vol';
    fi.tap('ArrowUp');
    step(body);
    expect(ui.focus).toBe('a');
    ui.focus = 'vol';
    v = 1;
    fi.tap('ArrowRight'); // already at max: no change, no commit
    expect(step(body)).toEqual([1, false, false]);
  });

  it('hold repeat: after 0.4 s, then every 0.08 s; the gamepad D-pad too', () => {
    const { ui, fi, step } = setup();
    let v = 0;
    const body = () => (v = sl(ui, v, { min: 0, max: 100, step: 1 }));
    step(body);
    ui.focus = 'vol';
    fi.hold('ArrowRight');
    step(body, 0.1);
    expect(v).toBe(1);
    for (let k = 0; k < 3; k++) step(body, 0.1);
    expect(v).toBe(1); // 0.3 s held
    step(body, 0.1);
    expect(v).toBe(2); // 0.4 s
    step(body, 0.04);
    expect(v).toBe(2);
    step(body, 0.04);
    expect(v).toBe(3); // 0.48 s
    step(body, 0.08);
    expect(v).toBe(4);
    fi.up('ArrowRight');
    step(body, 0.08);
    expect(v).toBe(4);
    fi.pad('Left');
    fi.padHold('Left');
    step(body, 0.2);
    expect(v).toBe(3);
    step(body, 0.2);
    step(body, 0.2);
    expect(v).toBe(2);
    fi.padHold('Left', false);
  });

  it('snaps with toFixed(10); clamping or snapping the game value is not a change', () => {
    const { ui, fi, step } = setup();
    expect(step(() => [ui.slider('s', 0.1 + 0.2, 0, 0, 100, 10, { step: 0.1 }), ui.changed('s')])).toEqual([0.3, false]);
    expect(step(() => [ui.slider('s', 7, 0, 0, 100, 10), ui.changed('s'), ui.committed('s')])).toEqual([1, false, false]);
    expect(step(() => ui.slider('s', 0.26, 0, 0, 100, 10, { min: 0, max: 1, step: 0.25 }))).toBe(0.25);
    expect(step(() => ui.slider('s', NaN, 0, 0, 100, 10, { min: 2, max: 5 }))).toBe(2);
    // default keyStep for a continuous slider: (max - min) / 20
    let v = 0;
    step(() => (v = ui.slider('s', v, 0, 0, 100, 10, { max: 2 })));
    ui.focus = 's';
    fi.tap('ArrowRight');
    step(() => (v = ui.slider('s', v, 0, 0, 100, 10, { max: 2 })));
    expect(v).toBeCloseTo(0.1);
  });

  it('invalid range: drawn disabled, value unchanged, exact warning once', () => {
    const { ui, fi, step, warnings, frame } = setup();
    for (let k = 0; k < 2; k++) expect(step(() => ui.slider('bad', 3, 0, 0, 100, 10, { min: 1, max: 1 }))).toBe(3);
    expect(warnings).toEqual([`${P}slider "bad" needs finite min < max; it is drawn disabled`]);
    expect(frame().some((o) => o.includes('a0.5'))).toBe(true);
    fi.tap('ArrowDown');
    step(() => ui.slider('bad', 3, 0, 0, 100, 10, { min: 1, max: NaN }));
    expect(ui.focus).toBeNull();
  });
});

describe('ui.toggle', () => {
  const tg = (ui: Ui, on: boolean, o = {}) => ui.toggle('t', on, 'SHAKE', 10, 10, 100, 10, o);

  it('click flips once with changed + committed; press outside then release inside does not', () => {
    const { ui, fi, step } = setup();
    let on = false;
    Object.assign(fi.mouse, { x: 50, y: 15 });
    step(() => (on = tg(ui, on)));
    fi.mouse.pressed = true;
    expect(step(() => (on = tg(ui, on)))).toBe(false);
    fi.mouse.released = true;
    expect(step(() => [(on = tg(ui, on)), ui.changed('t'), ui.committed('t')])).toEqual([true, true, true]);
    expect(step(() => [(on = tg(ui, on)), ui.changed('t')])).toEqual([true, false]);
    fi.mouse.x = 300;
    fi.mouse.pressed = true;
    step(() => (on = tg(ui, on)));
    fi.mouse.x = 50;
    fi.mouse.released = true;
    expect(step(() => (on = tg(ui, on)))).toBe(true);
  });

  it('activate flips; disabled never flips', () => {
    const { ui, fi, step } = setup();
    let on = true;
    step(() => (on = tg(ui, on)));
    ui.focus = 't';
    fi.pad('A');
    expect(step(() => (on = tg(ui, on)))).toBe(false);
    ui.focus = 't';
    fi.tap('Enter');
    expect(step(() => [tg(ui, on, { disabled: true }), ui.changed('t')])).toEqual([false, false]);
    Object.assign(fi.mouse, { x: 50, y: 15, pressed: true, released: true });
    expect(step(() => tg(ui, on, { disabled: true }))).toBe(false);
  });
});

describe('ui.textField', () => {
  // Rect 100..200 × 10..30; text starts at x 104, 8 units per code point.
  const tf = (ui: Ui, t: string, o = {}) => ui.textField('name', t, 100, 10, 100, 20, o);
  const menu = (ui: Ui, s: { t: string }, o = {}) => {
    ui.button('a', 'A', 0, 0, 10, 10);
    s.t = tf(ui, s.t, o);
    ui.button('b', 'B', 0, 50, 10, 10);
    return { changed: ui.changed('name'), committed: ui.committed('name'), editing: ui.editing };
  };

  it('a click starts editing with the caret from x; typing inserts there', () => {
    const { ui, fi, step } = setup();
    const s = { t: 'abcd' };
    step(() => menu(ui, s));
    Object.assign(fi.mouse, { x: 121, y: 20, pressed: true, released: true }); // between "ab" and "cd"
    expect(step(() => menu(ui, s)).editing).toBe('name');
    expect(ui.focus).toBe('name');
    fi.type('X');
    expect(step(() => menu(ui, s))).toMatchObject({ changed: true, committed: false });
    expect(s.t).toBe('abXcd');
  });

  it('activate starts editing at the end; Enter commits (committed even unchanged), focus kept', () => {
    const { ui, fi, step } = setup();
    const s = { t: 'mia' };
    step(() => menu(ui, s));
    ui.focus = 'name';
    fi.tap('Enter');
    expect(step(() => menu(ui, s)).editing).toBe('name');
    fi.type('!');
    step(() => menu(ui, s));
    expect(s.t).toBe('mia!');
    fi.type({ kind: 'key', key: 'Backspace' });
    step(() => menu(ui, s));
    fi.tap('Enter');
    expect(step(() => menu(ui, s))).toEqual({ changed: false, committed: true, editing: null });
    expect(ui.focus).toBe('name');
  });

  it('typing while focused starts editing and suppresses navigation; Space types a space', () => {
    const { ui, fi, step } = setup([{ id: 'down', keys: ['KeyS'] }]);
    const s = { t: '' };
    step(() => menu(ui, s));
    ui.focus = 'name';
    fi.tap('KeyS');
    fi.type('s');
    expect(step(() => menu(ui, s))).toMatchObject({ editing: 'name', changed: true });
    expect(ui.focus).toBe('name');
    expect(s.t).toBe('s');
    ui.editing = null;
    step(() => menu(ui, s));
    fi.tap('Space');
    fi.type(' ');
    step(() => menu(ui, s));
    expect([s.t, ui.editing]).toEqual(['s ', 'name']);
  });

  it('applies edits in order', () => {
    const { ui, fi, step } = setup();
    const s = { t: 'ac' };
    step(() => menu(ui, s));
    ui.editing = 'name';
    step(() => menu(ui, s));
    fi.type({ kind: 'key', key: 'ArrowLeft' }, 'b', { kind: 'key', key: 'End' }, 'd', { kind: 'key', key: 'Home' }, { kind: 'key', key: 'Delete' });
    step(() => menu(ui, s));
    expect(s.t).toBe('bcd');
  });

  it('raw ArrowUp / ArrowDown and pad Down commit and move focus', () => {
    const { ui, fi, step } = setup();
    const s = { t: 'x' };
    step(() => menu(ui, s));
    ui.editing = 'name';
    step(() => menu(ui, s));
    fi.type('y');
    step(() => menu(ui, s));
    fi.tap('ArrowDown');
    expect(step(() => menu(ui, s))).toEqual({ changed: false, committed: true, editing: null });
    expect(ui.focus).toBe('b');
    ui.editing = 'name';
    step(() => menu(ui, s));
    fi.tap('ArrowUp'); // unchanged → no committed for a leave
    expect(step(() => menu(ui, s)).committed).toBe(false);
    expect(ui.focus).toBe('a');
    ui.editing = 'name';
    step(() => menu(ui, s));
    fi.pad('Down');
    step(() => menu(ui, s));
    expect([ui.focus, ui.editing]).toEqual(['b', null]);
  });

  it('left/right intents are ignored while editing (focus stays)', () => {
    const { ui, fi, step } = setup([{ id: 'right', keys: ['KeyD'] }]);
    const s = { t: 'ab' };
    step(() => menu(ui, s));
    ui.editing = 'name';
    step(() => menu(ui, s));
    fi.pad('Right');
    fi.type({ kind: 'key', key: 'ArrowLeft' });
    step(() => menu(ui, s));
    expect([ui.focus, ui.editing]).toEqual(['name', 'name']);
  });

  it('a pointer press outside commits', () => {
    const { ui, fi, step } = setup();
    const s = { t: 'a' };
    step(() => menu(ui, s));
    ui.editing = 'name';
    step(() => menu(ui, s));
    fi.type('b');
    step(() => menu(ui, s));
    Object.assign(fi.mouse, { x: 400, y: 400, pressed: true });
    expect(step(() => menu(ui, s))).toEqual({ changed: false, committed: true, editing: null });
  });

  it('Escape and pad B revert: original returned, changed true, committed false, focus kept', () => {
    for (const how of ['Escape', 'B'] as const) {
      const { ui, fi, step } = setup();
      const s = { t: 'mia' };
      step(() => menu(ui, s));
      ui.editing = 'name';
      step(() => menu(ui, s));
      fi.type('x', 'y');
      step(() => menu(ui, s));
      expect(s.t).toBe('miaxy');
      if (how === 'Escape') fi.tap('Escape');
      else fi.pad('B');
      expect(step(() => menu(ui, s))).toEqual({ changed: true, committed: false, editing: null });
      expect([s.t, ui.focus]).toEqual(['mia', 'name']);
    }
  });

  it('an undeclared field drops editing with no signal', () => {
    const { ui, fi, step } = setup();
    const s = { t: 'a' };
    step(() => menu(ui, s));
    ui.editing = 'name';
    step(() => menu(ui, s));
    fi.type('b');
    step(() => menu(ui, s));
    step(() => ui.button('a', 'A', 0, 0, 10, 10));
    expect(ui.editing).toBeNull();
    expect(step(() => menu(ui, s))).toEqual({ changed: false, committed: false, editing: null });
  });

  it('ui.editing = id starts in the next step at the end; unknown ids are cleared; only one field edits', () => {
    const { ui, fi, step } = setup();
    let a = 'one';
    let b = 'two';
    const two = () => {
      a = ui.textField('f1', a, 0, 0, 100, 20);
      b = ui.textField('f2', b, 0, 30, 100, 20);
      return [ui.committed('f1'), ui.committed('f2')];
    };
    step(two);
    ui.editing = 'f1';
    step(two);
    fi.type('!');
    step(two);
    expect(a).toBe('one!');
    ui.editing = 'f2';
    expect(step(two)).toEqual([true, false]); // f1 committed (changed), f2 starts
    fi.type('?');
    step(two);
    expect([a, b, ui.editing]).toEqual(['one!', 'two?', 'f2']);
    ui.editing = 'nope';
    step(two);
    expect(ui.editing).toBeNull();
  });

  it('maxLength clamp warning text; maxLength limits typing', () => {
    const { ui, fi, step, warnings } = setup();
    const s = { t: '' };
    step(() => menu(ui, s, { maxLength: 2.5 }));
    expect(warnings).toEqual([`${P}textField "name" maxLength must be an integer from 1 to 256`]);
    ui.editing = 'name';
    step(() => menu(ui, s, { maxLength: 2.5 }));
    fi.type('abc');
    step(() => menu(ui, s, { maxLength: 2.5 }));
    expect(s.t).toBe('ab');
  });

  it('calls setKeyboardCapture with the editing state at endStep', () => {
    const { ui, fi, step } = setup();
    const s = { t: '' };
    step(() => menu(ui, s));
    ui.editing = 'name';
    step(() => menu(ui, s));
    fi.tap('Enter');
    step(() => menu(ui, s));
    expect(fi.capture).toEqual([false, true, false]);
  });

  it('draws the caret while editing and the placeholder when empty and idle', () => {
    const { ui, step, frame } = setup();
    step(() => tf(ui, '', { placeholder: 'NAME' }));
    expect(frame()).toContain('text "NAME" 104,20 #5d6488');
    ui.editing = 'name';
    step(() => tf(ui, 'ab', { placeholder: 'NAME' }));
    const ops = frame();
    expect(ops).toContain('rect 120,16,1,8 #ffd166 a1');
    expect(ops.some((o) => o.includes('NAME'))).toBe(false);
  });
});

describe('ui.list', () => {
  const items = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'];
  // Rect 10..110 × 20..60, rowHeight 10 → 4 visible rows.
  const ls = (ui: Ui, o = {}) => ui.list('lv', items, 10, 20, 100, 40, { rowHeight: 10, ...o });

  it('a click on a row returns its index and sets the cursor; release on another row does not', () => {
    const { ui, fi, step } = setup();
    step(() => ls(ui));
    Object.assign(fi.mouse, { x: 50, y: 35, pressed: true });
    expect(step(() => ls(ui))).toBe(-1);
    fi.mouse.released = true;
    expect(step(() => [ls(ui), ui.changed('lv'), ui.committed('lv'), ui.listCursor('lv')])).toEqual([1, true, true, 1]);
    fi.mouse.pressed = true;
    step(() => ls(ui));
    Object.assign(fi.mouse, { y: 33, released: true }); // same row, small move
    expect(step(() => [ls(ui), ui.changed('lv'), ui.committed('lv')])).toEqual([1, false, true]);
    fi.mouse.pressed = true;
    step(() => ls(ui));
    Object.assign(fi.mouse, { y: 36, released: true }); // 3 units from the press at 33
    expect(step(() => ls(ui))).toBe(1);
    fi.mouse.pressed = true;
    step(() => ls(ui));
    Object.assign(fi.mouse, { y: 45, released: true }); // another row (and > 4 units)
    expect(step(() => ls(ui))).toBe(-1);
  });

  it('a drag over 4 units scrolls and never activates', () => {
    const { ui, fi, step, frame } = setup();
    step(() => ls(ui));
    Object.assign(fi.mouse, { x: 50, y: 55, pressed: true });
    step(() => ls(ui));
    fi.mouse.y = 35; // 20 units up = 2 rows
    step(() => ls(ui));
    expect(frame()).toContain('text "L2" 14,25 #ffffff');
    fi.mouse.y = 55; // back over the pressed row
    fi.mouse.released = true;
    expect(step(() => ls(ui))).toBe(-1);
  });

  it('the wheel scrolls by sign · max(1, round(|wheel| / 100)) rows, clamped', () => {
    const { ui, fi, step, frame } = setup();
    step(() => ls(ui));
    Object.assign(fi.mouse, { x: 50, y: 30, wheel: 30 });
    step(() => ls(ui));
    expect(frame()).toContain('text "L1" 14,25 #ffffff');
    fi.mouse.wheel = 260;
    step(() => ls(ui));
    expect(frame()).toContain('text "L4" 14,25 #ffffff');
    fi.mouse.wheel = 10000;
    step(() => ls(ui));
    expect(frame()).toContain('text "L6" 14,25 #ffffff');
    Object.assign(fi.mouse, { x: 300, wheel: -500 }); // not over the list
    step(() => ls(ui));
    expect(frame()).toContain('text "L6" 14,25 #ffffff');
  });

  it('cursor on focus: next → 0, previous → last, selected wins; ui.focus → 0', () => {
    const { ui, fi, step } = setup();
    const m = (o = {}) => {
      ui.button('a', 'A', 0, 0, 5, 5);
      const r = ls(ui, o);
      ui.button('b', 'B', 0, 100, 5, 5);
      return r;
    };
    step(m);
    ui.focus = 'a';
    fi.tap('ArrowDown');
    step(m);
    expect([ui.focus, ui.listCursor('lv')]).toEqual(['lv', 0]);
    ui.focus = 'b';
    fi.tap('ArrowUp');
    step(m);
    expect(ui.listCursor('lv')).toBe(9);
    ui.focus = 'a';
    step(() => m({ selected: 6 }));
    fi.tap('ArrowDown');
    step(() => m({ selected: 6 }));
    expect(ui.listCursor('lv')).toBe(6);
    ui.focus = 'a';
    step(m);
    ui.focus = 'lv';
    step(m);
    expect(ui.listCursor('lv')).toBe(0);
  });

  it('up/down move and scroll into view; fresh press at the ends leaves; repeat never leaves; activate', () => {
    const { ui, fi, step, frame } = setup();
    const m = () => {
      ui.button('a', 'A', 0, 0, 5, 5);
      const r = [ls(ui), ui.changed('lv'), ui.committed('lv')];
      ui.button('b', 'B', 0, 100, 5, 5);
      return r;
    };
    step(m);
    ui.focus = 'lv';
    step(m);
    for (let k = 0; k < 5; k++) {
      fi.tap('ArrowDown');
      step(m);
    }
    expect(ui.listCursor('lv')).toBe(5);
    expect(frame()).toContain('text "L2" 14,25 #ffffff'); // rows 2..5 visible
    fi.tap('Enter');
    expect(step(m)).toEqual([5, false, true]);
    fi.tap('ArrowUp');
    expect(step(m)).toEqual([-1, true, false]);
    // hold down: repeats to the last row and stays
    fi.hold('ArrowDown');
    step(m, 0.1);
    for (let k = 0; k < 60; k++) step(m, 0.1);
    expect([ui.focus, ui.listCursor('lv')]).toEqual(['lv', 9]);
    fi.up('ArrowDown');
    step(m);
    fi.tap('ArrowDown');
    step(m);
    expect(ui.focus).toBe('b');
    ui.focus = 'lv';
    step(m);
    fi.tap('ArrowUp');
    step(m);
    expect(ui.focus).toBe('a');
    ui.focus = 'lv';
    step(m);
    fi.tap('ArrowRight'); // left/right move focus
    step(m);
    expect(ui.focus).toBe('b');
  });

  it('an empty list is skipped by navigation and never activates', () => {
    const { ui, fi, step } = setup();
    const m = () => {
      ui.button('a', 'A', 0, 0, 5, 5);
      ui.list('e', [], 10, 20, 100, 40);
      ui.button('b', 'B', 0, 100, 5, 5);
    };
    step(m);
    ui.focus = 'a';
    fi.tap('ArrowDown');
    step(m);
    expect(ui.focus).toBe('b');
  });

  it('1001 items → warning once and 1000 rows; invalid rowHeight warning', () => {
    const { ui, step, warnings } = setup();
    const many = Array.from({ length: 1001 }, (_, k) => k);
    step(() => ui.list('big', many, 0, 0, 100, 40));
    step(() => ui.list('big', many, 0, 0, 100, 40));
    step(() => ui.list('rh', items, 0, 0, 100, 40, { rowHeight: 3 }));
    expect(warnings).toEqual([
      `${P}list "big" has more than 1000 items; only the first 1000 are shown`,
      `${P}list "rh" rowHeight must be an integer from 4 to 256`,
    ]);
    ui.focus = 'big';
    step(() => ui.list('big', many, 0, 0, 100, 40, { selected: 999 }));
    expect(ui.listCursor('big')).toBe(999);
    ui.focus = null;
    step(() => ui.list('big', many, 0, 0, 100, 40, { selected: 1000 })); // out of range → none
    ui.focus = 'big';
    step(() => ui.list('big', many, 0, 0, 100, 40, { selected: 1000 }));
    expect(ui.listCursor('big')).toBe(0);
  });

  it('listCursor is -1 for unknown ids and non-lists; state is dropped when undeclared for a step', () => {
    const { ui, fi, step } = setup();
    step(() => ui.button('a', 'A', 0, 0, 5, 5));
    expect(ui.listCursor('a')).toBe(-1);
    expect(ui.listCursor('zz')).toBe(-1);
    step(() => ls(ui));
    Object.assign(fi.mouse, { x: 50, y: 35, pressed: true, released: true });
    step(() => ls(ui));
    expect(ui.listCursor('lv')).toBe(1);
    step(() => {});
    expect(ui.listCursor('lv')).toBe(-1);
  });

  it('a reappearing list starts scrolled so that selected is visible', () => {
    const { ui, step, frame } = setup();
    step(() => ls(ui, { selected: 8 }));
    expect(frame()).toContain('text "L5" 14,25 #ffffff');
  });
});

describe('F019 shared rules', () => {
  it('duplicate id across kinds: the second is inert with the exact warning', () => {
    const { ui, fi, step, warnings } = setup();
    Object.assign(fi.mouse, { x: 50, y: 5 });
    step(() => [ui.button('x', 'X', 0, 0, 100, 10), ui.slider('x', 0.5, 0, 0, 100, 10)]);
    fi.mouse.pressed = true;
    expect(step(() => ui.slider('x', 0.5, 0, 0, 100, 10) + (ui.button('x', 'X', 0, 0, 100, 10) ? 1 : 0))).toBe(0.5);
    expect(warnings).toEqual([
      `${P}slider id "x" is used twice in one step; the second one never changes`,
      `${P}button id "x" is used twice in one step; the second one never activates`, // F012 wording unchanged
    ]);
  });

  it('invalid id warnings per kind', () => {
    const { ui, step, warnings } = setup();
    step(() => {
      expect(ui.toggle('', true, 'T', 0, 0, 10, 10)).toBe(true);
      expect(ui.textField('y'.repeat(65), 'abc', 0, 0, 10, 10)).toBe('abc');
      expect(ui.list(5 as unknown as string, ['a'], 0, 0, 10, 10)).toBe(-1);
      expect(ui.slider(null as unknown as string, 9, 0, 0, 10, 10)).toBe(9);
    });
    expect(warnings).toEqual([
      `${P}toggle id "" must be a string of 1–64 characters; it never changes`,
      `${P}textField id "${'y'.repeat(65)}" must be a string of 1–64 characters; it never changes`,
      `${P}list id "5" must be a string of 1–64 characters; it never changes`,
      `${P}slider id "null" must be a string of 1–64 characters; it never changes`,
    ]);
  });

  it('phase warnings for each kind from render; widgets draw and return their input', () => {
    const { ui, warnings, rec } = setup();
    ui.setPhase('render');
    expect(ui.slider('s', 2, 0, 0, 10, 10)).toBe(2);
    expect(ui.toggle('t', false, 'T', 0, 0, 10, 10)).toBe(false);
    expect(ui.textField('f', 'x', 0, 0, 10, 10)).toBe('x');
    expect(ui.list('l', ['a'], 0, 0, 10, 10)).toBe(-1);
    ui.slider('s', 2, 0, 0, 10, 10);
    ui.setPhase('other');
    expect(warnings).toEqual(
      [['slider', 's'], ['toggle', 't'], ['textField', 'f'], ['list', 'l']].map(
        ([k, id]) => `${P}${k} "${id}" was called outside update; it is drawn but never changes (call widgets from update)`,
      ),
    );
    expect(rec.ops.length).toBeGreaterThan(0);
  });

  it('disabled widgets return their input (slider clamped and snapped) and are never focused', () => {
    const { ui, fi, step } = setup();
    const m = () => [
      ui.slider('s', 0.33, 0, 0, 10, 10, { step: 0.5, disabled: true }),
      ui.toggle('t', true, 'T', 0, 20, 10, 10, { disabled: true }),
      ui.textField('f', 'abc', 0, 40, 10, 10, { disabled: true }),
      ui.list('l', ['a'], 0, 60, 10, 10, { disabled: true }),
    ];
    expect(step(m)).toEqual([0.5, true, 'abc', -1]);
    fi.tap('ArrowDown');
    step(m);
    expect(ui.focus).toBeNull();
    ui.editing = 'f';
    step(m);
    expect(ui.editing).toBeNull();
  });

  it('changed / committed are false before the call in the step', () => {
    const { ui, fi, step } = setup();
    let on = false;
    step(() => (on = ui.toggle('t', on, 'T', 0, 0, 10, 10)));
    ui.focus = 't';
    fi.tap('Enter');
    const r = step(() => {
      const before = [ui.changed('t'), ui.committed('t')];
      on = ui.toggle('t', on, 'T', 0, 0, 10, 10);
      return [...before, ui.changed('t'), ui.committed('t')];
    });
    expect(r).toEqual([false, false, true, true]);
    expect(ui.changed('t')).toBe(false);
  });

  it('each widget counts once toward the 256-command cap', () => {
    const { ui, step, warnings, frame } = setup();
    step(() => {
      for (let k = 0; k < 64; k++) {
        ui.slider(`s${k}`, 0, 0, 0, 10, 10);
        ui.toggle(`t${k}`, false, 'T', 0, 0, 10, 10);
        ui.textField(`f${k}`, '', 0, 0, 10, 10);
        ui.list(`l${k}`, ['a'], 0, 0, 10, 10);
      }
    });
    expect(warnings).toEqual([]);
    expect(frame().length).toBeGreaterThan(0);
    step(() => {
      for (let k = 0; k < 257; k++) ui.toggle(`t${k}`, false, 'T', 0, 0, 10, 10);
    });
    expect(warnings).toEqual([`${P}more than 256 widgets in one step; the extra ones are not drawn`]);
  });

  it('a focused button still activates as in F012 with the new routing', () => {
    const { ui, fi, step } = setup();
    let v = 0.5;
    const m = () => {
      const a = ui.button('a', 'A', 0, 0, 10, 10);
      v = ui.slider('s', v, 0, 20, 100, 10, { step: 0.1 });
      return a;
    };
    step(m);
    fi.tap('ArrowDown');
    step(m);
    expect(ui.focus).toBe('a');
    fi.tap('ArrowRight'); // on a button, right = next (F012)
    step(m);
    expect(ui.focus).toBe('s');
    fi.tap('Escape');
    step(m);
    expect(ui.focus).toBeNull();
  });
});

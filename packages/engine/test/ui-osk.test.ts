import { describe, expect, it } from 'vitest';
import { InputState } from '../src/input';
import { OSK_DEL, OSK_KEYS, OSK_OK, OSK_SHIFT, OSK_SPACE, oskChar, oskLayout } from '../src/osk';
import { Ui, type TextFieldOptions, type UiInput, type UiRenderer } from '../src/ui';
import type { TextEvent } from '../src/uitext';

type Pad = 'Up' | 'Down' | 'Left' | 'Right' | 'A' | 'B' | 'X' | 'Y' | 'Start' | 'LB';

const P = '[pixelforge] ui: ';
const FIELD = { x: 10, y: 10, w: 160, h: 16 };
const LAYOUT = oskLayout(480, 270, FIELD)!;
const RECT = { x: 2, y: 134, w: 476, h: 136 };

/** Flat key index of a character key (upper case) or a row 4 key. */
function keyIdx(name: string): number {
  const special: Record<string, number> = { SHIFT: OSK_SHIFT, SPACE: OSK_SPACE, DEL: OSK_DEL, OK: OSK_OK };
  if (name in special) return special[name]!;
  return OSK_KEYS.findIndex((k) => oskChar(k.def, true) === name);
}
function centre(name: string): { x: number; y: number } {
  const k = LAYOUT.keys[keyIdx(name)]!;
  return { x: k.x + k.w / 2, y: k.y + k.h / 2 };
}

/** A fake engine.input with lastDevice and the F023 pad buttons. */
function fakeInput(actions: { id: string; keys: string[] }[] = [], withDevice = true) {
  const keys = new InputState();
  const padPressed = new Set<Pad>();
  const padHeld = new Set<Pad>();
  const mouse = { x: 0, y: 0, pressed: false, released: false, inside: true, down: false, cancelled: false, wheel: 0 };
  const state = { textEvents: [] as TextEvent[], device: 'keyboard' };
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
    setKeyboardCapture: () => {},
  };
  if (withDevice) Object.defineProperty(input, 'lastDevice', { get: () => state.device });
  return {
    input,
    mouse,
    keys,
    state,
    set device(d: string) {
      state.device = d;
    },
    tap(code: string) {
      keys.press(code);
      keys.release(code);
    },
    pad(...b: Pad[]) {
      for (const x of b) padPressed.add(x);
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

function recorder(size: { width: number; height: number } | null = { width: 480, height: 270 }) {
  const ops: string[] = [];
  const renderer: UiRenderer = {
    drawNineSlice: (_s, x, y, w, h) => ops.push(`9s ${x},${y},${w},${h}`),
    drawRect: (x, y, w, h, c, o) => ops.push(`rect ${x},${y},${w},${h} ${String(c)} a${o?.alpha ?? 1}`),
    strokeRect: (x, y, w, h, c, t) => ops.push(`stroke ${x},${y},${w},${h} ${String(c)} t${t}`),
    drawText: (t, x, y, o) => ops.push(`text "${t}" ${x},${y} ${String(o?.color)}`),
    measureText: (t) => ({ width: Array.from(String(t)).length * 8, height: 8 }),
    ui: (fn) => fn(),
  };
  if (size) Object.assign(renderer, size);
  return { renderer, ops };
}

function setup(o: { actions?: { id: string; keys: string[] }[]; opts?: TextFieldOptions; size?: { width: number; height: number } | null; withDevice?: boolean } = {}) {
  const fi = fakeInput(o.actions ?? [], o.withDevice ?? true);
  const rec = recorder(o.size === undefined ? { width: 480, height: 270 } : o.size);
  const warnings: string[] = [];
  const ui = new Ui({ input: fi.input, renderer: rec.renderer, warn: (m) => warnings.push(m) });
  const s = { name: '', opts: o.opts ?? ({} as TextFieldOptions), fired: [] as string[], declare: true };
  /** The game: the NAME field, a NEXT button below it, and a button under the keyboard panel. */
  const game = (): void => {
    if (s.declare) s.name = ui.textField('name', s.name, FIELD.x, FIELD.y, FIELD.w, FIELD.h, s.opts);
    if (ui.button('next', 'NEXT', 10, 40, 80, 16)) s.fired.push('next');
    if (ui.button('under', 'UNDER', 100, 200, 80, 20)) s.fired.push('under');
  };
  const step = (extra?: () => void, dt = 1 / 60): void => {
    ui.beginStep(dt);
    extra?.();
    game();
    ui.endStep();
    fi.end();
  };
  const frame = (): string[] => {
    rec.ops.length = 0;
    ui.frameStart();
    ui.drawLayer();
    return [...rec.ops];
  };
  /** Start editing with `ui.editing = "name"` under `device`; the keyboard is drawn from the end of the second step. */
  const start = (device: string): void => {
    fi.device = device;
    step(() => (ui.editing = 'name'));
    step();
  };
  /** The key the cursor outline is on, from the last committed list. */
  const cursorKey = (): string | null => {
    const ops = frame();
    for (let i = 0; i < LAYOUT.keys.length; i++) {
      const k = LAYOUT.keys[i]!;
      if (ops.includes(`stroke ${k.x},${k.y},${k.w},${k.h} #ffd166 t2`)) {
        const d = OSK_KEYS[i]!.def;
        return d.kind === 'char' ? d.upper : d.kind.toUpperCase();
      }
    }
    return null;
  };
  /** Tap a key with the pointer: press in one step, release in the next. */
  const tapKey = (name: string, release: Partial<typeof fi.mouse> = {}): void => {
    Object.assign(fi.mouse, centre(name), { pressed: true, down: true });
    step();
    Object.assign(fi.mouse, { released: true, down: false }, release);
    step();
  };
  return { ui, fi, rec, warnings, s, step, frame, start, cursorKey, tapKey };
}

describe('F023 opening', () => {
  it('opens on a start with lastDevice "touch" or "gamepad", not "keyboard" or "mouse"', () => {
    for (const [dev, shown] of [['touch', true], ['gamepad', true], ['keyboard', false], ['mouse', false]] as const) {
      const t = setup();
      t.start(dev);
      expect(t.ui.editing).toBe('name');
      expect(t.ui.keyboardRect).toEqual(shown ? RECT : null);
      if (shown) expect(Object.isFrozen(t.ui.keyboardRect)).toBe(true);
    }
  });

  it('"always" and "never" behave as named', () => {
    const a = setup({ opts: { keyboard: 'always' } });
    a.start('mouse');
    expect(a.ui.keyboardRect).toEqual(RECT);
    const n = setup({ opts: { keyboard: 'never' } });
    n.start('gamepad');
    expect(n.ui.keyboardRect).toBeNull();
    expect(n.ui.editing).toBe('name');
  });

  it('an invalid keyboard value warns once (exact text) and acts as "auto"', () => {
    const t = setup({ opts: { keyboard: 'sometimes' as never } });
    t.start('keyboard');
    expect(t.ui.keyboardRect).toBeNull();
    t.step(() => (t.ui.editing = null));
    t.start('touch');
    expect(t.ui.keyboardRect).toEqual(RECT);
    expect(t.warnings).toEqual([`${P}textField "name" keyboard must be "auto", "always" or "never"`]);
  });

  it('fakes without lastDevice or a renderer size never show it', () => {
    const a = setup({ withDevice: false });
    a.start('touch');
    expect(a.ui.keyboardRect).toBeNull();
    const b = setup({ size: null, opts: { keyboard: 'always' } });
    b.start('touch');
    expect(b.ui.keyboardRect).toBeNull();
    expect(b.warnings).toEqual([]);
  });

  it('is drawn from the end of the starting step; the A press that starts editing types nothing', () => {
    const { ui, fi, s, step, cursorKey } = setup();
    fi.device = 'gamepad';
    step(() => (ui.focus = 'name'));
    step();
    fi.pad('A');
    step();
    expect(ui.editing).toBe('name');
    expect(s.name).toBe('');
    expect(ui.keyboardRect).toEqual(RECT);
    expect(cursorKey()).toBe('Q');
    fi.pad('A');
    step();
    expect(s.name).toBe('Q');
    expect(ui.editing).toBe('name');
    // Keyboard events never reach input.textEvents or lastDevice.
    expect(fi.input.textEvents).toEqual([]);
    expect(fi.input.lastDevice).toBe('gamepad');
  });
});

describe('F023 gamepad', () => {
  it('D-pad moves the cursor with hold repeat (0.4 s, then every 0.08 s)', () => {
    const { fi, step, start, cursorKey } = setup();
    start('gamepad');
    fi.pad('Right');
    step(undefined, 0.04);
    expect(cursorKey()).toBe('W');
    fi.padHold('Right');
    for (let i = 1; i <= 9; i++) step(undefined, 0.04); // t = 0.36
    expect(cursorKey()).toBe('W');
    step(undefined, 0.04); // t = 0.40
    expect(cursorKey()).toBe('E');
    step(undefined, 0.04); // 0.44
    expect(cursorKey()).toBe('E');
    step(undefined, 0.04); // 0.48
    expect(cursorKey()).toBe('R');
    fi.padHold('Right', false);
    step(undefined, 0.04);
    fi.pad('Down');
    step();
    expect(cursorKey()).toBe('F');
    fi.pad('Up', 'Left');
    step(); // vertical first: R, then left: E
    expect(cursorKey()).toBe('E');
  });

  it('X deletes and repeats while held; Y types a space; LB toggles case; Start submits', () => {
    const { ui, fi, s, step, start, frame } = setup();
    s.name = 'ABCDEFG';
    start('gamepad');
    fi.pad('X');
    step(undefined, 0.1);
    expect(s.name).toBe('ABCDEF');
    fi.padHold('X');
    for (let i = 0; i < 3; i++) step(undefined, 0.1); // 0.3
    expect(s.name).toBe('ABCDEF');
    step(undefined, 0.1); // 0.4
    expect(s.name).toBe('ABCDE');
    step(undefined, 0.1); // 0.5 >= 0.48
    expect(s.name).toBe('ABCD');
    fi.padHold('X', false);
    step(undefined, 0.1);
    expect(s.name).toBe('ABCD');
    fi.pad('Y');
    step();
    expect(s.name).toBe('ABCD ');
    expect(frame().some((o) => o.startsWith('text "abc"'))).toBe(true);
    fi.pad('LB');
    step();
    const ops = frame();
    expect(ops.some((o) => o.startsWith('text "ABC"'))).toBe(true);
    expect(ops.some((o) => o.startsWith('text "q"'))).toBe(true);
    fi.pad('A');
    step();
    expect(s.name).toBe('ABCD q');
    fi.pad('Start');
    step();
    expect(ui.editing).toBeNull();
    expect(ui.focus).toBe('name');
    expect(ui.keyboardRect).toBeNull();
    expect(s.name).toBe('ABCD q');
  });

  it('Start reports committed after the field call', () => {
    const { ui, fi, s, start } = setup();
    start('gamepad');
    fi.pad('Start');
    ui.beginStep(1 / 60);
    s.name = ui.textField('name', s.name, FIELD.x, FIELD.y, FIELD.w, FIELD.h);
    expect(ui.committed('name')).toBe(true);
    ui.endStep();
    fi.end();
    expect(ui.keyboardRect).toBeNull();
  });

  it('B reverts and drops the keyboard events of that step', () => {
    const { ui, fi, s, step, start } = setup();
    s.name = 'OLD';
    start('gamepad');
    fi.pad('A');
    step();
    expect(s.name).toBe('OLDQ');
    fi.pad('B', 'Y', 'A');
    step();
    expect(s.name).toBe('OLD');
    expect(ui.editing).toBeNull();
    expect(ui.focus).toBe('name');
    expect(ui.keyboardRect).toBeNull();
  });

  it('while shown, confirm and pad A do not submit, pad Up/Down do not leave; raw ArrowDown commits and moves focus', () => {
    const { ui, fi, s, step, start } = setup({ actions: [{ id: 'confirm', keys: ['PadConfirm'] }] });
    start('gamepad');
    fi.tap('PadConfirm');
    step();
    expect(ui.editing).toBe('name');
    fi.pad('A');
    step();
    expect(ui.editing).toBe('name');
    expect(s.name).toBe('Q');
    fi.pad('Down');
    step();
    fi.pad('Up');
    step();
    expect(ui.editing).toBe('name');
    expect(ui.focus).toBe('name');
    fi.tap('ArrowDown');
    step();
    expect(ui.editing).toBeNull();
    expect(ui.focus).toBe('next');
    expect(ui.keyboardRect).toBeNull();
    expect(s.name).toBe('Q');
  });

  it('raw arrow keys never move the cursor; raw Enter submits', () => {
    const { ui, fi, step, start, cursorKey } = setup();
    ui.navigation = false;
    start('gamepad');
    fi.tap('ArrowRight');
    fi.tap('ArrowDown');
    step();
    expect(cursorKey()).toBe('Q');
    expect(ui.editing).toBe('name');
    fi.tap('Enter');
    step();
    expect(ui.editing).toBeNull();
  });
});

describe('F023 pointer', () => {
  it('a tap on a key types on release', () => {
    const { ui, fi, s, step, start, tapKey } = setup();
    start('touch');
    Object.assign(fi.mouse, centre('M'), { pressed: true, down: true });
    step();
    expect(s.name).toBe('');
    expect(ui.hot).toBeNull();
    Object.assign(fi.mouse, { released: true, down: false });
    step();
    expect(s.name).toBe('M');
    tapKey('I');
    tapKey('A');
    tapKey('OK');
    expect(s.name).toBe('MIA');
    expect(ui.editing).toBeNull();
    expect(ui.focus).toBe('name');
  });

  it('a press and release in the same step types once', () => {
    const { fi, s, step, start } = setup();
    start('touch');
    Object.assign(fi.mouse, centre('Z'), { pressed: true, released: true, down: false });
    step();
    expect(s.name).toBe('Z');
  });

  it('a release on another key, or a cancelled release, types nothing', () => {
    const { fi, s, step, start, tapKey } = setup();
    start('touch');
    Object.assign(fi.mouse, centre('Q'), { pressed: true, down: true });
    step();
    Object.assign(fi.mouse, centre('W'), { released: true, down: false });
    step();
    expect(s.name).toBe('');
    tapKey('Q', { cancelled: true });
    expect(s.name).toBe('');
  });

  it('a press on the panel over a widget does not commit, keep focus, hot null, never activates it', () => {
    const { ui, fi, s, step, start } = setup();
    start('touch');
    // "under" (100..180 × 200..220) is behind row 2/3 keys.
    Object.assign(fi.mouse, { x: 120, y: 210, pressed: true, down: true });
    step();
    expect(ui.editing).toBe('name');
    expect(ui.focus).toBe('name');
    expect(ui.hot).toBeNull();
    expect(ui.active).toBeNull();
    Object.assign(fi.mouse, { released: true, down: false });
    step();
    expect(s.fired).toEqual([]);
    expect(ui.editing).toBe('name');
    // Hovering the panel never makes the widget under it hot.
    step();
    expect(ui.hot).toBeNull();
  });

  it('a press outside the panel and the field commits and closes', () => {
    const { ui, fi, s, step, start } = setup();
    start('touch');
    s.name = 'X';
    Object.assign(fi.mouse, { x: 300, y: 50, pressed: true, down: true });
    step();
    expect(ui.editing).toBeNull();
    expect(ui.keyboardRect).toBeNull();
  });

  it('a press on the field moves the caret and keeps the keyboard', () => {
    const { ui, fi, s, step, start, tapKey } = setup();
    s.name = 'AB';
    start('touch');
    Object.assign(fi.mouse, { x: 14, y: 18, pressed: true, down: true }); // before "A"
    step();
    Object.assign(fi.mouse, { released: true, down: false });
    step();
    expect(ui.keyboardRect).toEqual(RECT);
    tapKey('Z');
    expect(s.name).toBe('ZAB');
  });
});

describe('F023 hide and reopen', () => {
  it('a physical text event hides the keyboard and still applies; a touch press on the field reopens it', () => {
    const { ui, fi, s, step, start, cursorKey } = setup();
    start('touch');
    fi.pad('Right');
    step();
    expect(cursorKey()).toBe('W');
    fi.type('k');
    step();
    expect(s.name).toBe('k');
    expect(ui.editing).toBe('name');
    expect(ui.keyboardRect).toBeNull();
    // A mouse press on the field ("auto") doesn't reopen it.
    fi.device = 'mouse';
    Object.assign(fi.mouse, { x: 50, y: 18, pressed: true, released: true });
    step();
    expect(ui.keyboardRect).toBeNull();
    // A touch press does, with capitals and the cursor on Q.
    fi.device = 'touch';
    Object.assign(fi.mouse, { x: 50, y: 18, pressed: true, released: true });
    step();
    expect(ui.keyboardRect).toEqual(RECT);
    expect(cursorKey()).toBe('Q');
    expect(ui.editing).toBe('name');
  });

  it('"always" reopens on a mouse press', () => {
    const { ui, fi, step, start } = setup({ opts: { keyboard: 'always' } });
    start('mouse');
    fi.type('k');
    step();
    expect(ui.keyboardRect).toBeNull();
    Object.assign(fi.mouse, { x: 50, y: 18, pressed: true, released: true });
    step();
    expect(ui.keyboardRect).toEqual(RECT);
  });

  it('typing that starts editing keeps the keyboard hidden', () => {
    const { ui, fi, s, step } = setup();
    fi.device = 'gamepad';
    step(() => (ui.focus = 'name'));
    fi.type('a');
    step();
    expect(ui.editing).toBe('name');
    expect(s.name).toBe('a');
    expect(ui.keyboardRect).toBeNull();
  });
});

describe('F023 disabled keys', () => {
  const disabledLabel = (ops: string[], label: string): boolean => ops.some((o) => o.startsWith(`text "${label}" `) && o.endsWith('#8b91b0'));

  it('maxLength reached: character keys and SPACE disabled; pressing does nothing; DEL enabled', () => {
    const { fi, s, step, start, frame } = setup({ opts: { maxLength: 2 } });
    s.name = 'AB';
    start('gamepad');
    const ops = frame();
    expect(disabledLabel(ops, 'Q')).toBe(true);
    expect(disabledLabel(ops, 'SPACE')).toBe(true);
    expect(disabledLabel(ops, 'DEL')).toBe(false);
    expect(disabledLabel(ops, 'OK')).toBe(false);
    expect(ops.some((o) => o.includes('#2a3358 a0.5'))).toBe(true); // disabled keys at alpha 0.5
    fi.pad('A', 'Y');
    step();
    expect(s.name).toBe('AB');
  });

  it('allow rejecting: those keys dim and cannot be typed', () => {
    const { s, start, frame, tapKey } = setup({ opts: { allow: (c) => /^[A-Z]$/.test(c) } });
    start('touch');
    const ops = frame();
    expect(disabledLabel(ops, '1')).toBe(true);
    expect(disabledLabel(ops, "'")).toBe(true);
    expect(disabledLabel(ops, 'Q')).toBe(false);
    tapKey('1');
    tapKey('Q');
    expect(s.name).toBe('Q');
  });

  it('allow throwing: the F019 warning, once', () => {
    const { warnings, start, frame } = setup({
      opts: {
        allow: () => {
          throw new Error('x');
        },
      },
    });
    start('touch');
    expect(disabledLabel(frame(), 'Q')).toBe(true);
    expect(warnings).toEqual([`${P}textField "name" allow threw; the character was rejected`]);
  });

  it('DEL is disabled at caret 0', () => {
    const { fi, s, step, start, frame } = setup();
    start('gamepad');
    expect(disabledLabel(frame(), 'DEL')).toBe(true);
    fi.pad('X');
    step();
    expect(s.name).toBe('');
    fi.pad('A');
    step();
    expect(disabledLabel(frame(), 'DEL')).toBe(false);
  });
});

describe('F023 order within a step', () => {
  it('pointer key, then A on the start-of-step key, then the move, then X / Y / Start', () => {
    const { ui, fi, s, step, start } = setup();
    start('touch');
    Object.assign(fi.mouse, centre('W'), { pressed: true, down: true });
    step();
    Object.assign(fi.mouse, { released: true, down: false });
    fi.pad('A', 'Right', 'X', 'Y', 'Start');
    ui.beginStep(1 / 60);
    s.name = ui.textField('name', s.name, FIELD.x, FIELD.y, FIELD.w, FIELD.h);
    const committed = ui.committed('name');
    ui.endStep();
    fi.end();
    // "W" (pointer), "Q" (A on Q), cursor → W, DEL removes Q, space; then OK submits.
    expect(s.name).toBe('W ');
    expect(committed).toBe(true);
    expect(ui.editing).toBeNull();
  });

  it('A uses the start-of-step key even when the cursor moves in the same step', () => {
    const { fi, s, step, start, cursorKey } = setup();
    start('gamepad');
    fi.pad('A', 'Right');
    step();
    expect(s.name).toBe('Q');
    expect(cursorKey()).toBe('W');
  });

  it('SHIFT changes the case of the events after it in the same step', () => {
    const { fi, s, step, start } = setup();
    start('touch');
    Object.assign(fi.mouse, centre('SHIFT'), { pressed: true, down: true });
    step();
    Object.assign(fi.mouse, { released: true, down: false });
    fi.pad('A');
    step();
    expect(s.name).toBe('q');
    fi.pad('A', 'LB'); // LB after A: A still types lower case
    step();
    expect(s.name).toBe('qq');
    fi.pad('A');
    step();
    expect(s.name).toBe('qqQ');
  });
});

describe('F023 drawing', () => {
  it('the panel is one command after the widgets and outside the 256 cap', () => {
    const { ui, fi, s, warnings, start, frame } = setup();
    start('gamepad');
    fi.end();
    ui.beginStep(1 / 60);
    s.name = ui.textField('name', s.name, FIELD.x, FIELD.y, FIELD.w, FIELD.h);
    for (let i = 0; i < 300; i++) ui.label('x', 0, 0);
    ui.endStep();
    expect(warnings.some((w) => w.includes('more than 256 widgets'))).toBe(true);
    expect(ui.keyboardRect).toEqual(RECT);
    const ops = frame();
    const panel = ops.indexOf('rect 2,134,476,136 #141a2e a1');
    expect(panel).toBeGreaterThan(ops.lastIndexOf('text "x" 0,0 #ffffff'));
    expect(ops.filter((o) => o.startsWith('text "x"'))).toHaveLength(255);
    // Last op: the cursor outline, 2 units inside the Q key.
    const q = LAYOUT.keys[keyIdx('Q')]!;
    expect(ops[ops.length - 1]).toBe(`stroke ${q.x},${q.y},${q.w},${q.h} #ffd166 t2`);
  });

  it('a pressed key uses the button down colour; hover uses the hover colour', () => {
    const { fi, step, start, frame } = setup();
    start('touch');
    const w = LAYOUT.keys[keyIdx('W')]!;
    Object.assign(fi.mouse, centre('W'));
    step();
    expect(frame()).toContain(`rect ${w.x},${w.y},${w.w},${w.h} #3a4780 a1`);
    fi.mouse.pressed = fi.mouse.down = true;
    step();
    expect(frame()).toContain(`rect ${w.x},${w.y},${w.w},${w.h} #1e2540 a1`);
  });

  it('a game too small: no keyboard, the exact warning once', () => {
    const { ui, warnings, step, start } = setup({ size: { width: 60, height: 40 } });
    start('touch');
    step();
    step();
    expect(ui.keyboardRect).toBeNull();
    expect(ui.editing).toBe('name');
    expect(warnings).toEqual([`${P}on-screen keyboard does not fit a 60x40 game; it is not shown`]);
  });

  it('docks at the top when the field is near the bottom', () => {
    const { ui, s } = setup();
    ui.beginStep();
    ui.editing = 'low';
    ui.endStep();
    const low = (): void => {
      ui.beginStep();
      ui.textField('low', s.name, 10, 240, 100, 16, { keyboard: 'always' });
      ui.endStep();
    };
    low();
    low();
    expect(ui.keyboardRect).toEqual({ x: 2, y: 0, w: 476, h: 136 });
  });
});

describe('F023 pause and drop', () => {
  it('cancelPointer drops a key press; the keyboard stays open', () => {
    const { ui, fi, s, step, start } = setup();
    start('touch');
    Object.assign(fi.mouse, centre('Q'), { pressed: true, down: true });
    step();
    ui.cancelPointer();
    Object.assign(fi.mouse, { released: true, down: false });
    step();
    expect(s.name).toBe('');
    expect(ui.keyboardRect).toEqual(RECT);
    expect(ui.editing).toBe('name');
  });

  it('cancelPointer drops the repeat timers', () => {
    const { ui, fi, s, step, start } = setup();
    s.name = 'ABCDEF';
    start('gamepad');
    fi.pad('X');
    step(undefined, 0.1);
    fi.padHold('X');
    for (let i = 0; i < 3; i++) step(undefined, 0.1);
    ui.cancelPointer();
    step(undefined, 0.1); // the timer restarts: no repeat at 0.4
    expect(s.name).toBe('ABCDE');
  });

  it('a field that is not declared drops editing and closes the keyboard with no signal', () => {
    const { ui, s, step, start } = setup();
    start('touch');
    s.declare = false;
    step();
    expect(ui.editing).toBeNull();
    expect(ui.keyboardRect).toBeNull();
    s.declare = true;
    step();
    expect(ui.committed('name')).toBe(false);
    expect(ui.keyboardRect).toBeNull();
  });
});

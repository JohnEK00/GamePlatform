import { describe, expect, it } from 'vitest';
import { InputState } from '../src/input';
import { NineSlice } from '../src/nineslice';
import { Texture, type TexturePage } from '../src/texture';
import { Ui, type UiInput, type UiRenderer } from '../src/ui';

type Pad = 'Up' | 'Down' | 'Left' | 'Right' | 'A' | 'B';

/** A fake engine.input: keys via InputState, a settable mouse, declared actions and a gamepad. */
function fakeInput(actions: { id: string; keys: string[] }[] = []) {
  const keys = new InputState();
  const padPressed = new Set<Pad>();
  const calls: string[] = [];
  const mouse = { x: 0, y: 0, pressed: false, released: false, inside: true };
  const input: UiInput = {
    mouse,
    actions,
    actionPressed(id) {
      calls.push(id);
      const a = actions.find((x) => x.id === id);
      return !!a && a.keys.some((k) => keys.wasPressed(k));
    },
    wasPressed: (c) => keys.wasPressed(c),
    gamepad: () => ({ wasPressed: (b: Pad) => padPressed.has(b) }),
  };
  return {
    input,
    mouse,
    calls,
    /** Tap a key so it is "pressed" for the next step. */
    tap(code: string) {
      keys.press(code);
      keys.release(code);
    },
    pad(b: Pad) {
      padPressed.add(b);
    },
    /** After a step: clear edges. */
    end() {
      keys.endStep();
      padPressed.clear();
      mouse.pressed = mouse.released = false;
    },
  };
}

function recorder() {
  const ops: string[] = [];
  const renderer: UiRenderer = {
    drawNineSlice: (_s, x, y, w, h, o) => ops.push(`9s ${x},${y},${w},${h} s${o?.scale} a${o?.alpha}`),
    drawRect: (x, y, w, h, c, o) => ops.push(`rect ${x},${y},${w},${h} ${String(c)} a${o?.alpha ?? 1}`),
    strokeRect: (x, y, w, h, c, t, a) => ops.push(`stroke ${x},${y},${w},${h} ${String(c)} t${t} a${a}`),
    drawText: (t, x, y, o) => ops.push(`text "${t}" ${x},${y} ${o?.font} ${o?.size} ${String(o?.color)}`),
    ui: (fn) => {
      ops.push('ui{');
      fn();
      ops.push('}');
    },
    setBlend: (m) => ops.push(`blend ${m}`),
    blendMode: 'normal',
  };
  return { renderer, ops };
}

function setup(actions: { id: string; keys: string[] }[] = []) {
  const fi = fakeInput(actions);
  const rec = recorder();
  const warnings: string[] = [];
  const ui = new Ui({ input: fi.input, renderer: rec.renderer, warn: (m) => warnings.push(m) });
  /** One fixed step running `body` (the game's update). */
  const step = <T>(body: () => T): T => {
    ui.beginStep();
    const r = body();
    ui.endStep();
    fi.end();
    return r;
  };
  /** One rendered frame (automatic layer). */
  const frame = (body?: () => void) => {
    rec.ops.length = 0;
    ui.frameStart();
    ui.setPhase('render');
    body?.();
    ui.setPhase('other');
    ui.drawLayer();
    return [...rec.ops];
  };
  return { ui, fi, rec, warnings, step, frame };
}

const menu = (ui: Ui, opts: { disabledB?: boolean; navC?: boolean } = {}) => ({
  a: ui.button('a', 'A', 10, 10, 100, 20),
  b: ui.button('b', 'B', 10, 40, 100, 20, { disabled: opts.disabledB }),
  c: ui.button('c', 'C', 10, 70, 100, 20, { nav: opts.navC }),
});

describe('Ui pointer', () => {
  it('click = press inside + release inside → true exactly once', () => {
    const { ui, fi, step } = setup();
    Object.assign(fi.mouse, { x: 50, y: 15 });
    expect(step(() => menu(ui)).a).toBe(false);
    expect(ui.hot).toBeNull(); // hot comes from the previous step's rects
    fi.mouse.pressed = true;
    expect(step(() => menu(ui)).a).toBe(false);
    expect(ui.hot).toBe('a');
    expect(ui.active).toBe('a');
    fi.mouse.released = true;
    expect(step(() => menu(ui)).a).toBe(true);
    expect(ui.active).toBeNull();
    expect(step(() => menu(ui)).a).toBe(false);
  });

  it('a quick tap between two steps (press + release in one step) activates', () => {
    const { ui, fi, step } = setup();
    Object.assign(fi.mouse, { x: 50, y: 15 });
    step(() => menu(ui));
    fi.mouse.pressed = fi.mouse.released = true;
    expect(step(() => menu(ui)).a).toBe(true);
  });

  it('a touch tap activates even though pointerleave already cleared mouse.inside', () => {
    const { ui, fi, step } = setup();
    Object.assign(fi.mouse, { x: 50, y: 15, inside: false });
    step(() => menu(ui));
    Object.assign(fi.mouse, { pressed: true });
    step(() => menu(ui));
    expect(ui.active).toBe('a');
    Object.assign(fi.mouse, { released: true });
    expect(step(() => menu(ui)).a).toBe(true);
  });

  it('release outside → false; press outside then release inside → false', () => {
    const { ui, fi, step } = setup();
    Object.assign(fi.mouse, { x: 50, y: 15 });
    step(() => menu(ui));
    fi.mouse.pressed = true;
    step(() => menu(ui));
    Object.assign(fi.mouse, { x: 300, y: 15, released: true });
    expect(step(() => menu(ui)).a).toBe(false);

    Object.assign(fi.mouse, { x: 300, y: 15, pressed: true });
    step(() => menu(ui));
    expect(ui.active).toBeNull();
    Object.assign(fi.mouse, { x: 50, y: 15, released: true });
    expect(step(() => menu(ui)).a).toBe(false);
  });

  it('a disabled button is never hot, active or activated', () => {
    const { ui, fi, step } = setup();
    Object.assign(fi.mouse, { x: 50, y: 45 });
    step(() => menu(ui, { disabledB: true }));
    fi.mouse.pressed = true;
    step(() => menu(ui, { disabledB: true }));
    expect(ui.hot).toBeNull();
    expect(ui.active).toBeNull();
    fi.mouse.released = true;
    expect(step(() => menu(ui, { disabledB: true })).b).toBe(false);
  });

  it('the last declared of overlapping buttons wins; pointer outside the canvas is never hot', () => {
    const { ui, fi, step } = setup();
    Object.assign(fi.mouse, { x: 15, y: 15 });
    const both = () => [ui.button('under', 'U', 0, 0, 50, 50), ui.button('over', 'O', 10, 10, 50, 50)];
    step(both);
    step(both);
    expect(ui.hot).toBe('over');
    fi.mouse.inside = false;
    step(both);
    expect(ui.hot).toBeNull();
  });

  it('a duplicate id warns once and never activates', () => {
    const { ui, fi, warnings, step } = setup();
    Object.assign(fi.mouse, { x: 50, y: 15 });
    const dup = () => [ui.button('x', '1', 10, 10, 100, 20), ui.button('x', '2', 10, 10, 100, 20)];
    step(dup);
    fi.mouse.pressed = fi.mouse.released = true;
    expect(step(dup)).toEqual([true, false]);
    step(dup);
    expect(warnings.filter((w) => w.includes('"x" is used twice'))).toHaveLength(1);
    step(() => ui.button('', 'bad', 0, 0, 1, 1));
    step(() => ui.button('y'.repeat(65), 'bad', 0, 0, 1, 1));
    expect(warnings.filter((w) => w.includes('must be a string of 1–64'))).toHaveLength(2);
  });
});

describe('Ui navigation', () => {
  it('down from no focus → first nav button; wraps; up → last; skips nav:false and disabled', () => {
    const { ui, fi, step } = setup();
    const m = () => menu(ui, { disabledB: true, navC: false });
    const d = () => ({ ...m(), d: ui.button('d', 'D', 10, 100, 100, 20) });
    step(d);
    expect(ui.focus).toBeNull();
    fi.tap('ArrowDown');
    step(d);
    expect(ui.focus).toBe('a');
    fi.tap('ArrowDown');
    step(d);
    expect(ui.focus).toBe('d');
    fi.tap('ArrowDown');
    step(d);
    expect(ui.focus).toBe('a'); // wrapped
    fi.tap('Escape');
    step(d);
    expect(ui.focus).toBeNull();
    fi.tap('ArrowUp');
    step(d);
    expect(ui.focus).toBe('d');
    fi.tap('ArrowLeft');
    step(d);
    expect(ui.focus).toBe('a');
    fi.tap('ArrowRight');
    step(d);
    expect(ui.focus).toBe('d');
  });

  it('Enter / Space / NumpadEnter activate the focused button when confirm is not declared', () => {
    const { ui, fi, step } = setup();
    step(() => menu(ui));
    for (const key of ['Enter', 'Space', 'NumpadEnter']) {
      ui.focus = 'b';
      fi.tap(key);
      expect(step(() => menu(ui))).toEqual({ a: false, b: true, c: false });
    }
    ui.focus = null;
    fi.tap('Enter');
    expect(step(() => menu(ui))).toEqual({ a: false, b: false, c: false });
  });

  it('uses the declared confirm/up/down actions; Enter is then ignored; undeclared ids are never queried', () => {
    const { ui, fi, step } = setup([
      { id: 'confirm', keys: ['KeyK'] },
      { id: 'down', keys: ['KeyS'] },
    ]);
    step(() => menu(ui));
    fi.tap('ArrowDown'); // down is declared → the arrow is ignored
    step(() => menu(ui));
    expect(ui.focus).toBeNull();
    fi.tap('KeyS');
    step(() => menu(ui));
    expect(ui.focus).toBe('a');
    fi.tap('Enter');
    expect(step(() => menu(ui)).a).toBe(false);
    fi.tap('KeyK');
    expect(step(() => menu(ui)).a).toBe(true);
    fi.tap('ArrowUp'); // up is not declared → the fallback key works
    step(() => menu(ui));
    expect(ui.focus).toBe('c');
    expect(new Set(fi.calls)).toEqual(new Set(['confirm', 'down']));
  });

  it('gamepad D-pad moves, A activates, B clears', () => {
    const { ui, fi, step } = setup();
    step(() => menu(ui));
    fi.pad('Down');
    step(() => menu(ui));
    expect(ui.focus).toBe('a');
    fi.pad('Down');
    step(() => menu(ui));
    expect(ui.focus).toBe('b');
    fi.pad('A');
    expect(step(() => menu(ui)).b).toBe(true);
    fi.pad('Up');
    step(() => menu(ui));
    expect(ui.focus).toBe('a');
    fi.pad('B');
    step(() => menu(ui));
    expect(ui.focus).toBeNull();
  });

  it('nothing happens with an empty order or navigation off', () => {
    const { ui, fi, step } = setup();
    fi.tap('ArrowDown');
    step(() => ui.button('hud', 'II', 0, 0, 10, 10, { nav: false }));
    fi.tap('ArrowDown');
    step(() => ui.button('hud', 'II', 0, 0, 10, 10, { nav: false }));
    expect(ui.focus).toBeNull();
    ui.navigation = false;
    step(() => menu(ui));
    fi.tap('ArrowDown');
    step(() => menu(ui));
    expect(ui.focus).toBeNull();
  });

  it('focus is cleared when the focused id is not declared (or disabled) in a step', () => {
    const { ui, fi, step } = setup();
    step(() => menu(ui));
    fi.tap('ArrowDown');
    step(() => menu(ui));
    expect(ui.focus).toBe('a');
    step(() => ui.button('b', 'B', 0, 0, 1, 1));
    expect(ui.focus).toBeNull();
    ui.focus = 'b';
    step(() => ui.button('b', 'B', 0, 0, 1, 1, { disabled: true }));
    expect(ui.focus).toBeNull();
  });

  it('a pointer press clears focus', () => {
    const { ui, fi, step } = setup();
    step(() => menu(ui));
    fi.tap('ArrowDown');
    step(() => menu(ui));
    expect(ui.focus).toBe('a');
    Object.assign(fi.mouse, { x: 50, y: 45, pressed: true });
    step(() => menu(ui));
    expect(ui.focus).toBeNull();
    expect(ui.active).toBe('b');
  });
});

describe('Ui phases and drawing', () => {
  it('a button called during render draws immediately, returns false and warns once', () => {
    const { ui, rec, warnings, frame, step } = setup();
    step(() => undefined);
    let r: boolean | undefined;
    const ops = frame(() => {
      r = ui.button('play', 'PLAY', 0, 0, 50, 20);
      ui.button('play', 'PLAY', 0, 0, 50, 20);
    });
    expect(r).toBe(false);
    expect(ops.filter((o) => o.startsWith('text "PLAY"'))).toHaveLength(2);
    expect(warnings.filter((w) => w.includes('"play" was called outside update'))).toHaveLength(1);
    rec.ops.length = 0;
    // L2c (GAME_FORMAT § F012 Phases): outside a step and outside render ("other", e.g. load or a
    // setTimeout callback) widgets also draw immediately at the call site and never activate.
    expect(ui.button('load', 'X', 0, 0, 1, 1)).toBe(false);
    ui.panel(0, 0, 10, 10);
    ui.label('L', 1, 2);
    expect(rec.ops.filter((o) => o === 'ui{')).toHaveLength(3);
    expect(rec.ops).toContain('text "X" 0.5,0.5 default undefined #ffffff');
    expect(rec.ops).toContain('rect 0,0,10,10 #141a2e a1');
    expect(rec.ops).toContain('text "L" 1,2 default undefined #ffffff');
    expect(warnings.filter((w) => w.includes('"load"'))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('panel') || w.includes('label'))).toEqual([]);
    // …and they don't leak into the next step's list.
    rec.ops.length = 0;
    const ops2 = frame();
    expect(ops2.some((o) => o.includes('"X"') || o.includes('"L"'))).toBe(false);
  });

  it('panel and label draw at the call site in render without warnings', () => {
    const { ui, warnings, frame } = setup();
    const ops = frame(() => {
      ui.panel(0, 0, 100, 50);
      ui.label('HI', 5, 5);
    });
    expect(ops).toContain('rect 0,0,100,50 #141a2e a1');
    expect(ops).toContain('stroke 0,0,100,50 #3a4470 t1 a1');
    expect(ops).toContain('text "HI" 5,5 default undefined #ffffff');
    expect(warnings).toEqual([]);
  });

  it('the committed list survives steps without beginStep and is replaced (even by an empty list)', () => {
    const { ui, step, frame } = setup();
    step(() => ui.label('one', 0, 0));
    expect(frame().filter((o) => o.startsWith('text'))).toEqual(['text "one" 0,0 default undefined #ffffff']);
    expect(frame().filter((o) => o.startsWith('text'))).toHaveLength(1); // paused: no step, redrawn
    step(() => ui.label('two', 0, 0));
    step(() => ui.label('three', 0, 0)); // several steps: the last wins
    expect(frame().filter((o) => o.startsWith('text'))).toEqual(['text "three" 0,0 default undefined #ffffff']);
    step(() => {});
    expect(frame()).toEqual([]);
  });

  it('draws in screen space with normal blend, restoring the previous blend', () => {
    const { ui, rec, step, frame } = setup();
    step(() => ui.label('x', 0, 0));
    (rec.renderer as { blendMode: string }).blendMode = 'additive';
    const ops = frame();
    expect(ops[0]).toBe('blend normal');
    expect(ops[1]).toBe('ui{');
    expect(ops.at(-2)).toBe('}');
    expect(ops.at(-1)).toBe('blend additive');
  });

  it('autoDraw = false without draw() draws nothing; draw() twice in a frame draws once', () => {
    const { ui, step, frame } = setup();
    step(() => ui.label('x', 0, 0));
    ui.autoDraw = false;
    expect(frame()).toEqual([]);
    const ops = frame(() => {
      ui.draw();
      ui.draw();
    });
    expect(ops.filter((o) => o.startsWith('text'))).toHaveLength(1);
    ui.autoDraw = true;
    const ops2 = frame(() => ui.draw()); // draw() ran → the automatic layer is skipped
    expect(ops2.filter((o) => o.startsWith('text'))).toHaveLength(1);
  });

  it('caps a step at 256 commands with one warning', () => {
    const { ui, warnings, step, frame } = setup();
    step(() => {
      for (let i = 0; i < 300; i++) ui.label(String(i), 0, 0);
    });
    step(() => {
      for (let i = 0; i < 300; i++) ui.label(String(i), 0, 0);
    });
    expect(frame().filter((o) => o.startsWith('text'))).toHaveLength(256);
    expect(warnings.filter((w) => w.includes('more than 256'))).toHaveLength(1);
  });

  it('draws button states, the focus ring and disabled buttons per the theme', () => {
    const { ui, fi, step, frame } = setup();
    Object.assign(fi.mouse, { x: 50, y: 15 });
    const m = () => menu(ui, { disabledB: true });
    step(m);
    step(m); // a is hot
    let ops = frame();
    expect(ops).toContain('rect 10,10,100,20 #3a4780 a1'); // hover
    expect(ops).toContain('rect 10,40,100,20 #2a3358 a0.5'); // disabled
    expect(ops).toContain('text "B" 60,50 default undefined #8b91b0');
    fi.mouse.pressed = true;
    step(m);
    ops = frame();
    expect(ops).toContain('rect 10,10,100,20 #1e2540 a1'); // down
    fi.mouse.released = true;
    step(m);
    fi.mouse.inside = false;
    fi.tap('ArrowDown');
    step(m);
    fi.tap('ArrowDown');
    step(m);
    expect(ui.focus).toBe('c');
    ops = frame();
    expect(ops).toContain('stroke 6,66,108,28 #ffd166 t2 a1');
    expect(ops.filter((o) => o.includes('#ffd166'))).toHaveLength(1);
  });

  it('uses theme 9-slices, nineSliceScale, font and textSize', () => {
    const { ui, fi, step, frame } = setup();
    const page = { glTexture: {} as WebGLTexture, width: 12, height: 12, white: null } as TexturePage;
    const ns = new NineSlice(new Texture(page, 12, 12, 0, 0, 1, 1), 4);
    Object.assign(ui.theme, { panel: ns, button: ns, nineSliceScale: 2, font: 'pixel', textSize: 8 });
    fi.mouse.inside = false;
    step(() => {
      ui.panel(0, 0, 100, 60);
      ui.panel(0, 0, 10, 10, { style: null, color: '#123456', alpha: 0.5 });
      ui.button('p', 'PLAY', 10, 10, 80, 20, { textSize: 16, textColor: '#ff0000' });
    });
    const ops = frame();
    expect(ops).toContain('9s 0,0,100,60 s2 a1');
    expect(ops).toContain('rect 0,0,10,10 #123456 a0.5');
    expect(ops).toContain('9s 10,10,80,20 s2 a1');
    expect(ops).toContain('text "PLAY" 50,20 pixel 16 #ff0000');
  });
});

describe('review 5 M2: a cancelled press never activates', () => {
  /** Ui driven by a real InputState for Mouse0, mirroring Input.beginStep / engine.step. */
  function realMouse() {
    const st = new InputState();
    const mouse = { x: 50, y: 15, pressed: false, released: false, inside: true, down: false, cancelled: false };
    const input: UiInput = { mouse, actions: [], actionPressed: () => false, wasPressed: () => false, gamepad: () => ({ wasPressed: () => false }) };
    const { renderer } = recorder();
    const ui = new Ui({ input, renderer, warn: () => {} });
    const step = (): boolean => {
      Object.assign(mouse, {
        down: st.isDown('Mouse0'), pressed: st.wasPressed('Mouse0'), released: st.wasReleased('Mouse0'), cancelled: st.wasCancelled('Mouse0'),
      });
      ui.beginStep();
      const fired = ui.button('quit', 'QUIT', 0, 0, 100, 30);
      ui.endStep();
      st.endStep();
      return fired;
    };
    return { st, ui, step, mouse };
  }

  it('the review repro: press, hold, releaseAll (blur / pause) → never fires', () => {
    const { st, ui, step } = realMouse();
    step();
    st.press('Mouse0');
    expect(step()).toBe(false);
    expect(ui.active).toBe('quit');
    expect(step()).toBe(false);
    st.releaseAll();
    expect(step()).toBe(false);
    expect(ui.active).toBeNull();
    expect(step()).toBe(false);
  });

  it('pointercancel (a cancelling release) clears active without firing', () => {
    const { st, ui, step } = realMouse();
    step();
    st.press('Mouse0');
    step();
    st.release('Mouse0', true);
    expect(step()).toBe(false);
    expect(ui.active).toBeNull();
    // a real click afterwards still works
    st.press('Mouse0');
    step();
    st.release('Mouse0');
    expect(step()).toBe(true);
  });

  it('press + cancel within one step never fires; cancel then a new press starts a fresh press', () => {
    const { st, ui, step } = realMouse();
    step();
    st.press('Mouse0');
    st.releaseAll();
    expect(step()).toBe(false);
    expect(ui.active).toBeNull();
    // held, then blur and a new press before the next step: the old press is dropped, the new one is active
    st.press('Mouse0');
    step();
    st.releaseAll();
    st.press('Mouse0');
    expect(step()).toBe(false);
    expect(ui.active).toBe('quit');
    st.release('Mouse0');
    expect(step()).toBe(true);
  });

  it('a real release followed by a new press in one step fires the first press and arms the second', () => {
    const { st, ui, step } = realMouse();
    step();
    st.press('Mouse0');
    step();
    st.release('Mouse0');
    st.press('Mouse0');
    expect(step()).toBe(true);
    expect(ui.active).toBe('quit');
  });

  it('cancelPointer (engine pause / resume) drops active and hot', () => {
    const { st, ui, step } = realMouse();
    step();
    st.press('Mouse0');
    step();
    expect(ui.hot).toBe('quit');
    ui.cancelPointer();
    expect(ui.active).toBeNull();
    expect(ui.hot).toBeNull();
    // even a real release over the button afterwards does not fire (the press was abandoned)
    st.release('Mouse0');
    expect(step()).toBe(false);
  });
});

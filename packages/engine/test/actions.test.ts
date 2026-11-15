import { describe, expect, it } from 'vitest';
import {
  ActionMap, applyOverrides, BINDABLE_KEYS, GAMEPAD_BUTTON_NAMES, gamepadLabel, keyLabel, parseActions,
  type ControlAction, type GamepadButtonName, type PadSource,
} from '../src/actions';
import { InputState } from '../src/input';

const act = (id: string, keys: string[], gamepad: GamepadButtonName[] = [], name = id): ControlAction => ({ id, name, keys, gamepad });

describe('key tables', () => {
  it('has 86 bindable codes and 16 gamepad buttons', () => {
    expect(BINDABLE_KEYS).toHaveLength(86);
    expect(new Set(BINDABLE_KEYS).size).toBe(86);
    expect(BINDABLE_KEYS.filter((k) => !k.startsWith('Mouse'))).toHaveLength(83);
    expect(GAMEPAD_BUTTON_NAMES).toHaveLength(16);
    expect(GAMEPAD_BUTTON_NAMES).not.toContain('Home');
    for (const k of ['KeyA', 'KeyZ', 'Digit0', 'Numpad9', 'NumpadEnter', 'IntlBackslash', 'Home', 'PageDown', 'Mouse2', 'AltRight'])
      expect(BINDABLE_KEYS).toContain(k);
    for (const k of ['Escape', 'Tab', 'F1', 'F3', 'F24', 'MetaLeft', 'MetaRight', 'CapsLock', 'ContextMenu', 'PrintScreen', 'ScrollLock', 'Pause', 'NumLock'])
      expect(BINDABLE_KEYS).not.toContain(k);
  });
  it('labels codes per the default table', () => {
    expect(keyLabel('KeyQ')).toBe('Q');
    expect(keyLabel('Digit7')).toBe('7');
    expect(keyLabel('Numpad3')).toBe('Num 3');
    expect(keyLabel('NumpadAdd')).toBe('Num +');
    expect(keyLabel('NumpadEnter')).toBe('Num Enter');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('ShiftLeft')).toBe('Left Shift');
    expect(keyLabel('ControlRight')).toBe('Right Ctrl');
    expect(keyLabel('Backslash')).toBe('\\');
    expect(keyLabel('Backquote')).toBe('`');
    expect(keyLabel('Quote')).toBe("'");
    expect(keyLabel('IntlBackslash')).toBe('Intl \\');
    expect(keyLabel('PageUp')).toBe('Page Up');
    expect(keyLabel('Mouse0')).toBe('Left click');
    expect(keyLabel('Mouse1')).toBe('Middle click');
    expect(keyLabel('Escape')).toBe('Escape');
    expect(keyLabel('Whatever')).toBe('Whatever');
    expect(gamepadLabel('A')).toBe('A');
    expect(gamepadLabel('RT')).toBe('RT');
    expect(gamepadLabel('Up')).toBe('D-pad ↑');
    expect(gamepadLabel('Right')).toBe('D-pad →');
    expect(gamepadLabel('Home')).toBe('Home');
  });
});

describe('parseActions (lenient)', () => {
  it('accepts a valid manifest, trims names and defaults lists', () => {
    const { actions, warnings } = parseActions([
      { id: 'left', name: ' Move left ', keys: ['ArrowLeft', 'KeyA'], gamepad: ['Left'] },
      { id: 'jump', name: 'Jump', keys: ['Space', 'ArrowUp', 'KeyW'], gamepad: ['A'], extra: 1 },
      { id: 'fire', name: 'Fire', keys: ['Mouse0', 'KeyZ'] },
      { id: 'pad_only', name: 'Pad', gamepad: ['B', 'Start'] },
    ]);
    expect(warnings).toEqual([]);
    expect(actions).toEqual([
      act('left', ['ArrowLeft', 'KeyA'], ['Left'], 'Move left'),
      act('jump', ['Space', 'ArrowUp', 'KeyW'], ['A'], 'Jump'),
      act('fire', ['Mouse0', 'KeyZ'], [], 'Fire'),
      act('pad_only', [], ['B', 'Start'], 'Pad'),
    ]);
    expect(Object.isFrozen(actions[0])).toBe(true);
    expect(Object.isFrozen(actions[0]!.keys)).toBe(true);
  });

  it('absent / null → [] without warnings; non-array → [] with a warning', () => {
    expect(parseActions(undefined)).toEqual({ actions: [], warnings: [] });
    expect(parseActions(null)).toEqual({ actions: [], warnings: [] });
    for (const v of [{}, 'jump', 3, true]) {
      const r = parseActions(v);
      expect(r.actions).toEqual([]);
      expect(r.warnings).toHaveLength(1);
    }
  });

  it('drops invalid entries with a warning', () => {
    const cases: unknown[] = [
      'not an object',
      { id: 'Bad Id', name: 'x', keys: ['KeyA'] },
      { id: 'x'.repeat(33), name: 'x', keys: ['KeyA'] },
      { name: 'no id', keys: ['KeyA'] },
      { id: 'noname', keys: ['KeyA'] },
      { id: 'empty', name: '   ', keys: ['KeyA'] },
      { id: 'long', name: 'n'.repeat(41), keys: ['KeyA'] },
      { id: 'ctrl', name: 'a\u0007b', keys: ['KeyA'] },
      { id: 'bidi', name: 'a‮b', keys: ['KeyA'] },
      { id: 'none', name: 'No bindings' },
      { id: 'onlybad', name: 'Only bad', keys: ['Escape', 'F1'], gamepad: ['Home'] },
    ];
    for (const c of cases) {
      const r = parseActions([c]);
      expect(r.actions, JSON.stringify(c)).toEqual([]);
      expect(r.warnings.length, JSON.stringify(c)).toBeGreaterThan(0);
    }
    expect(parseActions([{ id: 'ok', name: 'n'.repeat(40), keys: ['KeyA'] }]).actions).toHaveLength(1);
  });

  it('drops a duplicate id, keeping the first', () => {
    const r = parseActions([
      { id: 'jump', name: 'Jump', keys: ['Space'] },
      { id: 'jump', name: 'Jump 2', keys: ['KeyK'] },
    ]);
    expect(r.actions).toEqual([act('jump', ['Space'], [], 'Jump')]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('actions[1]');
  });

  it('drops invalid keys and buttons inside an entry', () => {
    const r = parseActions([
      { id: 'a', name: 'A', keys: ['Escape', 'KeyA', 'F1', 7, 'Tab', 'MetaLeft'], gamepad: ['Home', 'A'] },
    ]);
    expect(r.actions).toEqual([act('a', ['KeyA'], ['A'], 'A')]);
    expect(r.warnings).toHaveLength(6);
    expect(r.warnings.some((w) => w.includes('actions[0].keys[0]') && w.includes('Escape'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('actions[0].gamepad[0]') && w.includes('Home'))).toBe(true);
  });

  it('keeps the first 3 keys and 2 buttons, removing duplicates', () => {
    const r = parseActions([
      { id: 'a', name: 'A', keys: ['KeyA', 'KeyA', 'KeyB', 'KeyC', 'KeyD'], gamepad: ['A', 'A', 'B', 'X'] },
    ]);
    expect(r.actions).toEqual([act('a', ['KeyA', 'KeyB', 'KeyC'], ['A', 'B'], 'A')]);
    expect(r.warnings).toHaveLength(4); // dup KeyA, KeyD over limit, dup A, X over limit
  });

  it('drops a non-array keys list but keeps the action if it still has a binding', () => {
    const r = parseActions([{ id: 'a', name: 'A', keys: 'KeyA', gamepad: ['A'] }]);
    expect(r.actions).toEqual([act('a', [], ['A'], 'A')]);
    expect(r.warnings).toHaveLength(1);
  });

  it('keeps at most 32 entries', () => {
    const list = Array.from({ length: 33 }, (_, i) => ({ id: `a${i}`, name: `A ${i}`, keys: ['KeyA'] }));
    const r = parseActions(list);
    expect(r.actions).toHaveLength(32);
    expect(r.actions[31]!.id).toBe('a31');
    expect(r.warnings).toHaveLength(1);
  });

  it('never throws', () => {
    const weird: unknown[] = [[null], [[]], [{ id: {}, name: [] }], [{ id: 'x', name: 'X', keys: [null, undefined, {}] }], [Object.create(null)]];
    for (const w of weird) expect(() => parseActions(w)).not.toThrow();
  });
});

describe('applyOverrides', () => {
  const defaults = [act('fire', ['Space', 'KeyZ'], ['A', 'RT']), act('jump', ['ArrowUp'], ['A'])];

  it('replaces keys and keeps gamepad', () => {
    const r = applyOverrides(defaults, { fire: ['KeyK'] });
    expect(r[0]).toEqual(act('fire', ['KeyK'], ['A', 'RT']));
    expect(r[1]).toBe(defaults[1]);
  });
  it('[] clears the keys', () => {
    expect(applyOverrides(defaults, { jump: [] })[1]).toEqual(act('jump', [], ['A']));
  });
  it('ignores unknown ids, non-array values and invalid codes', () => {
    const r = applyOverrides(defaults, { nope: ['KeyQ'], jump: 'KeyQ', fire: ['Escape', 'KeyK', 5, 'F5'] });
    expect(r.map((a) => a.id)).toEqual(['fire', 'jump']);
    expect(r[0]!.keys).toEqual(['KeyK']);
    expect(r[1]!.keys).toEqual(['ArrowUp']);
  });
  it('de-duplicates and keeps the first 3', () => {
    expect(applyOverrides(defaults, { fire: ['KeyA', 'KeyA', 'KeyB', 'KeyC', 'KeyD'] })[0]!.keys).toEqual(['KeyA', 'KeyB', 'KeyC']);
  });
  it('never overrides gamepad and tolerates non-objects', () => {
    expect(applyOverrides(defaults, { fire: ['KeyK'], gamepad: ['B'] })[0]!.gamepad).toEqual(['A', 'RT']);
    expect(applyOverrides(defaults, null)).toEqual(defaults);
    expect(applyOverrides(defaults, ['x'])).toEqual(defaults);
  });
  it('ignores inherited properties', () => {
    const o = Object.create({ fire: ['KeyK'] }) as object;
    expect(applyOverrides(defaults, o)[0]!.keys).toEqual(['Space', 'KeyZ']);
  });
});

/** Fake first gamepad: set `cur` / `prev` button sets directly. */
class FakePad implements PadSource {
  connected = true;
  cur = new Set<GamepadButtonName>();
  prev = new Set<GamepadButtonName>();
  set(down: GamepadButtonName[]): void {
    this.prev = this.cur;
    this.cur = new Set(down);
  }
  isDown(b: GamepadButtonName): boolean {
    return this.cur.has(b);
  }
  wasPressed(b: GamepadButtonName): boolean {
    return this.cur.has(b) && !this.prev.has(b);
  }
  wasReleased(b: GamepadButtonName): boolean {
    return !this.cur.has(b) && this.prev.has(b);
  }
}

describe('ActionMap edges', () => {
  const jump = act('jump', ['Space', 'ArrowUp'], ['A']);
  const snap = (m: ActionMap, id = 'jump'): [boolean, boolean, boolean] => [m.down(id), m.pressed(id), m.released(id)];
  /** Run one step: apply events, update, then clear edges like the engine does. */
  function step(m: ActionMap, s: InputState, events: () => void, pad?: PadSource): [boolean, boolean, boolean] {
    events();
    m.update(s, pad);
    const r = snap(m);
    s.endStep();
    return r;
  }

  it('hold key 1 then press key 2 → one pressed; releasing one of two → no released', () => {
    const m = new ActionMap([jump]);
    const s = new InputState();
    expect(step(m, s, () => s.press('Space'))).toEqual([true, true, false]);
    expect(step(m, s, () => {})).toEqual([true, false, false]);
    expect(step(m, s, () => s.press('ArrowUp'))).toEqual([true, false, false]);
    expect(step(m, s, () => s.release('Space'))).toEqual([true, false, false]);
    expect(step(m, s, () => s.release('ArrowUp'))).toEqual([false, false, true]);
    expect(step(m, s, () => {})).toEqual([false, false, false]);
  });

  it('a tap within one step reports pressed and released with down false', () => {
    const m = new ActionMap([jump]);
    const s = new InputState();
    expect(step(m, s, () => { s.press('Space'); s.release('Space'); })).toEqual([false, true, true]);
    expect(step(m, s, () => {})).toEqual([false, false, false]);
  });

  it('swapping keys within one step while held does not fire again', () => {
    const m = new ActionMap([jump]);
    const s = new InputState();
    step(m, s, () => s.press('Space'));
    expect(step(m, s, () => { s.press('ArrowUp'); s.release('Space'); })).toEqual([true, false, false]);
  });

  it('gamepad-only action', () => {
    const m = new ActionMap([act('pause', [], ['Start'])]);
    const s = new InputState();
    const pad = new FakePad();
    const run = (b: GamepadButtonName[]): [boolean, boolean, boolean] => {
      pad.set(b);
      m.update(s, pad);
      s.endStep();
      return snap(m, 'pause');
    };
    expect(run(['Start'])).toEqual([true, true, false]);
    expect(run(['Start'])).toEqual([true, false, false]);
    expect(run([])).toEqual([false, false, true]);
    pad.connected = false;
    pad.set(['Start']);
    m.update(s, pad);
    expect(snap(m, 'pause')).toEqual([false, false, false]);
  });

  it('key + gamepad on the same action count as one', () => {
    const m = new ActionMap([jump]);
    const s = new InputState();
    const pad = new FakePad();
    expect(step(m, s, () => { s.press('Space'); pad.set([]); }, pad)).toEqual([true, true, false]);
    expect(step(m, s, () => pad.set(['A']), pad)).toEqual([true, false, false]);
    expect(step(m, s, () => { s.release('Space'); pad.set(['A']); }, pad)).toEqual([true, false, false]);
    expect(step(m, s, () => pad.set([]), pad)).toEqual([false, false, true]);
  });

  it('a rebuild carries down state over, so a held action does not re-fire', () => {
    const s = new InputState();
    const m1 = new ActionMap([jump]);
    step(m1, s, () => s.press('Space'));
    const m2 = new ActionMap([act('jump', ['Space', 'KeyK'], ['A'])], m1);
    expect(step(m2, s, () => s.press('KeyK'))).toEqual([true, false, false]);
    expect(m2.boundKeys.has('KeyK')).toBe(true);
  });

  it('boundKeys holds keyboard codes only', () => {
    const m = new ActionMap([act('fire', ['Mouse0', 'KeyZ'])]);
    expect([...m.boundKeys]).toEqual(['KeyZ']);
    expect(m.has('fire')).toBe(true);
    expect(m.has('nope')).toBe(false);
  });
});

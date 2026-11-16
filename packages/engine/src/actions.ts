/**
 * F009 named actions: the bindable key table, default labels, lenient game.json `actions` parsing,
 * player overrides and per-step action edges. Pure (no DOM); docs/GAME_FORMAT.md § F009 is normative.
 */

/** Gamepad buttons an action may use (the standard mapping without `Home`). */
export type GamepadButtonName =
  | 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'Back' | 'Start' | 'LS' | 'RS' | 'Up' | 'Down' | 'Left' | 'Right';

/** A named action with its key codes (KeyboardEvent.code or Mouse0..2) and gamepad buttons. */
export interface ControlAction {
  id: string;
  name: string;
  keys: string[];
  gamepad: GamepadButtonName[];
}

export const MAX_ACTIONS = 32;
export const MAX_ACTION_KEYS = 3;
export const MAX_ACTION_GAMEPAD = 2;
export const ACTION_NAME_MAX = 40;
export const ACTION_ID_RE = /^[a-z0-9_-]{1,32}$/;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const DIGITS = '0123456789'.split('');

/** code → default (US layout) label, in table order. */
const LABELS: ReadonlyMap<string, string> = new Map<string, string>([
  ...LETTERS.map((l): [string, string] => [`Key${l}`, l]),
  ...DIGITS.map((d): [string, string] => [`Digit${d}`, d]),
  ...DIGITS.map((d): [string, string] => [`Numpad${d}`, `Num ${d}`]),
  ['NumpadAdd', 'Num +'],
  ['NumpadSubtract', 'Num -'],
  ['NumpadMultiply', 'Num *'],
  ['NumpadDivide', 'Num /'],
  ['NumpadDecimal', 'Num .'],
  ['NumpadEnter', 'Num Enter'],
  ['ArrowUp', '↑'],
  ['ArrowDown', '↓'],
  ['ArrowLeft', '←'],
  ['ArrowRight', '→'],
  ['Space', 'Space'],
  ['Enter', 'Enter'],
  ['Backspace', 'Backspace'],
  ['ShiftLeft', 'Left Shift'],
  ['ShiftRight', 'Right Shift'],
  ['ControlLeft', 'Left Ctrl'],
  ['ControlRight', 'Right Ctrl'],
  ['AltLeft', 'Left Alt'],
  ['AltRight', 'Right Alt'],
  ['Minus', '-'],
  ['Equal', '='],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backslash', '\\'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['Backquote', '`'],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/'],
  ['IntlBackslash', 'Intl \\'],
  ['Insert', 'Insert'],
  ['Delete', 'Delete'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'Page Up'],
  ['PageDown', 'Page Down'],
  ['Mouse0', 'Left click'],
  ['Mouse1', 'Middle click'],
  ['Mouse2', 'Right click'],
]);

/** The 86 bindable codes (83 keyboard + Mouse0..2), GAME_FORMAT § F009 table order. */
export const BINDABLE_KEYS: readonly string[] = Object.freeze([...LABELS.keys()]);
const BINDABLE = new Set(BINDABLE_KEYS);

/** The 16 gamepad button names actions may use. */
export const GAMEPAD_BUTTON_NAMES: readonly GamepadButtonName[] = Object.freeze([
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right',
] as GamepadButtonName[]);
const PAD_NAMES = new Set<string>(GAMEPAD_BUTTON_NAMES);

export function isBindableKey(code: unknown): code is string {
  return typeof code === 'string' && BINDABLE.has(code);
}
export function isGamepadButtonName(name: unknown): name is GamepadButtonName {
  return typeof name === 'string' && PAD_NAMES.has(name);
}
/** True for bindable keyboard codes (not the Mouse0..2 codes). */
export function isKeyboardCode(code: string): boolean {
  return BINDABLE.has(code) && !code.startsWith('Mouse');
}

/** Default (US layout) label for a code; an unknown code returns the input string. */
export function keyLabel(code: string): string {
  return LABELS.get(code) ?? String(code);
}

const PAD_LABELS: Record<string, string> = { Up: 'D-pad ↑', Down: 'D-pad ↓', Left: 'D-pad ←', Right: 'D-pad →' };
/** Default label for a gamepad button name; an unknown name returns the input string. */
export function gamepadLabel(name: string): string {
  return PAD_LABELS[name] ?? String(name);
}

/** C0, DEL, C1 controls and the bidi controls U+202A–U+202E, U+2066–U+2069 (F004 set). */
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function freezeAction(a: ControlAction): ControlAction {
  Object.freeze(a.keys);
  Object.freeze(a.gamepad);
  return Object.freeze(a);
}

function parseList<T extends string>(
  raw: unknown, at: string, field: 'keys' | 'gamepad', max: number, valid: (v: unknown) => v is T, warn: (m: string) => void,
): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn(`${at}.${field} must be an array; ignored`);
    return [];
  }
  const out: T[] = [];
  raw.forEach((v, j) => {
    const p = `${at}.${field}[${j}]`;
    if (!valid(v)) warn(`${p} ${JSON.stringify(v) ?? String(v)} can't be bound; dropped`);
    else if (out.includes(v)) warn(`${p} "${v}" is duplicated; dropped`);
    else if (out.length >= max) warn(`${p} "${v}" is over the limit of ${max}; dropped`);
    else out.push(v);
  });
  return out;
}

/**
 * Lenient parse of game.json `actions` (GAME_FORMAT § F009). Invalid entries, and invalid keys or
 * buttons inside an entry, are dropped with a warning. Never throws. Result entries are frozen.
 */
export function parseActions(raw: unknown): { actions: ControlAction[]; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (m: string): void => void warnings.push(m);
  if (raw === undefined || raw === null) return { actions: [], warnings };
  if (!Array.isArray(raw)) return { actions: [], warnings: ['"actions" must be an array; ignored'] };
  const actions: ControlAction[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, i) => {
    const at = `actions[${i}]`;
    if (i >= MAX_ACTIONS) return void warn(`${at} is over the limit of ${MAX_ACTIONS} actions; dropped`);
    if (!isObject(entry)) return void warn(`${at} must be an object; dropped`);
    const id = entry.id;
    if (typeof id !== 'string' || !ACTION_ID_RE.test(id)) return void warn(`${at}.id must match ${ACTION_ID_RE}; dropped`);
    if (seen.has(id)) return void warn(`${at}.id "${id}" is duplicated; dropped`);
    const name = typeof entry.name === 'string' ? entry.name.trim() : null;
    const len = name === null ? 0 : Array.from(name).length;
    if (name === null || len < 1 || len > ACTION_NAME_MAX)
      return void warn(`${at}.name must be a string of 1–${ACTION_NAME_MAX} chars; dropped`);
    if (BAD_NAME_CHARS.test(name)) return void warn(`${at}.name contains invalid characters; dropped`);
    const keys = parseList(entry.keys, at, 'keys', MAX_ACTION_KEYS, isBindableKey, warn);
    const gamepad = parseList(entry.gamepad, at, 'gamepad', MAX_ACTION_GAMEPAD, isGamepadButtonName, warn);
    if (keys.length === 0 && gamepad.length === 0) return void warn(`${at} ("${id}") has no keys or gamepad buttons; dropped`);
    seen.add(id);
    actions.push(freezeAction({ id, name, keys, gamepad }));
  });
  return { actions, warnings };
}

/**
 * Effective actions = defaults with player overrides applied. For each known action id with an
 * array value, `keys` becomes the valid, de-duplicated bindable codes (first 3). Unknown ids,
 * non-array values and invalid codes are ignored; `gamepad` is never overridden.
 */
export function applyOverrides(defaults: readonly ControlAction[], overrides: unknown): ControlAction[] {
  const o = isObject(overrides) ? overrides : {};
  return defaults.map((a) => {
    const v = Object.prototype.hasOwnProperty.call(o, a.id) ? o[a.id] : undefined;
    if (!Array.isArray(v)) return a;
    const keys: string[] = [];
    for (const c of v) if (isBindableKey(c) && !keys.includes(c) && keys.length < MAX_ACTION_KEYS) keys.push(c);
    return freezeAction({ id: a.id, name: a.name, keys, gamepad: [...a.gamepad] });
  });
}

/** What ActionMap reads per code (InputState satisfies it). */
export interface ButtonSource {
  isDown(code: string): boolean;
  wasPressed(code: string): boolean;
  wasReleased(code: string): boolean;
}
/** What ActionMap reads per gamepad button (GamepadState satisfies it). */
export interface PadSource {
  readonly connected: boolean;
  isDown(b: GamepadButtonName): boolean;
  wasPressed(b: GamepadButtonName): boolean;
  wasReleased(b: GamepadButtonName): boolean;
}

interface ActionEdge {
  down: boolean;
  pressed: boolean;
  released: boolean;
}

/**
 * Per-action down/pressed/released, computed once per fixed step by `update()` with action-level
 * edges (GAME_FORMAT § F009). Rebuilding with `previous` carries each id's `down` over, so a remap
 * neither fires a spurious `pressed` for a still-held action nor loses its state.
 */
export class ActionMap {
  readonly actions: readonly ControlAction[];
  /** Keyboard codes bound by any action (not the Mouse codes). */
  readonly boundKeys: ReadonlySet<string>;
  private readonly edges = new Map<string, ActionEdge>();

  constructor(actions: readonly ControlAction[], previous?: ActionMap) {
    this.actions = actions;
    const bound = new Set<string>();
    for (const a of actions) {
      for (const k of a.keys) if (isKeyboardCode(k)) bound.add(k);
      const prev = previous?.edges.get(a.id);
      this.edges.set(a.id, { down: prev?.down ?? false, pressed: false, released: false });
    }
    this.boundKeys = bound;
  }

  /** Recompute every action from the current button states (call once per step, after polling). */
  update(keys: ButtonSource, pad?: PadSource | null): void {
    const p = pad && pad.connected ? pad : null;
    for (const a of this.actions) {
      const e = this.edges.get(a.id)!;
      const prevDown = e.down;
      let down = false;
      let anyPressed = false;
      let anyReleased = false;
      for (const k of a.keys) {
        down ||= keys.isDown(k);
        anyPressed ||= keys.wasPressed(k);
        anyReleased ||= keys.wasReleased(k);
      }
      if (p) {
        for (const b of a.gamepad) {
          down ||= p.isDown(b);
          anyPressed ||= p.wasPressed(b);
          anyReleased ||= p.wasReleased(b);
        }
      }
      const pressed = anyPressed && !prevDown;
      e.down = down;
      e.pressed = pressed;
      e.released = !down && (prevDown || pressed) && anyReleased;
    }
  }

  has(id: string): boolean {
    return this.edges.has(id);
  }
  down(id: string): boolean {
    return this.edges.get(id)?.down ?? false;
  }
  pressed(id: string): boolean {
    return this.edges.get(id)?.pressed ?? false;
  }
  released(id: string): boolean {
    return this.edges.get(id)?.released ?? false;
  }
}

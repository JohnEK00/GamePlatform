/** Keyboard / mouse / touch / gamepad input with per-step pressed/released edges. */
import {
  ActionMap,
  applyOverrides,
  gamepadLabel,
  isGamepadButtonName,
  isKeyboardCode,
  keyLabel as defaultKeyLabel,
  type ButtonSource,
  type ControlAction,
  type GamepadButtonName,
  type PadSource,
} from './actions';
import { filterText, TEXT_EDIT_KEYS, type TextEvent } from './uitext';

/** At most this many `textEvents` per step (GAME_FORMAT § F019); extras are dropped. */
export const MAX_TEXT_EVENTS = 64;
/** A paste is cut to this many code points. */
export const MAX_PASTE = 256;
const NO_TEXT_EVENTS: readonly TextEvent[] = Object.freeze([]);

/** True when `s` is exactly one code point. */
function oneCodePoint(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > 2) return false;
  return Array.from(s).length === 1;
}

interface BtnState {
  down: boolean;
  pressed: boolean;
  released: boolean;
  /** The release this step was synthetic (blur, pause, pointercancel), not made by the player. */
  cancelled: boolean;
}

/**
 * Pure button state machine. Events set `pressed`/`released`; they stay visible for exactly one
 * fixed update step (`endStep()` clears them). A press+release between two steps still reports
 * `wasPressed` and `wasReleased` on the next step.
 */
export class InputState {
  private readonly buttons = new Map<string, BtnState>();

  private get(code: string): BtnState {
    let b = this.buttons.get(code);
    if (!b) {
      b = { down: false, pressed: false, released: false, cancelled: false };
      this.buttons.set(code, b);
    }
    return b;
  }

  press(code: string): void {
    const b = this.get(code);
    if (!b.down) {
      b.down = true;
      b.pressed = true;
    }
  }
  /**
   * Release a held button. `cancel` marks the release as synthetic (window blur, pause,
   * `pointercancel`): `wasReleased` still reports it, and `wasCancelled` tells it apart.
   */
  release(code: string, cancel = false): void {
    const b = this.get(code);
    if (b.down) {
      b.down = false;
      b.released = true;
      b.cancelled = cancel;
    }
  }
  /** Release everything as a cancellation (window blur, pause / resume). */
  releaseAll(): void {
    for (const k of this.buttons.keys()) this.release(k, true);
  }
  isDown(code: string): boolean {
    return this.buttons.get(code)?.down ?? false;
  }
  wasPressed(code: string): boolean {
    return this.buttons.get(code)?.pressed ?? false;
  }
  wasReleased(code: string): boolean {
    return this.buttons.get(code)?.released ?? false;
  }
  /** The button's release this step was a cancellation (see `release`). */
  wasCancelled(code: string): boolean {
    const b = this.buttons.get(code);
    return !!b && b.released && b.cancelled;
  }
  /** Codes currently held (F019 end-of-capture latch). */
  heldCodes(): string[] {
    const out: string[] = [];
    for (const [k, b] of this.buttons) if (b.down) out.push(k);
    return out;
  }
  /** Any button pressed this step (optionally filtered by prefix). */
  anyPressed(filter?: (code: string) => boolean): boolean {
    for (const [k, b] of this.buttons) if (b.pressed && (!filter || filter(k))) return true;
    return false;
  }
  /** Clear edge flags; call once after each fixed update step. */
  endStep(): void {
    for (const b of this.buttons.values()) {
      b.pressed = false;
      b.released = false;
      b.cancelled = false;
    }
  }
}

export interface Letterbox {
  /** CSS size of the scaled game area. */
  width: number;
  height: number;
  /** Offset of the game area inside the available area. */
  x: number;
  y: number;
  /** CSS pixels per game unit. */
  scale: number;
}

/** Largest aspect-preserving fit of a gameW×gameH area inside availW×availH, centered. */
export function computeLetterbox(availW: number, availH: number, gameW: number, gameH: number): Letterbox {
  const scale = Math.max(0, Math.min(availW / gameW, availH / gameH));
  const width = gameW * scale;
  const height = gameH * scale;
  return { width, height, x: (availW - width) / 2, y: (availH - height) / 2, scale };
}

/**
 * Map a client (CSS px) position to game coordinates, given the canvas' bounding rect.
 * Accounts for letterboxing if the element's box doesn't match the game aspect ratio.
 */
export function clientToGame(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  gameW: number,
  gameH: number,
): { x: number; y: number } {
  const lb = computeLetterbox(rect.width, rect.height, gameW, gameH);
  if (lb.scale === 0) return { x: 0, y: 0 };
  return { x: (clientX - rect.left - lb.x) / lb.scale, y: (clientY - rect.top - lb.y) / lb.scale };
}

/** Combine negative/positive digital inputs and an analog value into -1..1. */
export function combineAxis(neg: boolean, pos: boolean, analog = 0, deadzone = 0.2): number {
  let v = (pos ? 1 : 0) - (neg ? 1 : 0);
  if (v === 0 && Math.abs(analog) > deadzone) v = Math.sign(analog) * ((Math.abs(analog) - deadzone) / (1 - deadzone));
  return Math.max(-1, Math.min(1, v));
}

/** Standard gamepad button names → indices. */
export const GamepadButtons = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, Back: 8, Start: 9, LS: 10, RS: 11,
  Up: 12, Down: 13, Left: 14, Right: 15, Home: 16,
} as const;
/** Every standard button name including `Home` (actions use the narrower `GamepadButtonName`). */
export type GamepadButtonKey = keyof typeof GamepadButtons;

/** Stick threshold for `lastDevice` (F016): an axis crossing it counts as gamepad input. */
const STICK_ACTIVITY = 0.5;

export class GamepadState {
  connected = false;
  id = '';
  axes: number[] = [];
  private prev: boolean[] = [];
  private cur: boolean[] = [];
  private prevAxes: number[] = [];
  private latched = false;
  /** Analog values 0..1 per button (triggers). */
  values: number[] = [];

  /** Engine-internal: refresh from a navigator Gamepad snapshot. */
  poll(gp: Gamepad | null | undefined): void {
    this.prev = this.cur;
    this.prevAxes = this.axes;
    const latched = this.latched;
    this.latched = false;
    if (!gp || !gp.connected) {
      this.connected = false;
      this.cur = [];
      this.axes = [];
      this.values = [];
      return;
    }
    this.connected = true;
    this.id = gp.id;
    this.axes = Array.from(gp.axes);
    this.cur = gp.buttons.map((b) => b.pressed);
    this.values = gp.buttons.map((b) => b.value);
    if (latched) {
      // F016 resume latch: what is held now counts as already held (no edges this poll).
      this.prev = [...this.cur];
      this.prevAxes = [...this.axes];
    }
  }
  /**
   * Engine-internal (F016 resume latch): the next `poll` copies the new pressed state into the
   * previous one, so a button held at that moment reports `isDown` but not `wasPressed`.
   */
  latch(): void {
    this.latched = true;
  }
  /**
   * Engine-internal (F016 `lastDevice`): a button went down this poll, or a left/right stick axis
   * (0..3) crossed from below 0.5 to 0.5 or more in absolute value.
   */
  active(): boolean {
    if (!this.connected) return false;
    for (let i = 0; i < this.cur.length; i++) if (this.cur[i] && !this.prev[i]) return true;
    for (let i = 0; i < 4; i++) {
      const now = Math.abs(this.axes[i] ?? 0);
      const before = Math.abs(this.prevAxes[i] ?? 0);
      if (now >= STICK_ACTIVITY && before < STICK_ACTIVITY) return true;
    }
    return false;
  }
  private idx(b: number | GamepadButtonKey): number {
    return typeof b === 'number' ? b : GamepadButtons[b];
  }
  isDown(b: number | GamepadButtonKey): boolean {
    return this.cur[this.idx(b)] ?? false;
  }
  wasPressed(b: number | GamepadButtonKey): boolean {
    const i = this.idx(b);
    return (this.cur[i] ?? false) && !(this.prev[i] ?? false);
  }
  wasReleased(b: number | GamepadButtonKey): boolean {
    const i = this.idx(b);
    return !(this.cur[i] ?? false) && (this.prev[i] ?? false);
  }
  get leftX(): number {
    return this.axes[0] ?? 0;
  }
  get leftY(): number {
    return this.axes[1] ?? 0;
  }
  get rightX(): number {
    return this.axes[2] ?? 0;
  }
  get rightY(): number {
    return this.axes[3] ?? 0;
  }
}

export interface TouchPoint {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  /** Started this step. */
  pressed: boolean;
  /** Ended this step (it is removed on the following step). */
  released: boolean;
}

export interface MouseState {
  /** Position in game (screen) coordinates. Use camera.screenToWorld for world coords. */
  x: number;
  y: number;
  /** Primary button (or primary touch) held. */
  down: boolean;
  pressed: boolean;
  released: boolean;
  /**
   * `released` this step came from a cancellation (window blur, pause / resume, `pointercancel`)
   * rather than the player letting go: treat it as "the press was abandoned", never as a click.
   */
  cancelled: boolean;
  rightDown: boolean;
  rightPressed: boolean;
  /** Wheel delta accumulated this step (+ = down). */
  wheel: number;
  /** Pointer currently over the canvas. */
  inside: boolean;
}

/** The kind of device the player used last (F016 `input.lastDevice`). */
export type InputDevice = 'keyboard' | 'mouse' | 'touch' | 'gamepad';

const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace']);

/** DOM-attached input. Keys use KeyboardEvent.code ("ArrowLeft", "KeyA", "Space"); mouse buttons are "Mouse0/1/2". */
export class Input {
  readonly state = new InputState();
  readonly mouse: MouseState = { x: 0, y: 0, down: false, pressed: false, released: false, cancelled: false, rightDown: false, rightPressed: false, wheel: 0, inside: false };
  /** Active touches (game coordinates). */
  touches: TouchPoint[] = [];
  private readonly touchMap = new Map<number, TouchPoint>();
  private readonly pads: GamepadState[] = [new GamepadState(), new GamepadState(), new GamepadState(), new GamepadState()];
  private wheelAcc = 0;
  private readonly cleanup: (() => void)[] = [];
  /** Last KeyboardEvent.key typed this step (for text entry). */
  typed = '';
  private typedAcc = '';
  /** F019: this step's typing (keydown text, editing keys, paste), in order; frozen, `[]` when none. */
  textEvents: readonly TextEvent[] = NO_TEXT_EVENTS;
  private textAcc: TextEvent[] = [];
  /** F019 keyboard capture: on from the step editing starts in (`captureKeyboardNow`); recomputed by the UI at each step's end. */
  private capture = false;
  /** Capture state the last `updateActions` ran with (detects the first / last captured step). */
  private captureApplied = false;
  /** Keyboard codes held when capture ended: they count as up for actions until released. */
  private readonly captureLatch = new Set<string>();
  /** The keyboard source this step's actions were computed with (reused by same-step recomputes). */
  private stepKeys: ButtonSource | null = null;
  /**
   * F023 pad latch: gamepad 0 buttons consumed by the on-screen keyboard. They count as up for
   * actions and the `axis()` fallback until released.
   */
  private readonly padLatch = new Set<GamepadButtonName>();
  /** Buttons latched in this step while already held at the previous poll: they report `wasReleased` once. */
  private readonly padLatchReleased = new Set<GamepadButtonName>();
  private defaults: readonly ControlAction[] = Object.freeze([]);
  private effective: readonly ControlAction[] = Object.freeze([]);
  private overrides: unknown = {};
  private gamepadOverrides: unknown = undefined;
  private device: InputDevice = 'keyboard';
  /** Map used by the action queries; swapped for `next` at the next beginStep. */
  private map = new ActionMap([]);
  private next: ActionMap | null = null;
  private readonly warned = new Set<string>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gameW: number,
    private readonly gameH: number,
  ) {}

  /** Engine-internal: attach DOM listeners. */
  attach(): void {
    const on = <K extends keyof WindowEventMap>(t: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      t.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    const c = this.canvas;
    c.style.touchAction = 'none';
    (c.style as CSSStyleDeclaration & { webkitUserSelect?: string }).userSelect = 'none';
    c.style.outline = 'none';
    if (c.tabIndex < 0) c.tabIndex = 0;

    on(window, 'keydown', (e) => {
      const produced = this.collectKeyText(e);
      if (this.capture) {
        // F019: while a text field edits, typing must not trigger browser shortcuts (quick find,
        // page scroll); Ctrl/Meta+V must still reach the browser so it fires `paste`.
        const paste = (e.ctrlKey || e.metaKey) && e.code === 'KeyV';
        if ((produced || e.code === 'Space') && !paste) e.preventDefault();
      }
      if ((PREVENT.has(e.code) || (this.next ?? this.map).boundKeys.has(e.code)) && !e.ctrlKey && !e.metaKey) e.preventDefault();
      if (!e.repeat) {
        this.state.press(e.code);
        this.device = 'keyboard';
      }
      if (typeof e.key === 'string' && e.key.length === 1) this.typedAcc += e.key;
    });
    on(window, 'keyup', (e) => this.state.release(e.code));
    on(window, 'paste', (e: ClipboardEvent) => {
      e.preventDefault();
      let raw = '';
      try {
        raw = e.clipboardData?.getData('text/plain') ?? '';
      } catch {
        raw = '';
      }
      const flat = String(raw).replace(/\r\n|\r|\n|\t/g, ' ');
      const text = filterText(Array.from(flat).slice(0, MAX_PASTE).join(''));
      if (text) this.pushText({ kind: 'text', text });
    });
    on(window, 'blur', () => {
      this.state.releaseAll();
      this.mouse.down = false;
    });
    // F016 resume latch: a gamepad button held while the page was unfocused never fires `pressed`.
    on(window, 'focus', () => this.latchGamepads());

    const pos = (e: PointerEvent | WheelEvent): { x: number; y: number } =>
      clientToGame(e.clientX, e.clientY, c.getBoundingClientRect(), this.gameW, this.gameH);

    on(c, 'pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      try {
        c.focus({ preventScroll: true });
        window.focus();
      } catch {
        /* ignore */
      }
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (e.pointerType === 'mouse') this.device = 'mouse';
      else if (e.pointerType === 'touch' || e.pointerType === 'pen') this.device = 'touch';
      const p = pos(e);
      if (e.pointerType === 'touch') {
        const t: TouchPoint = { id: e.pointerId, x: p.x, y: p.y, startX: p.x, startY: p.y, pressed: true, released: false };
        this.touchMap.set(e.pointerId, t);
      }
      if (e.isPrimary || e.pointerType === 'mouse') {
        this.mouse.x = p.x;
        this.mouse.y = p.y;
        this.state.press(`Mouse${e.pointerType === 'mouse' ? e.button : 0}`);
      }
    });
    on(window, 'pointermove', (e: PointerEvent) => {
      const p = pos(e);
      const t = this.touchMap.get(e.pointerId);
      if (t) {
        t.x = p.x;
        t.y = p.y;
      }
      if (e.isPrimary || e.pointerType === 'mouse') {
        this.mouse.x = p.x;
        this.mouse.y = p.y;
      }
    });
    const up = (e: PointerEvent, cancel: boolean): void => {
      const p = pos(e);
      const t = this.touchMap.get(e.pointerId);
      if (t) {
        t.x = p.x;
        t.y = p.y;
        t.released = true;
      }
      if (e.isPrimary || e.pointerType === 'mouse') {
        const code = `Mouse${e.pointerType === 'mouse' ? e.button : 0}`;
        // pointercancel reports button -1 for mice: cancel every held mouse button then.
        if (cancel && e.pointerType === 'mouse' && e.button < 0) for (const b of [0, 1, 2]) this.state.release(`Mouse${b}`, true);
        else this.state.release(code, cancel);
      }
    };
    on(window, 'pointerup', (e: PointerEvent) => up(e, false));
    on(window, 'pointercancel', (e: PointerEvent) => up(e, true));
    // F016 lastDevice: legacy mouse / touch events (a touch's compatibility mousedown doesn't count).
    on(c, 'mousedown', (e: MouseEvent) => {
      const caps = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } | null }).sourceCapabilities;
      if (!caps?.firesTouchEvents) this.device = 'mouse';
    });
    on(c, 'touchstart', () => void (this.device = 'touch'), { passive: true });
    on(c, 'pointerenter', () => void (this.mouse.inside = true));
    on(c, 'pointerleave', () => void (this.mouse.inside = false));
    on(c, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(c, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      this.wheelAcc += e.deltaY;
    }, { passive: false });
  }

  detach(): void {
    for (const f of this.cleanup.splice(0)) f();
  }

  /**
   * F019: turn a keydown into a text event (GAME_FORMAT § F019 "Input additions"). Returns true when
   * the key produces an entry (even if the per-step cap then drops it).
   */
  private collectKeyText(e: KeyboardEvent): boolean {
    if (e.isComposing) return false;
    const key = e.key;
    // AltGr on Windows reports ctrlKey + altKey: its characters still type.
    const altGr = e.ctrlKey && e.altKey;
    if (oneCodePoint(key) && ((!e.ctrlKey && !e.metaKey) || altGr)) {
      const text = filterText(key);
      if (!text) return false;
      this.pushText({ kind: 'text', text });
      return true;
    }
    if (typeof key === 'string' && TEXT_EDIT_KEYS.has(key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.pushText({ kind: 'key', key: key as Extract<TextEvent, { kind: 'key' }>['key'] });
      return true;
    }
    return false;
  }

  private pushText(ev: TextEvent): void {
    if (this.textAcc.length < MAX_TEXT_EVENTS) this.textAcc.push(Object.freeze(ev));
  }

  /** Engine-internal (F019): drop text typed so far (called when a pause ends). */
  clearTextEvents(): void {
    this.textAcc = [];
    this.textEvents = NO_TEXT_EVENTS;
  }

  /**
   * Engine-internal (F019): keyboard capture on/off, set by `engine.ui` at the end of each step;
   * it applies to actions and `axis()` from the next step.
   */
  setKeyboardCapture(on: boolean): void {
    this.capture = !!on;
  }

  /**
   * Engine-internal (F019): editing starts in this step (`ui.beginStep`, before the game's update):
   * turn capture on now and recompute this step's actions as a first captured step, so the key
   * that started editing never fires its action. No-op while capture is already on.
   */
  captureKeyboardNow(): void {
    if (this.capture) return;
    this.capture = true;
    this.stepKeys = this.actionKeys();
    this.map.update(this.stepKeys, this.actionPad(), true);
  }

  /**
   * Engine-internal (F023): the on-screen keyboard takes gamepad 0's `buttons` in this step
   * (`ui.beginStep`, before the game's update). Each of them held now is latched: it counts as up
   * for actions and the `axis()` fallback, with no `pressed` edge, until it is released (an action
   * held through it reports `actionReleased` in this step). This step's actions are recomputed.
   * No effect when gamepad 0 is not connected. Raw `gamepad(i)` reads are unaffected.
   */
  consumePadButtons(buttons: readonly string[]): void {
    const p = this.pads[0]!;
    if (!p.connected) return;
    let changed = false;
    for (const b of buttons) {
      if (!isGamepadButtonName(b) || this.padLatch.has(b) || !p.isDown(b)) continue;
      this.padLatch.add(b);
      if (!p.wasPressed(b)) this.padLatchReleased.add(b);
      changed = true;
    }
    if (changed) this.map.update(this.stepKeys ?? this.actionKeys(), this.actionPad(), true);
  }

  /** The pad the actions read (the first connected one), seen through the F023 pad latch. */
  private actionPad(): PadSource | null {
    const p = this.pads.find((x) => x.connected) ?? null;
    if (!p || this.padLatch.size === 0) return p;
    const latch = this.padLatch;
    const rel = this.padLatchReleased;
    return {
      connected: true,
      isDown: (b) => !latch.has(b) && p.isDown(b),
      wasPressed: (b) => !latch.has(b) && p.wasPressed(b),
      wasReleased: (b) => (latch.has(b) ? rel.has(b) : p.wasReleased(b)),
    };
  }

  /** Start of step: a latched pad button counts again once released (or when gamepad 0 is gone). */
  private prunePadLatch(): void {
    this.padLatchReleased.clear();
    if (this.padLatch.size === 0) return;
    const p = this.pads[0]!;
    if (!p.connected) this.padLatch.clear();
    else for (const b of this.padLatch) if (!p.isDown(b)) this.padLatch.delete(b);
  }

  /** True while a `ui.textField` is editing: actions and `axis()` ignore keyboard keys (F019). */
  get keyboardCaptured(): boolean {
    return this.capture;
  }

  /** Engine-internal: called before each fixed update step. */
  beginStep(): void {
    const s = this.state;
    const m = this.mouse;
    m.down = s.isDown('Mouse0');
    m.pressed = s.wasPressed('Mouse0');
    m.released = s.wasReleased('Mouse0');
    m.cancelled = s.wasCancelled('Mouse0');
    m.rightDown = s.isDown('Mouse2');
    m.rightPressed = s.wasPressed('Mouse2');
    m.wheel = this.wheelAcc;
    this.wheelAcc = 0;
    this.typed = this.typedAcc;
    this.typedAcc = '';
    this.textEvents = this.textAcc.length ? Object.freeze(this.textAcc.slice(0, MAX_TEXT_EVENTS)) : NO_TEXT_EVENTS;
    this.textAcc = [];
    this.touches = Array.from(this.touchMap.values());
    const list = this.readGamepads();
    for (let i = 0; i < this.pads.length; i++) this.pads[i]!.poll(list[i] ?? null);
    // Gamepads are checked when the step starts, after that step's DOM events: they win a tie.
    if (this.pads.some((p) => p.active())) this.device = 'gamepad';
    this.updateActions();
  }

  /** Engine-internal (also used by tests): apply a pending rebuild, then compute action edges. */
  updateActions(): void {
    if (this.next) {
      this.map = this.next;
      this.next = null;
    }
    this.prunePadLatch();
    this.stepKeys = this.actionKeys();
    this.map.update(this.stepKeys, this.actionPad());
  }

  /**
   * F019 keyboard capture: the button source the actions read this step.
   * - Captured: keyboard codes are up with no press edges; in the first captured step a held (or
   *   just released) keyboard code reports `wasReleased`, so key-only actions get `actionReleased`.
   * - When capture ends, the keyboard codes still held are latched: they count as up until released.
   * Mouse codes pass through; gamepads are read separately.
   */
  private actionKeys(): ButtonSource {
    const s = this.state;
    const cap = this.capture;
    const first = cap && !this.captureApplied;
    if (!cap && this.captureApplied) for (const k of s.heldCodes()) if (isKeyboardCode(k)) this.captureLatch.add(k);
    this.captureApplied = cap;
    // A latched key counts again once released (a release + new press between steps passes through).
    for (const k of this.captureLatch) if (!s.isDown(k) || s.wasReleased(k)) this.captureLatch.delete(k);
    if (cap) {
      return {
        isDown: (c) => (isKeyboardCode(c) ? false : s.isDown(c)),
        wasPressed: (c) => (isKeyboardCode(c) ? false : s.wasPressed(c)),
        wasReleased: (c) => (isKeyboardCode(c) ? first && (s.isDown(c) || s.wasReleased(c)) : s.wasReleased(c)),
      };
    }
    if (this.captureLatch.size === 0) return s;
    const latch = this.captureLatch;
    return {
      isDown: (c) => !latch.has(c) && s.isDown(c),
      wasPressed: (c) => !latch.has(c) && s.wasPressed(c),
      wasReleased: (c) => !latch.has(c) && s.wasReleased(c),
    };
  }

  /** Raw key held, as seen by the undeclared-action `axis()` fallback (honours capture and its latch). */
  private axisKey(code: string): boolean {
    if (this.capture || this.captureLatch.has(code)) return false;
    return this.state.isDown(code);
  }

  // --- F009 actions ----------------------------------------------------------

  /** Engine-internal: the declared actions (boot option `actions`, already parsed). Clears overrides. */
  setActions(defaults: readonly ControlAction[]): void {
    this.defaults = Object.freeze([...defaults]);
    this.overrides = {};
    this.gamepadOverrides = undefined;
    this.rebuild();
  }
  /**
   * Engine-internal: player overrides (`webgame:controls`: F009 `overrides` keys, F016 `gamepad`).
   * Replaces both previous sets; an absent `gamepad` restores the gamepad defaults. Applied at the next step.
   */
  setOverrides(keys: unknown, gamepad?: unknown): void {
    this.overrides = keys;
    this.gamepadOverrides = gamepad;
    this.rebuild();
  }
  private rebuild(): void {
    this.effective = Object.freeze(applyOverrides(this.defaults, this.overrides, this.gamepadOverrides));
    // Takes effect at the next step; per-id `down` carries over so a held action does not re-fire.
    this.next = new ActionMap(this.effective, this.next ?? this.map);
  }

  /** Effective bindings (defaults + player overrides), manifest order, frozen. */
  get actions(): readonly ControlAction[] {
    return this.effective;
  }
  /** The declared actions (after lenient parsing), frozen. */
  get defaultActions(): readonly ControlAction[] {
    return this.defaults;
  }
  private known(id: string): boolean {
    if (this.effective.some((a) => a.id === id)) return true;
    if (!this.warned.has(id)) {
      this.warned.add(id);
      console.warn(`[pixelforge] input: unknown action "${id}" (declare it in game.json "actions")`);
    }
    return false;
  }
  /** Any key / gamepad button of the action is held. */
  actionDown(id: string): boolean {
    return this.known(id) && this.map.down(id);
  }
  /** The action went from up to down this step (a second bound key while held does not count). */
  actionPressed(id: string): boolean {
    return this.known(id) && this.map.pressed(id);
  }
  /** The action went from down to up this step. */
  actionReleased(id: string): boolean {
    return this.known(id) && this.map.released(id);
  }
  /**
   * Label of an action's effective binding (GAME_FORMAT § F009, § F016):
   * - no `device`: the first key, else the first gamepad button, else "";
   * - `"keyboard"`: the first key (mouse codes included), else "";
   * - `"gamepad"`: the first gamepad button, else "";
   * - `"auto"`: like `"gamepad"` when `lastDevice` is `"gamepad"` and the action has a gamepad
   *   button, otherwise like no `device`.
   */
  actionLabel(id: string, device?: 'keyboard' | 'gamepad' | 'auto'): string {
    if (!this.known(id)) return '';
    const a = this.effective.find((x) => x.id === id)!;
    const key = a.keys[0] ? defaultKeyLabel(a.keys[0]) : '';
    const pad = a.gamepad[0] ? gamepadLabel(a.gamepad[0]) : '';
    if (device === 'keyboard') return key;
    if (device === 'gamepad') return pad;
    if (device === 'auto' && this.device === 'gamepad' && pad) return pad;
    return key || pad;
  }
  /**
   * The kind of device the player used last (F016): `"keyboard"` (initial), `"mouse"`, `"touch"`
   * or `"gamepad"`. Only player presses change it (not mouse movement, the wheel, key repeat or
   * synthetic releases); gamepads are checked at the start of each fixed step.
   */
  get lastDevice(): InputDevice {
    return this.device;
  }
  /**
   * Latch every gamepad (F016 resume latch): on the next poll, buttons held at that moment report
   * `isDown` but not `wasPressed`, and actions bound to them don't fire `actionPressed`. The engine
   * calls this on host `webgame:resume` and on window `focus`.
   */
  latchGamepads(): void {
    for (const p of this.pads) p.latch();
  }
  /** Default (US layout) label of a code; an unknown code returns the code. */
  keyLabel(code: string): string {
    return defaultKeyLabel(code);
  }
  /** Default label of a gamepad button name (`Up` → "D-pad ↑", `A` → "A"); an unknown name returns the name. */
  gamepadLabel(name: string): string {
    return gamepadLabel(name);
  }

  /** Set once getGamepads() has thrown, so a blocked Gamepad API is not retried every step. */
  private gamepadsBlocked = false;

  /**
   * navigator.getGamepads() throws a SecurityError when the document's permissions policy
   * disallows "gamepad" (e.g. an iframe without allow="gamepad", or a non-secure origin such as
   * http://<LAN IP>). That must never stop the game loop: fall back to "no gamepads".
   */
  private readGamepads(): ArrayLike<Gamepad | null> {
    if (this.gamepadsBlocked) return [];
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (!nav || typeof nav.getGamepads !== 'function') return [];
    try {
      return nav.getGamepads() ?? [];
    } catch (err) {
      this.gamepadsBlocked = true;
      console.warn('[engine] Gamepad input unavailable:', err instanceof Error ? err.message : err);
      return [];
    }
  }

  /** Engine-internal: called after each fixed update step. */
  endStep(): void {
    this.state.endStep();
    for (const [id, t] of this.touchMap) {
      t.pressed = false;
      if (t.released) this.touchMap.delete(id);
    }
  }

  isDown(code: string): boolean {
    return this.state.isDown(code);
  }
  wasPressed(code: string): boolean {
    return this.state.wasPressed(code);
  }
  wasReleased(code: string): boolean {
    return this.state.wasReleased(code);
  }
  /** Any key / mouse button / touch / gamepad button pressed this step. */
  anyPressed(): boolean {
    if (this.state.anyPressed() || this.touches.some((t) => t.pressed)) return true;
    for (const p of this.pads) if (p.connected && p.values.some((_, i) => p.wasPressed(i))) return true;
    return false;
  }
  /** Gamepad `i` (0..3); `connected` is false if absent. */
  gamepad(i = 0): GamepadState {
    return this.pads[i] ?? new GamepadState();
  }
  /**
   * -1..1 from arrows / WASD / first connected gamepad (left stick + d-pad). When both `left`/`right`
   * (or `up`/`down`) actions are declared, those actions plus the left stick are used instead.
   */
  axis(name: 'horizontal' | 'vertical'): number {
    const s = { isDown: (code: string) => this.axisKey(code) };
    const pad = this.pads.find((p) => p.connected);
    const dpad = this.actionPad(); // F023: D-pad buttons latched by the on-screen keyboard count as up
    // F009: with both movement actions declared, follow the (remappable) actions + left stick.
    const [negId, posId] = name === 'horizontal' ? ['left', 'right'] : ['up', 'down'];
    if (this.effective.some((a) => a.id === negId) && this.effective.some((a) => a.id === posId))
      return combineAxis(this.map.down(negId), this.map.down(posId), (name === 'horizontal' ? pad?.leftX : pad?.leftY) ?? 0);
    if (name === 'horizontal') {
      const neg = s.isDown('ArrowLeft') || s.isDown('KeyA') || !!dpad?.isDown('Left');
      const pos = s.isDown('ArrowRight') || s.isDown('KeyD') || !!dpad?.isDown('Right');
      return combineAxis(neg, pos, pad?.leftX ?? 0);
    }
    const neg = s.isDown('ArrowUp') || s.isDown('KeyW') || !!dpad?.isDown('Up');
    const pos = s.isDown('ArrowDown') || s.isDown('KeyS') || !!dpad?.isDown('Down');
    return combineAxis(neg, pos, pad?.leftY ?? 0);
  }
}

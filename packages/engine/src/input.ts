/** Keyboard / mouse / touch / gamepad input with per-step pressed/released edges. */
import { ActionMap, applyOverrides, gamepadLabel, keyLabel as defaultKeyLabel, type ControlAction } from './actions';

interface BtnState {
  down: boolean;
  pressed: boolean;
  released: boolean;
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
      b = { down: false, pressed: false, released: false };
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
  release(code: string): void {
    const b = this.get(code);
    if (b.down) {
      b.down = false;
      b.released = true;
    }
  }
  /** Release everything (e.g. on window blur). */
  releaseAll(): void {
    for (const k of this.buttons.keys()) this.release(k);
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

export class GamepadState {
  connected = false;
  id = '';
  axes: number[] = [];
  private prev: boolean[] = [];
  private cur: boolean[] = [];
  /** Analog values 0..1 per button (triggers). */
  values: number[] = [];

  /** Engine-internal: refresh from a navigator Gamepad snapshot. */
  poll(gp: Gamepad | null | undefined): void {
    this.prev = this.cur;
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
  rightDown: boolean;
  rightPressed: boolean;
  /** Wheel delta accumulated this step (+ = down). */
  wheel: number;
  /** Pointer currently over the canvas. */
  inside: boolean;
}

const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace']);

/** DOM-attached input. Keys use KeyboardEvent.code ("ArrowLeft", "KeyA", "Space"); mouse buttons are "Mouse0/1/2". */
export class Input {
  readonly state = new InputState();
  readonly mouse: MouseState = { x: 0, y: 0, down: false, pressed: false, released: false, rightDown: false, rightPressed: false, wheel: 0, inside: false };
  /** Active touches (game coordinates). */
  touches: TouchPoint[] = [];
  private readonly touchMap = new Map<number, TouchPoint>();
  private readonly pads: GamepadState[] = [new GamepadState(), new GamepadState(), new GamepadState(), new GamepadState()];
  private wheelAcc = 0;
  private readonly cleanup: (() => void)[] = [];
  /** Last KeyboardEvent.key typed this step (for text entry). */
  typed = '';
  private typedAcc = '';
  private defaults: readonly ControlAction[] = Object.freeze([]);
  private effective: readonly ControlAction[] = Object.freeze([]);
  private overrides: unknown = {};
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
      if ((PREVENT.has(e.code) || (this.next ?? this.map).boundKeys.has(e.code)) && !e.ctrlKey && !e.metaKey) e.preventDefault();
      if (!e.repeat) this.state.press(e.code);
      if (e.key.length === 1) this.typedAcc += e.key;
    });
    on(window, 'keyup', (e) => this.state.release(e.code));
    on(window, 'blur', () => {
      this.state.releaseAll();
      this.mouse.down = false;
    });

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
    const up = (e: PointerEvent): void => {
      const p = pos(e);
      const t = this.touchMap.get(e.pointerId);
      if (t) {
        t.x = p.x;
        t.y = p.y;
        t.released = true;
      }
      if (e.isPrimary || e.pointerType === 'mouse') {
        this.state.release(`Mouse${e.pointerType === 'mouse' ? e.button : 0}`);
      }
    };
    on(window, 'pointerup', up);
    on(window, 'pointercancel', up);
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

  /** Engine-internal: called before each fixed update step. */
  beginStep(): void {
    const s = this.state;
    const m = this.mouse;
    m.down = s.isDown('Mouse0');
    m.pressed = s.wasPressed('Mouse0');
    m.released = s.wasReleased('Mouse0');
    m.rightDown = s.isDown('Mouse2');
    m.rightPressed = s.wasPressed('Mouse2');
    m.wheel = this.wheelAcc;
    this.wheelAcc = 0;
    this.typed = this.typedAcc;
    this.typedAcc = '';
    this.touches = Array.from(this.touchMap.values());
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const list = nav && typeof nav.getGamepads === 'function' ? nav.getGamepads() : [];
    for (let i = 0; i < this.pads.length; i++) this.pads[i]!.poll(list[i] ?? null);
    this.updateActions();
  }

  /** Engine-internal (also used by tests): apply a pending rebuild, then compute action edges. */
  updateActions(): void {
    if (this.next) {
      this.map = this.next;
      this.next = null;
    }
    this.map.update(this.state, this.pads.find((p) => p.connected) ?? null);
  }

  // --- F009 actions ----------------------------------------------------------

  /** Engine-internal: the declared actions (boot option `actions`, already parsed). Clears overrides. */
  setActions(defaults: readonly ControlAction[]): void {
    this.defaults = Object.freeze([...defaults]);
    this.overrides = {};
    this.rebuild();
  }
  /** Engine-internal: player key overrides (`webgame:controls`); replaces the previous overrides. */
  setOverrides(overrides: unknown): void {
    this.overrides = overrides;
    this.rebuild();
  }
  private rebuild(): void {
    this.effective = Object.freeze(applyOverrides(this.defaults, this.overrides));
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
  /** Label of the action's first effective key, else its first gamepad button, else "". */
  actionLabel(id: string): string {
    if (!this.known(id)) return '';
    const a = this.effective.find((x) => x.id === id)!;
    if (a.keys[0]) return defaultKeyLabel(a.keys[0]);
    if (a.gamepad[0]) return gamepadLabel(a.gamepad[0]);
    return '';
  }
  /** Default (US layout) label of a code; an unknown code returns the code. */
  keyLabel(code: string): string {
    return defaultKeyLabel(code);
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
    const s = this.state;
    const pad = this.pads.find((p) => p.connected);
    // F009: with both movement actions declared, follow the (remappable) actions + left stick.
    const [negId, posId] = name === 'horizontal' ? ['left', 'right'] : ['up', 'down'];
    if (this.effective.some((a) => a.id === negId) && this.effective.some((a) => a.id === posId))
      return combineAxis(this.map.down(negId), this.map.down(posId), (name === 'horizontal' ? pad?.leftX : pad?.leftY) ?? 0);
    if (name === 'horizontal') {
      const neg = s.isDown('ArrowLeft') || s.isDown('KeyA') || !!pad?.isDown('Left');
      const pos = s.isDown('ArrowRight') || s.isDown('KeyD') || !!pad?.isDown('Right');
      return combineAxis(neg, pos, pad?.leftX ?? 0);
    }
    const neg = s.isDown('ArrowUp') || s.isDown('KeyW') || !!pad?.isDown('Up');
    const pos = s.isDown('ArrowDown') || s.isDown('KeyS') || !!pad?.isDown('Down');
    return combineAxis(neg, pos, pad?.leftY ?? 0);
  }
}

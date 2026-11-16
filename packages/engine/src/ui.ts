/**
 * F012 `engine.ui`: an immediate-mode helper (panel, label, button) with pointer, keyboard and
 * gamepad navigation. Widgets are called from `update`; each fixed step builds a command list that
 * the engine draws (screen space, normal blend) after the game's render, before the capture point.
 * Input and renderer are injected so the rules are testable in node.
 */
import type { ColorLike } from './math';
import type { NineSlice, NineSliceOptions } from './nineslice';
import type { BlendMode, ShapeOptions, TextOptions } from './renderer';

export type UiTheme = {
  font: string;
  /** null = the font's default size (16 for canvas fonts, native size for bitmap fonts). */
  textSize: number | null;
  textColor: ColorLike;
  disabledTextColor: ColorLike;
  /** null = flat panelColor with a 1-unit panelBorder. */
  panel: NineSlice | null;
  panelColor: ColorLike;
  panelBorder: ColorLike;
  /** null = flat colours below. */
  button: NineSlice | null;
  /** null = button. */
  buttonHover: NineSlice | null;
  /** null = buttonHover ?? button. */
  buttonDown: NineSlice | null;
  buttonColor: ColorLike;
  buttonHoverColor: ColorLike;
  buttonDownColor: ColorLike;
  buttonBorder: ColorLike;
  focusColor: ColorLike;
  /** Scale passed to drawNineSlice for panels and buttons; default 1. */
  nineSliceScale: number;
};

export type ButtonOptions = { disabled?: boolean; nav?: boolean; font?: string; textSize?: number; textColor?: ColorLike };
export type PanelOptions = { style?: NineSlice | null; color?: ColorLike; alpha?: number };

type NavButton = 'Up' | 'Down' | 'Left' | 'Right' | 'A' | 'B';

/** What Ui reads from `engine.input`. */
export interface UiInput {
  readonly mouse: {
    readonly x: number;
    readonly y: number;
    readonly pressed: boolean;
    readonly released: boolean;
    readonly inside: boolean;
    /** Primary button held (tells "release then press" from "press then release" within one step). */
    readonly down?: boolean;
    /** The release was a cancellation (blur, pause, pointercancel): it never activates a button. */
    readonly cancelled?: boolean;
  };
  readonly actions: readonly { readonly id: string }[];
  actionPressed(id: string): boolean;
  wasPressed(code: string): boolean;
  gamepad(i: number): { wasPressed(b: NavButton): boolean };
}

/** What Ui draws with (a subset of Renderer). */
export interface UiRenderer {
  drawNineSlice(src: NineSlice, x: number, y: number, w: number, h: number, opts?: NineSliceOptions): void;
  drawRect(x: number, y: number, w: number, h: number, color?: ColorLike, opts?: ShapeOptions): void;
  strokeRect(x: number, y: number, w: number, h: number, color?: ColorLike, thickness?: number, alpha?: number): void;
  drawText(text: string | number, x: number, y: number, opts?: TextOptions): void;
  ui(fn: () => void): void;
  setBlend?(mode: BlendMode): void;
  readonly blendMode?: BlendMode;
}

export interface UiDeps {
  input: UiInput;
  renderer: UiRenderer;
  warn?: (message: string) => void;
}

/** Engine-internal phase: widgets are live only in `update`; elsewhere they draw at the call site. */
export type UiPhase = 'update' | 'render' | 'other';

type Cmd =
  | { k: 'panel'; x: number; y: number; w: number; h: number; o: PanelOptions }
  | { k: 'label'; text: string; x: number; y: number; o: TextOptions }
  | { k: 'button'; id: string; label: string; x: number; y: number; w: number; h: number; o: ButtonOptions; valid: boolean };

interface Hit {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const UI_MAX_COMMANDS = 256;
export const UI_MAX_ID = 64;

export function defaultTheme(): UiTheme {
  return {
    font: 'default',
    textSize: null,
    textColor: '#ffffff',
    disabledTextColor: '#8b91b0',
    panel: null,
    panelColor: '#141a2e',
    panelBorder: '#3a4470',
    button: null,
    buttonHover: null,
    buttonDown: null,
    buttonColor: '#2a3358',
    buttonHoverColor: '#3a4780',
    buttonDownColor: '#1e2540',
    buttonBorder: '#5a6bc0',
    focusColor: '#ffd166',
    nineSliceScale: 1,
  };
}

export class Ui {
  /** Mutable theme fields (assign to restyle). */
  theme: UiTheme = defaultTheme();
  /** Keyboard / gamepad navigation on (default true). */
  navigation = true;
  /** Draw the committed list automatically after the game's render (default true). */
  autoDraw = true;

  private readonly input: UiInput;
  private readonly renderer: UiRenderer;
  private readonly warnFn: (message: string) => void;
  private phase: UiPhase = 'other';
  private _hot: string | null = null;
  private _active: string | null = null;
  private _focus: string | null = null;

  /** Draw list of the step in progress / of the last completed step. */
  private building: Cmd[] = [];
  private committed: Cmd[] = [];
  /** Ids declared this step (valid ones), enabled ones, and the hit / nav order of this step. */
  private declared = new Set<string>();
  private enabled = new Set<string>();
  private hits: Hit[] = [];
  private nav: string[] = [];
  /** The previous step's hit list and nav order (used for this step's decisions). */
  private prevHits: Hit[] = [];
  private prevNav: string[] = [];
  /** Ids activated in this step (pointer release or nav activate). */
  private pointerFire: string | null = null;
  private navFire: string | null = null;
  private drawnThisFrame = false;
  private readonly warned = new Set<string>();

  constructor(deps: UiDeps) {
    this.input = deps.input;
    this.renderer = deps.renderer;
    this.warnFn = deps.warn ?? ((m) => console.warn(m));
  }

  /** Button under the pointer (read-only). */
  get hot(): string | null {
    return this._hot;
  }
  /** Button being pressed (read-only). */
  get active(): string | null {
    return this._active;
  }
  /** Focused button (keyboard / gamepad); setting an id shows the focus ring. */
  get focus(): string | null {
    return this._focus;
  }
  set focus(id: string | null) {
    this._focus = typeof id === 'string' && id ? id : null;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnFn(`[pixelforge] ui: ${msg}`);
  }

  // -------------------------------------------------------------------------
  // Engine hooks
  // -------------------------------------------------------------------------

  /** Engine-internal: set the current phase (`update` inside a step, `render` around render). */
  setPhase(p: UiPhase): void {
    this.phase = p;
  }

  /** Engine-internal: start of a fixed step (after input.beginStep). Reads pointer and nav edges. */
  beginStep(): void {
    this.phase = 'update';
    this.building = [];
    this.declared = new Set();
    this.enabled = new Set();
    this.hits = [];
    this.nav = [];
    this.pointerFire = null;
    this.navFire = null;
    const m = this.input.mouse;

    // Pointer: hot from the previous step's rects (last declared wins). A press/release edge counts
    // as "inside": on touch, pointerleave follows pointerup before the step sees the release.
    this._hot = null;
    if (m.inside || m.pressed || m.released) {
      for (let i = this.prevHits.length - 1; i >= 0; i--) {
        const r = this.prevHits[i]!;
        if (m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h) {
          this._hot = r.id;
          break;
        }
      }
    }
    const press = (): void => {
      this._focus = null; // a pointer press hides the focus ring (:focus-visible)
      this._active = this._hot;
    };
    const release = (): void => {
      // A cancelled release (blur, pause/resume, pointercancel) abandons the press: no activation.
      if (!m.cancelled && this._active !== null && this._active === this._hot) this.pointerFire = this._active;
      this._active = null;
    };
    // Both edges in one step: still down → the release ended an earlier press, then a new one began.
    if (m.pressed && m.released && m.down) {
      release();
      press();
    } else {
      if (m.pressed) press();
      if (m.released) release();
    }

    // Keyboard / gamepad navigation over the previous step's order.
    const order = this.prevNav;
    if (!this.navigation || order.length === 0) return;
    const inp = this.input;
    const pad = inp.gamepad(0);
    const declared = (id: string): boolean => inp.actions.some((a) => a.id === id);
    const edge = (action: string, keys: readonly string[]): boolean =>
      declared(action) ? inp.actionPressed(action) : keys.some((k) => inp.wasPressed(k));
    const prev = edge('up', ['ArrowUp']) || edge('left', ['ArrowLeft']) || pad.wasPressed('Up') || pad.wasPressed('Left');
    const next = edge('down', ['ArrowDown']) || edge('right', ['ArrowRight']) || pad.wasPressed('Down') || pad.wasPressed('Right');
    const activate = edge('confirm', ['Enter', 'NumpadEnter', 'Space']) || pad.wasPressed('A');
    const clear = inp.wasPressed('Escape') || pad.wasPressed('B');
    if (clear) this._focus = null;
    if (next !== prev) {
      const n = order.length;
      const i = this._focus === null ? -1 : order.indexOf(this._focus);
      this._focus = next ? order[i < 0 ? 0 : (i + 1) % n]! : order[i < 0 ? n - 1 : (i - 1 + n) % n]!;
    }
    if (activate && !clear && this._focus !== null) this.navFire = this._focus;
  }

  /** Engine-internal: end of a fixed step (before input.endStep). Commits the draw list. */
  endStep(): void {
    if (this._focus !== null && !this.enabled.has(this._focus)) this._focus = null;
    if (this._active !== null && !this.enabled.has(this._active)) this._active = null;
    if (this._hot !== null && !this.enabled.has(this._hot)) this._hot = null;
    this.committed = this.building;
    this.building = [];
    this.prevHits = this.hits;
    this.prevNav = this.nav;
    this.pointerFire = null;
    this.navFire = null;
    this.phase = 'other';
  }

  /**
   * Engine-internal: the engine paused or resumed. Any press in progress is abandoned (it never
   * activates), and the hover state is dropped until the pointer is seen again.
   */
  cancelPointer(): void {
    this._active = null;
    this._hot = null;
  }

  /** Engine-internal: a new rendered frame starts (re-arms `draw()`). */
  frameStart(): void {
    this.drawnThisFrame = false;
  }

  /** Engine-internal: the automatic UI layer (after scenes.render, before flush + capture). */
  drawLayer(): void {
    if (!this.autoDraw || this.drawnThisFrame) return;
    this.drawList();
  }

  /** Draw the committed list now (from `render`); at most once per frame, and skips the automatic layer. */
  draw(): void {
    if (this.drawnThisFrame || this.phase !== 'render') return;
    this.drawList();
  }

  private drawList(): void {
    this.drawnThisFrame = true;
    const list = this.committed;
    if (list.length === 0) return;
    const r = this.renderer;
    const prevBlend = r.blendMode;
    r.setBlend?.('normal');
    r.ui(() => {
      for (const c of list) this.exec(c);
    });
    if (prevBlend !== undefined && prevBlend !== 'normal') r.setBlend?.(prevBlend);
  }

  // -------------------------------------------------------------------------
  // Widgets
  // -------------------------------------------------------------------------

  /**
   * Inside a step the command joins the step's list. Outside one (`render`, `load`, a timer outside
   * update) it is drawn immediately at the call site, like a direct renderer call there.
   */
  private emit(c: Cmd): void {
    if (this.phase === 'update') {
      if (this.building.length >= UI_MAX_COMMANDS) {
        this.warnOnce('#max', `more than ${UI_MAX_COMMANDS} widgets in one step; the extra ones are not drawn`);
        return;
      }
      this.building.push(c);
    } else {
      this.renderer.ui(() => this.exec(c));
    }
  }

  /** A frame: `style` (default theme.panel) as a 9-slice, or a flat rect with a 1-unit border. */
  panel(x: number, y: number, w: number, h: number, opts: PanelOptions = {}): void {
    this.emit({ k: 'panel', x, y, w, h, o: { ...opts } });
  }

  /** Text with the theme's font, size and colour as defaults. */
  label(text: string | number, x: number, y: number, opts: TextOptions = {}): void {
    this.emit({ k: 'label', text: String(text), x, y, o: { ...opts } });
  }

  /** A button; returns true exactly once per activation (pointer click, or confirm on focus). */
  button(id: string, label: string, x: number, y: number, w: number, h: number, opts: ButtonOptions = {}): boolean {
    const o = { ...(opts ?? {}) };
    const key = typeof id === 'string' ? id : String(id);
    if (this.phase !== 'update') {
      this.warnOnce(`phase:${key}`, `button "${key}" was called outside update; it is drawn but never activates (call widgets from update)`);
      this.emit({ k: 'button', id: key, label: String(label), x, y, w, h, o, valid: false });
      return false;
    }
    let valid = typeof id === 'string' && id.length >= 1 && id.length <= UI_MAX_ID;
    if (!valid) this.warnOnce(`id:${key}`, `button id ${JSON.stringify(key)} must be a string of 1–${UI_MAX_ID} characters; it never activates`);
    else if (this.declared.has(id)) {
      valid = false;
      this.warnOnce(`dup:${key}`, `button id "${key}" is used twice in one step; the second one never activates`);
    }
    const disabled = !!o.disabled;
    if (valid) {
      this.declared.add(id);
      if (!disabled) {
        this.enabled.add(id);
        this.hits.push({ id, x, y, w, h });
        if (o.nav !== false) this.nav.push(id);
      }
    }
    this.emit({ k: 'button', id: key, label: String(label), x, y, w, h, o, valid });
    return valid && !disabled && (this.pointerFire === id || this.navFire === id);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private exec(c: Cmd): void {
    const r = this.renderer;
    const t = this.theme;
    const scale = t.nineSliceScale > 0 ? t.nineSliceScale : 1;
    if (c.k === 'panel') {
      const style = c.o.style === undefined ? t.panel : c.o.style;
      const alpha = c.o.alpha ?? 1;
      if (style) r.drawNineSlice(style, c.x, c.y, c.w, c.h, { scale, alpha });
      else {
        r.drawRect(c.x, c.y, c.w, c.h, c.o.color ?? t.panelColor, { alpha });
        r.strokeRect(c.x, c.y, c.w, c.h, t.panelBorder, 1, alpha);
      }
    } else if (c.k === 'label') {
      r.drawText(c.text, c.x, c.y, {
        ...c.o,
        font: c.o.font ?? t.font,
        size: c.o.size ?? t.textSize ?? undefined,
        color: c.o.color ?? t.textColor,
      });
    } else {
      const disabled = !!c.o.disabled;
      const live = c.valid && !disabled;
      const hover = live && this._hot === c.id;
      const down = hover && this._active === c.id;
      const alpha = disabled ? 0.5 : 1;
      const style = down ? (t.buttonDown ?? t.buttonHover ?? t.button) : hover ? (t.buttonHover ?? t.button) : t.button;
      if (style) r.drawNineSlice(style, c.x, c.y, c.w, c.h, { scale, alpha });
      else {
        r.drawRect(c.x, c.y, c.w, c.h, down ? t.buttonDownColor : hover ? t.buttonHoverColor : t.buttonColor, { alpha });
        r.strokeRect(c.x, c.y, c.w, c.h, t.buttonBorder, 1, alpha);
      }
      r.drawText(c.label, c.x + c.w / 2, c.y + c.h / 2, {
        align: 'center',
        baseline: 'middle',
        font: c.o.font ?? t.font,
        size: c.o.textSize ?? t.textSize ?? undefined,
        color: disabled ? t.disabledTextColor : (c.o.textColor ?? t.textColor),
        alpha,
      });
      if (live && this._focus === c.id) r.strokeRect(c.x - 4, c.y - 4, c.w + 8, c.h + 8, t.focusColor, 2, 1);
    }
  }
}

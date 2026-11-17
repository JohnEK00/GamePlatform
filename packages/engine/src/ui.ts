/**
 * F012 + F019 `engine.ui`: an immediate-mode helper (panel, label, button, slider, toggle, text
 * field, list) with pointer, keyboard and gamepad navigation. Widgets are called from `update`; each
 * fixed step builds a command list that the engine draws (screen space, normal blend) after the
 * game's render, before the capture point. Input and renderer are injected so the rules are
 * testable in node.
 *
 * F019 widgets are "value in, value out": the game passes its value every step and stores what
 * comes back. The Ui keeps only interaction state per id (drag, list cursor and scroll, caret).
 */
import type { ColorLike } from './math';
import type { NineSlice, NineSliceOptions } from './nineslice';
import type { BlendMode, ShapeOptions, TextOptions } from './renderer';
import { applyTextEvents, caretFromX, truncateToWidth, visibleRun, type MeasureFn, type TextEvent } from './uitext';

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
  /** Scale passed to drawNineSlice for panels, buttons and the F019 9-slices; default 1. */
  nineSliceScale: number;
  // --- F019 ---
  /** Slider track, toggle switch when off, scrollbar track. */
  trackColor: ColorLike;
  /** Slider fill, toggle switch when on, scrollbar thumb. */
  fillColor: ColorLike;
  /** Slider knob, toggle knob. */
  knobColor: ColorLike;
  /** Text field and list background. */
  fieldColor: ColorLike;
  /** Text field and list 1-unit border. */
  fieldBorder: ColorLike;
  caretColor: ColorLike;
  placeholderColor: ColorLike;
  rowHoverColor: ColorLike;
  rowSelectedColor: ColorLike;
  /** null = flat trackColor / fillColor bars. */
  track: NineSlice | null;
  /** null = flat knobColor square. */
  knob: NineSlice | null;
  /** null = flat fieldColor + fieldBorder (text field and list frame). */
  field: NineSlice | null;
};

export type ButtonOptions = { disabled?: boolean; nav?: boolean; font?: string; textSize?: number; textColor?: ColorLike };
export type PanelOptions = { style?: NineSlice | null; color?: ColorLike; alpha?: number };
export type SliderOptions = {
  /** Default 0. */
  min?: number;
  /** Default 1; needs finite min < max. */
  max?: number;
  /** Default 0 = continuous; > 0 snaps the value. */
  step?: number;
  /** Keyboard / gamepad increment; default `step > 0 ? step : (max - min) / 20`. */
  keyStep?: number;
  disabled?: boolean;
  /** Default true. */
  nav?: boolean;
};
export type ToggleOptions = { disabled?: boolean; nav?: boolean; font?: string; textSize?: number; textColor?: ColorLike };
export type TextFieldOptions = {
  /** In code points; default 24; integers 1–256. */
  maxLength?: number;
  /** Shown when empty and not editing. */
  placeholder?: string;
  /** Called per code point; false rejects it. */
  allow?: (ch: string) => boolean;
  disabled?: boolean;
  nav?: boolean;
  font?: string;
  textSize?: number;
  textColor?: ColorLike;
};
export type ListOptions = {
  /** Default 16; integers 4–256. */
  rowHeight?: number;
  /** The "current" row, drawn highlighted; default -1 (none). */
  selected?: number;
  disabled?: boolean;
  nav?: boolean;
  font?: string;
  textSize?: number;
  textColor?: ColorLike;
};
export type { TextEvent } from './uitext';

type NavButton = 'Up' | 'Down' | 'Left' | 'Right' | 'A' | 'B';

/**
 * What Ui reads from `engine.input`. The F019 members are optional so minimal hosts (and the F012
 * test doubles) keep working; `engine.input` provides all of them.
 */
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
    /** F019: wheel delta this step (+ = down); scrolls lists. */
    readonly wheel?: number;
  };
  readonly actions: readonly { readonly id: string }[];
  actionPressed(id: string): boolean;
  /** F019: hold repeat for declared actions. */
  actionDown?(id: string): boolean;
  wasPressed(code: string): boolean;
  /** F019: hold repeat for fallback keys. */
  isDown?(code: string): boolean;
  gamepad(i: number): { wasPressed(b: NavButton): boolean; isDown?(b: NavButton): boolean };
  /** F019: this step's typing. */
  readonly textEvents?: readonly TextEvent[];
  /** F019: keyboard capture while a text field edits (engine-internal). */
  setKeyboardCapture?(on: boolean): void;
  /** F019: editing starts in this step: capture keyboard actions from this step on (engine-internal). */
  captureKeyboardNow?(): void;
}

/** What Ui draws with (a subset of Renderer). */
export interface UiRenderer {
  drawNineSlice(src: NineSlice, x: number, y: number, w: number, h: number, opts?: NineSliceOptions): void;
  drawRect(x: number, y: number, w: number, h: number, color?: ColorLike, opts?: ShapeOptions): void;
  strokeRect(x: number, y: number, w: number, h: number, color?: ColorLike, thickness?: number, alpha?: number): void;
  drawText(text: string | number, x: number, y: number, opts?: TextOptions): void;
  /** F019: text fields and list rows fit their text with it (an estimate is used when absent). */
  measureText?(text: string, opts?: Pick<TextOptions, 'size' | 'font'>): { width: number; height: number };
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

type Kind = 'button' | 'slider' | 'toggle' | 'textField' | 'list';

type TextStyle = { font: string; size: number | undefined; color: ColorLike };

type Cmd =
  | { k: 'panel'; x: number; y: number; w: number; h: number; o: PanelOptions }
  | { k: 'label'; text: string; x: number; y: number; o: TextOptions }
  | { k: 'button'; id: string; label: string; x: number; y: number; w: number; h: number; o: ButtonOptions; valid: boolean }
  | { k: 'slider'; id: string; x: number; y: number; w: number; h: number; t: number; live: boolean }
  | { k: 'toggle'; id: string; label: string; x: number; y: number; w: number; h: number; on: boolean; live: boolean; style: TextStyle }
  | {
      k: 'field';
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      live: boolean;
      text: string;
      placeholder: boolean;
      caretX: number | null;
      caretH: number;
      style: TextStyle;
    }
  | {
      k: 'list';
      id: string;
      x: number;
      y: number;
      w: number;
      h: number;
      live: boolean;
      rowHeight: number;
      rows: string[];
      first: number;
      count: number;
      visible: number;
      selected: number;
      hover: number;
      cursor: number;
      style: TextStyle;
    };

interface Hit {
  id: string;
  kind: Kind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Lists: row height used in that step. */
  rowHeight: number;
}

/** Per-id interaction state (ARCHITECTURE § F019), dropped at the end of a step that doesn't declare the id. */
interface WidgetState {
  kind: Kind;
  // list
  cursor: number;
  scroll: number;
  count: number;
  visible: number;
  hadFocus: boolean;
  pressRow: number;
  pressY: number;
  pressScroll: number;
  dragScroll: boolean;
  fireRow: number;
  // text field
  caret: number;
  runStart: number;
  original: string | null;
  pressX: number | null;
  pendingCommit: boolean;
  // slider
  dragChanged: boolean;
  applyPointer: boolean;
  endDrag: boolean;
}

type EditAction = 'revert' | 'submit' | 'commit' | null;

export const UI_MAX_COMMANDS = 256;
export const UI_MAX_ID = 64;
export const UI_MAX_LIST_ITEMS = 1000;
/** Hold repeat (slider adjustment and list cursor): first repeat after, then every (seconds). */
export const UI_REPEAT_DELAY = 0.4;
export const UI_REPEAT_INTERVAL = 0.08;
/** A list press becomes a drag scroll after this much vertical movement (game units). */
export const UI_DRAG_THRESHOLD = 4;

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
    trackColor: '#0e1224',
    fillColor: '#5a6bc0',
    knobColor: '#ffffff',
    fieldColor: '#0e1224',
    fieldBorder: '#5a6bc0',
    caretColor: '#ffd166',
    placeholderColor: '#5d6488',
    rowHoverColor: '#2a3358',
    rowSelectedColor: '#3a4780',
    track: null,
    knob: null,
    field: null,
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function newState(kind: Kind): WidgetState {
  return {
    kind,
    cursor: -1,
    scroll: 0,
    count: 0,
    visible: 1,
    hadFocus: false,
    pressRow: -1,
    pressY: 0,
    pressScroll: 0,
    dragScroll: false,
    fireRow: -1,
    caret: 0,
    runStart: 0,
    original: null,
    pressX: null,
    pendingCommit: false,
    dragChanged: false,
    applyPointer: false,
    endDrag: false,
  };
}

interface Dir {
  pressed: boolean;
  held: boolean;
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
  private committedList: Cmd[] = [];
  /** Ids declared this step (valid ones), enabled ones, and the hit / nav order of this step. */
  private declared = new Set<string>();
  private enabled = new Set<string>();
  private hits: Hit[] = [];
  private nav: string[] = [];
  private kinds = new Map<string, Kind>();
  /** The previous step's hit list, nav order and kinds (used for this step's decisions). */
  private prevHits: Hit[] = [];
  private prevNav: string[] = [];
  private prevKinds = new Map<string, Kind>();
  /** Ids activated in this step (pointer release or nav activate). */
  private pointerFire: string | null = null;
  private navFire: string | null = null;
  private drawnThisFrame = false;
  private readonly warned = new Set<string>();

  // --- F019 ---
  private readonly states = new Map<string, WidgetState>();
  /** Change signals of this step, set by each widget's call. */
  private signals = new Map<string, { changed: boolean; committed: boolean }>();
  private _editing: string | null = null;
  /** `ui.editing = id`: pending for the next step / live in this step. */
  private editRequestNext: string | null = null;
  private editRequestNow: string | null = null;
  /** What happens to the editing field in this step (decided in beginStep). */
  private editAction: EditAction = null;
  /** The focused field starts editing because of typing in this step. */
  private typeStart: string | null = null;
  /** A text field pressed with the pointer in this step. */
  private pointerEdit: string | null = null;
  /**
   * The text field that starts editing in this step at its call (type-start, pointer press or
   * activate, decided in beginStep); `ui.editing` reports it from beginStep on.
   */
  private pendingStart: string | null = null;
  /** How focus arrived on its current id (list cursor initialisation). */
  private arrival: 'next' | 'prev' | 'set' = 'set';
  /** Slider adjustment / list cursor movement for the focused widget in this step (−1, 0, +1). */
  private keyMove = 0;
  /** Hold-repeat timer. */
  private rep: { focus: string; dir: number; t: number; next: number } | null = null;
  private stepDt = 1 / 60;

  constructor(deps: UiDeps) {
    this.input = deps.input;
    this.renderer = deps.renderer;
    this.warnFn = deps.warn ?? ((m) => console.warn(m));
  }

  /** Widget under the pointer (read-only). */
  get hot(): string | null {
    return this._hot;
  }
  /** Widget being pressed (read-only). */
  get active(): string | null {
    return this._active;
  }
  /** Focused widget (keyboard / gamepad); setting an id shows the focus ring. Moving it away from an editing field commits the edit. */
  get focus(): string | null {
    return this._focus;
  }
  set focus(id: string | null) {
    const next = typeof id === 'string' && id ? id : null;
    if (this._editing !== null && next !== this._editing) this.stopEditing(this._editing);
    if (this.pendingStart !== null && next !== this.pendingStart) this.cancelPendingStart();
    if (next !== this._focus) this.focusChanged();
    this._focus = next;
  }

  /** Focus changed outside navigation (ui.focus / ui.editing): a list gaining it re-initialises its cursor. */
  private focusChanged(): void {
    this.arrival = 'set';
    for (const st of this.states.values()) st.hadFocus = false;
  }

  /**
   * The text field being edited (F019). Setting an id focuses it and starts editing in the next
   * step (caret at the end) if that step declares an enabled text field with that id; setting
   * `null` stops editing with a commit. A field that starts editing in this step (typing on it,
   * pressing it, activating it) is reported from the start of the step, before its call.
   */
  get editing(): string | null {
    return this._editing ?? this.editRequestNow ?? this.pendingStart ?? this.editRequestNext;
  }
  set editing(id: string | null) {
    const next = typeof id === 'string' && id ? id : null;
    if (next === null) {
      if (this._editing !== null) this.stopEditing(this._editing);
      this.editRequestNext = this.editRequestNow = null;
      this.cancelPendingStart();
      return;
    }
    if (this._editing === next) return;
    if (this._editing !== null) this.stopEditing(this._editing);
    if (this.pendingStart !== null && this.pendingStart !== next) this.cancelPendingStart();
    if (this._focus !== next) this.focusChanged();
    this._focus = next;
    this.editRequestNext = next;
  }

  /** The player changed the widget's value in this step (after its call; F019 § "Change signals"). */
  changed(id: string): boolean {
    return this.signals.get(id)?.changed ?? false;
  }
  /** The player finished a change in this step (after its call; F019 § "Change signals"). */
  committed(id: string): boolean {
    return this.signals.get(id)?.committed ?? false;
  }
  /** A list's cursor row, or -1 (no cursor, unknown id, or not a list). */
  listCursor(id: string): number {
    const st = this.states.get(id);
    return st && st.kind === 'list' ? st.cursor : -1;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnFn(`[pixelforge] ui: ${msg}`);
  }

  /** End editing with a commit, reported by the field's next call. */
  private stopEditing(id: string): void {
    const st = this.states.get(id);
    if (st && st.kind === 'textField') st.pendingCommit = true;
    if (this._editing === id) this._editing = null;
  }

  /**
   * The game moved focus or `ui.editing` away before the pending field's call: it doesn't start
   * editing in this step. Capture, already on, is recomputed at endStep as usual.
   */
  private cancelPendingStart(): void {
    const id = this.pendingStart;
    if (id === null) return;
    this.pendingStart = null;
    if (this.typeStart === id) this.typeStart = null;
    if (this.pointerEdit === id) this.pointerEdit = null;
    if (this.navFire === id) this.navFire = null;
  }

  // -------------------------------------------------------------------------
  // Engine hooks
  // -------------------------------------------------------------------------

  /** Engine-internal: set the current phase (`update` inside a step, `render` around render). */
  setPhase(p: UiPhase): void {
    this.phase = p;
  }

  /**
   * Engine-internal: start of a fixed step (after input.beginStep). Reads pointer and navigation
   * edges once and routes them by the focused widget's kind (GAME_FORMAT § F019 "Navigation").
   * `dt` is the fixed-step length (hold repeat).
   */
  beginStep(dt = 1 / 60): void {
    this.phase = 'update';
    this.stepDt = finite(dt) && dt > 0 ? dt : 1 / 60;
    this.building = [];
    this.declared = new Set();
    this.enabled = new Set();
    this.hits = [];
    this.nav = [];
    this.kinds = new Map();
    this.signals = new Map();
    this.pointerFire = null;
    this.navFire = null;
    this.editAction = null;
    this.typeStart = null;
    this.pointerEdit = null;
    this.keyMove = 0;
    this.editRequestNow = this.editRequestNext;
    this.editRequestNext = null;
    this.pendingStart = null;
    this.pointerStep();
    this.navigateStep();
    // F019: editing that starts in this step captures the keyboard from this step on, so the key
    // that started it (the typed letter, Enter / Space / the confirm key) never fires its action.
    if (this._editing === null) {
      const nav = this.navFire !== null && this.prevKinds.get(this.navFire) === 'textField' ? this.navFire : null;
      this.pendingStart = this.typeStart ?? this.pointerEdit ?? nav;
      if (this.pendingStart !== null || this.editRequestNow !== null) this.input.captureKeyboardNow?.();
    }
  }

  private pointerStep(): void {
    const m = this.input.mouse;
    // Pointer: hot from the previous step's rects (last declared wins). A press/release edge counts
    // as "inside": on touch, pointerleave follows pointerup before the step sees the release.
    this._hot = null;
    let hotHit: Hit | null = null;
    if (m.inside || m.pressed || m.released) {
      for (let i = this.prevHits.length - 1; i >= 0; i--) {
        const r = this.prevHits[i]!;
        if (m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h) {
          this._hot = r.id;
          hotHit = r;
          break;
        }
      }
    }
    const press = (): void => {
      // A press anywhere but on the editing field commits it.
      if (this._editing !== null && this._hot !== this._editing) this.stopEditing(this._editing);
      this._focus = null; // a pointer press hides the focus ring (:focus-visible)
      this._active = this._hot;
      if (!hotHit) return;
      const st = this.states.get(hotHit.id);
      if (!st || st.kind !== hotHit.kind) return;
      if (hotHit.kind === 'slider') {
        st.applyPointer = true;
        st.dragChanged = false;
      } else if (hotHit.kind === 'textField') {
        this._focus = hotHit.id; // an editing field shows the ring
        this.arrival = 'set';
        st.pressX = m.x;
        this.pointerEdit = hotHit.id;
      } else if (hotHit.kind === 'list') {
        st.pressRow = this.rowAt(hotHit, st, m.y);
        st.pressY = m.y;
        st.pressScroll = st.scroll;
        st.dragScroll = false;
      }
    };
    const release = (): void => {
      const id = this._active;
      const st = id !== null ? this.states.get(id) : undefined;
      if (id !== null && st) {
        if (st.kind === 'slider') {
          // Any release (cancelled or not) ends the drag; a real one applies the final position.
          if (!m.cancelled) st.applyPointer = true;
          st.endDrag = true;
        } else if (st.kind === 'list') {
          if (Math.abs(m.y - st.pressY) > UI_DRAG_THRESHOLD) st.dragScroll = true;
          const hit = hotHit && hotHit.id === id ? hotHit : null;
          if (!m.cancelled && !st.dragScroll && hit && st.pressRow >= 0 && this.rowAt(hit, st, m.y) === st.pressRow) st.fireRow = st.pressRow;
          st.pressRow = -1;
          st.dragScroll = false;
        }
      }
      // A cancelled release (blur, pause/resume, pointercancel) abandons the press: no activation.
      if (!m.cancelled && id !== null && id === this._hot) this.pointerFire = id;
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
  }

  /** The list row under game y (from the hit rect and the list's scroll), or -1. */
  private rowAt(hit: Hit, st: WidgetState, y: number): number {
    const i = Math.floor((y - hit.y) / hit.rowHeight);
    if (i < 0 || i >= st.visible) return -1;
    const row = st.scroll + i;
    return row < st.count ? row : -1;
  }

  private navigateStep(): void {
    const inp = this.input;
    const pad = inp.gamepad(0);
    const declared = (id: string): boolean => inp.actions.some((a) => a.id === id);
    const order = this.prevNav;

    // A text field being edited owns the keys (keyboard actions are captured meanwhile).
    if (this._editing !== null) {
      this.rep = null;
      const id = this._editing;
      const revert = inp.wasPressed('Escape') || pad.wasPressed('B');
      const submit =
        inp.wasPressed('Enter') || inp.wasPressed('NumpadEnter') || (declared('confirm') && inp.actionPressed('confirm')) || pad.wasPressed('A');
      if (revert) this.editAction = 'revert';
      else if (submit) this.editAction = 'submit';
      else if (this.navigation) {
        const up = this.dir('up', 'ArrowUp', 'Up').pressed || inp.wasPressed('ArrowUp');
        const down = this.dir('down', 'ArrowDown', 'Down').pressed || inp.wasPressed('ArrowDown');
        if (up !== down) {
          this.editAction = 'commit';
          this._focus = id;
          this.moveFocus(order, down ? 1 : -1);
        }
      }
      return;
    }
    if (this.pointerEdit !== null) {
      this.rep = null;
      return;
    }
    // Typing on a focused, non-editing field starts editing; no navigation in that step.
    const te = inp.textEvents ?? [];
    if (this._focus !== null && this.prevKinds.get(this._focus) === 'textField' && te.some((e) => e && e.kind === 'text')) {
      this.typeStart = this._focus;
      this.rep = null;
      return;
    }

    if (!this.navigation || order.length === 0) {
      this.rep = null;
      return;
    }
    const up = this.dir('up', 'ArrowUp', 'Up');
    const down = this.dir('down', 'ArrowDown', 'Down');
    const left = this.dir('left', 'ArrowLeft', 'Left');
    const right = this.dir('right', 'ArrowRight', 'Right');
    const edge = (action: string, keys: readonly string[]): boolean =>
      declared(action) ? inp.actionPressed(action) : keys.some((k) => inp.wasPressed(k));
    const activate = edge('confirm', ['Enter', 'NumpadEnter', 'Space']) || pad.wasPressed('A');
    const clear = inp.wasPressed('Escape') || pad.wasPressed('B');
    if (clear) this._focus = null;
    const kind = this._focus !== null ? this.prevKinds.get(this._focus) : undefined;
    let repeating = false;
    if (kind === 'slider') {
      if (up.pressed !== down.pressed) this.moveFocus(order, down.pressed ? 1 : -1);
      else {
        repeating = true;
        this.keyMove = this.repeat(left, right).dir;
      }
    } else if (kind === 'list') {
      if (left.pressed !== right.pressed) this.moveFocus(order, right.pressed ? 1 : -1);
      else {
        repeating = true;
        const r = this.repeat(up, down);
        const st = this.states.get(this._focus!);
        if (r.dir !== 0 && st && st.kind === 'list') {
          // A fresh press past the first / last row leaves the list; a repeat never does.
          if (r.fresh && st.cursor >= 0 && ((r.dir < 0 && st.cursor === 0) || (r.dir > 0 && st.cursor >= st.count - 1))) {
            this.rep = null;
            this.moveFocus(order, r.dir);
          } else this.keyMove = r.dir;
        }
      }
    } else {
      // F012: "previous" = up or left, "next" = down or right.
      const prev = up.pressed || left.pressed;
      const next = down.pressed || right.pressed;
      if (next !== prev) this.moveFocus(order, next ? 1 : -1);
    }
    if (!repeating) this.rep = null;
    if (activate && !clear && this._focus !== null) this.navFire = this._focus;
  }

  /** One intent: pressed edge and held state (declared action, else the fallback key; plus the D-pad). */
  private dir(action: string, key: string, padButton: NavButton): Dir {
    const inp = this.input;
    const pad = inp.gamepad(0);
    const isDeclared = inp.actions.some((a) => a.id === action);
    return {
      pressed: (isDeclared ? inp.actionPressed(action) : inp.wasPressed(key)) || pad.wasPressed(padButton),
      held: (isDeclared ? !!inp.actionDown?.(action) : !!inp.isDown?.(key)) || !!pad.isDown?.(padButton),
    };
  }

  /** F012 focus movement over the previous step's order (wraps; no focus → first / last). */
  private moveFocus(order: readonly string[], delta: number): void {
    const n = order.length;
    if (n === 0) return;
    const i = this._focus === null ? -1 : order.indexOf(this._focus);
    this._focus = delta > 0 ? order[i < 0 ? 0 : (i + 1) % n]! : order[i < 0 ? n - 1 : (i - 1 + n) % n]!;
    this.arrival = delta > 0 ? 'next' : 'prev';
  }

  /**
   * Hold repeat for a pair of intents: a fresh press acts at once; holding repeats after 0.4 s and
   * then every 0.08 s of step time. The timer restarts when the held intent or the focus changes.
   */
  private repeat(neg: Dir, pos: Dir): { dir: number; fresh: boolean } {
    const focus = this._focus ?? '';
    if (neg.pressed !== pos.pressed) {
      const d = pos.pressed ? 1 : -1;
      this.rep = { focus, dir: d, t: 0, next: UI_REPEAT_DELAY };
      return { dir: d, fresh: true };
    }
    const held = neg.pressed || neg.held === pos.held ? 0 : pos.held ? 1 : -1;
    if (held === 0) {
      this.rep = null;
      return { dir: 0, fresh: false };
    }
    if (!this.rep || this.rep.focus !== focus || this.rep.dir !== held) {
      this.rep = { focus, dir: held, t: 0, next: UI_REPEAT_DELAY };
      return { dir: 0, fresh: false };
    }
    this.rep.t += this.stepDt;
    if (this.rep.t + 1e-9 >= this.rep.next) {
      this.rep.next += UI_REPEAT_INTERVAL;
      return { dir: held, fresh: false };
    }
    return { dir: 0, fresh: false };
  }

  /** Engine-internal: end of a fixed step (before input.endStep). Commits the draw list. */
  endStep(): void {
    // Editing is dropped (no signal) when its field was not declared, or disabled, in this step.
    if (this._editing !== null && !(this.enabled.has(this._editing) && this.kinds.get(this._editing) === 'textField')) {
      const st = this.states.get(this._editing);
      if (st) st.original = null;
      this._editing = null;
    }
    if (this._focus !== null && !this.enabled.has(this._focus)) this._focus = null;
    if (this._active !== null && !this.enabled.has(this._active)) this._active = null;
    if (this._hot !== null && !this.enabled.has(this._hot)) this._hot = null;
    for (const id of this.states.keys()) if (!this.declared.has(id) || this.kinds.get(id) !== this.states.get(id)!.kind) this.states.delete(id);
    for (const [id, st] of this.states) if (st.kind === 'list') st.hadFocus = this._focus === id;
    this.editRequestNow = null;
    this.pendingStart = null;
    this.input.setKeyboardCapture?.(this._editing !== null);
    this.committedList = this.building;
    this.building = [];
    this.prevHits = this.hits;
    this.prevNav = this.nav;
    this.prevKinds = this.kinds;
    this.signals = new Map();
    this.pointerFire = null;
    this.navFire = null;
    this.editAction = null;
    this.typeStart = null;
    this.pointerEdit = null;
    this.keyMove = 0;
    this.phase = 'other';
  }

  /**
   * Engine-internal: the engine paused or resumed. Any press in progress is abandoned (it never
   * activates), and the hover state is dropped until the pointer is seen again. A slider drag ends
   * (its commit, if the value changed, is reported by the next call).
   */
  cancelPointer(): void {
    if (this._active !== null) {
      const st = this.states.get(this._active);
      if (st?.kind === 'slider') st.endDrag = true;
      if (st?.kind === 'list') {
        st.pressRow = -1;
        st.dragScroll = false;
      }
    }
    this._active = null;
    this._hot = null;
    this.rep = null;
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
    const list = this.committedList;
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
    if (valid) this.register(id, 'button', x, y, w, h, !disabled, o.nav !== false);
    this.emit({ k: 'button', id: key, label: String(label), x, y, w, h, o, valid });
    const fired = valid && !disabled && (this.pointerFire === id || this.navFire === id);
    if (valid) this.signals.set(id, { changed: fired, committed: fired });
    return fired;
  }

  /** Declare a valid id for this step: kind, and (when enabled) hit rect and nav order. */
  private register(id: string, kind: Kind, x: number, y: number, w: number, h: number, enabled: boolean, nav: boolean, rowHeight = 0): void {
    this.declared.add(id);
    this.kinds.set(id, kind);
    if (!enabled) return;
    this.enabled.add(id);
    this.hits.push({ id, kind, x, y, w, h, rowHeight });
    if (nav) this.nav.push(id);
  }

  /**
   * Shared F019 checks: phase, id validity and duplicates (GAME_FORMAT § F019 "Phases, ids and
   * disabled state"). Returns the valid id, or null when the widget is inert this call.
   */
  private check(kind: Exclude<Kind, 'button'>, id: unknown): string | null {
    const key = typeof id === 'string' ? id : String(id);
    if (this.phase !== 'update') {
      this.warnOnce(`phase:${kind}:${key}`, `${kind} "${key}" was called outside update; it is drawn but never changes (call widgets from update)`);
      return null;
    }
    if (typeof id !== 'string' || id.length < 1 || id.length > UI_MAX_ID) {
      this.warnOnce(`id:${kind}:${key}`, `${kind} id ${JSON.stringify(key)} must be a string of 1–${UI_MAX_ID} characters; it never changes`);
      return null;
    }
    if (this.declared.has(id)) {
      this.warnOnce(`dup:${kind}:${key}`, `${kind} id "${key}" is used twice in one step; the second one never changes`);
      return null;
    }
    return id;
  }

  private stateFor(id: string, kind: Kind): WidgetState {
    let st = this.states.get(id);
    if (!st || st.kind !== kind) {
      st = newState(kind);
      this.states.set(id, st);
    }
    return st;
  }

  private textStyle(o: { font?: string; textSize?: number; textColor?: ColorLike }, disabled: boolean): TextStyle {
    const t = this.theme;
    return {
      font: o.font ?? t.font,
      size: o.textSize ?? t.textSize ?? undefined,
      color: disabled ? t.disabledTextColor : (o.textColor ?? t.textColor),
    };
  }

  private measurer(style: TextStyle): MeasureFn {
    const r = this.renderer;
    if (r.measureText) {
      const opts = { font: style.font, size: style.size };
      return (s) => (s ? r.measureText!(s, opts).width : 0);
    }
    const px = (style.size ?? 16) * 0.6;
    return (s) => Array.from(s).length * px;
  }

  private textHeight(style: TextStyle): number {
    const r = this.renderer;
    const h = r.measureText ? r.measureText('Hg', { font: style.font, size: style.size }).height : 0;
    return h > 0 ? h : (style.size ?? 16);
  }

  /**
   * A horizontal slider; returns the new value, clamped to `[min, max]` and snapped to `step`.
   * Drag it with the pointer, or focus it and press left / right (hold to repeat).
   */
  slider(id: string, value: number, x: number, y: number, w: number, h: number, opts: SliderOptions = {}): number {
    const o = opts ?? {};
    const min = o.min ?? 0;
    const max = o.max ?? 1;
    const rangeOk = finite(min) && finite(max) && max > min;
    const step = finite(o.step) && o.step > 0 ? o.step : 0;
    const keyStep = finite(o.keyStep) && o.keyStep > 0 ? o.keyStep : step > 0 ? step : (max - min) / 20;
    const norm = (v: number): number => {
      let r = clamp(v, min, max);
      if (step > 0) r = Number(clamp(min + Math.round((r - min) / step) * step, min, max).toFixed(10));
      return r;
    };
    const tOf = (v: number): number => (rangeOk && finite(v) ? clamp((v - min) / (max - min), 0, 1) : 0);
    const vid = this.check('slider', id);
    const key = typeof id === 'string' ? id : String(id);
    if (vid !== null && !rangeOk) this.warnOnce(`range:${key}`, `slider "${key}" needs finite min < max; it is drawn disabled`);
    const inValue = finite(value) ? value : min;
    if (vid === null || !rangeOk) {
      if (vid !== null) this.register(vid, 'slider', x, y, w, h, false, false);
      this.emit({ k: 'slider', id: key, x, y, w, h, t: rangeOk ? tOf(norm(inValue)) : 0, live: false });
      if (vid !== null) this.signals.set(vid, { changed: false, committed: false });
      return value;
    }
    const disabled = !!o.disabled;
    const v = norm(inValue);
    this.register(vid, 'slider', x, y, w, h, !disabled, o.nav !== false);
    const st = this.stateFor(vid, 'slider');
    let out = v;
    let changed = false;
    let committed = false;
    if (disabled) {
      st.applyPointer = st.endDrag = st.dragChanged = false;
    } else {
      if (this._active === vid || st.applyPointer) {
        const m = this.input.mouse;
        const t = clamp((m.x - (x + h / 2)) / Math.max(1, w - h), 0, 1);
        out = norm(min + t * (max - min));
        if (out !== v) st.dragChanged = true;
        st.applyPointer = false;
      }
      if (st.endDrag) {
        committed = st.dragChanged;
        st.dragChanged = false;
        st.endDrag = false;
      }
      if (this._focus === vid && this.keyMove !== 0) {
        const k = norm(out + this.keyMove * keyStep);
        if (k !== out) {
          out = k;
          if (out !== v) committed = true;
        }
      }
      changed = out !== v;
    }
    this.signals.set(vid, { changed, committed });
    this.emit({ k: 'slider', id: vid, x, y, w, h, t: tOf(out), live: !disabled });
    return out;
  }

  /** A labelled on/off switch; returns the new state (flips on click or activate). */
  toggle(id: string, on: boolean, label: string, x: number, y: number, w: number, h: number, opts: ToggleOptions = {}): boolean {
    const o = opts ?? {};
    const vid = this.check('toggle', id);
    const key = typeof id === 'string' ? id : String(id);
    const disabled = !!o.disabled;
    const style = this.textStyle(o, disabled);
    if (vid === null) {
      this.emit({ k: 'toggle', id: key, label: String(label), x, y, w, h, on: !!on, live: false, style });
      return on;
    }
    this.register(vid, 'toggle', x, y, w, h, !disabled, o.nav !== false);
    const fired = !disabled && (this.pointerFire === vid || this.navFire === vid);
    const out = fired ? !on : on;
    this.signals.set(vid, { changed: fired, committed: fired });
    this.emit({ k: 'toggle', id: vid, label: String(label), x, y, w, h, on: !!out, live: !disabled, style });
    return out;
  }

  /** A single-line text field; returns the (live) text. See GAME_FORMAT § F019 "Text editing". */
  textField(id: string, text: string, x: number, y: number, w: number, h: number, opts: TextFieldOptions = {}): string {
    const o = opts ?? {};
    const vid = this.check('textField', id);
    const key = typeof id === 'string' ? id : String(id);
    const str = typeof text === 'string' ? text : String(text ?? '');
    const disabled = !!o.disabled;
    const style = this.textStyle(o, disabled);
    const measure = this.measurer(style);
    const inner = Math.max(0, w - 8);
    const placeholder = typeof o.placeholder === 'string' ? o.placeholder : '';
    const draw = (shown: string, editing: boolean, caret: number, runStart: number, live: boolean): void => {
      const isPh = shown === '' && !editing && placeholder !== '';
      const cps = Array.from(shown);
      const run = editing || !isPh ? visibleRun(shown, editing ? caret : 0, editing ? runStart : 0, inner, measure) : { start: 0, end: 0 };
      const visible = isPh ? truncateToWidth(placeholder, inner, measure) : cps.slice(run.start, run.end).join('');
      const caretX = editing ? x + 4 + measure(cps.slice(run.start, clamp(caret, run.start, run.end)).join('')) : null;
      this.emit({
        k: 'field', id: key, x, y, w, h, live, text: visible, placeholder: isPh, caretX,
        caretH: Math.min(Math.max(1, h - 2), this.textHeight(style)), style,
      });
    };
    if (vid === null) {
      draw(str, false, 0, 0, false);
      return text;
    }
    // maxLength: integers 1–256, else clamped after Math.floor (NaN → 24) with a warning.
    let maxLength = 24;
    if (o.maxLength !== undefined) {
      const ml = o.maxLength;
      if (typeof ml === 'number' && Number.isInteger(ml) && ml >= 1 && ml <= 256) maxLength = ml;
      else {
        this.warnOnce(`maxLength:${vid}`, `textField "${vid}" maxLength must be an integer from 1 to 256`);
        const f = Math.floor(Number(ml));
        maxLength = Number.isNaN(f) ? 24 : clamp(f, 1, 256);
      }
    }
    this.register(vid, 'textField', x, y, w, h, !disabled, o.nav !== false);
    const st = this.stateFor(vid, 'textField');
    let out = str;
    let committed = false;
    // An edit that ended outside this call (pointer press elsewhere, ui.editing = null, focus moved).
    if (st.pendingCommit && this._editing !== vid) {
      committed = st.original !== null && str !== st.original;
      st.pendingCommit = false;
      st.original = null;
      st.runStart = 0;
    }
    if (this.pendingStart === vid) this.pendingStart = null; // started below, or disabled
    if (disabled) {
      st.pressX = null;
      if (this._editing === vid) this._editing = null; // dropped at endStep without a signal
      this.signals.set(vid, { changed: false, committed });
      draw(str, false, 0, 0, false);
      return text;
    }
    const events = this.input.textEvents ?? [];
    let startedNow = false;
    if (this._editing !== vid) {
      const byPointer = this.pointerEdit === vid;
      if (this.editRequestNow === vid || byPointer || this.navFire === vid || this.typeStart === vid) {
        if (this._editing !== null) this.stopEditing(this._editing);
        this._editing = vid;
        this._focus = vid;
        st.original = str;
        st.pendingCommit = false;
        st.runStart = 0;
        st.caret = Array.from(str).length;
        if (byPointer && st.pressX !== null) st.caret = caretFromX(str, 0, st.pressX - (x + 4), measure);
        st.pressX = null;
        startedNow = true;
      }
    } else if (this.pointerEdit === vid && st.pressX !== null) {
      // A press on the editing field moves the caret.
      const run = visibleRun(str, st.caret, st.runStart, inner, measure);
      st.caret = caretFromX(str, run.start, st.pressX - (x + 4), measure);
      st.pressX = null;
    }
    if (this._editing === vid) {
      const action = startedNow ? null : this.editAction;
      if (action === 'revert') {
        out = st.original ?? str;
        this.endEdit(st);
      } else {
        const r = applyTextEvents({ text: out, caret: st.caret }, events, { maxLength, allow: typeof o.allow === 'function' ? o.allow : undefined });
        if (r.allowThrew) this.warnOnce(`allow:${vid}`, `textField "${vid}" allow threw; the character was rejected`);
        out = r.text;
        st.caret = r.caret;
        if (action === 'submit') {
          committed = true;
          this.endEdit(st);
        } else if (action === 'commit') {
          committed = out !== (st.original ?? str);
          this.endEdit(st);
        }
      }
    }
    const editing = this._editing === vid;
    if (editing) st.runStart = visibleRun(out, st.caret, st.runStart, inner, measure).start;
    this.signals.set(vid, { changed: out !== str, committed });
    draw(out, editing, st.caret, st.runStart, true);
    return out;
  }

  private endEdit(st: WidgetState): void {
    this._editing = null;
    st.original = null;
    st.runStart = 0;
    st.pendingCommit = false;
  }

  /** A vertical list of rows; returns the index activated in this step, else -1. */
  list(id: string, items: readonly (string | number)[], x: number, y: number, w: number, h: number, opts: ListOptions = {}): number {
    const o = opts ?? {};
    const vid = this.check('list', id);
    const key = typeof id === 'string' ? id : String(id);
    const disabled = !!o.disabled;
    const style = this.textStyle(o, disabled);
    const all = Array.isArray(items) ? items : [];
    if (vid !== null && all.length > UI_MAX_LIST_ITEMS)
      this.warnOnce(`items:${vid}`, `list "${vid}" has more than ${UI_MAX_LIST_ITEMS} items; only the first ${UI_MAX_LIST_ITEMS} are shown`);
    const count = Math.min(all.length, UI_MAX_LIST_ITEMS);
    let rowHeight = 16;
    if (o.rowHeight !== undefined) {
      const rh = o.rowHeight;
      if (typeof rh === 'number' && Number.isInteger(rh) && rh >= 4 && rh <= 256) rowHeight = rh;
      else if (vid !== null) this.warnOnce(`rowHeight:${vid}`, `list "${vid}" rowHeight must be an integer from 4 to 256`);
    }
    const visible = Math.max(1, Math.floor(h / rowHeight));
    const maxScroll = Math.max(0, count - visible);
    const selected = typeof o.selected === 'number' && Number.isInteger(o.selected) && o.selected >= 0 && o.selected < count ? o.selected : -1;
    const measure = this.measurer(style);
    const draw = (scroll: number, cursor: number, hover: number, live: boolean): void => {
      const textW = Math.max(0, w - (count > visible ? 12 : 8));
      const rows: string[] = [];
      for (let i = 0; i < visible && scroll + i < count; i++) rows.push(truncateToWidth(String(all[scroll + i]), textW, measure));
      this.emit({ k: 'list', id: key, x, y, w, h, live, rowHeight, rows, first: scroll, count, visible, selected, hover, cursor, style });
    };
    const initialScroll = selected >= 0 ? clamp(selected - visible + 1, 0, maxScroll) : 0;
    if (vid === null) {
      draw(initialScroll, -1, -1, false);
      return -1;
    }
    const live = !disabled && count > 0;
    const fresh = !this.states.has(vid) || this.states.get(vid)!.kind !== 'list';
    const st = this.stateFor(vid, 'list');
    this.register(vid, 'list', x, y, w, h, live, o.nav !== false, rowHeight);
    if (fresh) st.scroll = initialScroll;
    st.count = count;
    st.visible = visible;
    st.scroll = clamp(st.scroll, 0, maxScroll);
    if (st.cursor >= count) st.cursor = count - 1;
    let result = -1;
    let changed = false;
    let committed = false;
    if (!live) {
      st.fireRow = -1;
      st.pressRow = -1;
      st.hadFocus = false;
      this.signals.set(vid, { changed, committed });
      draw(st.scroll, -1, -1, false);
      return -1;
    }
    const scrollTo = (row: number): void => {
      if (row < st.scroll) st.scroll = row;
      else if (row >= st.scroll + visible) st.scroll = row - visible + 1;
      st.scroll = clamp(st.scroll, 0, maxScroll);
    };
    const focused = this._focus === vid;
    if (focused && !st.hadFocus) {
      st.cursor = selected >= 0 ? selected : this.arrival === 'prev' ? count - 1 : 0;
      scrollTo(st.cursor);
    }
    st.hadFocus = focused;
    const m = this.input.mouse;
    // Pointer: drag scroll past the threshold, row activation on release (decided in beginStep).
    if (this._active === vid) {
      if (Math.abs(m.y - st.pressY) > UI_DRAG_THRESHOLD) st.dragScroll = true;
      if (st.dragScroll) st.scroll = clamp(st.pressScroll + Math.round((st.pressY - m.y) / rowHeight), 0, maxScroll);
    }
    if (st.fireRow >= 0) {
      if (st.fireRow < count) {
        result = st.fireRow;
        if (st.cursor !== result) changed = true;
        st.cursor = result;
        committed = true;
      }
      st.fireRow = -1;
    }
    const wheel = m.wheel ?? 0;
    if (wheel !== 0 && m.inside && m.x >= x && m.x < x + w && m.y >= y && m.y < y + h) {
      const rows = Math.sign(wheel) * Math.max(1, Math.round(Math.abs(wheel) / 100));
      st.scroll = clamp(st.scroll + rows, 0, maxScroll);
    }
    if (focused) {
      if (this.keyMove !== 0) {
        const c = clamp((st.cursor < 0 ? (this.keyMove > 0 ? -1 : count) : st.cursor) + this.keyMove, 0, count - 1);
        if (c !== st.cursor) {
          st.cursor = c;
          changed = true;
        }
        scrollTo(st.cursor);
      }
      if (this.navFire === vid && st.cursor >= 0 && st.cursor < count && result < 0) {
        result = st.cursor;
        committed = true;
      }
    }
    let hover = -1;
    if (this._hot === vid && m.inside && !st.dragScroll && m.x >= x && m.x < x + w) {
      const i = Math.floor((m.y - y) / rowHeight);
      if (i >= 0 && i < visible && st.scroll + i < count) hover = st.scroll + i;
    }
    this.signals.set(vid, { changed, committed });
    draw(st.scroll, focused ? st.cursor : -1, hover, true);
    return result;
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private frame(x: number, y: number, w: number, h: number, alpha: number): void {
    const r = this.renderer;
    const t = this.theme;
    if (t.field) r.drawNineSlice(t.field, x, y, w, h, { scale: this.scale(), alpha });
    else {
      r.drawRect(x, y, w, h, t.fieldColor, { alpha });
      r.strokeRect(x, y, w, h, t.fieldBorder, 1, alpha);
    }
  }

  private scale(): number {
    return this.theme.nineSliceScale > 0 ? this.theme.nineSliceScale : 1;
  }

  private ring(id: string, live: boolean, x: number, y: number, w: number, h: number): void {
    if (live && this._focus === id) this.renderer.strokeRect(x - 4, y - 4, w + 8, h + 8, this.theme.focusColor, 2, 1);
  }

  private exec(c: Cmd): void {
    const r = this.renderer;
    const t = this.theme;
    const scale = this.scale();
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
    } else if (c.k === 'button') {
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
    } else if (c.k === 'slider') {
      const alpha = c.live ? 1 : 0.5;
      const barH = Math.max(2, Math.round(c.h / 3));
      const by = c.y + (c.h - barH) / 2;
      if (t.track) r.drawNineSlice(t.track, c.x, by, c.w, barH, { scale, alpha });
      else r.drawRect(c.x, by, c.w, barH, t.trackColor, { alpha });
      const cx = c.x + c.h / 2 + c.t * Math.max(0, c.w - c.h);
      if (cx > c.x) r.drawRect(c.x, by, cx - c.x, barH, t.fillColor, { alpha });
      if (t.knob) r.drawNineSlice(t.knob, cx - c.h / 2, c.y, c.h, c.h, { scale, alpha });
      else r.drawRect(cx - c.h / 2, c.y, c.h, c.h, t.knobColor, { alpha });
      this.ring(c.id, c.live, c.x, c.y, c.w, c.h);
    } else if (c.k === 'toggle') {
      const alpha = c.live ? 1 : 0.5;
      r.drawText(c.label, c.x, c.y + c.h / 2, { align: 'left', baseline: 'middle', font: c.style.font, size: c.style.size, color: c.style.color, alpha });
      const sw = Math.min(c.w, 2 * c.h);
      const sx = c.x + c.w - sw;
      if (t.track) r.drawNineSlice(t.track, sx, c.y, sw, c.h, { scale, alpha });
      else r.drawRect(sx, c.y, sw, c.h, c.on ? t.fillColor : t.trackColor, { alpha });
      const ks = c.h - 4;
      if (ks > 0) {
        const kx = c.on ? sx + sw - 2 - ks : sx + 2;
        if (t.knob) r.drawNineSlice(t.knob, kx, c.y + 2, ks, ks, { scale, alpha });
        else r.drawRect(kx, c.y + 2, ks, ks, t.knobColor, { alpha });
      }
      this.ring(c.id, c.live, c.x, c.y, c.w, c.h);
    } else if (c.k === 'field') {
      const alpha = c.live ? 1 : 0.5;
      this.frame(c.x, c.y, c.w, c.h, alpha);
      if (c.text)
        r.drawText(c.text, c.x + 4, c.y + c.h / 2, {
          align: 'left',
          baseline: 'middle',
          font: c.style.font,
          size: c.style.size,
          color: c.placeholder ? t.placeholderColor : c.style.color,
          alpha,
        });
      if (c.caretX !== null) r.drawRect(c.caretX, c.y + (c.h - c.caretH) / 2, 1, c.caretH, t.caretColor, { alpha });
      this.ring(c.id, c.live, c.x, c.y, c.w, c.h);
    } else {
      const alpha = c.live ? 1 : 0.5;
      this.frame(c.x, c.y, c.w, c.h, alpha);
      const bar = c.count > c.visible;
      const rowW = Math.max(0, c.w - 2 - (bar ? 4 : 0));
      for (let i = 0; i < c.rows.length; i++) {
        const row = c.first + i;
        const ry = c.y + i * c.rowHeight;
        if (row === c.selected) r.drawRect(c.x + 1, ry, rowW, c.rowHeight, t.rowSelectedColor, { alpha });
        else if (row === c.hover) r.drawRect(c.x + 1, ry, rowW, c.rowHeight, t.rowHoverColor, { alpha });
        if (c.rows[i])
          r.drawText(c.rows[i]!, c.x + 4, ry + c.rowHeight / 2, {
            align: 'left',
            baseline: 'middle',
            font: c.style.font,
            size: c.style.size,
            color: c.style.color,
            alpha,
          });
        if (c.live && row === c.cursor && this._focus === c.id) r.strokeRect(c.x + 1, ry, rowW, c.rowHeight, t.focusColor, 1, 1);
      }
      if (bar) {
        const th = Math.max(2, c.h - 2);
        r.drawRect(c.x + c.w - 4, c.y + 1, 3, th, t.trackColor, { alpha });
        const thumb = Math.min(th, Math.max(4, (c.h * c.visible) / c.count));
        const maxScroll = Math.max(1, c.count - c.visible);
        r.drawRect(c.x + c.w - 4, c.y + 1 + (th - thumb) * (c.first / maxScroll), 3, thumb, t.fillColor, { alpha });
      }
      this.ring(c.id, c.live, c.x, c.y, c.w, c.h);
    }
  }
}

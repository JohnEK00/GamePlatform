/**
 * F023 on-screen keyboard for `ui.textField`: the fixed layout, the sizing / docking formula, hit
 * testing, cursor movement and labels (GAME_FORMAT § F023 "Layout" and "Size and position").
 * Pure: no DOM, no renderer. `Ui` owns the state and the drawing.
 */

/** One key of the layout table. Character keys take one column at their index in the row. */
export type OskKeyDef =
  | { kind: 'char'; lower: string; upper: string }
  | { kind: 'shift' | 'space' | 'del' | 'ok'; col: number; span: number };

const charRow = (s: string): OskKeyDef[] =>
  Array.from(s).map((c) => ({ kind: 'char' as const, lower: c.toLowerCase(), upper: c.toUpperCase() }));

/** The layout table (GAME_FORMAT § F023 "Layout"): 10 columns, 5 rows. */
export const OSK_ROWS: readonly (readonly OskKeyDef[])[] = Object.freeze([
  Object.freeze(charRow('1234567890')),
  Object.freeze(charRow('QWERTYUIOP')),
  Object.freeze(charRow("ASDFGHJKL'")),
  Object.freeze(charRow('ZXCVBNM-_.')),
  Object.freeze<OskKeyDef[]>([
    { kind: 'shift', col: 0, span: 2 },
    { kind: 'space', col: 2, span: 4 },
    { kind: 'del', col: 6, span: 2 },
    { kind: 'ok', col: 8, span: 2 },
  ]),
]);

export const OSK_COLS = 10;
export const OSK_ROW_COUNT = 5;
/** Margin and gap of the sizing formula (game units). */
export const OSK_MARGIN = 4;
export const OSK_GAP = 2;

/** One key in flat order (row by row): its definition, row, first column and span. */
export interface OskKeyPos {
  readonly def: OskKeyDef;
  readonly row: number;
  readonly col: number;
  readonly span: number;
}

/** Every key in flat order; the index matches `OskLayout.keys` and `oskKeyAt`. */
export const OSK_KEYS: readonly OskKeyPos[] = Object.freeze(
  OSK_ROWS.flatMap((row, r) =>
    row.map((def, i) => Object.freeze({ def, row: r, col: def.kind === 'char' ? i : def.col, span: def.kind === 'char' ? 1 : def.span })),
  ),
);

/** Flat key indices of the row 4 keys. */
export const OSK_SHIFT = 40;
export const OSK_SPACE = 41;
export const OSK_DEL = 42;
export const OSK_OK = 43;

export interface OskKeyRect {
  row: number;
  col: number;
  span: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OskLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  keyW: number;
  keyH: number;
  keys: OskKeyRect[];
}

export interface OskCursor {
  row: number;
  /** First column of the key the cursor is on. */
  col: number;
  /** The column up / down aim for; set by left / right only. */
  anchor: number;
}

/** The cursor at open: on `Q` (row 1, column 0), anchor 0. */
export function oskStartCursor(): OskCursor {
  return { row: 1, col: 0, anchor: 0 };
}

/**
 * The sizing and docking formula (GAME_FORMAT § F023 "Size and position"), or `null` when the
 * keyboard doesn't fit (`keyW < 8` or `panelH > H`, or a non-finite game size).
 */
export function oskLayout(gameW: number, gameH: number, field: { x: number; y: number; w: number; h: number }): OskLayout | null {
  const W = gameW;
  const H = gameH;
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return null;
  const m = OSK_MARGIN;
  const g = OSK_GAP;
  const keyH = Math.min(48, Math.max(12, Math.round(H * 0.09)));
  const keyW = Math.floor((W - 2 * m - 9 * g) / 10);
  const panelW = 10 * keyW + 9 * g + 2 * m;
  const panelH = 5 * keyH + 4 * g + 2 * m;
  if (keyW < 8 || panelH > H) return null;
  const panelX = Math.floor((W - panelW) / 2);
  let panelY = H - panelH;
  const fy = Number(field?.y);
  const fh = Number(field?.h);
  if (Number.isFinite(fy) && Number.isFinite(fh) && fy + fh > H - panelH && fy >= panelH) panelY = 0;
  const keys: OskKeyRect[] = OSK_KEYS.map((k) => ({
    row: k.row,
    col: k.col,
    span: k.span,
    x: panelX + m + k.col * (keyW + g),
    y: panelY + m + k.row * (keyH + g),
    w: k.span * keyW + (k.span - 1) * g,
    h: keyH,
  }));
  return { x: panelX, y: panelY, w: panelW, h: panelH, keyW, keyH, keys };
}

/** The flat index of the key under (x, y), or -1 for gaps, margins and outside. */
export function oskKeyAt(layout: OskLayout, x: number, y: number): number {
  for (let i = 0; i < layout.keys.length; i++) {
    const k = layout.keys[i]!;
    if (x >= k.x && x < k.x + k.w && y >= k.y && y < k.y + k.h) return i;
  }
  return -1;
}

/** The flat index of the key in `row` that covers `col` (row 0–4, col 0–9), or -1. */
export function oskKeyIndex(row: number, col: number): number {
  for (let i = 0; i < OSK_KEYS.length; i++) {
    const k = OSK_KEYS[i]!;
    if (k.row === row && col >= k.col && col < k.col + k.span) return i;
  }
  return -1;
}

const wrap = (v: number, n: number): number => ((v % n) + n) % n;

/**
 * Move the cursor (GAME_FORMAT § F023 "Cursor"): the vertical move first (to the key in the
 * adjacent row covering the anchor column, wrapping rows 0 ↔ 4; the anchor is kept), then the
 * horizontal one (one key along the row, wrapping; the anchor becomes the new key's first column).
 */
export function oskMove(cursor: OskCursor, dx: -1 | 0 | 1, dy: -1 | 0 | 1): OskCursor {
  let row = wrap(Math.floor(cursor.row) || 0, OSK_ROW_COUNT);
  const anchor = wrap(Math.floor(cursor.anchor) || 0, OSK_COLS);
  let idx = oskKeyIndex(row, wrap(Math.floor(cursor.col) || 0, OSK_COLS));
  let next = { row, col: OSK_KEYS[idx]!.col, anchor };
  if (dy !== 0) {
    row = wrap(row + dy, OSK_ROW_COUNT);
    idx = oskKeyIndex(row, anchor);
    next = { row, col: OSK_KEYS[idx]!.col, anchor };
  }
  if (dx !== 0) {
    const keys = OSK_ROWS[row]!;
    const pos = OSK_KEYS[idx]!;
    const inRow = OSK_KEYS.filter((k) => k.row === row).indexOf(pos);
    const target = OSK_KEYS.filter((k) => k.row === row)[wrap(inRow + dx, keys.length)]!;
    next = { row, col: target.col, anchor: target.col };
  }
  return next;
}

/** The label drawn on a key: its character in the current case; `SHIFT` shows the case a press switches to. */
export function oskLabel(key: OskKeyDef, upper: boolean): string {
  switch (key.kind) {
    case 'char':
      return upper ? key.upper : key.lower;
    case 'shift':
      return upper ? 'abc' : 'ABC';
    case 'space':
      return 'SPACE';
    case 'del':
      return 'DEL';
    case 'ok':
      return 'OK';
  }
}

/** The character a key types (`SPACE` gives " "), or null for `SHIFT`, `DEL` and `OK`. */
export function oskChar(key: OskKeyDef, upper: boolean): string | null {
  if (key.kind === 'char') return upper ? key.upper : key.lower;
  if (key.kind === 'space') return ' ';
  return null;
}

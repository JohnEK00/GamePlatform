import { describe, expect, it } from 'vitest';
import {
  OSK_DEL, OSK_KEYS, OSK_OK, OSK_ROWS, OSK_SHIFT, OSK_SPACE, oskChar, oskKeyAt, oskKeyIndex, oskLabel, oskLayout, oskMove,
  oskStartCursor, type OskCursor,
} from '../src/osk';

const noField = { x: 0, y: 0, w: 10, h: 10 };
const keyName = (c: OskCursor): string => oskLabel(OSK_KEYS[oskKeyIndex(c.row, c.col)]!.def, true);

describe('OSK_ROWS', () => {
  it('is the GAME_FORMAT § F023 layout table', () => {
    const chars = OSK_ROWS.slice(0, 4).map((row) => row.map((k) => oskChar(k, true)).join(''));
    expect(chars).toEqual(['1234567890', 'QWERTYUIOP', "ASDFGHJKL'", 'ZXCVBNM-_.']);
    expect(OSK_ROWS[4]).toEqual([
      { kind: 'shift', col: 0, span: 2 },
      { kind: 'space', col: 2, span: 4 },
      { kind: 'del', col: 6, span: 2 },
      { kind: 'ok', col: 8, span: 2 },
    ]);
    expect(OSK_KEYS).toHaveLength(44);
    expect([OSK_SHIFT, OSK_SPACE, OSK_DEL, OSK_OK].map((i) => OSK_KEYS[i]!.def.kind)).toEqual(['shift', 'space', 'del', 'ok']);
  });
});

describe('oskLayout', () => {
  it('480×270: keys 45×24, panel 476×136 at (2, 134)', () => {
    const l = oskLayout(480, 270, noField)!;
    expect([l.keyW, l.keyH, l.x, l.y, l.w, l.h]).toEqual([45, 24, 2, 134, 476, 136]);
    expect(l.keys).toHaveLength(44);
    // Q: row 1 col 0; SPACE: row 4 cols 2–5; OK: cols 8–9.
    expect(l.keys[10]).toEqual({ row: 1, col: 0, span: 1, x: 6, y: 134 + 4 + 26, w: 45, h: 24 });
    expect(l.keys[OSK_SPACE]).toEqual({ row: 4, col: 2, span: 4, x: 6 + 2 * 47, y: 134 + 4 + 4 * 26, w: 4 * 45 + 3 * 2, h: 24 });
    const ok = l.keys[OSK_OK]!;
    expect(ok.x + ok.w).toBe(l.x + l.w - 4);
  });

  it('320×180: keys 29×16, panel 316×96', () => {
    const l = oskLayout(320, 180, noField)!;
    expect([l.keyW, l.keyH, l.w, l.h, l.x, l.y]).toEqual([29, 16, 316, 96, 2, 84]);
  });

  it('1280×720: keys 125×48 (keyH capped), panel 1276×256', () => {
    const l = oskLayout(1280, 720, noField)!;
    expect([l.keyW, l.keyH, l.w, l.h, l.x, l.y]).toEqual([125, 48, 1276, 256, 2, 464]);
  });

  it('returns null when it does not fit', () => {
    expect(oskLayout(60, 40, noField)).toBeNull(); // keyW 3 < 8
    expect(oskLayout(400, 60, noField)).toBeNull(); // panelH 76 > 60
    expect(oskLayout(Number.NaN, 270, noField)).toBeNull();
  });

  it('docks at the top when the field reaches into the bottom panel and the top one would not cover it', () => {
    expect(oskLayout(480, 270, { x: 10, y: 200, w: 100, h: 16 })!.y).toBe(0);
    // Ends exactly at the panel's top edge: stays at the bottom.
    expect(oskLayout(480, 270, { x: 10, y: 118, w: 100, h: 16 })!.y).toBe(134);
    // Reaches into both positions (y < panelH): stays at the bottom.
    expect(oskLayout(480, 270, { x: 10, y: 100, w: 100, h: 60 })!.y).toBe(134);
    expect(oskLayout(480, 270, { x: 10, y: 136, w: 100, h: 16 })!.y).toBe(0);
  });
});

describe('oskKeyAt', () => {
  const l = oskLayout(480, 270, noField)!;
  it('finds keys, and -1 for gaps, margins and outside', () => {
    expect(oskKeyAt(l, 6, 138)).toBe(0); // "1" top-left corner
    expect(oskKeyAt(l, 50, 161)).toBe(0); // last unit of "1"
    expect(oskKeyAt(l, 51, 140)).toBe(-1); // gap between 1 and 2
    expect(oskKeyAt(l, 53, 140)).toBe(1);
    expect(oskKeyAt(l, 20, 163)).toBe(-1); // gap between rows
    expect(oskKeyAt(l, 3, 140)).toBe(-1); // margin
    expect(oskKeyAt(l, 200, 100)).toBe(-1); // above the panel
    const sp = l.keys[OSK_SPACE]!;
    expect(oskKeyAt(l, sp.x + sp.w - 1, sp.y + 1)).toBe(OSK_SPACE);
  });
});

describe('oskMove', () => {
  it('opens on Q with anchor 0', () => {
    expect(oskStartCursor()).toEqual({ row: 1, col: 0, anchor: 0 });
    expect(keyName(oskStartCursor())).toBe('Q');
  });

  it('wraps rows (0 ↔ 4) and columns within a row', () => {
    expect(oskMove({ row: 0, col: 3, anchor: 3 }, 0, -1)).toEqual({ row: 4, col: 2, anchor: 3 }); // 4 → SPACE
    expect(oskMove({ row: 4, col: 2, anchor: 3 }, 0, 1)).toEqual({ row: 0, col: 3, anchor: 3 }); // back to 4
    expect(oskMove({ row: 1, col: 9, anchor: 9 }, 1, 0)).toEqual({ row: 1, col: 0, anchor: 0 }); // P → Q
    expect(oskMove({ row: 1, col: 0, anchor: 0 }, -1, 0)).toEqual({ row: 1, col: 9, anchor: 9 }); // Q → P
    expect(oskMove({ row: 4, col: 8, anchor: 8 }, 1, 0)).toEqual({ row: 4, col: 0, anchor: 0 }); // OK → SHIFT
    expect(oskMove({ row: 4, col: 0, anchor: 0 }, -1, 0)).toEqual({ row: 4, col: 8, anchor: 8 }); // SHIFT → OK
  });

  it('a wide key counts once; up / down keep the anchor column', () => {
    const b = { row: 3, col: 4, anchor: 4 };
    const space = oskMove(b, 0, 1);
    expect(keyName(space)).toBe('SPACE');
    expect(space).toEqual({ row: 4, col: 2, anchor: 4 });
    expect(keyName(oskMove(space, 0, -1))).toBe('B');
    const del = oskMove(space, 1, 0);
    expect(keyName(del)).toBe('DEL');
    // SHIFT reached with left: anchor 0, so up → Z.
    const shift = oskMove(space, -1, 0);
    expect(shift).toEqual({ row: 4, col: 0, anchor: 0 });
    expect(keyName(oskMove(shift, 0, -1))).toBe('Z');
  });

  it('applies the vertical move before the horizontal one', () => {
    // From B (row 3, col 4): down → SPACE (row 4), then right → DEL.
    expect(keyName(oskMove({ row: 3, col: 4, anchor: 4 }, 1, 1))).toBe('DEL');
    // From Q: up → 1, then left → 0 (wraps).
    const c = oskMove(oskStartCursor(), -1, -1);
    expect(c).toEqual({ row: 0, col: 9, anchor: 9 });
  });
});

describe('oskLabel / oskChar', () => {
  const q = OSK_ROWS[1]![0]!;
  const apos = OSK_ROWS[2]![9]!;
  const one = OSK_ROWS[0]![0]!;
  const [shift, space, del, ok] = OSK_ROWS[4]!;
  it('labels in both cases', () => {
    expect([oskLabel(q, true), oskLabel(q, false)]).toEqual(['Q', 'q']);
    expect([oskLabel(apos, true), oskLabel(apos, false), oskLabel(one, false)]).toEqual(["'", "'", '1']);
    expect([oskLabel(shift!, true), oskLabel(shift!, false)]).toEqual(['abc', 'ABC']);
    expect([space, del, ok].map((k) => oskLabel(k!, true))).toEqual(['SPACE', 'DEL', 'OK']);
    expect([space, del, ok].map((k) => oskLabel(k!, false))).toEqual(['SPACE', 'DEL', 'OK']);
  });
  it('characters in both cases; null for SHIFT, DEL and OK', () => {
    expect([oskChar(q, true), oskChar(q, false), oskChar(apos, false), oskChar(space!, true)]).toEqual(['Q', 'q', "'", ' ']);
    expect([shift, del, ok].map((k) => oskChar(k!, true))).toEqual([null, null, null]);
  });
});

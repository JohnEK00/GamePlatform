import { describe, expect, it } from 'vitest';
import { applyTextEvents, caretFromX, filterText, truncateToWidth, visibleRun, type TextEvent } from '../src/uitext';

/** Monospace: 8 units per code point. */
const mono = (s: string): number => Array.from(s).length * 8;
const txt = (text: string): TextEvent => ({ kind: 'text', text });
const key = (k: Extract<TextEvent, { kind: 'key' }>['key']): TextEvent => ({ kind: 'key', key: k });

describe('filterText', () => {
  it('removes C0, DEL, C1 and lone surrogates; keeps pairs', () => {
    expect(filterText('a\u0000b\u001fc\u007fd\u0085e\u009ff')).toBe('abcdef');
    expect(filterText('x\uD83Dy\uDE00z')).toBe('xyz');
    expect(filterText('ok 😀 é')).toBe('ok 😀 é');
    expect(filterText('\n\t')).toBe('');
  });
});

describe('applyTextEvents', () => {
  const opts = { maxLength: 24 };
  it('inserts at the caret', () => {
    expect(applyTextEvents({ text: 'ac', caret: 1 }, [txt('b')], opts)).toEqual({ text: 'abc', caret: 2, allowThrew: false });
    expect(applyTextEvents({ text: '', caret: 0 }, [txt('MI'), txt('A')], opts).text).toBe('MIA');
  });
  it('maxLength cuts mid-event and drops the rest of it', () => {
    const r = applyTextEvents({ text: 'ab', caret: 2 }, [txt('cdef'), txt('g')], { maxLength: 4 });
    expect(r).toEqual({ text: 'abcd', caret: 4, allowThrew: false });
    expect(applyTextEvents({ text: 'abcd', caret: 4 }, [key('Backspace'), txt('xy')], { maxLength: 4 }).text).toBe('abcx');
  });
  it('allow rejects code points; a throw counts as false and sets allowThrew', () => {
    const digits = (c: string): boolean => /[0-9]/.test(c);
    expect(applyTextEvents({ text: '', caret: 0 }, [txt('a1b2')], { maxLength: 9, allow: digits }).text).toBe('12');
    const r = applyTextEvents({ text: '', caret: 0 }, [txt('ab')], {
      maxLength: 9,
      allow: (c) => {
        if (c === 'a') throw new Error('x');
        return true;
      },
    });
    expect(r).toEqual({ text: 'b', caret: 1, allowThrew: true });
  });
  it('Backspace / Delete at the ends are no-ops; Home / End / arrows move', () => {
    expect(applyTextEvents({ text: 'abc', caret: 0 }, [key('Backspace')], opts)).toMatchObject({ text: 'abc', caret: 0 });
    expect(applyTextEvents({ text: 'abc', caret: 3 }, [key('Delete')], opts)).toMatchObject({ text: 'abc', caret: 3 });
    expect(applyTextEvents({ text: 'abc', caret: 3 }, [key('Backspace')], opts)).toMatchObject({ text: 'ab', caret: 2 });
    expect(applyTextEvents({ text: 'abc', caret: 0 }, [key('Delete')], opts)).toMatchObject({ text: 'bc', caret: 0 });
    expect(applyTextEvents({ text: 'abc', caret: 1 }, [key('Home'), txt('>')], opts)).toMatchObject({ text: '>abc', caret: 1 });
    expect(applyTextEvents({ text: 'abc', caret: 1 }, [key('End'), txt('<')], opts)).toMatchObject({ text: 'abc<', caret: 4 });
    expect(applyTextEvents({ text: 'abc', caret: 0 }, [key('ArrowLeft'), key('ArrowRight'), key('ArrowRight')], opts).caret).toBe(2);
    expect(applyTextEvents({ text: 'abc', caret: 3 }, [key('ArrowRight')], opts).caret).toBe(3);
    expect(applyTextEvents({ text: 'abc', caret: 99 }, [], opts).caret).toBe(3);
  });
  it('an astral code point (emoji) counts as one', () => {
    const r = applyTextEvents({ text: 'a😀', caret: 2 }, [txt('😀')], { maxLength: 3 });
    expect(r).toMatchObject({ text: 'a😀😀', caret: 3 });
    expect(applyTextEvents({ text: 'a😀b', caret: 2 }, [key('Backspace')], opts)).toMatchObject({ text: 'ab', caret: 1 });
    expect(applyTextEvents(r, [txt('x')], { maxLength: 3 }).text).toBe('a😀😀');
  });
});

describe('visibleRun', () => {
  // "abcdefghij" is 80 wide; a 40-wide field shows 5 code points.
  const t = 'abcdefghij';
  it('the whole text when it fits', () => {
    expect(visibleRun('abc', 3, 0, 40, mono)).toEqual({ start: 0, end: 3 });
  });
  it('moves right by the minimum amount when the caret leaves on the right', () => {
    expect(visibleRun(t, 5, 0, 40, mono)).toEqual({ start: 0, end: 5 });
    expect(visibleRun(t, 6, 0, 40, mono)).toEqual({ start: 1, end: 6 });
    expect(visibleRun(t, 8, 1, 40, mono)).toEqual({ start: 3, end: 8 });
  });
  it('moves left by the minimum amount when the caret leaves on the left; stays while inside', () => {
    expect(visibleRun(t, 4, 3, 40, mono)).toEqual({ start: 3, end: 8 });
    expect(visibleRun(t, 2, 3, 40, mono)).toEqual({ start: 2, end: 7 });
    expect(visibleRun(t, 0, 3, 40, mono)).toEqual({ start: 0, end: 5 });
  });
  it('at the end of the text the run fills to the left', () => {
    expect(visibleRun('abcdefg', 7, 5, 40, mono)).toEqual({ start: 2, end: 7 });
  });
});

describe('caretFromX', () => {
  it('nearest boundary from the run start', () => {
    expect(caretFromX('abcdef', 0, 3, mono)).toBe(0);
    expect(caretFromX('abcdef', 0, 5, mono)).toBe(1);
    expect(caretFromX('abcdef', 0, 13, mono)).toBe(2);
    expect(caretFromX('abcdef', 2, 9, mono)).toBe(3);
    expect(caretFromX('abcdef', 0, 999, mono)).toBe(6);
    expect(caretFromX('abcdef', 2, -5, mono)).toBe(2);
  });
});

describe('truncateToWidth', () => {
  it('keeps text that fits, else the longest prefix plus "..."', () => {
    expect(truncateToWidth('abc', 24, mono)).toBe('abc');
    expect(truncateToWidth('abcdefgh', 48, mono)).toBe('abc...');
    expect(truncateToWidth('abcdefgh', 24, mono)).toBe('...');
    expect(truncateToWidth('😀😀😀😀', 31, mono)).toBe('...');
    expect(truncateToWidth('😀😀😀😀', 32, mono)).toBe('😀😀😀😀');
  });
  it('returns "" when even "..." does not fit', () => {
    expect(truncateToWidth('abcdef', 23, mono)).toBe('');
  });
});

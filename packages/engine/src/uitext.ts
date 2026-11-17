/**
 * F019 text helpers for `ui.textField` / `ui.list` (pure, no DOM). Everything works on code points
 * (`Array.from(text)`), never UTF-16 units, so surrogate pairs (emoji) stay whole. Width-dependent
 * helpers take a `measure(text) → width` function so they are testable in node.
 */

/** One entry of `engine.input.textEvents` (GAME_FORMAT § F019 "Types"). */
export type TextEvent =
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: 'Backspace' | 'Delete' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' };

/** The editing keys that become `{ kind: "key" }` text events. */
export const TEXT_EDIT_KEYS: ReadonlySet<string> = new Set(['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

/** Width of a string in game units. */
export type MeasureFn = (text: string) => number;

/**
 * Remove code points below U+0020, U+007F–U+009F and lone surrogates (GAME_FORMAT § F019
 * "Input additions"). Paired surrogates (astral code points) are kept.
 */
export function filterText(raw: string): string {
  let out = '';
  for (const ch of String(raw)) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || (c >= 0xd800 && c <= 0xdfff)) continue;
    out += ch;
  }
  return out;
}

export interface TextEditOptions {
  /** Maximum length in code points (the caller has already clamped it to 1–256). */
  maxLength: number;
  /** Called per code point; a falsy result (or a throw) rejects it. */
  allow?: (ch: string) => boolean;
}

/**
 * Apply a step's text events in order (GAME_FORMAT § F019 "Text editing"):
 * - `text`: each code point is inserted at the caret unless `allow` rejects it (a throw counts as a
 *   rejection and sets `allowThrew`) or the text already has `maxLength` code points, in which case
 *   the rest of that event is dropped;
 * - `Backspace` / `Delete` remove the code point before / after the caret (no-ops at the ends);
 * - `ArrowLeft` / `ArrowRight` move the caret by one code point; `Home` / `End` to the start / end.
 * The caret is clamped to the text first.
 */
export function applyTextEvents(
  state: { text: string; caret: number },
  events: readonly TextEvent[],
  opts: TextEditOptions,
): { text: string; caret: number; allowThrew: boolean } {
  const cps = Array.from(String(state.text));
  let caret = clampCaret(state.caret, cps.length);
  let allowThrew = false;
  const max = Math.max(0, Math.floor(opts.maxLength));
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.kind === 'text') {
      for (const ch of Array.from(filterText(ev.text))) {
        if (cps.length >= max) break; // the rest of this event is dropped
        if (opts.allow) {
          let ok: unknown = false;
          try {
            ok = opts.allow(ch);
          } catch {
            allowThrew = true;
            ok = false;
          }
          if (!ok) continue;
        }
        cps.splice(caret, 0, ch);
        caret++;
      }
    } else if (ev.kind === 'key') {
      switch (ev.key) {
        case 'Backspace':
          if (caret > 0) {
            cps.splice(caret - 1, 1);
            caret--;
          }
          break;
        case 'Delete':
          if (caret < cps.length) cps.splice(caret, 1);
          break;
        case 'ArrowLeft':
          caret = Math.max(0, caret - 1);
          break;
        case 'ArrowRight':
          caret = Math.min(cps.length, caret + 1);
          break;
        case 'Home':
          caret = 0;
          break;
        case 'End':
          caret = cps.length;
          break;
      }
    }
  }
  return { text: cps.join(''), caret, allowThrew };
}

function clampCaret(caret: number, len: number): number {
  if (!Number.isFinite(caret)) return len;
  return Math.max(0, Math.min(len, Math.floor(caret)));
}

/** Prefix widths: `p[i]` = width of the first `i` code points (so spacing between them is included). */
function prefixWidths(cps: readonly string[], measure: MeasureFn): number[] {
  const p = [0];
  let s = '';
  for (const ch of cps) {
    s += ch;
    p.push(measure(s));
  }
  return p;
}

/**
 * The window of code points `[start, end)` a text field shows: it contains the caret
 * (`start ≤ caret ≤ end`) and fits in `maxWidth`. When the caret leaves the previous window
 * (starting at `runStart`), the window moves by the minimum amount. When the whole text fits,
 * the window is the whole text. When the window reaches the end of the text it also grows to the
 * left as far as it fits, so deleting at the end never leaves an empty gap while text is hidden.
 */
export function visibleRun(text: string, caret: number, runStart: number, maxWidth: number, measure: MeasureFn): { start: number; end: number } {
  const cps = Array.from(String(text));
  const n = cps.length;
  const c = clampCaret(caret, n);
  const p = prefixWidths(cps, measure);
  const width = (s: number, e: number): number => p[e]! - p[s]!;
  if (width(0, n) <= maxWidth) return { start: 0, end: n };
  let start = Math.max(0, Math.min(n, Number.isFinite(runStart) ? Math.floor(runStart) : 0));
  if (c < start) start = c; // caret left the window on the left: shift left by the minimum
  const extend = (s: number): number => {
    let e = s;
    while (e < n && width(s, e + 1) <= maxWidth) e++;
    return e;
  };
  let end = extend(start);
  if (c > end) {
    // caret left the window on the right: the smallest start whose window still reaches the caret
    start = c;
    while (start > 0 && width(start - 1, c) <= maxWidth) start--;
    end = extend(start);
    if (end < c) end = c; // a single code point wider than maxWidth
  }
  if (end === n) while (start > 0 && width(start - 1, n) <= maxWidth) start--;
  return { start, end };
}

/** The code-point boundary (≥ `runStart`) nearest to `localX`, measured from the run's left edge. */
export function caretFromX(text: string, runStart: number, localX: number, measure: MeasureFn): number {
  const cps = Array.from(String(text));
  const n = cps.length;
  const s = Math.max(0, Math.min(n, Number.isFinite(runStart) ? Math.floor(runStart) : 0));
  if (!(localX > 0)) return s;
  const p = prefixWidths(cps, measure);
  let best = s;
  let bestD = Infinity;
  for (let i = s; i <= n; i++) {
    const d = Math.abs(p[i]! - p[s]! - localX);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
    if (p[i]! - p[s]! > localX) break; // widths only grow from here
  }
  return best;
}

/**
 * `text` if it fits in `maxWidth`, else the longest code-point prefix followed by `...` that fits;
 * `""` when even `...` does not fit.
 */
export function truncateToWidth(text: string, maxWidth: number, measure: MeasureFn): string {
  const str = String(text);
  if (measure(str) <= maxWidth) return str;
  if (measure('...') > maxWidth) return '';
  const cps = Array.from(str);
  let lo = 0; // fits
  let hi = cps.length; // the full text does not fit
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (measure(cps.slice(0, mid).join('') + '...') <= maxWidth) lo = mid;
    else hi = mid;
  }
  return cps.slice(0, lo).join('') + '...';
}

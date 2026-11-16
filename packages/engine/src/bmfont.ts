/**
 * F012 bitmap fonts: the AngelCode BMFont parser (text and JSON formats), the `BitmapFont` runtime
 * object (also built from a glyph grid) and the pure text layout shared by drawText / measureText.
 * No DOM here, so everything is testable in node.
 */
import type { Texture } from './texture';

export type BitmapGlyph = {
  /** Unicode code point, 0–0x10FFFF. */
  id: number;
  /** Top-left in the page, px, >= 0. */
  x: number;
  y: number;
  /** Size in px, 0–4096. */
  width: number;
  height: number;
  /** px from the pen position / line top to the glyph's top-left. */
  xoffset: number;
  yoffset: number;
  /** px the pen moves after this glyph. */
  xadvance: number;
  /** Index into pages. */
  page: number;
};

/** `amount` in px, added between `first` and `second`. */
export type Kerning = { first: number; second: number; amount: number };

export type BitmapFontData = {
  /** info.face, "" when absent. */
  face: string;
  /** Native size: abs(info.size); 0 or absent → lineHeight. */
  size: number;
  /** common.lineHeight, 1–4096. */
  lineHeight: number;
  /** common.base, 0–4096 (line top → baseline). */
  base: number;
  scaleW: number | null;
  scaleH: number | null;
  /** Page file names, relative to the descriptor, index = page id. */
  pages: string[];
  chars: BitmapGlyph[];
  kernings: Kerning[];
  /** Non-fatal issues (duplicate ids, distanceField, …). */
  warnings: string[];
};

export type GridFontOptions = {
  /** Cell size in px, integers >= 1. */
  cellW: number;
  cellH: number;
  /** Glyphs in cell order (left→right, top→bottom), one code point per cell. */
  chars: string;
  /** As SpriteSheet; default 0. */
  spacing?: number;
  margin?: number;
  /** Pen advance, default cellW. */
  advance?: number;
  /** Default cellH. */
  lineHeight?: number;
};

/** Font names games can't register (the engine's own overlays rely on them). */
export const RESERVED_FONT_NAMES: readonly string[] = Object.freeze(['default', 'mono', 'pixel']);

/** Throws `font name "…" is reserved` for default/mono/pixel, and for a non-string or empty name. */
export function checkFontName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name === '') throw new Error('font name must be a non-empty string');
  if (RESERVED_FONT_NAMES.includes(name)) throw new Error(`font name "${name}" is reserved`);
}

export const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
/** Longest accepted text-format line (real BMFont lines are under 200 characters). */
export const MAX_LINE_LENGTH = 4096;
const MAX_PAGES = 16;
const MAX_CHARS = 8192;
const MAX_KERNINGS = 65536;
const MAX_CP = 0x10ffff;
const PAGE_EXT = /\.(png|webp|gif|jpe?g)$/i;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

class FontError extends Error {}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A finite number (or numeric string) rounded to an integer within [min, max]. */
function num(v: unknown, field: string, min: number, max: number): number {
  if (v === undefined || v === null) throw new FontError(`${field} is required`);
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && NUMERIC.test(v.trim())) n = Number(v.trim());
  if (Number.isFinite(n)) {
    n = Math.round(n);
    if (n >= min && n <= max) return n === 0 ? 0 : n; // no -0
  }
  throw new FontError(`${field} must be a number from ${min} to ${max}`);
}

function optNum(v: unknown, field: string, min: number, max: number, def: number): number {
  return v === undefined || v === null ? def : num(v, field, min, max);
}

function isObj(v: unknown): v is Raw {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const KEY = /^[A-Za-z_][\w-]*$/;

function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0xfeff;
}
function isAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/**
 * Parse one text-format line: `tag key=value key="quoted value" …`. One left-to-right scan with no
 * backtracking (each character is visited a bounded number of times), so the cost is linear.
 * Tokens without `=` are ignored; a value starting with `"` runs to the next `"` (else to whitespace).
 */
export function parseLine(line: string): { tag: string; attrs: Record<string, string> } | null {
  const n = line.length;
  let i = 0;
  while (i < n && isSpace(line.charCodeAt(i))) i++;
  const t0 = i;
  while (i < n && isAlpha(line.charCodeAt(i))) i++;
  if (i === t0) return null;
  const after = i < n ? line.charCodeAt(i) : 32;
  if (isAlpha(after) || (after >= 48 && after <= 57) || after === 95) return null; // the tag must end at a word boundary
  const tag = line.slice(t0, i);
  const attrs: Record<string, string> = {};
  while (i < n) {
    while (i < n && isSpace(line.charCodeAt(i))) i++;
    const k0 = i;
    while (i < n && line.charCodeAt(i) !== 61 /* = */ && !isSpace(line.charCodeAt(i))) i++;
    if (i >= n || line.charCodeAt(i) !== 61) continue; // a bare word (or the end): ignored
    const key = line.slice(k0, i);
    i++;
    let value: string;
    const close = line.charCodeAt(i) === 34 /* " */ ? line.indexOf('"', i + 1) : -1;
    if (close >= 0) {
      value = line.slice(i + 1, close);
      i = close + 1;
    } else {
      const v0 = i;
      while (i < n && !isSpace(line.charCodeAt(i))) i++;
      value = line.slice(v0, i);
    }
    if (KEY.test(key)) attrs[key] = value;
  }
  return { tag, attrs };
}

/** The text format → the JSON layout (values still strings; validated afterwards). */
function textToRaw(src: string): Raw {
  let info: Raw | undefined;
  let common: Raw | undefined;
  const pageTags: Raw[] = [];
  const chars: Raw[] = [];
  const kernings: Raw[] = [];
  let distanceField: Raw | undefined;
  let lineNo = 0;
  for (const line of src.split(/\r\n|\r|\n/)) {
    lineNo++;
    if (line.length > MAX_LINE_LENGTH) throw new FontError(`line ${lineNo} is longer than ${MAX_LINE_LENGTH} characters`);
    const p = parseLine(line);
    if (!p) continue;
    switch (p.tag) {
      case 'info':
        info ??= p.attrs;
        break;
      case 'common':
        common ??= p.attrs;
        break;
      case 'page':
        pageTags.push(p.attrs);
        break;
      case 'char':
        chars.push(p.attrs);
        if (chars.length > MAX_CHARS) throw new FontError(`chars must have 1 to ${MAX_CHARS} entries`);
        break;
      case 'kerning':
        kernings.push(p.attrs);
        if (kernings.length > MAX_KERNINGS) throw new FontError(`kernings must have at most ${MAX_KERNINGS} entries`);
        break;
      case 'distanceField':
        distanceField = p.attrs;
        break;
    }
  }
  if (pageTags.length < 1 || pageTags.length > MAX_PAGES) throw new FontError(`pages must have 1 to ${MAX_PAGES} entries`);
  const pages: string[] = new Array<string>(pageTags.length);
  pageTags.forEach((t, i) => {
    const id = num(t.id, `page[${i}].id`, 0, pageTags.length - 1);
    if (pages[id] !== undefined) throw new FontError(`page ids must be 0..${pageTags.length - 1} without gaps (id ${id} is repeated)`);
    pages[id] = typeof t.file === 'string' ? t.file : '';
  });
  const out: Raw = { pages, chars, kernings };
  if (info) out.info = info;
  if (common) out.common = common;
  if (distanceField) out.distanceField = distanceField;
  return out;
}

function checkPageFile(f: unknown, i: number): string {
  if (typeof f !== 'string' || f === '' || /^[a-z][a-z0-9+.-]*:/i.test(f) || /^[\\/]/.test(f) || !PAGE_EXT.test(f.split(/[?#]/)[0]!))
    throw new FontError(`pages[${i}] must be a relative png, webp, gif or jpg path (got ${JSON.stringify(f)})`);
  return f;
}

/** Validate the JSON layout (shared by both formats) into BitmapFontData. */
function rawToData(raw: Raw): BitmapFontData {
  const warnings: string[] = [];
  const info = isObj(raw.info) ? raw.info : {};
  if (!isObj(raw.common)) throw new FontError('common is missing');
  const c = raw.common;
  if (c.lineHeight === undefined) throw new FontError('common.lineHeight is required');
  if (c.base === undefined) throw new FontError('common.base is required');
  const lineHeight = num(c.lineHeight, 'common.lineHeight', 1, 4096);
  const base = num(c.base, 'common.base', 0, 4096);
  const scaleW = c.scaleW === undefined ? null : num(c.scaleW, 'common.scaleW', 1, 8192);
  const scaleH = c.scaleH === undefined ? null : num(c.scaleH, 'common.scaleH', 1, 8192);
  const packed = optNum(c.packed, 'common.packed', -32768, 32767, 0);
  if (packed !== 0) throw new FontError('channel-packed fonts are not supported');
  const rawSize = optNum(info.size, 'info.size', -32768, 32767, 0);
  const size = Math.abs(rawSize) || lineHeight;
  const face = typeof info.face === 'string' ? info.face : '';

  if (!Array.isArray(raw.pages)) throw new FontError('pages must be an array of file names');
  if (raw.pages.length < 1 || raw.pages.length > MAX_PAGES) throw new FontError(`pages must have 1 to ${MAX_PAGES} entries`);
  const pages = raw.pages.map((f, i) => checkPageFile(f, i));

  if (!Array.isArray(raw.chars) || raw.chars.length < 1 || raw.chars.length > MAX_CHARS)
    throw new FontError(`chars must have 1 to ${MAX_CHARS} entries`);
  const chars: BitmapGlyph[] = [];
  const seen = new Set<number>();
  raw.chars.forEach((ch: unknown, i) => {
    const at = `char[${i}]`;
    if (!isObj(ch)) throw new FontError(`${at} must be an object`);
    const g: BitmapGlyph = {
      id: num(ch.id, `${at}.id`, 0, MAX_CP),
      x: num(ch.x, `${at}.x`, 0, 32767),
      y: num(ch.y, `${at}.y`, 0, 32767),
      width: num(ch.width, `${at}.width`, 0, 4096),
      height: num(ch.height, `${at}.height`, 0, 4096),
      xoffset: optNum(ch.xoffset, `${at}.xoffset`, -32768, 32767, 0),
      yoffset: optNum(ch.yoffset, `${at}.yoffset`, -32768, 32767, 0),
      xadvance: num(ch.xadvance, `${at}.xadvance`, -32768, 32767),
      page: optNum(ch.page, `${at}.page`, 0, pages.length - 1, 0),
    };
    if (seen.has(g.id)) {
      warnings.push(`${at}: duplicate char id ${g.id}; the first one is kept`);
      return;
    }
    seen.add(g.id);
    chars.push(g);
  });

  const rk = raw.kernings ?? [];
  if (!Array.isArray(rk)) throw new FontError('kernings must be an array');
  if (rk.length > MAX_KERNINGS) throw new FontError(`kernings must have at most ${MAX_KERNINGS} entries`);
  const kernings: Kerning[] = rk.map((k: unknown, i) => {
    const at = `kerning[${i}]`;
    if (!isObj(k)) throw new FontError(`${at} must be an object`);
    return {
      first: num(k.first, `${at}.first`, 0, MAX_CP),
      second: num(k.second, `${at}.second`, 0, MAX_CP),
      amount: num(k.amount, `${at}.amount`, -32768, 32767),
    };
  });
  if (raw.distanceField !== undefined && raw.distanceField !== null)
    warnings.push('distance-field fonts are not supported; the font is drawn as a plain bitmap');
  return { face, size, lineHeight, base, scaleW, scaleH, pages, chars, kernings, warnings };
}

/** UTF-8 byte length of a string (lone surrogates count as U+FFFD); stops counting past `limit`. */
export function utf8Length(s: string, limit = Infinity): number {
  let bytes = 0;
  for (let i = 0; i < s.length && bytes <= limit; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** The binary BMFont format starts with the bytes "BMF" and a format version byte (3). */
export function isBinaryBMFont(s: string): boolean {
  return s.startsWith('BMF') && s.length >= 4 && s.charCodeAt(3) < 32;
}

/**
 * Parse an AngelCode BMFont descriptor: the text format (`.fnt`) or the JSON format (a string starting
 * with `{`, or an already parsed object). XML is rejected. Errors start with `BMFont "{path}": `.
 */
export function parseBMFont(source: string | object, path = 'font'): BitmapFontData {
  const prefix = `BMFont "${path}": `;
  try {
    let raw: Raw;
    if (typeof source === 'string') {
      // ≤ 1 MiB of UTF-8. Every UTF-16 unit is at least 1 byte and at most 3, so only the middle range is counted.
      if (source.length > MAX_DESCRIPTOR_BYTES || (source.length * 3 > MAX_DESCRIPTOR_BYTES && utf8Length(source, MAX_DESCRIPTOR_BYTES) > MAX_DESCRIPTOR_BYTES))
        throw new FontError('the descriptor is larger than 1 MiB');
      if (isBinaryBMFont(source)) throw new FontError('binary BMFont is not supported; export the text or JSON format');
      const s = source.replace(/^﻿/, '').trimStart();
      if (s.startsWith('<')) throw new FontError('BMFont XML is not supported; export the text or JSON format');
      if (s.startsWith('{')) {
        let j: unknown;
        try {
          j = JSON.parse(s);
        } catch (e) {
          throw new FontError(`invalid JSON: ${(e as Error).message}`);
        }
        if (!isObj(j)) throw new FontError('the JSON descriptor must be an object');
        raw = j;
      } else raw = textToRaw(s);
    } else if (isObj(source)) raw = source;
    else throw new FontError('the descriptor must be a string or an object');
    return rawToData(raw);
  } catch (e) {
    if (e instanceof FontError) throw new Error(prefix + e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// BitmapFont
// ---------------------------------------------------------------------------

/** A rectangular region of a GPU page (a `Texture`, or anything shaped like one in tests). */
export interface PageRegion {
  readonly width: number;
  readonly height: number;
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/** What layoutText needs from a font. */
export interface FontMetricsSource {
  readonly size: number;
  readonly lineHeight: number;
  /** Smooth fonts are not snapped to whole units. */
  readonly smooth: boolean;
  readonly pages: readonly PageRegion[];
  /** Advance (native px) of a space the font lacks; default size / 2. */
  readonly spaceAdvance?: number | null;
  glyph(codePoint: number): BitmapGlyph | undefined;
  kerning(first: number, second: number): number;
}

/** A registered bitmap font (BMFont, grid font or the built-in `pixel`). Read-only. */
export class BitmapFont implements FontMetricsSource {
  readonly name: string;
  readonly face: string;
  readonly size: number;
  readonly lineHeight: number;
  readonly base: number;
  readonly pages: readonly Texture[];
  readonly smooth: boolean;
  /** Non-fatal issues found while building the font (parser warnings + dropped glyphs). */
  readonly warnings: readonly string[];
  /** Advance of a missing space in native px (grid fonts: their advance), else null (= size / 2). */
  readonly spaceAdvance: number | null;
  /** @internal set once the "missing glyph" warning was printed. */
  missingWarned = false;
  private readonly glyphs = new Map<number, BitmapGlyph>();
  private readonly kerns = new Map<number, number>();

  constructor(name: string, data: BitmapFontData, pages: readonly Texture[], smooth = false, spaceAdvance: number | null = null) {
    this.name = name;
    this.face = data.face;
    this.size = data.size;
    this.lineHeight = data.lineHeight;
    this.base = data.base;
    this.pages = Object.freeze([...pages]);
    this.smooth = smooth;
    this.spaceAdvance = spaceAdvance;
    const warnings = [...data.warnings];
    let dropped = 0;
    for (const g of data.chars) {
      const p = pages[g.page];
      if (!p || g.x + g.width > p.width || g.y + g.height > p.height) {
        dropped++;
        continue;
      }
      if (!this.glyphs.has(g.id)) this.glyphs.set(g.id, { ...g });
    }
    if (dropped) warnings.push(`${dropped} glyph(s) lie outside their page image and were dropped`);
    for (const k of data.kernings) this.kerns.set(k.first * 0x110000 + k.second, k.amount);
    this.warnings = Object.freeze(warnings);
  }

  glyph(codePoint: number): BitmapGlyph | undefined {
    return this.glyphs.get(codePoint);
  }
  kerning(first: number, second: number): number {
    return this.kerns.get(first * 0x110000 + second) ?? 0;
  }
  /** The font has a glyph for the first code point of `char`. */
  has(char: string): boolean {
    const cp = String(char).codePointAt(0);
    return cp !== undefined && this.glyphs.has(cp);
  }
  /** Number of glyphs. */
  get glyphCount(): number {
    return this.glyphs.size;
  }

  /** A monospace font cut from a grid of cells (row-major, like SpriteSheet). Throws on bad options. */
  static grid(name: string, texture: Texture, opts: GridFontOptions): BitmapFont {
    const err = (m: string): Error => new Error(`gridFont "${name}": ${m}`);
    const o = opts ?? ({} as GridFontOptions);
    const int = (v: unknown, f: string, min: number, def?: number): number => {
      if (v === undefined && def !== undefined) return def;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw err(`${f} must be an integer >= ${min}`);
      return v;
    };
    const cellW = int(o.cellW, 'cellW', 1);
    const cellH = int(o.cellH, 'cellH', 1);
    const spacing = int(o.spacing, 'spacing', 0, 0);
    const margin = int(o.margin, 'margin', 0, 0);
    const advance = o.advance === undefined ? cellW : o.advance;
    if (typeof advance !== 'number' || !Number.isFinite(advance)) throw err('advance must be a number');
    const lineHeight = int(o.lineHeight, 'lineHeight', 1, cellH);
    if (typeof o.chars !== 'string') throw err('chars must be a string');
    const cps = Array.from(o.chars, (c) => c.codePointAt(0)!);
    const cols = Math.max(0, Math.floor((texture.width - margin * 2 + spacing) / (cellW + spacing)));
    const rows = Math.max(0, Math.floor((texture.height - margin * 2 + spacing) / (cellH + spacing)));
    if (cps.length > cols * rows) throw err(`chars has ${cps.length} code points but the texture has only ${cols * rows} cells`);
    const seen = new Set<number>();
    const chars: BitmapGlyph[] = cps.map((id, i) => {
      if (seen.has(id)) throw err(`chars repeats ${JSON.stringify(String.fromCodePoint(id))}`);
      seen.add(id);
      const c = i % cols;
      const r = Math.floor(i / cols);
      return {
        id, x: margin + c * (cellW + spacing), y: margin + r * (cellH + spacing), width: cellW, height: cellH,
        xoffset: 0, yoffset: 0, xadvance: advance, page: 0,
      };
    });
    const data: BitmapFontData = {
      face: name, size: cellH, lineHeight, base: cellH, scaleW: texture.width, scaleH: texture.height,
      pages: [''], chars, kernings: [], warnings: [],
    };
    return new BitmapFont(name, data, [texture], false, advance);
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LayoutOptions {
  /** Draw size (default: the font's native size). */
  size?: number;
  letterSpacing?: number;
  /** Line height multiplier (default 1). */
  lineHeight?: number;
  align?: 'left' | 'center' | 'right';
  baseline?: 'top' | 'middle' | 'bottom';
  maxWidth?: number;
  /** Anchor (default 0, 0). */
  x?: number;
  y?: number;
}

export interface LaidGlyph {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface TextLayout {
  lines: { glyphs: LaidGlyph[]; width: number }[];
  /** Widest line. */
  width: number;
  /** Block height. */
  height: number;
  /** Code points the font lacks (excluding space), in first-seen order. */
  missing: number[];
}

const QMARK = 63;
const SPACE = 32;

function isControl(cp: number): boolean {
  return cp < 32 || (cp >= 0x7f && cp <= 0x9f);
}

/** Text → lines of code points (`\n` and `\r\n` break; other control characters are dropped). */
function splitParagraphs(text: string): number[][] {
  const out: number[][] = [[]];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 10) out.push([]);
    else if (!isControl(cp)) out[out.length - 1]!.push(cp);
  }
  return out;
}

/**
 * Lay out text in a bitmap font (GAME_FORMAT § F012 "drawText / measureText with a bitmap font"):
 * kerning, letter spacing, wrapping, alignment, baseline, snapping and the missing-glyph fallback.
 */
export function layoutText(font: FontMetricsSource, text: string, o: LayoutOptions = {}): TextLayout {
  const size = o.size ?? font.size;
  const s = size / font.size;
  const sp = o.letterSpacing ?? 0;
  const missing = new Set<number>();
  const q = font.glyph(QMARK);
  const resolve = (cp: number): { g: BitmapGlyph | undefined; adv: number } => {
    const g = font.glyph(cp);
    if (g) return { g, adv: g.xadvance * s };
    if (cp === SPACE) return { g: undefined, adv: (font.spaceAdvance ?? font.size / 2) * s };
    missing.add(cp);
    if (q) return { g: q, adv: q.xadvance * s };
    return { g: undefined, adv: size / 2 };
  };
  const widthOf = (cps: readonly number[]): number => {
    let w = 0;
    for (let i = 0; i < cps.length; i++) {
      if (i > 0) w += font.kerning(cps[i - 1]!, cps[i]!) * s;
      w += resolve(cps[i]!).adv + sp;
    }
    return cps.length ? w - sp : 0;
  };

  /** Running sum `widthOf` keeps before subtracting the last `sp`: append `cps[from..to)` after `prev`. */
  const extend = (acc: number, prev: number, cps: readonly number[], from: number, to: number): number => {
    for (let i = from; i < to; i++) {
      const cp = cps[i]!;
      if (prev >= 0) acc += font.kerning(prev, cp) * s;
      acc += resolve(cp).adv + sp;
      prev = cp;
    }
    return acc;
  };

  let lines = splitParagraphs(String(text));
  const maxW = o.maxWidth;
  if (maxW !== undefined && maxW > 0) {
    // Greedy wrap at spaces with a running width: each word is measured once as a candidate (and
    // once more if it starts a new line), so a paragraph costs O(length) instead of O(words × line).
    const wrapped: number[][] = [];
    const one = [SPACE];
    for (const para of lines) {
      let cur: number[] = [];
      let acc = 0; // widthOf(cur) + sp (0 when empty)
      let started = false;
      let w0 = 0;
      for (let j = 0; j <= para.length; j++) {
        if (j < para.length && para[j] !== SPACE) continue;
        // the word is para[w0..j)
        if (!started) {
          for (let k = w0; k < j; k++) cur.push(para[k]!);
          acc = extend(0, -1, para, w0, j);
          started = true;
        } else {
          const last = cur.length ? cur[cur.length - 1]! : -1;
          const withSpace = extend(acc, last, one, 0, 1);
          const cand = extend(withSpace, SPACE, para, w0, j);
          if (cur.length && cand - sp > maxW) {
            wrapped.push(cur);
            cur = [];
            for (let k = w0; k < j; k++) cur.push(para[k]!);
            acc = extend(0, -1, para, w0, j);
          } else {
            cur.push(SPACE);
            for (let k = w0; k < j; k++) cur.push(para[k]!);
            acc = cand;
          }
        }
        w0 = j + 1;
      }
      wrapped.push(cur);
    }
    lines = wrapped;
  }

  const lh = font.lineHeight * s * (o.lineHeight ?? 1);
  const height = (lines.length - 1) * lh + font.lineHeight * s;
  const x = o.x ?? 0;
  const y = o.y ?? 0;
  let top = y;
  if (o.baseline === 'middle') top = y - height / 2;
  else if (o.baseline === 'bottom') top = y - height;
  const snap = !font.smooth;
  const align = o.align ?? 'left';
  let width = 0;
  const out: TextLayout['lines'] = [];
  for (let li = 0; li < lines.length; li++) {
    const cps = lines[li]!;
    const lw = widthOf(cps);
    width = Math.max(width, lw);
    let lineTop = top + li * lh;
    let pen = align === 'center' ? x - lw / 2 : align === 'right' ? x - lw : x;
    if (snap) {
      lineTop = Math.round(lineTop);
      pen = Math.round(pen);
    }
    const glyphs: LaidGlyph[] = [];
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i]!;
      if (i > 0) pen += font.kerning(cps[i - 1]!, cp) * s;
      const { g, adv } = resolve(cp);
      if (g && g.width > 0 && g.height > 0) {
        const p = font.pages[g.page];
        let u0 = 0, v0 = 0, u1 = 0, v1 = 0;
        if (p) {
          const du = (p.u1 - p.u0) / p.width;
          const dv = (p.v1 - p.v0) / p.height;
          u0 = p.u0 + g.x * du;
          v0 = p.v0 + g.y * dv;
          u1 = p.u0 + (g.x + g.width) * du;
          v1 = p.v0 + (g.y + g.height) * dv;
        }
        glyphs.push({ page: g.page, x: pen + g.xoffset * s, y: lineTop + g.yoffset * s, w: g.width * s, h: g.height * s, u0, v0, u1, v1 });
      }
      pen += adv + sp;
    }
    out.push({ glyphs, width: lw });
  }
  return { lines: out, width, height, missing: [...missing] };
}

/**
 * A small LRU of text layouts keyed by (font, text, options), for HUD strings drawn every frame.
 * Layouts are shared: callers must treat them as read-only. Long texts are not cached.
 */
export class LayoutCache {
  private readonly map = new Map<string, { font: FontMetricsSource; lay: TextLayout }>();
  private readonly ids = new WeakMap<FontMetricsSource, number>();
  private nextId = 1;

  readonly capacity: number;
  /** Texts longer than this (UTF-16 units) are laid out without caching. */
  readonly maxText: number;

  constructor(capacity = 64, maxText = 512) {
    this.capacity = capacity;
    this.maxText = maxText;
  }

  get size(): number {
    return this.map.size;
  }

  get(font: FontMetricsSource, text: string, o: LayoutOptions = {}): TextLayout {
    if (text.length > this.maxText || this.capacity <= 0) return layoutText(font, text, o);
    let id = this.ids.get(font);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(font, id);
    }
    const key = `${id}|${o.size}|${o.letterSpacing}|${o.lineHeight}|${o.align}|${o.baseline}|${o.maxWidth}|${o.x}|${o.y}|${text}`;
    const hit = this.map.get(key);
    if (hit && hit.font === font) {
      this.map.delete(key); // refresh LRU position
      this.map.set(key, hit);
      return hit.lay;
    }
    const lay = layoutText(font, text, o);
    this.map.set(key, { font, lay });
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value!);
    return lay;
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * The built-in `pixel` font: ASCII 32–126 as hand-authored 5×9 glyphs (capitals on rows 0–6,
 * descenders on rows 7–8). Metrics: size 8, lineHeight 10, base 7, every glyph advances 6 px.
 *
 * The glyph art was drawn by hand for Pixelforge and is dedicated to the public domain (CC0).
 *
 * Table format: one string per glyph, one character per row (top first), each a base-32 digit
 * (`0-9a-v`) whose 5 bits are the columns, most significant bit = leftmost column. Trailing empty
 * rows are omitted.
 */
import { BitmapFont, type BitmapFontData, type BitmapGlyph } from './bmfont';
import type { Texture } from './texture';

// prettier-ignore
export const PIXEL_GLYPHS: readonly string[] = Object.freeze([
  '', '4444404', 'aa', 'aavavaa', '4fke5u4', 'op248j3', 'cik8lid', '448', //   ! " # $ % & '
  '2488842', '8422248', '04lel4', '044v44', '00000c48', '000v', '00000cc', '01248g', // ( ) * + , - . /
  'ehjlphe', '4c4444e', 'eh1248v', 'v2421he', '26aiv22', 'vgu11he', '68guhhe', 'v124888', // 0 1 2 3 4 5 6 7
  'ehhehhe', 'ehhf12c', '0cc0cc', '0cc0c48', '248g842', '00v0v', '8421248', 'eh12404', // 8 9 : ; < = > ?
  'eh1dlle', 'ehhvhhh', 'uhhuhhu', 'ehggghe', 'sihhhis', 'vgguggv', 'vgguggg', 'ehgnhhf', // @ A B C D E F G
  'hhhvhhh', 'e44444e', '72222ic', 'hikokih', 'ggggggv', 'hrllhhh', 'hhpljhh', 'ehhhhhe', // H I J K L M N O
  'uhhuggg', 'ehhhlid', 'uhhukih', 'fgge11u', 'v444444', 'hhhhhhe', 'hhhhha4', 'hhhllla', // P Q R S T U V W
  'hha4ahh', 'hha4444', 'v1248gv', 'e88888e', '0g8421', 'e22222e', '4ah', '0000000v', // X Y Z [ \ ] ^ _
  '842', '00e1fhf', 'ggmphhu', '00egghe', '11djhhf', '00ehvge', '698s888', '00fhhhf1e', // ` a b c d e f g
  'ggmphhh', '40c444e', '2062222ic', 'ggikoki', 'c44444e', '00qllll', '00mphhh', '00ehhhe', // h i j k l m n o
  '00uhhhugg', '00fhhhf11', '00mpggg', '00fge1u', '88s8896', '00hhhjd', '00hhha4', '00hhlla', // p q r s t u v w
  '00ha4ah', '00hhhhf1e', '00v248v', '3448443', '44444444', 'o44244o', '008l2', // x y z { | } ~
]);

export const PIXEL_FONT_SIZE = 8;
export const PIXEL_LINE_HEIGHT = 10;
export const PIXEL_BASE = 7;
export const PIXEL_ADVANCE = 6;
const COLS = 16;
const CELL_W = 6; // 5 px glyph + 1 px gap
const CELL_H = 10; // 9 px glyph + 1 px gap

/** Decode a glyph to 9 rows of 5-bit masks. */
export function pixelGlyphRows(i: number): number[] {
  const s = PIXEL_GLYPHS[i] ?? '';
  const rows: number[] = [];
  for (let r = 0; r < 9; r++) rows.push(r < s.length ? parseInt(s[r]!, 32) : 0);
  return rows;
}

/** The glyph metrics of the `pixel` font (pure; page 0 is the image from pixelFontImage). */
export function pixelFontData(): BitmapFontData {
  const chars: BitmapGlyph[] = [];
  for (let i = 0; i < PIXEL_GLYPHS.length; i++) {
    const rows = pixelGlyphRows(i);
    let minC = 5, maxC = -1, minR = 9, maxR = -1;
    rows.forEach((bits, r) => {
      for (let c = 0; c < 5; c++)
        if (bits & (16 >> c)) {
          minC = Math.min(minC, c);
          maxC = Math.max(maxC, c);
          minR = Math.min(minR, r);
          maxR = Math.max(maxR, r);
        }
    });
    const cx = (i % COLS) * CELL_W;
    const cy = Math.floor(i / COLS) * CELL_H;
    const empty = maxC < 0;
    chars.push({
      id: 32 + i,
      x: empty ? cx : cx + minC,
      y: empty ? cy : cy + minR,
      width: empty ? 0 : maxC - minC + 1,
      height: empty ? 0 : maxR - minR + 1,
      xoffset: empty ? 0 : minC,
      yoffset: empty ? 0 : minR,
      xadvance: PIXEL_ADVANCE,
      page: 0,
    });
  }
  return {
    face: 'Pixelforge Pixel', size: PIXEL_FONT_SIZE, lineHeight: PIXEL_LINE_HEIGHT, base: PIXEL_BASE,
    scaleW: COLS * CELL_W, scaleH: Math.ceil(PIXEL_GLYPHS.length / COLS) * CELL_H,
    pages: ['pixel'], chars, kernings: [], warnings: [],
  };
}

/** The RGBA page image of the `pixel` font: white glyphs on transparent (pure). */
export function pixelFontImage(): { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> } {
  const width = COLS * CELL_W;
  const height = Math.ceil(PIXEL_GLYPHS.length / COLS) * CELL_H;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < PIXEL_GLYPHS.length; i++) {
    const rows = pixelGlyphRows(i);
    const cx = (i % COLS) * CELL_W;
    const cy = Math.floor(i / COLS) * CELL_H;
    rows.forEach((bits, r) => {
      for (let c = 0; c < 5; c++)
        if (bits & (16 >> c)) data.fill(255, ((cy + r) * width + cx + c) * 4, ((cy + r) * width + cx + c) * 4 + 4);
    });
  }
  return { width, height, data };
}

/** Build the `pixel` BitmapFont; `upload` turns the RGBA image into a (nearest, atlas) Texture. */
export function createPixelFont(upload: (img: { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }) => Texture): BitmapFont {
  return new BitmapFont('pixel', pixelFontData(), [upload(pixelFontImage())], false);
}

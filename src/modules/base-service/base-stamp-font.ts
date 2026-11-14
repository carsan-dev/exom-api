import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as fontkit from '@cantoo/fontkit';
import type { Font, FontCollection } from '@cantoo/fontkit';

/**
 * Stamp typeface: DM Sans Regular 4.004 (Google Fonts, SIL Open Font License
 * 1.1), the same `Body.ttf` used by exom-base-pdfs/entrega.py. It is copied to
 * `dist` by the `assets` entry in nest-cli.json.
 */
export const STAMP_FONT_FILE = join(__dirname, 'assets', 'Body.ttf');

let fontBytes: Buffer | undefined;
let font: Font | undefined;

export function loadStampFontBytes(): Buffer {
  fontBytes ??= readFileSync(STAMP_FONT_FILE);
  return fontBytes;
}

function loadStampFont(): Font {
  if (!font) {
    const parsed: Font | FontCollection = fontkit.create(loadStampFontBytes());
    if ('fonts' in parsed) {
      throw new Error(`Stamp font ${STAMP_FONT_FILE} is a font collection`);
    }
    font = parsed;
  }
  return font;
}

/**
 * Advance width of `text` at 1 pt in the stamp font, computed exactly as
 * pdf-lib's custom-font embedder does (`widthOfTextAtSize`: default layout,
 * sum of glyph advances, no kerning), so it matches what `stampPdf` measures.
 */
export function stampTextWidthAt1pt(text: string): number {
  const stampFont = loadStampFont();
  let units = 0;
  for (const glyph of stampFont.layout(text).glyphs)
    units += glyph.advanceWidth;
  return units / stampFont.unitsPerEm;
}

/** Characters of `text` (deduplicated, by code point) the stamp font cannot draw. */
export function charactersWithoutGlyph(text: string): string[] {
  const stampFont = loadStampFont();
  const missing = new Set<number>();
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && !stampFont.hasGlyphForCodePoint(codePoint)) {
      missing.add(codePoint);
    }
  }
  return [...missing]
    .sort((a, b) => a - b)
    .map((cp) => String.fromCodePoint(cp));
}

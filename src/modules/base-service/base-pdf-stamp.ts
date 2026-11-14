import * as fontkit from '@cantoo/fontkit';
import {
  PDFDocument,
  PDFFont,
  PDFName,
  PDFOperator,
  beginText,
  concatTransformationMatrix,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  showText,
} from '@cantoo/pdf-lib';
import { BaseServiceError } from './base-service.error';
import { loadStampFontBytes } from './base-stamp-font';

/**
 * Personal-license stamp, ported from exom-base-pdfs/entrega.py (`stamp_pdf`):
 * one line of text per page, rotated 90°, along the visible right margin and
 * vertically centred, computed from each page's own MediaBox and /Rotate.
 */

/**
 * 7.5 pt (was 6.5 pt, as in the reference): at 6.5 pt, gray 0.74 and opacity
 * 0.6 the line was painted but blended into the dark pages (effective gray
 * ~0.47 on a ~0.07 background) and was reported as invisible at 100 % zoom.
 */
export const STAMP_FONT_SIZE = 7.5;
export const STAMP_MIN_FONT_SIZE = 4;
/**
 * Distance from the visible right page edge to the text centre line, in pt.
 * On the delivered A4 pages the rightmost content ends ~36 pt from the edge
 * (measured 2026-11-14), so the 7.5 pt line still clears it by ~19 pt.
 */
export const STAMP_EDGE_OFFSET = 14;
/** The line never exceeds this fraction of the visible page height. */
export const STAMP_MAX_LENGTH_RATIO = 0.7;
/**
 * Light gray at 0.9 fill opacity: legible on the dark EXOM pages while staying
 * a discreet margin note. The reference samples each page background and
 * switches to dark gray on light pages; every EXOM page is dark, so that
 * sampling (which needs a renderer) is deliberately not ported.
 */
export const STAMP_GRAY = 0.82;
export const STAMP_OPACITY = 0.9;

/**
 * Smallest visible page height, in pt, among the page formats the product
 * delivers. Assumption (checked 2026-11-14 on the 91 PDFs of
 * exom-base-pdfs/entrega-cliente-final, 1296 pages): every page is A4 portrait
 * 595.28 × 841.89 pt without /Rotate. If a smaller or landscape format is
 * added, lower this value; `stampPdf` still refuses any page the line does not
 * fit, so a wrong value can only fail a send, never print a clipped line.
 */
export const STAMP_PRODUCT_PAGE_HEIGHT = 841.89;

/** Longest line, in pt, allowed on a page of this visible height. */
export function stampLengthLimit(visibleHeight: number): number {
  return visibleHeight * STAMP_MAX_LENGTH_RATIO;
}

/** Whether a line fits the 70 % limit at the 4 pt minimum font size. */
export function stampFitsAtMinimumSize(
  textWidthAt1pt: number,
  visibleHeight: number,
): boolean {
  return (
    textWidthAt1pt * STAMP_MIN_FONT_SIZE <= stampLengthLimit(visibleHeight)
  );
}

function visibleHeightOf(mediaBox: StampBox, rotation: number): number {
  const rot = normalizeRotation(rotation);
  return rot === 90 || rot === 270 ? mediaBox.width : mediaBox.height;
}

export function buildStampText(
  name: string,
  email: string,
  orderCode: string,
): string {
  return `Licencia personal · ${name} · ${email} · Pedido ${orderCode}`;
}

export function buildStampSubject(
  name: string,
  email: string,
  orderCode: string,
): string {
  return `Licencia personal de ${name} (${email}) · Pedido ${orderCode}`;
}

export function buildStampKeywords(orderCode: string): string {
  return `EXOM;${orderCode}`;
}

export interface StampOptions {
  text: string;
  subject?: string;
  keywords?: string;
}

export interface StampBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StampPlacement {
  /** Font size actually used, in pt. */
  size: number;
  /**
   * Affine matrix [a b c d e f] mapping text space (baseline origin at the
   * horizontal centre of the line, text running along +x) to page space.
   */
  matrix: [number, number, number, number, number, number];
}

type Matrix = [number, number, number, number, number, number];

/** Returns m1 × m2 in PDF order: apply m1 first, then m2. */
function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

function normalizeRotation(rotation: number): number {
  return ((Math.round(rotation) % 360) + 360) % 360;
}

/**
 * Same geometry as the reference `_overlay_page`. `textWidthAt1pt` is the
 * advance width of the text at 1 pt.
 */
export function computeStampPlacement(
  mediaBox: StampBox,
  rotation: number,
  textWidthAt1pt: number,
): StampPlacement {
  const { x: left, y: bottom, width: w, height: h } = mediaBox;
  const rot = normalizeRotation(rotation);
  const [visW, visH] = rot === 90 || rot === 270 ? [h, w] : [w, h];

  let size = STAMP_FONT_SIZE;
  const maxLength = stampLengthLimit(visH);
  const width = textWidthAt1pt * size;
  if (width > maxLength) {
    size = Math.max(STAMP_MIN_FONT_SIZE, (size * maxLength) / width);
  }

  // Map visual (rotated) coordinates back to the unrotated page space.
  const toPage: Matrix =
    rot === 90
      ? [0, 1, -1, 0, w, 0]
      : rot === 180
        ? [-1, 0, 0, -1, w, h]
        : rot === 270
          ? [0, -1, 1, 0, 0, h]
          : [1, 0, 0, 1, 0, 0];
  // Outer (right) side margin, rotated 90 degrees, vertically centred.
  const local: Matrix = multiply(
    [0, 1, -1, 0, 0, 0],
    [1, 0, 0, 1, visW - STAMP_EDGE_OFFSET + size * 0.35, visH / 2],
  );
  const matrix = multiply(multiply(local, toPage), [1, 0, 0, 1, left, bottom]);
  return { size, matrix };
}

function stampOperators(
  font: PDFFont,
  fontKey: PDFName,
  graphicsStateKey: PDFName,
  text: string,
  placement: StampPlacement,
): PDFOperator[] {
  const { size, matrix } = placement;
  const width = font.widthOfTextAtSize(text, size);
  return [
    pushGraphicsState(),
    setGraphicsState(graphicsStateKey),
    setFillingRgbColor(STAMP_GRAY, STAMP_GRAY, STAMP_GRAY),
    concatTransformationMatrix(...matrix),
    beginText(),
    setFontAndSize(fontKey, size),
    // Text matrix: centre the line on the placement origin.
    moveText(-width / 2, 0),
    showText(font.encodeText(text)),
    endText(),
    popGraphicsState(),
  ];
}

/**
 * Returns a stamped copy of `source`; the input bytes are not modified.
 * Title/Author and the rest of the Info dictionary are kept (no producer or
 * date rewrite); Subject and Keywords are set when given. Page tree, link
 * annotations and outlines are carried over untouched: only one content
 * stream and resource entries are appended per page.
 *
 * Throws `BaseServiceError('STAMP_TOO_LONG')` when the line does not fit some
 * page at the minimum font size: a clipped license line is never produced.
 */
export async function stampPdf(
  source: Uint8Array,
  options: StampOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(source, { updateMetadata: false });
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(loadStampFontBytes(), { subset: true });
  const textWidthAt1pt = font.widthOfTextAtSize(options.text, 1);
  const pages = doc.getPages();
  for (const page of pages) {
    const visibleHeight = visibleHeightOf(
      page.getMediaBox(),
      page.getRotation().angle,
    );
    if (!stampFitsAtMinimumSize(textWidthAt1pt, visibleHeight))
      throw new BaseServiceError(
        'STAMP_TOO_LONG',
        `La línea de licencia mide ${(textWidthAt1pt * STAMP_MIN_FONT_SIZE).toFixed(1)} pt con la letra mínima y la página solo admite ${stampLengthLimit(visibleHeight).toFixed(1)} pt.`,
      );
  }
  const graphicsState = doc.context.register(
    doc.context.obj({ Type: 'ExtGState', ca: STAMP_OPACITY }),
  );

  for (const page of pages) {
    const placement = computeStampPlacement(
      page.getMediaBox(),
      page.getRotation().angle,
      textWidthAt1pt,
    );
    // Registering resources normalizes the page, which wraps its existing
    // content in q/Q (pdf-lib's autoNormalizeCTM), so the stamp is drawn in
    // the default CTM with no clip left over by the page; covered by a spec.
    const fontKey = page.node.newFontDictionary('ExomStamp', font.ref);
    const graphicsStateKey = page.node.newExtGState(
      'ExomStampGS',
      graphicsState,
    );
    page.pushOperators(
      ...stampOperators(
        font,
        fontKey,
        graphicsStateKey,
        options.text,
        placement,
      ),
    );
  }

  if (options.subject) doc.setSubject(options.subject);
  if (options.keywords) doc.setKeywords([options.keywords]);
  return doc.save();
}

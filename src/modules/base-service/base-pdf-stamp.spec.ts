import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
  decodePDFRawStream,
  degrees,
} from '@cantoo/pdf-lib';
import {
  STAMP_EDGE_OFFSET,
  STAMP_FONT_SIZE,
  STAMP_MAX_LENGTH_RATIO,
  STAMP_MIN_FONT_SIZE,
  buildStampSubject,
  buildStampText,
  computeStampPlacement,
  stampPdf,
} from './base-pdf-stamp';
import * as fontkit from '@cantoo/fontkit';
import { BaseServiceError } from './base-service.error';
import { loadStampFontBytes } from './base-stamp-font';

const EMAIL = 'jose.nanez@example.test';
const TEXT = buildStampText('José Ñáñez', EMAIL, 'EX-0001');

/**
 * Synthetic source: 4 pages covering a plain A4 page with two links, a page
 * with /Rotate 90, a page whose MediaBox has a non-zero origin and a page with
 * /Rotate 270 and one link; plus a 2-entry outline and Title/Author.
 */
async function buildSyntheticPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('Bloque sintético');
  doc.setAuthor('EXOM');
  const plain = doc.addPage([595.28, 841.89]);
  plain.drawText('Sesión 1', { x: 50, y: 700, size: 20 });
  const rotated = doc.addPage([595.28, 841.89]);
  rotated.setRotation(degrees(90));
  rotated.drawText('Rotada', { x: 50, y: 700, size: 20 });
  const shifted = doc.addPage([400, 600]);
  shifted.setMediaBox(50, 100, 400, 600);
  shifted.drawText('Origen desplazado', { x: 80, y: 400, size: 14 });
  const rotated270 = doc.addPage([300, 500]);
  rotated270.setRotation(degrees(270));

  const { context } = doc;
  const link = (uri: string, y: number): PDFRef =>
    context.register(
      context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [40, y, 200, y + 20],
        Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri) },
      }),
    );
  plain.node.set(
    PDFName.of('Annots'),
    context.obj([
      link('https://exommethod.com/a', 100),
      link('https://exommethod.com/b', 200),
    ]),
  );
  rotated270.node.set(
    PDFName.of('Annots'),
    context.obj([link('https://exommethod.com/c', 50)]),
  );

  const outlineRef = context.nextRef();
  const firstRef = context.nextRef();
  const secondRef = context.nextRef();
  context.assign(
    firstRef,
    context.obj({
      Title: PDFHexString.fromText('Sesión 1'),
      Parent: outlineRef,
      Next: secondRef,
      Dest: [plain.ref, 'Fit'],
    }),
  );
  context.assign(
    secondRef,
    context.obj({
      Title: PDFHexString.fromText('Sesión 2'),
      Parent: outlineRef,
      Prev: firstRef,
      Dest: [shifted.ref, 'Fit'],
    }),
  );
  context.assign(
    outlineRef,
    context.obj({
      Type: 'Outlines',
      First: firstRef,
      Last: secondRef,
      Count: 2,
    }),
  );
  doc.catalog.set(PDFName.of('Outlines'), outlineRef);
  return doc.save();
}

function linkCount(doc: PDFDocument, pageIndex: number): number {
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return 0;
  let count = 0;
  for (let i = 0; i < annots.size(); i += 1) {
    const annot = annots.lookup(i, PDFDict);
    if (annot.get(PDFName.of('Subtype')) === PDFName.of('Link')) count += 1;
  }
  return count;
}

function outlineTitles(doc: PDFDocument): string[] {
  const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  const titles: string[] = [];
  let item = outlines?.lookupMaybe(PDFName.of('First'), PDFDict);
  while (item) {
    const title = item.lookup(PDFName.of('Title'));
    if (title instanceof PDFHexString || title instanceof PDFString) {
      titles.push(title.decodeText());
    }
    item = item.lookupMaybe(PDFName.of('Next'), PDFDict);
  }
  return titles;
}

function contentStreams(doc: PDFDocument, pageIndex: number): string[] {
  const contents = doc.getPage(pageIndex).node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      streams.push(contents.lookup(i, PDFRawStream));
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }
  return streams.map((stream) =>
    Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1'),
  );
}

interface StampOps {
  fontKey: string;
  size: number;
  hexText: string;
}

/** Every `/<key> <size> Tf` followed by a hex string shown with Tj. */
function textOps(stream: string): StampOps[] {
  return [
    ...stream.matchAll(/\/(\S+) ([\d.]+) Tf[\s\S]*?<([0-9A-Fa-f]+)> Tj/g),
  ].map((match) => ({
    fontKey: match[1],
    size: Number(match[2]),
    hexText: match[3],
  }));
}

/** Text-showing operations of a page that use the embedded DM Sans font. */
function stampOps(doc: PDFDocument, pageIndex: number): StampOps[] {
  return contentStreams(doc, pageIndex)
    .flatMap(textOps)
    .filter((ops) =>
      // pdf-lib names subsets `<PostScript name>-<suffix>`.
      baseFontOf(doc, pageIndex, ops.fontKey).startsWith('DMSans-Regular'),
    );
}

function baseFontOf(doc: PDFDocument, pageIndex: number, key: string): string {
  const resources = doc.getPage(pageIndex).node.Resources();
  const fonts = resources?.lookup(PDFName.of('Font'), PDFDict);
  const font = fonts?.lookup(PDFName.of(key), PDFDict);
  const baseFont = font?.get(PDFName.of('BaseFont'));
  return baseFont instanceof PDFName ? baseFont.decodeText() : '';
}

describe('buildStampText / buildStampSubject', () => {
  it('match the reference wording', () => {
    expect(TEXT).toBe(
      'Licencia personal · José Ñáñez · jose.nanez@example.test · Pedido EX-0001',
    );
    expect(buildStampSubject('José Ñáñez', EMAIL, 'EX-0001')).toBe(
      'Licencia personal de José Ñáñez (jose.nanez@example.test) · Pedido EX-0001',
    );
  });
});

describe('stampPdf', () => {
  let source: Uint8Array;

  beforeAll(async () => {
    source = await buildSyntheticPdf();
  });

  it('preserves page count, links per page, outline and Title/Author; sets Subject/Keywords', async () => {
    const stamped = await stampPdf(source, {
      text: TEXT,
      subject: buildStampSubject('José Ñáñez', EMAIL, 'EX-0001'),
      keywords: 'EXOM;EX-0001',
    });
    const before = await PDFDocument.load(source, { updateMetadata: false });
    const after = await PDFDocument.load(stamped, { updateMetadata: false });

    expect(after.getPageCount()).toBe(before.getPageCount());
    for (let i = 0; i < before.getPageCount(); i += 1) {
      expect(linkCount(after, i)).toBe(linkCount(before, i));
    }
    expect([0, 1, 2, 3].map((i) => linkCount(after, i))).toEqual([2, 0, 0, 1]);
    expect(outlineTitles(after)).toEqual(['Sesión 1', 'Sesión 2']);
    expect(after.getTitle()).toBe('Bloque sintético');
    expect(after.getAuthor()).toBe('EXOM');
    expect(after.getSubject()).toBe(
      'Licencia personal de José Ñáñez (jose.nanez@example.test) · Pedido EX-0001',
    );
    expect(after.getKeywords()).toBe('EXOM;EX-0001');
    expect(after.getPage(1).getRotation().angle).toBe(90);
    expect(after.getPage(2).getMediaBox()).toEqual({
      x: 50,
      y: 100,
      width: 400,
      height: 600,
    });
  });

  it('draws the stamp text, in the embedded stamp font, on every page', async () => {
    const stamped = await stampPdf(source, { text: TEXT });
    const before = await PDFDocument.load(source, { updateMetadata: false });
    const after = await PDFDocument.load(stamped, { updateMetadata: false });
    after.registerFontkit(fontkit);
    const font = await after.embedFont(loadStampFontBytes(), { subset: true });
    // Glyph ids of the stamp text in the stamp font: identical across embeds.
    const expectedHex = font.encodeText(TEXT).asString();

    for (let i = 0; i < after.getPageCount(); i += 1) {
      const streamsBefore = contentStreams(before, i);
      const streamsAfter = contentStreams(after, i);
      expect(streamsAfter.length).toBeGreaterThan(streamsBefore.length);
      // Exactly one text run per page in the subset DM Sans font, at the
      // size of the placement rule (6.5 pt unless the page is too short for
      // the line, as the 300 pt-high rotated page is now that the stamp
      // carries the email), whose glyph ids spell the stamp text.
      const ops = stampOps(after, i);
      expect(ops).toHaveLength(1);
      const page = after.getPage(i);
      expect(ops[0].size).toBeCloseTo(
        computeStampPlacement(
          page.getMediaBox(),
          page.getRotation().angle,
          font.widthOfTextAtSize(TEXT, 1),
        ).size,
        6,
      );
      if (i < 3) expect(ops[0].size).toBe(STAMP_FONT_SIZE);
      expect(ops[0].hexText.toUpperCase()).toBe(expectedHex.toUpperCase());
      // The source page has no DM Sans text of its own.
      expect(stampOps(before, i)).toHaveLength(0);
    }
  });

  it('shrinks the font for long text but never below 4 pt', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 500]);
    const page = await doc.save();
    const long = buildStampText('A'.repeat(80), EMAIL, 'EX-0001');

    const after = await PDFDocument.load(await stampPdf(page, { text: long }));
    const size = stampOps(after, 0)[0]?.size;
    expect(size).toBeLessThan(STAMP_FONT_SIZE);
    expect(size).toBeGreaterThan(STAMP_MIN_FONT_SIZE);
    // The placement rule clamps at 4 pt for a line that would need less.
    expect(
      computeStampPlacement({ x: 0, y: 0, width: 300, height: 120 }, 0, 100)
        .size,
    ).toBe(STAMP_MIN_FONT_SIZE);
  });

  it('refuses (instead of clipping) a line that does not fit at 4 pt', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 500]);
    doc.addPage([300, 120]);
    const pages = await doc.save();
    const long = buildStampText('A'.repeat(80), EMAIL, 'EX-0001');
    let thrown: unknown;
    try {
      await stampPdf(pages, { text: long });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaseServiceError);
    expect(thrown).toMatchObject({ code: 'STAMP_TOO_LONG' });
  });

  it('is byte-for-byte deterministic for the same input and options', async () => {
    // Retries rebuild the package and must send an identical body under the
    // same provider idempotency key, so no random font or resource names.
    const options = {
      text: TEXT,
      subject: buildStampSubject('José Ñáñez', EMAIL, 'EX-0001'),
      keywords: 'EXOM;EX-0001',
    };
    const first = Buffer.from(await stampPdf(source, options));
    const second = Buffer.from(await stampPdf(source, options));
    expect(second.equals(first)).toBe(true);
    const other = Buffer.from(
      await stampPdf(source, {
        ...options,
        text: buildStampText('Otra', EMAIL, 'X'),
      }),
    );
    expect(other.equals(first)).toBe(false);
  });

  it('does not reuse a resource name the page already has', async () => {
    const doc = await PDFDocument.load(source, { updateMetadata: false });
    const page = doc.getPage(0);
    const existing = doc.context.register(doc.context.obj({ Type: 'Font' }));
    page.node.setFontDictionary(PDFName.of('ExomStamp'), existing);
    const after = await PDFDocument.load(
      await stampPdf(await doc.save(), { text: TEXT }),
      { updateMetadata: false },
    );
    const fonts = after
      .getPage(0)
      .node.Resources()
      ?.lookup(PDFName.of('Font'), PDFDict);
    expect(fonts?.get(PDFName.of('ExomStamp'))).toBeInstanceOf(PDFRef);
    expect(stampOps(after, 0)).toHaveLength(1);
    expect(stampOps(after, 0)[0].fontKey).not.toBe('ExomStamp');
  });

  it('does not mutate the input bytes', async () => {
    const copy = Uint8Array.from(source);
    await stampPdf(source, { text: TEXT });
    expect(Buffer.from(source).equals(Buffer.from(copy))).toBe(true);
  });

  it('leaves Subject/Keywords untouched when not given', async () => {
    const after = await PDFDocument.load(
      await stampPdf(source, { text: TEXT }),
      {
        updateMetadata: false,
      },
    );
    expect(after.getSubject()).toBeUndefined();
    expect(after.getKeywords()).toBeUndefined();
  });
});

describe('computeStampPlacement', () => {
  /** Applies the 2D affine matrix [a b c d e f] to a point. */
  function apply(m: number[], x: number, y: number): [number, number] {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  const textWidthAt1pt = 50;

  it('centres the line on the right margin of an unrotated page', () => {
    const p = computeStampPlacement(
      { x: 0, y: 0, width: 600, height: 800 },
      0,
      textWidthAt1pt,
    );
    expect(p.size).toBe(STAMP_FONT_SIZE);
    // Baseline origin is shifted by size*0.35 so the glyph centre line sits
    // exactly STAMP_EDGE_OFFSET from the edge, as in the reference.
    const [x, y] = apply(p.matrix, 0, 0);
    expect(x).toBeCloseTo(600 - STAMP_EDGE_OFFSET + p.size * 0.35);
    expect(y).toBeCloseTo(400);
    // Text runs upwards (rotated 90°).
    const [x2, y2] = apply(p.matrix, 10, 0);
    expect(x2).toBeCloseTo(x);
    expect(y2).toBeCloseTo(y + 10);
  });

  it('honours a non-zero MediaBox origin', () => {
    const p = computeStampPlacement(
      { x: 50, y: 100, width: 400, height: 600 },
      0,
      textWidthAt1pt,
    );
    const [x, y] = apply(p.matrix, 0, 0);
    expect(x).toBeCloseTo(50 + 400 - STAMP_EDGE_OFFSET + p.size * 0.35);
    expect(y).toBeCloseTo(100 + 300);
  });

  it('uses the visible right edge on a /Rotate 90 page', () => {
    // Displayed rotated 90° clockwise: the unrotated top edge is shown on the right.
    const p = computeStampPlacement(
      { x: 10, y: 20, width: 200, height: 300 },
      90,
      textWidthAt1pt,
    );
    const [x, y] = apply(p.matrix, 0, 0);
    expect(x).toBeCloseTo(10 + 200 - 200 / 2);
    expect(y).toBeCloseTo(20 + 300 - STAMP_EDGE_OFFSET + p.size * 0.35);
  });

  it('uses the visible right edge on a /Rotate 270 (or -90) page', () => {
    for (const rotation of [270, -90]) {
      const p = computeStampPlacement(
        { x: 0, y: 0, width: 200, height: 300 },
        rotation,
        textWidthAt1pt,
      );
      const [x, y] = apply(p.matrix, 0, 0);
      // Displayed rotated 270°: the unrotated bottom edge is shown on the right.
      expect(x).toBeCloseTo(200 / 2);
      expect(y).toBeCloseTo(STAMP_EDGE_OFFSET - p.size * 0.35);
    }
  });

  it('caps the line at 70 % of the visible height', () => {
    const p = computeStampPlacement(
      { x: 0, y: 0, width: 600, height: 400 },
      0,
      50,
    );
    expect(p.size).toBeCloseTo((400 * 0.7) / 50);
    const rotated = computeStampPlacement(
      { x: 0, y: 0, width: 400, height: 600 },
      90,
      50,
    );
    expect(rotated.size).toBeCloseTo((400 * 0.7) / 50);
  });
});

describe('stamp fit for the longest allowed name and email', () => {
  const A4 = { x: 0, y: 0, width: 595.28, height: 841.89 };
  const longestEmail =
    'a'.repeat(64) +
    '@' +
    ['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(57), 'com'].join('.');
  const text = buildStampText('A'.repeat(80), longestEmail, 'EXB-000123');
  let widthAt1pt: number;

  beforeAll(async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(loadStampFontBytes(), { subset: true });
    widthAt1pt = font.widthOfTextAtSize(text, 1);
  });

  it('uses inputs at the validation limits (80-character name, 254-character email)', () => {
    expect(longestEmail).toHaveLength(254);
  });

  it('never shrinks the font below 4 pt', () => {
    const placement = computeStampPlacement(A4, 0, widthAt1pt);
    expect(placement.size).toBeGreaterThanOrEqual(STAMP_MIN_FONT_SIZE);
  });

  // The 4 pt / 70 % rule is not relaxed: this line (~890 pt at 4 pt against
  // 589.3 pt) cannot be stored (STAMP_TOO_LONG on create/update) and, should
  // it reach the stamper, is refused instead of being drawn clipped.
  it('does not fit within 70 % of an A4 page height at 4 pt, so it is refused', async () => {
    expect(widthAt1pt * STAMP_MIN_FONT_SIZE).toBeGreaterThan(
      A4.height * STAMP_MAX_LENGTH_RATIO,
    );
    const doc = await PDFDocument.create();
    doc.addPage([A4.width, A4.height]);
    await expect(stampPdf(await doc.save(), { text })).rejects.toMatchObject({
      name: 'BaseServiceError',
      code: 'STAMP_TOO_LONG',
    });
  });
});

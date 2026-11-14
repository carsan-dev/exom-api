import * as fontkit from '@cantoo/fontkit';
import { PDFDocument, PDFFont } from '@cantoo/pdf-lib';
import { BaseServiceError } from './base-service.error';
import {
  assertSubscriberStampFits,
  measureSubscriberStamp,
  normalizeClientName,
  normalizeOrderCode,
  normalizeSubscriberEmail,
  widestOrderCode,
} from './base-delivery-input';
import {
  STAMP_MAX_LENGTH_RATIO,
  STAMP_MIN_FONT_SIZE,
  STAMP_PRODUCT_PAGE_HEIGHT,
  buildStampText,
  computeStampPlacement,
  stampPdf,
} from './base-pdf-stamp';
import { loadStampFontBytes, stampTextWidthAt1pt } from './base-stamp-font';

function errorOf(fn: () => unknown): BaseServiceError {
  try {
    fn();
  } catch (error) {
    if (error instanceof BaseServiceError) return error;
    throw error;
  }
  throw new Error('expected a BaseServiceError');
}

describe('normalizeClientName', () => {
  it('collapses whitespace', () => {
    expect(normalizeClientName('  Ana   Pérez ')).toBe('Ana Pérez');
  });

  it('accepts Spanish accented names', () => {
    expect(normalizeClientName('José Ñáñez')).toBe('José Ñáñez');
    expect(normalizeClientName('María Güell-Ibáñez')).toBe(
      'María Güell-Ibáñez',
    );
  });

  it.each([
    ['newline', 'Ana\nPérez'],
    ['tab', 'Ana\tPérez'],
    ['zero-width joiner (format char)', 'Ana‍Pérez'],
    ['bidi override', 'Ana‮Pérez'],
  ])('rejects control/format characters (%s)', (_label, raw) => {
    const error = errorOf(() => normalizeClientName(raw));
    expect(error.code).toBe('INVALID_NAME');
    expect(error.message).toBe(
      'El nombre contiene caracteres de control o saltos de línea.',
    );
  });

  it('rejects an empty or blank name', () => {
    for (const raw of ['', '   ']) {
      const error = errorOf(() => normalizeClientName(raw));
      expect(error.code).toBe('INVALID_NAME');
      expect(error.message).toBe('El nombre no puede estar vacío.');
    }
  });

  it('accepts 80 characters and rejects 81', () => {
    expect(normalizeClientName('A'.repeat(80))).toHaveLength(80);
    const error = errorOf(() => normalizeClientName('A'.repeat(81)));
    expect(error.code).toBe('INVALID_NAME');
    expect(error.message).toBe('El nombre supera los 80 caracteres.');
  });

  it('counts code points, not UTF-16 units, for the length limit', () => {
    // 80 "é" are 80 code points; must not be rejected as too long.
    expect(normalizeClientName('é'.repeat(80))).toHaveLength(80);
  });

  it('names the characters the stamp font cannot draw', () => {
    const error = errorOf(() => normalizeClientName('Ana 😀 漢'));
    expect(error.code).toBe('INVALID_NAME');
    expect(error.message).toBe(
      'El nombre contiene caracteres que la tipografía no admite: «漢» «😀»',
    );
  });
});

describe('normalizeOrderCode', () => {
  it('upper-cases valid codes', () => {
    expect(normalizeOrderCode('ex-7')).toBe('EX-7');
    expect(normalizeOrderCode('EX-0001')).toBe('EX-0001');
    expect(normalizeOrderCode('rv_12')).toBe('RV_12');
  });

  it.each(['', '../x', 'EX 1', 'EX/1', 'EX.1', 'EX-1\n', 'ÑU-1'])(
    'rejects %j',
    (raw) => {
      const error = errorOf(() => normalizeOrderCode(raw));
      expect(error.code).toBe('INVALID_ORDER_CODE');
      expect(error.message).toBe(
        'Pedido no válido: solo se admiten letras, números, «_» y «-».',
      );
    },
  );

  it.each([
    ['nul', 'NUL'],
    ['COM1', 'COM1'],
    ['lpt9', 'LPT9'],
    ['con', 'CON'],
  ])('rejects the Windows reserved name %s', (raw, upper) => {
    const error = errorOf(() => normalizeOrderCode(raw));
    expect(error.code).toBe('INVALID_ORDER_CODE');
    expect(error.message).toBe(
      `Pedido no válido: «${upper}» es un nombre reservado de Windows.`,
    );
  });

  it('accepts names that only look like reserved ones', () => {
    expect(normalizeOrderCode('COM10')).toBe('COM10');
    expect(normalizeOrderCode('NUL-1')).toBe('NUL-1');
  });
});

describe('normalizeSubscriberEmail', () => {
  const longest =
    'a'.repeat(64) +
    '@' +
    ['b'.repeat(63), 'c'.repeat(63), 'd'.repeat(57), 'com'].join('.');

  it('trims and lower-cases', () => {
    expect(normalizeSubscriberEmail('  Ana.Pérez@Example.TEST ')).toBe(
      'ana.pérez@example.test',
    );
    expect(normalizeSubscriberEmail('ana+exom_1@example.test')).toBe(
      'ana+exom_1@example.test',
    );
  });

  it('accepts 254 characters and rejects 255', () => {
    expect(longest).toHaveLength(254);
    expect(normalizeSubscriberEmail(longest)).toBe(longest);
    expect(errorOf(() => normalizeSubscriberEmail('x' + longest)).code).toBe(
      'INVALID_EMAIL',
    );
  });

  it('names the characters the stamp font cannot draw', () => {
    const error = errorOf(() =>
      normalizeSubscriberEmail('ana漢字@example.test'),
    );
    expect(error.code).toBe('INVALID_EMAIL');
    expect(error.message).toContain('«漢»');
    expect(error.message).toContain('«字»');
  });

  it.each([
    '',
    '   ',
    'ana',
    'ana@',
    '@example.test',
    'ana @example.test',
    'ana\u0007@example.test',
    'ana\nb@example.test',
  ])('rejects %j', (raw) => {
    expect(errorOf(() => normalizeSubscriberEmail(raw)).code).toBe(
      'INVALID_EMAIL',
    );
  });
});

/** A valid address (local part ≤ 64, labels ≤ 63) of exactly `length` chars. */
function emailOfLength(length: number): string {
  const local = 'a'.repeat(Math.min(64, length - 6));
  let rest = length - local.length - 1 - '.com'.length;
  const labels: string[] = [];
  while (rest > 63) {
    labels.push('b'.repeat(62));
    rest -= 63;
  }
  labels.push('b'.repeat(rest));
  return `${local}@${labels.join('.')}.com`;
}

describe('measureSubscriberStamp / assertSubscriberStampFits', () => {
  const A4 = { x: 0, y: 0, width: 595.28, height: STAMP_PRODUCT_PAGE_HEIGHT };
  const limit = STAMP_PRODUCT_PAGE_HEIGHT * STAMP_MAX_LENGTH_RATIO;
  const name = 'A'.repeat(80);
  let pdfFont: PDFFont;
  /** First email length (with the 80-character name) that no longer fits. */
  let firstOverflow: number;

  beforeAll(async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    pdfFont = await doc.embedFont(loadStampFontBytes(), { subset: true });
    firstOverflow = 16;
    while (measureSubscriberStamp(name, emailOfLength(firstOverflow)).fits)
      firstOverflow += 1;
  });

  it('builds valid emails for the boundary search', () => {
    for (const length of [16, 70, 128, 200, 254]) {
      const email = emailOfLength(length);
      expect(email).toHaveLength(length);
      expect(normalizeSubscriberEmail(email)).toBe(email);
    }
  });

  it('measures exactly like the font pdf-lib embeds in the PDF', () => {
    for (const text of [
      buildStampText('José Ñáñez', 'jose@example.test', 'EXB-000001'),
      buildStampText(name, emailOfLength(254), widestOrderCode()),
      'fi fl ffi AV To',
    ])
      expect(stampTextWidthAt1pt(text)).toBeCloseTo(
        pdfFont.widthOfTextAtSize(text, 1),
        9,
      );
  });

  it('uses the widest EXB-NNNNNN order code, chosen by measuring the digits', () => {
    const widest = widestOrderCode();
    expect(widest).toMatch(/^EXB-(\d)\1{5}$/);
    const width = stampTextWidthAt1pt(widest);
    for (let digit = 0; digit <= 9; digit += 1)
      expect(width).toBeGreaterThanOrEqual(
        stampTextWidthAt1pt(`EXB-${String(digit).repeat(6)}`),
      );
    for (const sample of ['EXB-000123', 'EXB-987654', 'EXB-404040'])
      expect(width).toBeGreaterThanOrEqual(stampTextWidthAt1pt(sample));
  });

  it('derives the limit from A4 portrait and the 70 % / 4 pt rule', () => {
    const fit = measureSubscriberStamp('Ana', 'ana@example.test');
    expect(fit.limitPt).toBeCloseTo(limit, 9);
    expect(fit.limitPt).toBeCloseTo(589.323, 3);
    expect(fit.widthPt).toBeCloseTo(
      pdfFont.widthOfTextAtSize(
        buildStampText('Ana', 'ana@example.test', widestOrderCode()),
        STAMP_MIN_FONT_SIZE,
      ),
      9,
    );
  });

  it('accepts realistic long names and emails', () => {
    for (const [realName, email] of [
      [
        'María del Carmen Fernández-Villaverde de la Fuente',
        'mariadelcarmen.fernandez.villaverde@consultoria-ejemplo.es',
      ],
      [
        'Juan Sebastián Rodríguez-Montalbán Gutiérrez',
        'juan.sebastian.rodriguez.montalban+exom@universidad.example.com',
      ],
    ]) {
      const fit = measureSubscriberStamp(realName, email);
      expect(fit).toMatchObject({ fits: true, excessChars: 0 });
      expect(fit.widthPt).toBeLessThanOrEqual(fit.limitPt);
      expect(() => assertSubscriberStampFits(realName, email)).not.toThrow();
    }
  });

  it('flips exactly at the measured boundary (one character more does not fit)', () => {
    const fitting = emailOfLength(firstOverflow - 1);
    const overflowing = emailOfLength(firstOverflow);
    const ok = measureSubscriberStamp(name, fitting);
    const ko = measureSubscriberStamp(name, overflowing);
    expect(ok.fits).toBe(true);
    expect(ok.widthPt).toBeLessThanOrEqual(limit);
    expect(ko.fits).toBe(false);
    expect(ko.widthPt).toBeGreaterThan(limit);
    expect(ko.excessChars).toBe(1);
    // Independent path: the drawn size on an A4 page keeps the line in limits.
    const text = buildStampText(name, fitting, widestOrderCode());
    const widthAt1pt = pdfFont.widthOfTextAtSize(text, 1);
    const placement = computeStampPlacement(A4, 0, widthAt1pt);
    expect(placement.size).toBeGreaterThanOrEqual(STAMP_MIN_FONT_SIZE);
    expect(widthAt1pt * placement.size).toBeLessThanOrEqual(limit + 1e-9);
  });

  it('stampPdf draws the just-fitting line on A4 and refuses the overflowing one', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([A4.width, A4.height]);
    const a4 = await doc.save();
    const code = widestOrderCode();
    await expect(
      stampPdf(a4, {
        text: buildStampText(name, emailOfLength(firstOverflow - 1), code),
      }),
    ).resolves.toBeInstanceOf(Uint8Array);
    await expect(
      stampPdf(a4, {
        text: buildStampText(name, emailOfLength(firstOverflow), code),
      }),
    ).rejects.toMatchObject({
      name: 'BaseServiceError',
      code: 'STAMP_TOO_LONG',
    });
  });

  it('reports roughly how many characters to remove', () => {
    const fit = measureSubscriberStamp(name, emailOfLength(254));
    expect(fit.fits).toBe(false);
    const extra = 254 - (firstOverflow - 1);
    // An average-width estimate: same order as the exact count for this text.
    expect(fit.excessChars).toBeGreaterThan(extra / 2);
    expect(fit.excessChars).toBeLessThan(extra * 2);
    const error = errorOf(() =>
      assertSubscriberStampFits(name, emailOfLength(254)),
    );
    expect(error.code).toBe('STAMP_TOO_LONG');
    expect(error.message).toContain(`unos ${fit.excessChars} caracteres`);
    expect(error.message).toContain('nombre');
    expect(error.message).toContain('email');
  });

  it('rejects the longest name and email the individual checks allow', () => {
    expect(normalizeClientName(name)).toBe(name);
    expect(normalizeSubscriberEmail(emailOfLength(254))).toHaveLength(254);
    expect(measureSubscriberStamp(name, emailOfLength(254)).fits).toBe(false);
  });
});

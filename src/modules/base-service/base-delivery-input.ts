import { isEmail } from 'class-validator';
import {
  buildStampText,
  STAMP_MIN_FONT_SIZE,
  STAMP_PRODUCT_PAGE_HEIGHT,
  stampFitsAtMinimumSize,
  stampLengthLimit,
} from './base-pdf-stamp';
import { BaseServiceError } from './base-service.error';
import { charactersWithoutGlyph, stampTextWidthAt1pt } from './base-stamp-font';

export const MAX_CLIENT_NAME_LENGTH = 80;

const ORDER_CODE_RE = /^[A-Za-z0-9_-]+$/;
// Unicode category C: control, format, surrogate, private use, unassigned.
const OTHER_CATEGORY_RE = /\p{C}/u;
const RESERVED_ORDER_CODES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...['COM', 'LPT'].flatMap((prefix) =>
    Array.from({ length: 9 }, (_, i) => `${prefix}${i + 1}`),
  ),
]);

/**
 * Normalises the client name printed on the stamp (port of `clean_nombre`):
 * collapses whitespace and rejects control/format characters, empty names,
 * names longer than 80 code points and characters the stamp font cannot draw.
 */
export function normalizeClientName(raw: string): string {
  if (OTHER_CATEGORY_RE.test(raw)) {
    throw new BaseServiceError(
      'INVALID_NAME',
      'El nombre contiene caracteres de control o saltos de línea.',
    );
  }
  const name = raw.split(/\s+/u).filter(Boolean).join(' ');
  if (!name) {
    throw new BaseServiceError(
      'INVALID_NAME',
      'El nombre no puede estar vacío.',
    );
  }
  if ([...name].length > MAX_CLIENT_NAME_LENGTH) {
    throw new BaseServiceError(
      'INVALID_NAME',
      `El nombre supera los ${MAX_CLIENT_NAME_LENGTH} caracteres.`,
    );
  }
  const missing = charactersWithoutGlyph(name);
  if (missing.length > 0) {
    throw new BaseServiceError(
      'INVALID_NAME',
      'El nombre contiene caracteres que la tipografía no admite: ' +
        missing.map((char) => `«${char}»`).join(' '),
    );
  }
  return name;
}

export const MAX_SUBSCRIBER_EMAIL_LENGTH = 254;

/**
 * Normalises the subscriber email printed on the stamp and used as recipient:
 * trimmed and lower-cased (the storage form), at most 254 characters, valid
 * under the same `isEmail` check the API DTOs use, and drawable by the stamp
 * font, so stamping can never reject a stored address later.
 */
export function normalizeSubscriberEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!email || OTHER_CATEGORY_RE.test(email)) {
    throw new BaseServiceError(
      'INVALID_EMAIL',
      'El email está vacío o contiene caracteres de control.',
    );
  }
  if ([...email].length > MAX_SUBSCRIBER_EMAIL_LENGTH) {
    throw new BaseServiceError(
      'INVALID_EMAIL',
      `El email supera los ${MAX_SUBSCRIBER_EMAIL_LENGTH} caracteres.`,
    );
  }
  const missing = charactersWithoutGlyph(email);
  if (missing.length > 0) {
    throw new BaseServiceError(
      'INVALID_EMAIL',
      'El email contiene caracteres que la tipografía no admite: ' +
        missing.map((char) => `«${char}»`).join(' '),
    );
  }
  if (!isEmail(email)) {
    throw new BaseServiceError('INVALID_EMAIL', 'El email no es válido.');
  }
  return email;
}

/** Order codes are `EXB-` + a zero-padded 6-digit sequence number. */
const ORDER_CODE_PREFIX = 'EXB-';
const ORDER_CODE_DIGITS = 6;

let widestCode: string | undefined;

/**
 * The `EXB-NNNNNN` code with the widest stamp text, found by measuring every
 * digit in the stamp font (no assumption that digits are tabular). Codes past
 * 999999 gain a digit; `stampPdf` still refuses any line that does not fit.
 */
export function widestOrderCode(): string {
  if (widestCode === undefined) {
    let best = '';
    let bestWidth = -1;
    for (let digit = 0; digit <= 9; digit += 1) {
      const code = ORDER_CODE_PREFIX + String(digit).repeat(ORDER_CODE_DIGITS);
      const width = stampTextWidthAt1pt(code);
      if (width > bestWidth) {
        best = code;
        bestWidth = width;
      }
    }
    widestCode = best;
  }
  return widestCode;
}

export interface SubscriberStampFit {
  /** The license line fits at the minimum font size on every product page. */
  fits: boolean;
  /** Line length at the minimum font size with the widest order code, pt. */
  widthPt: number;
  /** 70 % of the smallest product page height, pt. */
  limitPt: number;
  /** Rough number of characters to remove from name + email; 0 if it fits. */
  excessChars: number;
}

/**
 * Pure check of the stamp line `Licencia personal · <name> · <email> · Pedido
 * <code>` for already normalised `name` and `email`: measured in the stamp
 * font with the widest possible order code, at the 4 pt minimum size, against
 * 70 % of the smallest visible page height the product uses (A4 portrait, see
 * STAMP_PRODUCT_PAGE_HEIGHT). The rule itself is the one `stampPdf` applies.
 */
export function measureSubscriberStamp(
  name: string,
  email: string,
): SubscriberStampFit {
  const text = buildStampText(name, email, widestOrderCode());
  const widthAt1pt = stampTextWidthAt1pt(text);
  const widthPt = widthAt1pt * STAMP_MIN_FONT_SIZE;
  const limitPt = stampLengthLimit(STAMP_PRODUCT_PAGE_HEIGHT);
  const fits = stampFitsAtMinimumSize(widthAt1pt, STAMP_PRODUCT_PAGE_HEIGHT);
  const averageCharPt = widthPt / [...text].length;
  return {
    fits,
    widthPt,
    limitPt,
    excessChars: fits
      ? 0
      : Math.max(1, Math.ceil((widthPt - limitPt) / averageCharPt)),
  };
}

/** Throws STAMP_TOO_LONG when the name + email license line cannot fit. */
export function assertSubscriberStampFits(name: string, email: string): void {
  const { fits, excessChars } = measureSubscriberStamp(name, email);
  if (fits) return;
  const excess =
    excessChars === 1
      ? 'sobra aproximadamente 1 carácter'
      : `sobran unos ${excessChars} caracteres`;
  throw new BaseServiceError(
    'STAMP_TOO_LONG',
    `El nombre y el email juntos son demasiado largos para la línea de licencia que se imprime en cada página de los PDF: ${excess} entre los dos. Acorta el nombre o usa un email más corto.`,
  );
}

/**
 * Normalises the order code (port of `clean_pedido`): only ASCII letters,
 * digits, `_` and `-`; upper-cased; Windows reserved device names rejected.
 */
export function normalizeOrderCode(raw: string): string {
  if (!ORDER_CODE_RE.test(raw)) {
    throw new BaseServiceError(
      'INVALID_ORDER_CODE',
      'Pedido no válido: solo se admiten letras, números, «_» y «-».',
    );
  }
  const code = raw.toUpperCase();
  if (RESERVED_ORDER_CODES.has(code)) {
    throw new BaseServiceError(
      'INVALID_ORDER_CODE',
      `Pedido no válido: «${code}» es un nombre reservado de Windows.`,
    );
  }
  return code;
}

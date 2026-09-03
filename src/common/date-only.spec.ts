import { BadRequestException } from '@nestjs/common';
import { isDateOnly, parseDateOnly } from './date-only';

describe('date-only', () => {
  it.each([
    '2026-02-30',
    '2026-13-01',
    '01-09-2026',
    '2026-9-01',
    '2026-09-01T00:00:00.000Z',
    '',
  ])('rejects invalid or non-canonical date %s', (value) => {
    expect(isDateOnly(value)).toBe(false);
    expect(() => parseDateOnly(value)).toThrow(BadRequestException);
  });

  it('parses a valid date at UTC midnight', () => {
    expect(parseDateOnly('2026-09-01')).toEqual(
      new Date('2026-09-01T00:00:00.000Z'),
    );
  });
});

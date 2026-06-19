import { BadRequestException } from '@nestjs/common';
import { normalizeGroupName } from './catalog-group.utils';

describe('normalizeGroupName', () => {
  it('trims, collapses spaces and removes accents from unique key', () => {
    expect(normalizeGroupName('  Fuerza   Élite  ')).toEqual({
      name: 'Fuerza Élite',
      normalizedName: 'fuerza elite',
    });
  });

  it('rejects empty and overlong names', () => {
    expect(() => normalizeGroupName('   ')).toThrow(BadRequestException);
    expect(() => normalizeGroupName('x'.repeat(101))).toThrow(BadRequestException);
  });
});

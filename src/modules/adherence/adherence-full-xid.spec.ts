import { prepareAdherenceCommitTimestampLookup } from './adherence-full-xid';

describe('prepareAdherenceCommitTimestampLookup', () => {
  it.each([
    ['3', '4', '3'],
    ['4294967299', '4294967300', '3'],
    ['18446744073709551613', '18446744073709551615', '4294967293'],
    ['18446744073709551614', '18446744073709551615', '4294967294'],
    ['4294967295', '4294967299', '4294967295'],
    ['3', '2147483650', '3'],
  ])('preserves exact full XID %s with snapshot %s', (full, next, low) => {
    expect(prepareAdherenceCommitTimestampLookup(full, next)).toEqual({
      status: 'eligible',
      fullXid: full,
      xid32Text: low,
    });
  });

  const invalidInputs: unknown[] = [
    undefined,
    null,
    true,
    3,
    3n,
    Symbol('private'),
    ['3'],
    { toString: () => '3' },
    '',
    '03',
    ' 3',
    '3 ',
    '3\n',
    '+3',
    '-3',
    '3.0',
    '3e0',
    '0x3',
    '3; SELECT 1',
    '3/*private*/',
    '18446744073709551616',
    '100000000000000000000',
    '9'.repeat(10000),
  ];

  it('rejects invalid full identifiers without coercion or input disclosure', () => {
    for (const input of invalidInputs) {
      expect(prepareAdherenceCommitTimestampLookup(input, '4')).toEqual({
        status: 'unknown',
        reason: 'invalid_full_xid',
      });
    }
  });

  it('rejects invalid snapshots without coercion or input disclosure', () => {
    for (const input of invalidInputs) {
      expect(prepareAdherenceCommitTimestampLookup('3', input)).toEqual({
        status: 'unknown',
        reason: 'invalid_next_full_xid',
      });
    }
  });

  it('does not invoke hostile object coercion', () => {
    const hostile = {
      toString: () => {
        throw new Error('must not coerce');
      },
    };
    expect(prepareAdherenceCommitTimestampLookup(hostile, '4')).toEqual({
      status: 'unknown',
      reason: 'invalid_full_xid',
    });
    expect(prepareAdherenceCommitTimestampLookup('3', hostile)).toEqual({
      status: 'unknown',
      reason: 'invalid_next_full_xid',
    });
  });

  it.each(['0', '1', '2', '4294967296', '4294967297', '4294967298'])(
    'rejects reserved low identifier in %s',
    (full) => {
      expect(prepareAdherenceCommitTimestampLookup(full, '4294967299')).toEqual(
        {
          status: 'unknown',
          reason: 'reserved_xid',
        },
      );
    },
  );

  it.each([
    ['3', '3'],
    ['4', '3'],
    ['3', '0'],
    ['18446744073709551615', '18446744073709551615'],
  ])('rejects non-older target %s at snapshot %s', (full, next) => {
    expect(prepareAdherenceCommitTimestampLookup(full, next)).toEqual({
      status: 'unknown',
      reason: 'not_older_than_snapshot',
    });
  });

  it.each([
    ['3', '2147483651'],
    ['3', '2147483652'],
    ['4294967299', '6442450947'],
    ['3', '4294967300'],
  ])('rejects ambiguous/stale target %s at snapshot %s', (full, next) => {
    expect(prepareAdherenceCommitTimestampLookup(full, next)).toEqual({
      status: 'unknown',
      reason: 'outside_retained_window',
    });
  });

  it('accepts a canonical snapshot whose low bits are reserved', () => {
    expect(
      prepareAdherenceCommitTimestampLookup('4294967295', '4294967296'),
    ).toEqual({
      status: 'eligible',
      fullXid: '4294967295',
      xid32Text: '4294967295',
    });
  });

  it('keeps caller text unchanged and returns eligibility, not commit proof', () => {
    const full = '4294967299';
    const next = '4294967300';
    expect(prepareAdherenceCommitTimestampLookup(full, next)).toEqual({
      status: 'eligible',
      fullXid: '4294967299',
      xid32Text: '3',
    });
    expect([full, next]).toEqual(['4294967299', '4294967300']);
  });
});

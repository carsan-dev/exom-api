import { BadRequestException } from '@nestjs/common';
import {
  decodeTrainingOverviewCursor,
  encodeTrainingOverviewCursor,
  validateTrainingOverviewPage,
} from './training-overview-pagination';

const range = { from: '2026-09-01', to: '2026-09-30' };
const invalid = (action: () => unknown) =>
  expect(action).toThrow(BadRequestException);

describe('training overview keyset pagination', () => {
  it('roundtrips the last exercise ID with exact client and window binding', () => {
    const token = encodeTrainingOverviewCursor('client-a', range, 'exercise-α');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTrainingOverviewCursor(token, 'client-a', range)).toBe(
      'exercise-α',
    );
    invalid(() => decodeTrainingOverviewCursor(token, 'client-b', range));
    invalid(() =>
      decodeTrainingOverviewCursor(token, 'client-a', {
        ...range,
        to: '2026-09-29',
      }),
    );
    invalid(() =>
      decodeTrainingOverviewCursor(token, 'client-a', {
        ...range,
        from: '2026-09-02',
      }),
    );
  });

  it('rejects malformed, noncanonical, wrong-version and altered cursors', () => {
    const token = encodeTrainingOverviewCursor('client-a', range, 'exercise-1');
    for (const malformed of ['', '*', `${token}=`, 'a', 'null']) {
      invalid(() => decodeTrainingOverviewCursor(malformed, 'client-a', range));
    }
    const forged = Buffer.from(
      JSON.stringify({
        v: 2,
        c: 'client-a',
        f: range.from,
        t: range.to,
        i: 'exercise-1',
      }),
    ).toString('base64url');
    invalid(() => decodeTrainingOverviewCursor(forged, 'client-a', range));
    const changed = Buffer.from(
      JSON.stringify({
        v: 1,
        c: 'client-b',
        f: range.from,
        t: range.to,
        i: 'exercise-1',
      }),
    ).toString('base64url');
    invalid(() => decodeTrainingOverviewCursor(changed, 'client-a', range));
  });

  it('bounds encoded and decoded cursors and refuses empty last IDs', () => {
    invalid(() => encodeTrainingOverviewCursor('client-a', range, ''));
    invalid(() =>
      encodeTrainingOverviewCursor('client-a', range, 'x'.repeat(2048)),
    );
    invalid(() =>
      decodeTrainingOverviewCursor('x'.repeat(2049), 'client-a', range),
    );
    const empty = Buffer.from(
      JSON.stringify({
        v: 1,
        c: 'client-a',
        f: range.from,
        t: range.to,
        i: '',
      }),
    ).toString('base64url');
    invalid(() => decodeTrainingOverviewCursor(empty, 'client-a', range));
  });

  it('defaults to 100 only in paged mode and requires an explicit limit with a cursor', () => {
    expect(validateTrainingOverviewPage({}, 'client-a', range)).toEqual({
      limit: 100,
      lastExerciseId: null,
    });
    const cursor = encodeTrainingOverviewCursor(
      'client-a',
      range,
      'exercise-1',
    );
    invalid(() => validateTrainingOverviewPage({ cursor }, 'client-a', range));
    expect(
      validateTrainingOverviewPage({ limit: 1, cursor }, 'client-a', range),
    ).toEqual({ limit: 1, lastExerciseId: 'exercise-1' });
    for (const limit of [0, 101, 1.5, NaN, Infinity]) {
      invalid(() => validateTrainingOverviewPage({ limit }, 'client-a', range));
    }
    expect(
      validateTrainingOverviewPage({ limit: 100 }, 'client-a', range).limit,
    ).toBe(100);
  });
});

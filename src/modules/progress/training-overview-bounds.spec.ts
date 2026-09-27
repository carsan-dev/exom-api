import { PayloadTooLargeException } from '@nestjs/common';
import {
  assertTrainingOverviewResponseBound,
  assertTrainingOverviewWorkBound,
  TRAINING_OVERVIEW_MAX_DISTINCT_EXERCISES,
  TRAINING_OVERVIEW_MAX_ENTRIES,
  TRAINING_OVERVIEW_MAX_INPUT_BYTES,
  TRAINING_OVERVIEW_MAX_RESPONSE_BYTES,
} from './training-overview-bounds';

const limitError = (action: () => unknown) => {
  try {
    action();
    throw new Error('Expected overview limit failure');
  } catch (error) {
    expect(error).toBeInstanceOf(PayloadTooLargeException);
    if (error instanceof PayloadTooLargeException) {
      expect(error.getStatus()).toBe(413);
      expect(error.getResponse()).toEqual(
        expect.objectContaining({ code: 'TRAINING_OVERVIEW_LIMIT_EXCEEDED' }),
      );
    }
  }
};

const validWork = {
  distinctExerciseCount: 10_000n,
  entryCount: 50_000n,
  inputBytes: BigInt(6 * 1024 * 1024),
};

// Matches TransformInterceptor's success/data/timestamp insertion order.
const envelopeBytes = (data: unknown) =>
  Buffer.byteLength(
    JSON.stringify({
      success: true,
      data,
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );

describe('training overview resource bounds', () => {
  it('accepts all three preflight limits inclusively, including zero', () => {
    expect(() => assertTrainingOverviewWorkBound(validWork)).not.toThrow();
    expect(() =>
      assertTrainingOverviewWorkBound({
        distinctExerciseCount: 0n,
        entryCount: 0n,
        inputBytes: 0n,
      }),
    ).not.toThrow();
    expect(TRAINING_OVERVIEW_MAX_DISTINCT_EXERCISES).toBe(10_000);
    expect(TRAINING_OVERVIEW_MAX_ENTRIES).toBe(50_000);
    expect(TRAINING_OVERVIEW_MAX_INPUT_BYTES).toBe(6 * 1024 * 1024);
    expect(TRAINING_OVERVIEW_MAX_RESPONSE_BYTES).toBe(3 * 1024 * 1024);
  });

  it('rejects exceeding any preflight limit even for a paged response', () => {
    limitError(() =>
      assertTrainingOverviewWorkBound({
        ...validWork,
        distinctExerciseCount: 10_001n,
      }),
    );
    limitError(() =>
      assertTrainingOverviewWorkBound({ ...validWork, entryCount: 50_001n }),
    );
    limitError(() =>
      assertTrainingOverviewWorkBound({
        ...validWork,
        inputBytes: BigInt(6 * 1024 * 1024 + 1),
      }),
    );
  });

  it('rejects negative, unsafe or invalid count values rather than rounding them', () => {
    for (const field of [
      'distinctExerciseCount',
      'entryCount',
      'inputBytes',
    ] as const) {
      for (const count of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
        limitError(() =>
          assertTrainingOverviewWorkBound({ ...validWork, [field]: count }),
        );
      }
      // Defensive runtime validation at the boundary, despite the bigint API.
      for (const count of [
        NaN,
        Infinity,
        -Infinity,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        limitError(() =>
          assertTrainingOverviewWorkBound({ ...validWork, [field]: count }),
        );
      }
    }
  });

  it('measures the exact UTF-8 success envelope including Unicode and the timestamp', () => {
    const prefix = { name: 'á🧪' };
    const exact = {
      name: `${prefix.name}${'x'.repeat(3 * 1024 * 1024 - envelopeBytes(prefix))}`,
    };
    expect(envelopeBytes(exact)).toBe(3 * 1024 * 1024);
    expect(() => assertTrainingOverviewResponseBound(exact)).not.toThrow();
    limitError(() =>
      assertTrainingOverviewResponseBound({ name: `${exact.name}🧪` }),
    );
    expect(() => assertTrainingOverviewResponseBound(prefix)).not.toThrow();
  });

  it('never truncates an oversized response payload', () => {
    const data = ['x'.repeat(3 * 1024 * 1024)];
    limitError(() => assertTrainingOverviewResponseBound(data));
    expect(data[0]).toHaveLength(3 * 1024 * 1024);
  });
});

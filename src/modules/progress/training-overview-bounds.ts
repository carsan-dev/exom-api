import { PayloadTooLargeException } from '@nestjs/common';

export const TRAINING_OVERVIEW_MAX_DISTINCT_EXERCISES = 10_000;
export const TRAINING_OVERVIEW_MAX_ENTRIES = 50_000;
export const TRAINING_OVERVIEW_MAX_INPUT_BYTES = 6 * 1024 * 1024;
export const TRAINING_OVERVIEW_MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

interface TrainingOverviewWorkCounts {
  distinctExerciseCount: bigint;
  entryCount: bigint;
  inputBytes: bigint;
}

const limitExceeded = () =>
  new PayloadTooLargeException({
    code: 'TRAINING_OVERVIEW_LIMIT_EXCEEDED',
    message: 'Training overview limit exceeded',
  });

// Counts come from raw PostgreSQL bigint aggregates. Reject unsafe or malformed
// values before comparing bounds rather than coercing/rounding them to numbers.
function assertCountWithinLimit(value: bigint, limit: number): void {
  if (
    typeof value !== 'bigint' ||
    value < 0n ||
    value > BigInt(Number.MAX_SAFE_INTEGER) ||
    value > BigInt(limit)
  ) {
    throw limitExceeded();
  }
}

// Call before fetching/materializing either legacy or paged overview data.
export function assertTrainingOverviewWorkBound(
  counts: TrainingOverviewWorkCounts,
): void {
  assertCountWithinLimit(
    counts.distinctExerciseCount,
    TRAINING_OVERVIEW_MAX_DISTINCT_EXERCISES,
  );
  assertCountWithinLimit(counts.entryCount, TRAINING_OVERVIEW_MAX_ENTRIES);
  assertCountWithinLimit(counts.inputBytes, TRAINING_OVERVIEW_MAX_INPUT_BYTES);
}

// Matches TransformInterceptor's success/data/timestamp envelope. The fixed
// ISO string has the same 24-character JSON footprint as new Date().toISOString().
export function assertTrainingOverviewResponseBound(data: unknown): void {
  const json = JSON.stringify({
    success: true,
    data,
    timestamp: '2000-01-01T00:00:00.000Z',
  });
  if (Buffer.byteLength(json, 'utf8') > TRAINING_OVERVIEW_MAX_RESPONSE_BYTES) {
    throw limitExceeded();
  }
}

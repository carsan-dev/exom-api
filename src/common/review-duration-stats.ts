export interface ReviewDurationRow {
  reviewed_count: number | bigint;
  avg_seconds: number | null;
}

export interface ReviewDurationStats {
  avg_review_seconds: number | null;
  reviewed_in_period: number;
}

export function reviewDurationStats(
  rows: ReviewDurationRow[],
): ReviewDurationStats {
  const row = rows[0];
  const reviewed = row ? Number(row.reviewed_count) : 0;
  const average =
    reviewed > 0 && row?.avg_seconds !== null && row?.avg_seconds !== undefined
      ? Number(row.avg_seconds)
      : null;
  return {
    avg_review_seconds:
      average !== null && Number.isFinite(average) ? average : null,
    reviewed_in_period: reviewed,
  };
}

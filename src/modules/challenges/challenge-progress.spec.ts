import {
  calculateStreak,
  evaluateAutomaticProgress,
} from './challenge-progress';

describe('challenge eligibility periods', () => {
  const assignedAt = new Date('2026-10-01T00:00:00.000Z');
  const asOf = new Date('2026-10-06T12:00:00.000Z');
  const periods = [
    {
      starts_on: new Date('2026-10-01T00:00:00.000Z'),
      ends_on: new Date('2026-10-03T00:00:00.000Z'),
    },
    {
      starts_on: new Date('2026-10-05T00:00:00.000Z'),
      ends_on: null,
    },
  ];

  it('excludes the inactive calendar days for dated automatic rules', () => {
    const days = [
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ].map((date) => ({
      date: new Date(`${date}T00:00:00.000Z`),
      training_completed: true,
      meals_completed: ['breakfast'],
      training_recorded_at: new Date(`${date}T12:00:00.000Z`),
      meal_recorded_at: { breakfast: `${date}T12:00:00.000Z` },
    }));
    const weights = days.map(({ date, training_recorded_at }) => ({
      date,
      weight_kg: 70,
      recorded_at: training_recorded_at,
    }));

    expect(
      evaluateAutomaticProgress(
        'TRAINING_DAYS',
        assignedAt,
        null,
        days,
        weights,
        null,
        asOf,
        periods,
      ),
    ).toBe(3);
    expect(
      evaluateAutomaticProgress(
        'MEAL_CHECKINS',
        assignedAt,
        null,
        days,
        weights,
        null,
        asOf,
        periods,
      ),
    ).toBe(3);
    expect(
      evaluateAutomaticProgress(
        'WEIGHT_LOGS',
        assignedAt,
        null,
        days,
        weights,
        null,
        asOf,
        periods,
      ),
    ).toBe(3);
  });

  it('does not credit ambiguous re-entry-day streak activity', () => {
    const result = calculateStreak(
      [
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
        '2026-10-04',
        '2026-10-05',
      ].map((date) => ({ date: new Date(`${date}T00:00:00.000Z`) })),
      [
        '2026-10-01',
        '2026-10-02',
        '2026-10-03',
        '2026-10-04',
        '2026-10-05',
      ].map((date) => ({
        date: new Date(`${date}T00:00:00.000Z`),
        training_completed: true,
        exercises_completed: [],
        meals_completed: [],
        training_recorded_at: new Date(`${date}T12:00:00.000Z`),
      })),
      asOf,
      undefined,
      periods,
    );

    expect(result.currentDays).toBe(1);
  });

  it('does not retrospectively credit an inactive write to an eligible date', () => {
    const date = new Date('2026-10-02T00:00:00.000Z');
    const recordedAt = new Date('2026-10-04T12:00:00.000Z');
    const activity = {
      date,
      training_completed: true,
      meals_completed: ['breakfast'],
      training_recorded_at: recordedAt,
      meal_recorded_at: { breakfast: recordedAt.toISOString() },
    };
    const metrics = [{ date, weight_kg: 70, recorded_at: recordedAt }];
    for (const rule of [
      'TRAINING_DAYS',
      'MEAL_CHECKINS',
      'WEIGHT_LOGS',
    ] as const) {
      expect(
        evaluateAutomaticProgress(
          rule,
          assignedAt,
          null,
          [activity],
          metrics,
          null,
          asOf,
          periods,
        ),
      ).toBe(0);
    }
    expect(
      calculateStreak(
        [{ date }],
        [{ ...activity, exercises_completed: [] }],
        asOf,
        undefined,
        periods,
      ).currentDays,
    ).toBe(0);
  });

  it('requires date and event provenance in the same period and never invents legacy times', () => {
    const entry = {
      date: new Date('2026-10-02'),
      weight_kg: 70,
      recorded_at: new Date('2026-10-05T12:00:00Z'),
    };
    expect(
      evaluateAutomaticProgress(
        'WEIGHT_LOGS',
        assignedAt,
        null,
        [],
        [entry],
        null,
        asOf,
        periods,
      ),
    ).toBe(0);
    expect(
      evaluateAutomaticProgress(
        'WEIGHT_LOGS',
        assignedAt,
        null,
        [],
        [{ date: entry.date, weight_kg: 70 }],
        null,
        asOf,
        periods,
      ),
    ).toBe(0);
    expect(
      evaluateAutomaticProgress(
        'WEIGHT_LOGS',
        assignedAt,
        null,
        [],
        [entry],
        null,
        asOf,
      ),
    ).toBe(1);
  });
});

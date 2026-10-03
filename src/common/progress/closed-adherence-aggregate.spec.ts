import { evaluateDailyAdherence } from './daily-adherence-evaluator';
import {
  aggregateClosedAdherence,
  recentClosedAdherence,
  recentClosedDates,
} from './closed-adherence-aggregate';

const cutoffDate = '2026-09-29';
const day = (
  date: string,
  sessions: readonly ('complete' | 'incomplete')[],
  meals: readonly ('complete' | 'incomplete' | 'indeterminate')[],
) =>
  evaluateDailyAdherence({
    date,
    cutoffDate,
    training: {
      basis: 'known',
      rest: sessions.length === 0,
      units: sessions.map((completion, index) => ({
        id: `session-${index}`,
        completion,
      })),
    },
    nutrition: {
      basis: 'known',
      groups: meals.map((completion, index) => ({
        id: `meal-${index}`,
        completion,
      })),
    },
  });

describe('recent closed adherence', () => {
  const configuration = {
    known: true,
    version: 1,
    low_global_percent: 80,
    effective_date: '2020-01-01',
  };
  it.each([
    ['2020-03-01', '2020-04-01', '2020-02-24', '2020-03-01'],
    ['2020-01-01', '2020-02-01', '2019-12-26', '2020-01-01'],
    ['2026-10-20', '2026-09-29', '2026-09-22', '2026-09-28'],
    ['2026-09-29', '2026-09-29', '2026-09-22', '2026-09-28'],
  ])(
    'anchors seven consecutive closed civil dates at %s',
    (end, today, start, last) => {
      const dates = recentClosedDates(end, today);
      expect(dates).toHaveLength(7);
      expect(dates[0]).toBe(start);
      expect(dates[6]).toBe(last);
    },
  );
  it('does not substitute selected month totals for the last seven dates', () => {
    const input = [
      day('2026-09-01', Array(100).fill('complete'), []),
      ...recentClosedDates('2026-09-28', cutoffDate).map((date) =>
        day(date, ['incomplete'], []),
      ),
      day(cutoffDate, ['complete'], ['complete']),
      day('2026-09-30', ['complete'], ['complete']),
    ];
    expect(aggregateClosedAdherence(input).global.ratio).toBeGreaterThan(0.8);
    const result = recentClosedAdherence(
      input,
      '2026-09-28',
      cutoffDate,
      configuration,
    );
    expect(result).toMatchObject({
      start: '2026-09-22',
      end: '2026-09-28',
      status: 'low',
    });
    expect(result.aggregate.global.ratio).toBe(0);
    expect(result.aggregate).toEqual(
      aggregateClosedAdherence(input.slice(1, 8)),
    );
  });
  it.each([
    [80000, 'not_low'],
    [79999, 'low'],
  ] as const)(
    'compares strictly below the dated threshold without rounding %s',
    (complete, status) => {
      const input = recentClosedDates('2026-09-28', cutoffDate).map((date) =>
        day(date, [], []),
      );
      input[6] = day('2026-09-28', [], []);
      // Large session counts exercise the exact ratio boundary, not formatted percentages.
      input[6].training = {
        status: 'evaluable',
        numerator: complete,
        denominator: 100000,
        ratio: complete / 100000,
        caveats: [],
      };
      input[6].global = {
        ...input[6].global,
        status: 'evaluable',
        source: 'training_only',
        ratio: complete / 100000,
      };
      expect(
        recentClosedAdherence(input, '2026-09-28', cutoffDate, configuration)
          .status,
      ).toBe(status);
      expect(
        recentClosedAdherence(input, '2026-09-28', cutoffDate, {
          ...configuration,
          low_global_percent: 70,
        }).status,
      ).toBe('not_low');
    },
  );
  it('keeps missing original days/configuration explicit, never turning them into zero', () => {
    const input = [day('2026-09-28', ['incomplete'], [])];
    const result = recentClosedAdherence(
      input,
      '2026-09-28',
      cutoffDate,
      configuration,
    );
    expect(result.status).toBe('insufficient');
    expect(result.coverage).toMatchObject({
      expected: 7,
      available: 1,
      insufficient: 6,
    });
    expect(result.aggregate.training.denominator).toBe(1);
    const full = recentClosedDates('2026-09-28', cutoffDate).map((date) =>
      day(date, [], []),
    );
    expect(
      recentClosedAdherence(full, '2026-09-28', cutoffDate, configuration)
        .status,
    ).toBe('not_applicable');
    full[0] = day('2026-09-22', ['incomplete'], []);
    expect(
      recentClosedAdherence(full, '2026-09-28', cutoffDate, {
        known: false,
        version: null,
        low_global_percent: null,
        effective_date: null,
      }).status,
    ).toBe('insufficient');
    full[1] = evaluateDailyAdherence({
      date: '2026-09-23',
      cutoffDate,
      training: { basis: 'unknown', rest: false, units: [] },
      nutrition: { basis: 'unknown', groups: [] },
    });
    expect(
      recentClosedAdherence(full, '2026-09-28', cutoffDate, configuration)
        .coverage.insufficient,
    ).toBe(1);
  });
});

describe('aggregateClosedAdherence', () => {
  it('uses totals of sessions and binary nutrition days, then weights domain ratios equally', () => {
    const result = aggregateClosedAdherence([
      day('2026-09-27', ['complete'], ['complete', 'complete']),
      day(
        '2026-09-28',
        ['incomplete', 'incomplete', 'incomplete'],
        ['complete', 'incomplete'],
      ),
    ]);
    expect(result.training).toMatchObject({
      status: 'evaluable',
      numerator: 1,
      denominator: 4,
      ratio: 0.25,
    });
    expect(result.nutrition).toMatchObject({
      status: 'evaluable',
      numerator: 1,
      denominator: 2,
      ratio: 0.5,
    });
    expect(result.global).toMatchObject({
      status: 'evaluable',
      source: 'both',
      ratio: 0.375,
    });
  });

  it('counts an incomplete plus indeterminate diet day in the closed nutrition denominator', () => {
    const result = aggregateClosedAdherence([
      day('2026-09-27', [], ['incomplete', 'indeterminate']),
      day('2026-09-28', [], ['complete', 'complete']),
    ]);
    expect(result.nutrition).toEqual({
      status: 'evaluable',
      numerator: 1,
      denominator: 2,
      ratio: 0.5,
      caveats: ['indeterminate_nutrition'],
    });
    expect(result.global).toMatchObject({
      status: 'evaluable',
      source: 'nutrition_only',
      ratio: 0.5,
    });
    expect(result.global.caveats).toContain('indeterminate_nutrition');
  });

  it('falls back to an evaluable domain with rest and unknown caveats', () => {
    const unknown = evaluateDailyAdherence({
      date: '2026-09-27',
      cutoffDate,
      training: { basis: 'unknown', rest: false, units: [] },
      nutrition: { basis: 'known', groups: [] },
    });
    const result = aggregateClosedAdherence([
      unknown,
      day('2026-09-28', [], ['incomplete']),
    ]);
    expect(result.training.status).toBe('insufficient');
    expect(result.global).toMatchObject({
      status: 'evaluable',
      source: 'nutrition_only',
      ratio: 0,
    });
    expect(result.global.caveats).toContain('unknown_training_basis');
    expect(result.global.caveats).toContain('training_insufficient');
  });

  it('distinguishes all insufficient from all not applicable and empty input', () => {
    const unknown = evaluateDailyAdherence({
      date: '2026-09-28',
      cutoffDate,
      training: { basis: 'unknown', rest: false, units: [] },
      nutrition: { basis: 'unknown', groups: [] },
    });
    expect(aggregateClosedAdherence([unknown]).global.status).toBe(
      'insufficient',
    );
    expect(aggregateClosedAdherence([unknown]).global.ratio).toBeNull();
    expect(
      aggregateClosedAdherence([day('2026-09-28', [], [])]).global.status,
    ).toBe('not_applicable');
    expect(aggregateClosedAdherence([]).global.status).toBe('not_applicable');
  });

  it('excludes provisional and future days without changing their values', () => {
    const today = day(cutoffDate, ['complete'], ['complete']);
    const future = day('2026-09-30', ['complete'], ['complete']);
    const result = aggregateClosedAdherence([
      day('2026-09-28', ['incomplete'], ['incomplete']),
      today,
      future,
    ]);
    expect(result.training).toMatchObject({ numerator: 0, denominator: 1 });
    expect(result.nutrition).toMatchObject({ numerator: 0, denominator: 1 });
    expect(today.global.ratio).toBe(1);
    expect(future.global.status).toBe('neutral');
  });

  it('rejects duplicate civil dates even among excluded days and rejects oversized lists', () => {
    const today = day(cutoffDate, [], []);
    expect(() => aggregateClosedAdherence([today, today])).toThrow(RangeError);
    const future = day('2026-09-30', [], []);
    expect(() => aggregateClosedAdherence([future, future])).toThrow(
      RangeError,
    );
    expect(() => aggregateClosedAdherence(Array(367).fill(today))).toThrow(
      RangeError,
    );
  });

  it('leaves inputs and earlier results untouched', () => {
    const input = day('2026-09-28', ['complete'], ['complete']);
    const snapshot = JSON.stringify(input);
    const list = Object.freeze([Object.freeze(input)]);
    aggregateClosedAdherence(list);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(list).toHaveLength(1);
  });
});

import { evaluateDailyAdherence } from './daily-adherence-evaluator';
import { aggregateClosedAdherence } from './closed-adherence-aggregate';

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

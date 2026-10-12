import { evaluateDailyAdherence } from './daily-adherence-evaluator';

describe('evaluateDailyAdherence', () => {
  const cutoffDate = '2026-09-29';
  const closedDate = '2026-09-28';
  const training = {
    basis: 'known' as const,
    rest: false,
    units: [
      { id: 'morning', completion: 'complete' as const },
      { id: 'evening', completion: 'incomplete' as const },
    ],
  };
  const nutrition = {
    basis: 'known' as const,
    groups: [
      { id: 'breakfast', completion: 'complete' as const },
      { id: 'dinner-main-or-alternative', completion: 'complete' as const },
    ],
  };

  it('counts two independently prescribed sessions and each meal alternatives group once', () => {
    const result = evaluateDailyAdherence({
      date: closedDate,
      cutoffDate,
      training,
      nutrition,
    });
    expect(result.training).toMatchObject({
      status: 'evaluable',
      numerator: 1,
      denominator: 2,
      ratio: 0.5,
    });
    // Both classified groups complete the single prescribed diet day.
    expect(result.nutrition).toMatchObject({
      status: 'evaluable',
      numerator: 1,
      denominator: 1,
      ratio: 1,
    });
    expect(result.global).toEqual({
      status: 'evaluable',
      source: 'both',
      numerator: 3,
      denominator: 4,
      ratio: 0.75,
      caveats: [],
    });
    expect(result.date).toBe(closedDate);
    expect(result.period).toBe('closed');
    expect(result.includeInClosedAggregate).toBe(true);
  });

  it('counts a prescribed diet day only when every classified meal group is complete', () => {
    const result = evaluateDailyAdherence({
      date: closedDate,
      cutoffDate,
      training,
      nutrition: {
        basis: 'known',
        groups: [
          { id: 'breakfast', completion: 'complete' },
          { id: 'dinner-main-or-alternative', completion: 'incomplete' },
        ],
      },
    });
    expect(result.nutrition).toEqual({
      status: 'evaluable',
      numerator: 0,
      denominator: 1,
      ratio: 0,
      caveats: [],
    });
    expect(result.global).toEqual({
      status: 'evaluable',
      source: 'both',
      numerator: 1,
      denominator: 4,
      ratio: 0.25,
      caveats: [],
    });
  });

  it('counts a definitely incomplete diet day despite another indeterminate group', () => {
    const result = evaluateDailyAdherence({
      date: closedDate,
      cutoffDate,
      training,
      nutrition: {
        basis: 'known',
        groups: [
          { id: 'breakfast', completion: 'incomplete' },
          { id: 'dinner-main-or-alternative', completion: 'indeterminate' },
        ],
      },
    });
    expect(result.nutrition).toEqual({
      status: 'evaluable',
      numerator: 0,
      denominator: 1,
      ratio: 0,
      caveats: ['indeterminate_nutrition'],
    });
    expect(result.global).toEqual({
      status: 'evaluable',
      source: 'both',
      numerator: 1,
      denominator: 4,
      ratio: 0.25,
      caveats: ['indeterminate_nutrition'],
    });
  });

  it('does not count a day with an indeterminate required meal group as fully evaluable', () => {
    const result = evaluateDailyAdherence({
      date: closedDate,
      cutoffDate,
      training,
      nutrition: {
        basis: 'known',
        groups: [
          { id: 'breakfast', completion: 'complete' },
          { id: 'dinner-main-or-alternative', completion: 'indeterminate' },
        ],
      },
    });
    expect(result.nutrition).toEqual({
      status: 'insufficient',
      numerator: 0,
      denominator: 0,
      ratio: null,
      caveats: ['indeterminate_nutrition'],
    });
    expect(result.global).toEqual({
      status: 'evaluable',
      source: 'training_only',
      numerator: 1,
      denominator: 2,
      ratio: 0.5,
      caveats: ['nutrition_insufficient', 'indeterminate_nutrition'],
    });
  });

  it('keeps a rest day training-neutral while using the known diet groups', () => {
    const result = evaluateDailyAdherence({
      date: closedDate,
      cutoffDate,
      training: { basis: 'known', rest: true, units: [] },
      nutrition: {
        basis: 'known',
        groups: [{ id: 'lunch', completion: 'incomplete' }],
      },
    });
    expect(result.training).toMatchObject({
      status: 'not_applicable',
      numerator: 0,
      denominator: 0,
      ratio: null,
    });
    expect(result.global).toEqual({
      status: 'evaluable',
      source: 'nutrition_only',
      numerator: 0,
      denominator: 1,
      ratio: 0,
      caveats: ['training_not_applicable'],
    });
  });

  it('excludes ambiguous legacy units from both counts with a visible caveat and nutrition fallback', () => {
    const result = evaluateDailyAdherence({
      date: closedDate,
      cutoffDate,
      training: {
        basis: 'known',
        rest: false,
        units: [{ id: 'legacy', completion: 'indeterminate' }],
      },
      nutrition,
    });
    expect(result.training).toEqual({
      status: 'insufficient',
      numerator: 0,
      denominator: 0,
      ratio: null,
      caveats: ['indeterminate_training'],
    });
    expect(result.global).toEqual({
      status: 'evaluable',
      source: 'nutrition_only',
      numerator: 1,
      denominator: 1,
      ratio: 1,
      caveats: ['training_insufficient', 'indeterminate_training'],
    });
  });

  it('does not turn missing historical bases into zero or not applicable', () => {
    const result = evaluateDailyAdherence({
      date: closedDate,
      cutoffDate,
      training: { basis: 'unknown', rest: false, units: [] },
      nutrition: { basis: 'unknown', groups: [] },
    });
    expect(result.training).toMatchObject({
      status: 'insufficient',
      ratio: null,
      caveats: ['unknown_training_basis'],
    });
    expect(result.nutrition).toMatchObject({
      status: 'insufficient',
      ratio: null,
      caveats: ['unknown_nutrition_basis'],
    });
    expect(result.global).toMatchObject({
      status: 'insufficient',
      ratio: null,
      numerator: 0,
      denominator: 0,
    });
  });

  it('rejects a legacy raw training basis rather than counting its units', () => {
    const legacyTraining = { ...training };
    Reflect.set(legacyTraining, 'basis', 'legacy_available');
    expect(() =>
      evaluateDailyAdherence({
        date: closedDate,
        cutoffDate,
        training: legacyTraining,
        nutrition,
      }),
    ).toThrow(new RangeError('Invalid historical basis'));
  });

  it('rejects a legacy raw nutrition basis rather than counting its groups', () => {
    const legacyNutrition = { ...nutrition };
    Reflect.set(legacyNutrition, 'basis', 'legacy_available');
    expect(() =>
      evaluateDailyAdherence({
        date: closedDate,
        cutoffDate,
        training,
        nutrition: legacyNutrition,
      }),
    ).toThrow(new RangeError('Invalid historical basis'));
  });

  it('distinguishes known empty prescriptions from unknown evidence', () => {
    const result = evaluateDailyAdherence({
      date: closedDate,
      cutoffDate,
      training: { basis: 'known', rest: false, units: [] },
      nutrition: { basis: 'known', groups: [] },
    });
    expect(result.global).toEqual({
      status: 'not_applicable',
      source: 'none',
      numerator: 0,
      denominator: 0,
      ratio: null,
      caveats: [],
    });
  });

  it('excludes today from closed aggregates but computes its provisional ratio; future is neutral', () => {
    const today = evaluateDailyAdherence({
      date: cutoffDate,
      cutoffDate,
      training,
      nutrition,
    });
    const future = evaluateDailyAdherence({
      date: '2026-09-30',
      cutoffDate,
      training,
      nutrition,
    });
    expect(today).toMatchObject({
      date: cutoffDate,
      period: 'provisional',
      includeInClosedAggregate: false,
      global: { ratio: 0.75 },
    });
    expect(future).toMatchObject({
      date: '2026-09-30',
      period: 'future',
      includeInClosedAggregate: false,
      global: { status: 'neutral', ratio: null, numerator: 0, denominator: 0 },
    });
  });

  it('uses only supplied UTC civil dates, not the system clock', () => {
    expect(
      evaluateDailyAdherence({
        date: closedDate,
        cutoffDate: closedDate,
        training,
        nutrition,
      }).period,
    ).toBe('provisional');
    expect(
      evaluateDailyAdherence({
        date: closedDate,
        cutoffDate: '2026-09-27',
        training,
        nutrition,
      }).period,
    ).toBe('future');
    expect(() =>
      evaluateDailyAdherence({
        date: '2026-09-31',
        cutoffDate,
        training,
        nutrition,
      }),
    ).toThrow('Invalid UTC civil date');
  });

  it('late replay changes only supplied evidence and does not mutate an earlier result or prescription', () => {
    const original = { date: closedDate, cutoffDate, training, nutrition };
    const before = evaluateDailyAdherence(original);
    const after = evaluateDailyAdherence({
      ...original,
      training: {
        ...training,
        units: training.units.map((unit) => ({
          ...unit,
          completion: 'complete' as const,
        })),
      },
    });
    expect(before.global.ratio).toBe(0.75);
    expect(after.global.ratio).toBe(1);
    expect(before.training.numerator).toBe(1);
    expect(training.units[1].completion).toBe('incomplete');
    expect(before.global.ratio).toBe(0.75);
  });
});

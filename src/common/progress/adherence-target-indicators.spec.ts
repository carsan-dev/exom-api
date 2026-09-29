import {
  evaluateTargetIndicators,
  INDICATOR_STATUS,
} from './adherence-target-indicators';
import { evaluateDailyAdherence } from './daily-adherence-evaluator';

const base = {
  prescription: { total_calories: 2000, total_protein_g: 100 },
  intake: { estimated_calories: 2000, estimated_protein_g: 100 },
  config: {
    calorie_lower_percent: 10,
    calorie_upper_percent: 20,
    protein_min_percent: 90,
    steps_goal: 10000,
    steps_min_percent: 100,
  },
  weeklyRecap: { average_daily_steps: 10000 },
};

function calorieStatus(value: number) {
  return evaluateTargetIndicators({
    ...base,
    intake: { ...base.intake, estimated_calories: value },
  }).calories.status;
}

describe('pure numeric adherence indicators', () => {
  it('includes exact asymmetric calorie edges, and distinguishes outside edges', () => {
    expect(calorieStatus(1800)).toBe(INDICATOR_STATUS.MET);
    expect(calorieStatus(2400)).toBe(INDICATOR_STATUS.MET);
    expect(calorieStatus(1799)).toBe(INDICATOR_STATUS.BELOW);
    expect(calorieStatus(2401)).toBe(INDICATOR_STATUS.ABOVE);
  });

  it('includes exact protein and weekly step thresholds, and excludes below', () => {
    const edge = evaluateTargetIndicators({
      ...base,
      intake: { estimated_calories: 2000, estimated_protein_g: 90 },
    });
    expect(edge.protein.status).toBe(INDICATOR_STATUS.MET);
    expect(edge.weeklySteps.status).toBe(INDICATOR_STATUS.MET);
    const belowProtein = evaluateTargetIndicators({
      ...base,
      intake: { ...base.intake, estimated_protein_g: 89.99 },
    });
    expect(belowProtein.protein.status).toBe(INDICATOR_STATUS.BELOW);
    const belowSteps = evaluateTargetIndicators({
      ...base,
      weeklyRecap: { average_daily_steps: 9999 },
    });
    expect(belowSteps.weeklySteps.status).toBe(INDICATOR_STATUS.BELOW);
    const reducedThreshold = evaluateTargetIndicators({
      ...base,
      config: { ...base.config, steps_min_percent: 80 },
      weeklyRecap: { average_daily_steps: 8000 },
    });
    expect(reducedThreshold.weeklySteps.status).toBe(INDICATOR_STATUS.MET);
  });

  it('treats missing or unsupported historical targets and marked intake as insufficient', () => {
    const missing = evaluateTargetIndicators({
      ...base,
      prescription: { total_calories: null, total_protein_g: 0 },
    });
    expect(missing.calories.status).toBe(INDICATOR_STATUS.INSUFFICIENT);
    expect(missing.protein.status).toBe(INDICATOR_STATUS.INSUFFICIENT);
    const zero = evaluateTargetIndicators({
      ...base,
      prescription: { total_calories: 0, total_protein_g: null },
    });
    expect(zero.calories.status).toBe(INDICATOR_STATUS.INSUFFICIENT);
    expect(zero.protein.status).toBe(INDICATOR_STATUS.INSUFFICIENT);
    const intakeMissing = evaluateTargetIndicators({
      ...base,
      intake: { estimated_calories: null, estimated_protein_g: null },
    });
    expect(intakeMissing.calories.status).toBe(INDICATOR_STATUS.INSUFFICIENT);
    expect(intakeMissing.protein.status).toBe(INDICATOR_STATUS.INSUFFICIENT);
  });

  it('requires a recap for steps; a null goal is not applicable even without a recap', () => {
    const noRecap = evaluateTargetIndicators({ ...base, weeklyRecap: null });
    expect(noRecap.weeklySteps.status).toBe(INDICATOR_STATUS.INSUFFICIENT);
    const noSteps = evaluateTargetIndicators({
      ...base,
      weeklyRecap: { average_daily_steps: null },
    });
    expect(noSteps.weeklySteps.status).toBe(INDICATOR_STATUS.INSUFFICIENT);
    const noGoal = evaluateTargetIndicators({
      ...base,
      config: { ...base.config, steps_goal: null },
      weeklyRecap: null,
    });
    expect(noGoal.weeklySteps.status).toBe(INDICATOR_STATUS.NOT_APPLICABLE);
    const zeroSteps = evaluateTargetIndicators({
      ...base,
      weeklyRecap: { average_daily_steps: 0 },
    });
    expect(zeroSteps.weeklySteps.status).toBe(INDICATOR_STATUS.BELOW);
  });

  it('rejects invalid numbers and percentages instead of treating them as zero', () => {
    for (const value of [NaN, Infinity, -1]) {
      expect(() => calorieStatus(value)).toThrow(RangeError);
      expect(() =>
        evaluateTargetIndicators({
          ...base,
          prescription: { ...base.prescription, total_protein_g: value },
        }),
      ).toThrow(RangeError);
      expect(() =>
        evaluateTargetIndicators({
          ...base,
          weeklyRecap: { average_daily_steps: value },
        }),
      ).toThrow(RangeError);
      expect(() =>
        evaluateTargetIndicators({
          ...base,
          config: { ...base.config, steps_goal: value },
        }),
      ).toThrow(RangeError);
    }
    const invalidPercentages = [
      { calorie_lower_percent: 101 },
      { calorie_upper_percent: -1 },
      { protein_min_percent: 201 },
      { steps_min_percent: Infinity },
      { calorie_lower_percent: 1.5 },
      { steps_goal: 0 },
    ];
    for (const invalid of invalidPercentages) {
      expect(() =>
        evaluateTargetIndicators({
          ...base,
          config: { ...base.config, ...invalid },
        }),
      ).toThrow(RangeError);
    }
  });

  it('rejects an overflowed calorie upper bound before reporting met', () => {
    expect(() =>
      evaluateTargetIndicators({
        ...base,
        prescription: {
          ...base.prescription,
          total_calories: Number.MAX_VALUE,
        },
        config: { ...base.config, calorie_upper_percent: 10 },
      }),
    ).toThrow(RangeError);
  });

  it('rejects an overflowed protein threshold before reporting below', () => {
    expect(() =>
      evaluateTargetIndicators({
        ...base,
        prescription: {
          ...base.prescription,
          total_protein_g: Number.MAX_VALUE,
        },
        config: { ...base.config, protein_min_percent: 200 },
      }),
    ).toThrow(RangeError);
  });

  it('rejects unrepresentable and unsafe integer step goals before classification', () => {
    for (const steps_goal of [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        evaluateTargetIndicators({
          ...base,
          config: { ...base.config, steps_goal, steps_min_percent: 200 },
        }),
      ).toThrow(RangeError);
    }
  });

  it('never changes the independent daily global percentage', () => {
    const day = {
      date: '2026-09-27',
      cutoffDate: '2026-09-28',
      training: {
        basis: 'known' as const,
        rest: false,
        units: [{ id: 'a', completion: 'complete' as const }],
      },
      nutrition: {
        basis: 'known' as const,
        groups: [{ id: 'meal', completion: 'incomplete' as const }],
      },
    };
    const before = evaluateDailyAdherence(day).global;
    const indicators = evaluateTargetIndicators({
      ...base,
      intake: { estimated_calories: 0, estimated_protein_g: 0 },
      weeklyRecap: null,
    });
    expect(indicators.calories.status).toBe(INDICATOR_STATUS.BELOW);
    expect(indicators.protein.status).toBe(INDICATOR_STATUS.BELOW);
    expect(indicators.weeklySteps.status).toBe(INDICATOR_STATUS.INSUFFICIENT);
    expect(evaluateDailyAdherence(day).global).toEqual(before);
    expect(before.ratio).toBe(0.5);
  });
});

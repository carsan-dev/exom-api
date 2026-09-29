export const INDICATOR_STATUS = {
  MET: 'met',
  BELOW: 'below',
  ABOVE: 'above',
  INSUFFICIENT: 'insufficient',
  NOT_APPLICABLE: 'not_applicable',
} as const;
export type IndicatorStatus =
  (typeof INDICATOR_STATUS)[keyof typeof INDICATOR_STATUS];

// Only totals from the historical prescribed DietDaySnapshot are accepted.
export interface PrescribedDietDaySnapshotTotals {
  total_calories: number | null;
  total_protein_g: number | null;
}

export interface MarkedIntakeEstimate {
  estimated_calories: number | null;
  estimated_protein_g: number | null;
}

export interface EffectiveIndicatorConfig {
  calorie_lower_percent: number;
  calorie_upper_percent: number;
  protein_min_percent: number;
  steps_goal: number | null;
  steps_min_percent: number;
}

export interface WeeklyStepsRecap {
  average_daily_steps: number | null;
}

export interface TargetIndicatorInput {
  prescription: PrescribedDietDaySnapshotTotals;
  intake: MarkedIntakeEstimate;
  config: EffectiveIndicatorConfig;
  weeklyRecap: WeeklyStepsRecap | null;
}

export interface TargetIndicator {
  status: IndicatorStatus;
}

export interface TargetIndicators {
  calories: TargetIndicator;
  protein: TargetIndicator;
  weeklySteps: TargetIndicator;
}

function checkNonNegative(value: number | null, name: string): void {
  if (
    value !== null &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
  ) {
    throw new RangeError(`Invalid ${name}`);
  }
}

function checkPercent(value: number, maximum: number, name: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new RangeError(`Invalid ${name}`);
  }
}

export function evaluateTargetIndicators(
  input: TargetIndicatorInput,
): TargetIndicators {
  const { prescription, intake, config, weeklyRecap } = input;
  checkNonNegative(prescription.total_calories, 'total_calories');
  checkNonNegative(prescription.total_protein_g, 'total_protein_g');
  checkNonNegative(intake.estimated_calories, 'estimated_calories');
  checkNonNegative(intake.estimated_protein_g, 'estimated_protein_g');
  if (weeklyRecap !== null) {
    checkNonNegative(weeklyRecap.average_daily_steps, 'average_daily_steps');
  }
  if (
    config.steps_goal !== null &&
    (typeof config.steps_goal !== 'number' ||
      !Number.isSafeInteger(config.steps_goal) ||
      config.steps_goal < 1)
  ) {
    throw new RangeError('Invalid steps_goal');
  }
  checkPercent(config.calorie_lower_percent, 100, 'calorie_lower_percent');
  checkPercent(config.calorie_upper_percent, 100, 'calorie_upper_percent');
  checkPercent(config.protein_min_percent, 200, 'protein_min_percent');
  checkPercent(config.steps_min_percent, 200, 'steps_min_percent');

  let calories: IndicatorStatus = INDICATOR_STATUS.INSUFFICIENT;
  if (
    prescription.total_calories !== null &&
    prescription.total_calories > 0 &&
    intake.estimated_calories !== null
  ) {
    const lower =
      prescription.total_calories * (1 - config.calorie_lower_percent / 100);
    const upper =
      prescription.total_calories * (1 + config.calorie_upper_percent / 100);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
      throw new RangeError('Invalid calorie bounds');
    }
    if (intake.estimated_calories < lower) calories = INDICATOR_STATUS.BELOW;
    else if (intake.estimated_calories > upper)
      calories = INDICATOR_STATUS.ABOVE;
    else calories = INDICATOR_STATUS.MET;
  }

  let protein: IndicatorStatus = INDICATOR_STATUS.INSUFFICIENT;
  if (
    prescription.total_protein_g !== null &&
    prescription.total_protein_g > 0 &&
    intake.estimated_protein_g !== null
  ) {
    const threshold =
      (prescription.total_protein_g * config.protein_min_percent) / 100;
    if (!Number.isFinite(threshold)) {
      throw new RangeError('Invalid protein threshold');
    }
    protein =
      intake.estimated_protein_g >= threshold
        ? INDICATOR_STATUS.MET
        : INDICATOR_STATUS.BELOW;
  }

  let weeklySteps: IndicatorStatus = INDICATOR_STATUS.NOT_APPLICABLE;
  if (config.steps_goal !== null) {
    if (weeklyRecap === null || weeklyRecap.average_daily_steps === null) {
      weeklySteps = INDICATOR_STATUS.INSUFFICIENT;
    } else {
      const threshold = (config.steps_goal * config.steps_min_percent) / 100;
      if (!Number.isFinite(threshold)) {
        throw new RangeError('Invalid steps threshold');
      }
      weeklySteps =
        weeklyRecap.average_daily_steps >= threshold
          ? INDICATOR_STATUS.MET
          : INDICATOR_STATUS.BELOW;
    }
  }
  return {
    calories: { status: calories },
    protein: { status: protein },
    weeklySteps: { status: weeklySteps },
  };
}

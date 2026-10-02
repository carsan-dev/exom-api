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

export interface DatedWeeklyStepsTarget {
  date: string;
  steps_goal: number | null;
  steps_min_percent: number | null;
}

export interface WeeklyStepsIndicator extends TargetIndicator {
  threshold: number | null;
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

function classifyWeeklySteps(
  recap: WeeklyStepsRecap | null,
  threshold: number,
): IndicatorStatus {
  if (recap === null || recap.average_daily_steps === null)
    return INDICATOR_STATUS.INSUFFICIENT;
  checkNonNegative(recap.average_daily_steps, 'average_daily_steps');
  return recap.average_daily_steps >= threshold
    ? INDICATOR_STATUS.MET
    : INDICATOR_STATUS.BELOW;
}

/** A recap describes the complete Monday..Sunday UTC week, never a selected
 * period subset. Average each day's threshold, not goals/percentages separately.
 * Null or missing policy on any date makes that whole week's target unknown. */
export function evaluateWeeklyStepsIndicator(
  weekStart: string,
  days: readonly DatedWeeklyStepsTarget[],
  recap: WeeklyStepsRecap | null,
): WeeklyStepsIndicator {
  const insufficient: WeeklyStepsIndicator = {
    status: INDICATOR_STATUS.INSUFFICIENT,
    threshold: null,
  };
  const start = new Date(`${weekStart}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(weekStart) ||
    !Number.isFinite(start.getTime()) ||
    start.toISOString().slice(0, 10) !== weekStart ||
    start.getUTCDay() !== 1 ||
    days.length !== 7
  )
    return insufficient;
  const byDate = new Map(days.map((day) => [day.date, day]));
  if (byDate.size !== 7) return insufficient;
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const date = new Date(start.getTime() + i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const day = byDate.get(date);
    if (!day || day.steps_goal === null || day.steps_min_percent === null)
      return insufficient;
    if (!Number.isSafeInteger(day.steps_goal) || day.steps_goal < 1)
      throw new RangeError('Invalid steps_goal');
    checkPercent(day.steps_min_percent, 200, 'steps_min_percent');
    total += (day.steps_goal * day.steps_min_percent) / 100;
  }
  const threshold = total / 7;
  if (!Number.isFinite(threshold))
    throw new RangeError('Invalid weekly steps threshold');
  return { status: classifyWeeklySteps(recap, threshold), threshold };
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
    const threshold = (config.steps_goal * config.steps_min_percent) / 100;
    if (!Number.isFinite(threshold)) {
      throw new RangeError('Invalid steps threshold');
    }
    weeklySteps = classifyWeeklySteps(weeklyRecap, threshold);
  }
  return {
    calories: { status: calories },
    protein: { status: protein },
    weeklySteps: { status: weeklySteps },
  };
}

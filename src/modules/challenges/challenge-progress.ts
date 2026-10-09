import type { ChallengeRuleKey } from './challenges.constants';

export interface ChallengeEligibilityPeriod {
  starts_on: Date;
  ends_on: Date | null;
  opened_at?: Date;
  baseline_value?: number;
}

export interface StreakAssignment {
  date: Date;
}

export interface StreakProgress {
  date: Date;
  training_completed: boolean;
  exercises_completed: unknown;
  meals_completed: string[];
  updated_at?: Date;
  training_recorded_at?: Date | null;
  exercise_recorded_at?: Date | null;
  meal_recorded_at?: Record<string, string>;
}

export function normalizeDate(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function normalizeEndOfDay(date: Date) {
  const normalized = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  normalized.setUTCHours(23, 59, 59, 999);
  return normalized;
}

export function getChallengeWindow(
  assignedAt: Date,
  deadline: Date | null,
  asOf = new Date(),
) {
  const start = normalizeDate(assignedAt);
  const now = asOf;
  const deadlineEnd = deadline ? normalizeEndOfDay(deadline) : now;
  const end = deadlineEnd.getTime() < now.getTime() ? deadlineEnd : now;

  return { start, end };
}

export function isDateInRange(date: Date, start: Date, end: Date) {
  const value = date.getTime();
  return value >= start.getTime() && value <= end.getTime();
}

export function isDateInEligibilityPeriods(
  date: Date,
  periods: ChallengeEligibilityPeriod[],
) {
  const day = normalizeDate(date).getTime();
  return periods.some(({ starts_on, ends_on }) => {
    const startsOn = normalizeDate(starts_on).getTime();
    const endsOn = ends_on ? normalizeDate(ends_on).getTime() : undefined;
    return day >= startsOn && (endsOn === undefined || day < endsOn);
  });
}

function isEligibleActivity(
  date: Date,
  recordedAt: Date | string | null | undefined,
  periods?: ChallengeEligibilityPeriod[],
) {
  if (!periods) return true;
  if (!recordedAt) return false;
  const recorded = new Date(recordedAt);
  return periods.some(
    (period) =>
      isDateInEligibilityPeriods(date, [period]) &&
      isDateInEligibilityPeriods(recorded, [period]) &&
      (!period.opened_at || recorded >= period.opened_at),
  );
}

function hasStreakActivity(
  progress: StreakProgress,
  periods?: ChallengeEligibilityPeriod[],
) {
  return (
    (progress.training_completed &&
      isEligibleActivity(
        progress.date,
        progress.training_recorded_at,
        periods,
      )) ||
    (Array.isArray(progress.exercises_completed) &&
      progress.exercises_completed.length > 0 &&
      isEligibleActivity(
        progress.date,
        progress.exercise_recorded_at,
        periods,
      )) ||
    progress.meals_completed.some((id) =>
      isEligibleActivity(
        progress.date,
        progress.meal_recorded_at?.[id],
        periods,
      ),
    )
  );
}

export function calculateStreak(
  assignments: StreakAssignment[],
  progresses: StreakProgress[],
  asOf: Date,
  trackingStartedAt?: Date | null,
  eligibilityPeriods?: ChallengeEligibilityPeriod[],
) {
  const normalizedAsOf = normalizeDate(asOf);
  const activityByDate = new Map(
    progresses.map((progress) => [
      normalizeDate(progress.date).getTime(),
      (!trackingStartedAt ||
        !progress.updated_at ||
        progress.updated_at >= trackingStartedAt) &&
        hasStreakActivity(progress, eligibilityPeriods),
    ]),
  );
  let currentDays = 0;
  let longestDays = 0;
  let lastActiveDate: Date | null = null;

  for (const assignment of assignments) {
    const date = normalizeDate(assignment.date);
    if (date > normalizedAsOf) continue;
    const active =
      (!eligibilityPeriods ||
        isDateInEligibilityPeriods(date, eligibilityPeriods)) &&
      (activityByDate.get(date.getTime()) ?? false);

    if (!active && date.getTime() === normalizedAsOf.getTime()) continue;
    if (active) {
      currentDays += 1;
      longestDays = Math.max(longestDays, currentDays);
      lastActiveDate = date;
    } else {
      currentDays = 0;
    }
  }

  return { currentDays, longestDays, lastActiveDate };
}

export function evaluateAutomaticProgress(
  ruleKey: ChallengeRuleKey | null,
  assignedAt: Date,
  deadline: Date | null,
  dayProgress: Array<{
    date: Date;
    training_completed: boolean;
    meals_completed: string[];
    training_recorded_at?: Date | null;
    meal_recorded_at?: Record<string, string>;
  }>,
  bodyMetrics: Array<{
    date: Date;
    weight_kg: number | null;
    recorded_at?: Date | null;
  }>,
  streak: { current_days: number } | null,
  asOf: Date,
  eligibilityPeriods?: ChallengeEligibilityPeriod[],
) {
  const { start, end } = getChallengeWindow(assignedAt, deadline, asOf);

  switch (ruleKey) {
    case 'TRAINING_DAYS':
      return dayProgress.filter(
        (entry) =>
          entry.training_completed &&
          isDateInRange(entry.date, start, end) &&
          isEligibleActivity(
            entry.date,
            entry.training_recorded_at,
            eligibilityPeriods,
          ),
      ).length;
    case 'MEAL_CHECKINS':
      return dayProgress.reduce((total, entry) => {
        if (
          !isDateInRange(entry.date, start, end) ||
          (eligibilityPeriods &&
            !isDateInEligibilityPeriods(entry.date, eligibilityPeriods))
        ) {
          return total;
        }

        return (
          total +
          entry.meals_completed.filter((id) =>
            isEligibleActivity(
              entry.date,
              entry.meal_recorded_at?.[id],
              eligibilityPeriods,
            ),
          ).length
        );
      }, 0);
    case 'WEIGHT_LOGS': {
      const uniqueDays = new Set(
        bodyMetrics
          .filter(
            (entry) =>
              entry.weight_kg != null &&
              isDateInRange(entry.date, start, end) &&
              isEligibleActivity(
                entry.date,
                entry.recorded_at,
                eligibilityPeriods,
              ),
          )
          .map((entry) => normalizeDate(entry.date).toISOString()),
      );

      return uniqueDays.size;
    }
    case 'STREAK_DAYS':
      return streak?.current_days ?? 0;
    default:
      return 0;
  }
}

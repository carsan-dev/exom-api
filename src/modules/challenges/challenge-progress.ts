import type { ChallengeRuleKey } from './challenges.constants';

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

export function evaluateAutomaticProgress(
  ruleKey: ChallengeRuleKey | null,
  assignedAt: Date,
  deadline: Date | null,
  dayProgress: Array<{
    date: Date;
    training_completed: boolean;
    meals_completed: string[];
  }>,
  bodyMetrics: Array<{
    date: Date;
    weight_kg: number | null;
  }>,
  streak: { current_days: number } | null,
  asOf: Date,
) {
  const { start, end } = getChallengeWindow(assignedAt, deadline, asOf);

  switch (ruleKey) {
    case 'TRAINING_DAYS':
      return dayProgress.filter(
        (entry) =>
          entry.training_completed && isDateInRange(entry.date, start, end),
      ).length;
    case 'MEAL_CHECKINS':
      return dayProgress.reduce((total, entry) => {
        if (!isDateInRange(entry.date, start, end)) {
          return total;
        }

        return total + entry.meals_completed.length;
      }, 0);
    case 'WEIGHT_LOGS': {
      const uniqueDays = new Set(
        bodyMetrics
          .filter(
            (entry) =>
              entry.weight_kg != null && isDateInRange(entry.date, start, end),
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

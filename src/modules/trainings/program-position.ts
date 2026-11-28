// Program week/day of a date for GET /trainings/day (L4b, decision L4b-D6).
// Pure date arithmetic on UTC date-only values: no clock, no I/O.

export interface ProgramRuleDay {
  weekday: number;
  is_rest_day: boolean;
  training_id: string | null;
  training: { is_active: boolean } | null;
  trainings: ReadonlyArray<{ training: { is_active: boolean } | null }>;
}

export interface ProgramRule {
  id: string;
  is_active: boolean;
  created_at: Date;
  starts_on: Date;
  ends_on: Date | null;
  days: readonly ProgramRuleDay[];
}

export interface ProgramPosition {
  program_week: number | null;
  program_day: number | null;
}

const DAY_MS = 86_400_000;

function utcDayNumber(date: Date): number {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) /
      DAY_MS,
  );
}

function isoWeekday(date: Date): number {
  return date.getUTCDay() || 7;
}

function mondayDayNumber(date: Date): number {
  return utcDayNumber(date) - (isoWeekday(date) - 1);
}

function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

function coversDate(rule: ProgramRule, date: Date): boolean {
  if (!isValidDate(rule.starts_on)) return false;
  const day = utcDayNumber(date);
  if (day < utcDayNumber(rule.starts_on)) return false;
  if (rule.ends_on === null) return true;
  return isValidDate(rule.ends_on) && day <= utcDayNumber(rule.ends_on);
}

// Same criterion as AutoAssignmentMaterializerService.desiredAssignment: a
// rest day never trains; linked trainings win over the legacy training_id and
// inactive trainings are ignored.
function isTrainingDay(day: ProgramRuleDay): boolean {
  if (day.is_rest_day) return false;
  if (day.trainings.length > 0) {
    return day.trainings.some((link) => link.training?.is_active !== false);
  }
  return Boolean(day.training_id) && day.training?.is_active !== false;
}

function trainingWeekdays(days: readonly ProgramRuleDay[]): number[] {
  const firstDayByWeekday = new Map<number, ProgramRuleDay>();
  for (const day of days) {
    const valid =
      Number.isInteger(day.weekday) && day.weekday >= 1 && day.weekday <= 7;
    if (valid && !firstDayByWeekday.has(day.weekday)) {
      firstDayByWeekday.set(day.weekday, day);
    }
  }
  return [...firstDayByWeekday.values()]
    .filter(isTrainingDay)
    .map((day) => day.weekday)
    .sort((left, right) => left - right);
}

/**
 * L4b-D6. With `assignmentRuleId` (the date's assignment was materialized by
 * a rule) that rule is used whether active or not, with no fallback. Otherwise
 * the active rule covering the date, newest `created_at` then highest `id`.
 */
export function selectProgramRule<TRule extends ProgramRule>(
  assignmentRuleId: string | null,
  rules: readonly TRule[],
  date: Date,
): TRule | null {
  if (assignmentRuleId) {
    return rules.find((rule) => rule.id === assignmentRuleId) ?? null;
  }
  const candidates = rules
    .filter((rule) => rule.is_active && coversDate(rule, date))
    .sort((left, right) => {
      const byCreatedAt =
        right.created_at.getTime() - left.created_at.getTime();
      if (byCreatedAt !== 0) return byCreatedAt;
      return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
    });
  return candidates[0] ?? null;
}

/**
 * `program_week`: 1 + whole Monday-Sunday weeks between the Monday of
 * `starts_on` and the Monday of `date`, when the rule covers the date.
 * `program_day`: 1-based position of the date's ISO weekday among the rule's
 * training weekdays, or null when the date is not a training day.
 */
export function deriveProgramPosition(
  rule: ProgramRule | null,
  date: Date,
): ProgramPosition {
  if (!rule || !isValidDate(date) || !coversDate(rule, date)) {
    return { program_week: null, program_day: null };
  }
  const weeks = (mondayDayNumber(date) - mondayDayNumber(rule.starts_on)) / 7;
  const dayIndex = trainingWeekdays(rule.days).indexOf(isoWeekday(date));
  return {
    program_week: weeks + 1,
    program_day: dayIndex === -1 ? null : dayIndex + 1,
  };
}

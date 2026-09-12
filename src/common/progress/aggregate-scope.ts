import { Prisma } from '@prisma/client';

export const AGGREGATE_RULES = [
  'TRAINING_DAYS',
  'MEAL_CHECKINS',
  'WEIGHT_LOGS',
  'STREAK_DAYS',
  'CHALLENGES_COMPLETED',
] as const;
export type AggregateRule = (typeof AGGREGATE_RULES)[number];

export interface ProgressActivity {
  training_completed: boolean;
  exercises_completed: Prisma.JsonValue;
  meals_completed: string[];
  updated_at: Date;
}

export function hasProgressActivity(
  progress: ProgressActivity | null,
): boolean {
  return (
    !!progress &&
    (progress.training_completed ||
      (Array.isArray(progress.exercises_completed) &&
        progress.exercises_completed.length > 0) ||
      progress.meals_completed.length > 0)
  );
}

export function affectedProgressRules(
  previous: ProgressActivity | null,
  current: ProgressActivity,
  streakChanged: boolean,
): AggregateRule[] {
  const rules: AggregateRule[] = [];
  if ((previous?.training_completed ?? false) !== current.training_completed)
    rules.push('TRAINING_DAYS');
  if (
    (previous?.meals_completed.length ?? 0) !== current.meals_completed.length
  )
    rules.push('MEAL_CHECKINS');
  if (streakChanged) rules.push('STREAK_DAYS');
  return rules;
}

// Unknown/legacy payloads retain full canonical reconciliation during rolling upgrades.
export function aggregateScope(
  payload: Prisma.JsonValue,
): AggregateRule[] | undefined {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    payload.version !== 1 ||
    !payload.scopes ||
    typeof payload.scopes !== 'object' ||
    Array.isArray(payload.scopes)
  )
    return undefined;
  if (
    Object.entries(payload.scopes).some(
      ([key, value]) =>
        value !== true || !AGGREGATE_RULES.some((rule) => rule === key),
    )
  )
    return undefined;
  return AGGREGATE_RULES.filter(
    (rule) =>
      payload.scopes &&
      typeof payload.scopes === 'object' &&
      !Array.isArray(payload.scopes) &&
      payload.scopes[rule] === true,
  );
}

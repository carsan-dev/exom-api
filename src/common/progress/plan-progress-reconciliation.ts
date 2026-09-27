import { Prisma } from '@prisma/client';

export interface CompletedExerciseEntry {
  training_exercise_id?: string;
  training_session_id?: string | null;
  exercise_id: string;
  [key: string]: unknown;
}

export interface CurrentTrainingExercise {
  id: string;
  exercise_id: string;
}

export function reconcileTrainingProgress(
  value: Prisma.JsonValue,
  currentExercises: CurrentTrainingExercise[],
  explicitlyDeletedIds: ReadonlySet<string> = new Set(),
) {
  const entries = Array.isArray(value)
    ? (value as unknown as CompletedExerciseEntry[])
    : [];
  const currentIds = new Set(currentExercises.map((exercise) => exercise.id));
  const currentByExerciseId = new Map<string, CurrentTrainingExercise[]>();
  for (const exercise of currentExercises) {
    const matches = currentByExerciseId.get(exercise.exercise_id) ?? [];
    matches.push(exercise);
    currentByExerciseId.set(exercise.exercise_id, matches);
  }

  const reconciled = new Set<string>();
  const completedBySession = new Map<string | null, Set<string>>();
  const resultEntries: CompletedExerciseEntry[] = [];
  for (const entry of entries) {
    const storedId = entry.training_exercise_id;
    let targetId =
      storedId &&
      currentIds.has(storedId) &&
      !explicitlyDeletedIds.has(storedId)
        ? storedId
        : undefined;
    // A canonical occurrence belongs to its original plan, even after removal.
    // Catalog identity alone cannot transfer it to another occurrence/training.
    if (!storedId) {
      const matches = currentByExerciseId.get(entry.exercise_id) ?? [];
      if (matches.length === 1) targetId = matches[0].id;
    }
    const sessionId = entry.training_session_id ?? null;
    const key = targetId ? JSON.stringify([sessionId, targetId]) : undefined;
    if (!targetId || !key || reconciled.has(key)) {
      resultEntries.push(entry);
      continue;
    }

    reconciled.add(key);
    resultEntries.push({ ...entry, training_exercise_id: targetId });
    const completed = completedBySession.get(sessionId) ?? new Set<string>();
    completed.add(targetId);
    completedBySession.set(sessionId, completed);
  }

  return {
    entries: resultEntries,
    trainingCompleted:
      currentIds.size > 0 &&
      [...completedBySession.values()].some((completedIds) =>
        [...currentIds].every((id) => completedIds.has(id)),
      ),
  };
}

export interface MealIdentity {
  id: string;
  parent_meal_id: string | null;
}

export function reconcileMealProgress(completedIds: string[]) {
  // Current meal counters filter against the assigned diet at read time.
  // Editing that catalog must neither erase history nor invent a eaten parent.
  return [...completedIds];
}

export function countCompletedMealGroups(
  completedIds: string[],
  meals: MealIdentity[],
) {
  const byId = new Map(meals.map((meal) => [meal.id, meal]));
  return new Set(
    completedIds.flatMap((id) => {
      const meal = byId.get(id);
      return meal ? [meal.parent_meal_id ?? meal.id] : [];
    }),
  ).size;
}

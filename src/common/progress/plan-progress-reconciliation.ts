import { Prisma } from '@prisma/client';

export interface CompletedExerciseEntry {
  training_exercise_id?: string;
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

  const reconciled = new Map<string, CompletedExerciseEntry>();
  const unresolved: CompletedExerciseEntry[] = [];
  for (const entry of entries) {
    const storedId = entry.training_exercise_id;
    if (storedId && explicitlyDeletedIds.has(storedId)) continue;

    let targetId = storedId && currentIds.has(storedId) ? storedId : undefined;
    if (!targetId) {
      const matches = currentByExerciseId.get(entry.exercise_id) ?? [];
      if (matches.length === 1) targetId = matches[0].id;
    }
    if (!targetId || reconciled.has(targetId)) {
      unresolved.push(entry);
      continue;
    }

    reconciled.set(targetId, {
      ...entry,
      training_exercise_id: targetId,
    });
  }

  const completedIds = new Set(reconciled.keys());
  return {
    entries: [...reconciled.values(), ...unresolved],
    trainingCompleted:
      currentIds.size > 0 && [...currentIds].every((id) => completedIds.has(id)),
  };
}

export interface MealIdentity {
  id: string;
  parent_meal_id: string | null;
}

export function reconcileMealProgress(
  completedIds: string[],
  previousMeals: MealIdentity[],
  currentMeals: MealIdentity[],
  explicitlyDeletedIds: ReadonlySet<string>,
) {
  const previousById = new Map(previousMeals.map((meal) => [meal.id, meal]));
  const currentById = new Map(currentMeals.map((meal) => [meal.id, meal]));
  const selectedByGroup = new Map<string, string>();

  for (const completedId of completedIds) {
    let targetId = currentById.has(completedId) ? completedId : undefined;
    if (!targetId && explicitlyDeletedIds.has(completedId)) {
      const previous = previousById.get(completedId);
      const survivingParentId = previous?.parent_meal_id;
      if (survivingParentId && currentById.has(survivingParentId)) {
        targetId = survivingParentId;
      }
    }
    if (!targetId) continue;

    const current = currentById.get(targetId)!;
    const groupId = current.parent_meal_id ?? current.id;
    if (!selectedByGroup.has(groupId)) selectedByGroup.set(groupId, targetId);
  }

  return [...selectedByGroup.values()];
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

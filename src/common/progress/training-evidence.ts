import { Prisma } from '@prisma/client';
import { isTrainingDayComplete } from './training-completion';
import { loadTrainingHistory } from './training-history';

/**
 * Execution-evidence derivation shared by the live progress writers and the
 * mode-change recompute. Extracted verbatim from ProgressService so every path
 * that decides "this training was performed" uses the same rules.
 */
export interface EvidenceExerciseEntry {
  training_session_id?: string;
  training_exercise_id?: string;
  exercise_id: string;
}

export interface EvidenceTrainingSession {
  training_session_id?: string;
  training_id: string;
}

export interface EvidenceTraining {
  id: string;
  exercises: ReadonlyArray<{ id: string; exercise_id: string }>;
}

export interface TrainingEvidenceContext {
  trainingIds: string[];
  exerciseIdByTrainingExerciseId: Map<string, string>;
  trainingExerciseIdsByTrainingId: Map<string, Set<string>>;
  exerciseIdsByTrainingId: Map<string, Set<string>>;
}

export function buildTrainingEvidenceContext(
  assignedTrainings: readonly EvidenceTraining[],
): TrainingEvidenceContext {
  const allExercises = assignedTrainings.flatMap(
    (training) => training.exercises,
  );
  return {
    trainingIds: assignedTrainings.map((training) => training.id),
    exerciseIdByTrainingExerciseId: new Map(
      allExercises.map((exercise) => [exercise.id, exercise.exercise_id]),
    ),
    trainingExerciseIdsByTrainingId: new Map(
      assignedTrainings.map((training) => [
        training.id,
        new Set(training.exercises.map((exercise) => exercise.id)),
      ]),
    ),
    exerciseIdsByTrainingId: new Map(
      assignedTrainings.map((training) => [
        training.id,
        new Set(training.exercises.map((exercise) => exercise.exercise_id)),
      ]),
    ),
  };
}

export function getTrainingCompletedStatus(
  assignedTrainingExerciseIds: Set<string>,
  assignedExerciseIds: Set<string>,
  completedEntries: readonly EvidenceExerciseEntry[],
  exerciseIdByTrainingExerciseId: ReadonlyMap<string, string>,
): boolean {
  if (assignedTrainingExerciseIds.size === 0) {
    return false;
  }

  const completedTrainingExerciseIds = new Set(
    completedEntries
      .map((entry) => entry.training_exercise_id)
      .filter((id): id is string => Boolean(id)),
  );

  if (completedTrainingExerciseIds.size > 0) {
    // Legacy evidence remains at exercise level until its occurrence is known.
    // Adding an ID elsewhere must not erase that evidence. Canonical entries
    // only count for their exact occurrence, never via their exercise_id.
    const legacyExerciseIds = new Set(
      completedEntries
        .filter((entry) => !entry.training_exercise_id)
        .map((entry) => entry.exercise_id),
    );
    return [...assignedTrainingExerciseIds].every(
      (trainingExerciseId) =>
        completedTrainingExerciseIds.has(trainingExerciseId) ||
        legacyExerciseIds.has(
          exerciseIdByTrainingExerciseId.get(trainingExerciseId) ?? '',
        ),
    );
  }

  const completedExerciseIds = new Set(
    completedEntries.map((entry) => entry.exercise_id),
  );

  return [...assignedExerciseIds].every((exerciseId) =>
    completedExerciseIds.has(exerciseId),
  );
}

export function getCompletedTrainingIds(
  assignment: TrainingEvidenceContext,
  completedEntries: readonly EvidenceExerciseEntry[],
  historicalTrainingIds: readonly string[] = [],
  confirmedSessions: readonly EvidenceTrainingSession[] = [],
): string[] {
  const confirmedIds = new Set(
    confirmedSessions.map((session) => session.training_session_id),
  );
  const groups = new Map<string | undefined, EvidenceExerciseEntry[]>();
  for (const entry of completedEntries) {
    if (
      entry.training_session_id &&
      !confirmedIds.has(entry.training_session_id)
    ) {
      continue;
    }
    const group = groups.get(entry.training_session_id) ?? [];
    group.push(entry);
    groups.set(entry.training_session_id, group);
  }
  const completed = assignment.trainingIds.filter((trainingId) =>
    [...groups.values()].some((entries) =>
      getTrainingCompletedStatus(
        assignment.trainingExerciseIdsByTrainingId.get(trainingId) ?? new Set(),
        assignment.exerciseIdsByTrainingId.get(trainingId) ?? new Set(),
        entries,
        assignment.exerciseIdByTrainingExerciseId,
      ),
    ),
  );
  return [
    ...historicalTrainingIds.filter(
      (id) => !assignment.trainingIds.includes(id),
    ),
    ...completed,
  ];
}

type RecomputeClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | 'planAssignment' | 'dayProgress'
>;

function jsonRecords(
  value: Prisma.JsonValue | null | undefined,
): Prisma.JsonObject[] {
  // Stored day_progress JSON is written only by the progress writers; entries
  // that are not objects carry no execution evidence and are ignored here.
  return Array.isArray(value)
    ? value.filter(
        (item): item is Prisma.JsonObject =>
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    : [];
}

function optionalString(value: Prisma.JsonValue | undefined) {
  return typeof value === 'string' ? value : undefined;
}

function evidenceExerciseEntries(
  value: Prisma.JsonValue | null | undefined,
): EvidenceExerciseEntry[] {
  return jsonRecords(value).flatMap((item) => {
    const exerciseId = item.exercise_id;
    if (typeof exerciseId !== 'string') return [];
    return [
      {
        exercise_id: exerciseId,
        training_session_id: optionalString(item.training_session_id),
        training_exercise_id: optionalString(item.training_exercise_id),
      },
    ];
  });
}

function evidenceTrainingSessions(
  value: Prisma.JsonValue | null | undefined,
): EvidenceTrainingSession[] {
  return jsonRecords(value).flatMap((item) => {
    const trainingId = item.training_id;
    if (typeof trainingId !== 'string') return [];
    return [
      {
        training_id: trainingId,
        training_session_id: optionalString(item.training_session_id),
      },
    ];
  });
}

/**
 * Promote-only recompute after an assignment's completion mode changed.
 *
 * Callers MUST already hold the client's day-progress advisory lock (directly
 * or via lockAssignmentPlanning) in the same transaction. The flag can only go
 * false -> true, from execution evidence derived exactly like the live writers
 * (snapshot-first trainings, confirmed sessions). Stored trainings_completed
 * IDs alone never promote (2026-09-23 decision) and nothing is demoted.
 * Only training_completed is written; exercise/training history is untouched.
 * Returns true when the stored flag was promoted.
 */
export async function recomputeTrainingCompletionAfterModeChange(
  tx: RecomputeClient,
  clientId: string,
  date: Date,
): Promise<boolean> {
  const progress = await tx.dayProgress.findUnique({
    where: { client_id_date: { client_id: clientId, date } },
    select: {
      id: true,
      training_completed: true,
      exercises_completed: true,
      training_sessions: true,
    },
  });
  if (!progress || progress.training_completed) return false;

  const exerciseSelect = {
    select: { id: true, exercise_id: true },
  } as const;
  const assignment = await tx.planAssignment.findUnique({
    where: { client_id_date: { client_id: clientId, date } },
    select: {
      training_id: true,
      training_completion_mode: true,
      trainings: {
        orderBy: { position: 'asc' },
        select: {
          training: { select: { id: true, exercises: exerciseSelect } },
        },
      },
      training: { select: { id: true, exercises: exerciseSelect } },
    },
  });
  if (!assignment) return false;

  const trainingHistory = await loadTrainingHistory(tx, clientId, date);
  const current: EvidenceTraining[] = assignment.trainings.length
    ? assignment.trainings.map((link) => link.training)
    : assignment.training
      ? [
          {
            ...assignment.training,
            id:
              assignment.training.id ??
              assignment.training_id ??
              '__legacy_training__',
          },
        ]
      : [];
  const context = buildTrainingEvidenceContext(
    current.map((training) => trainingHistory.get(training.id) ?? training),
  );
  const evidenceIds = getCompletedTrainingIds(
    context,
    evidenceExerciseEntries(progress.exercises_completed),
    [],
    evidenceTrainingSessions(progress.training_sessions),
  );
  if (
    !isTrainingDayComplete(
      assignment.training_completion_mode,
      context.trainingIds,
      evidenceIds,
    )
  ) {
    return false;
  }
  await tx.dayProgress.update({
    where: { id: progress.id },
    data: { training_completed: true },
  });
  return true;
}

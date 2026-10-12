import { TrainingCompletionMode } from '@prisma/client';

/**
 * Canonical "the day's training plan is satisfied" rule.
 *
 * - ALL (default, legacy behaviour): every assigned training is completed.
 * - ANY: the day prescribes one training to choose from; one is enough.
 *
 * An absent mode (legacy rows, journal row images captured before the column
 * existed) means ALL. A day without assigned trainings is never complete.
 */
export function isTrainingDayComplete(
  mode: TrainingCompletionMode | null | undefined,
  assignedTrainingIds: readonly string[],
  completedTrainingIds: Iterable<string>,
): boolean {
  if (assignedTrainingIds.length === 0) return false;
  const completed = new Set(completedTrainingIds);
  return mode === TrainingCompletionMode.ANY
    ? assignedTrainingIds.some((id) => completed.has(id))
    : assignedTrainingIds.every((id) => completed.has(id));
}

export interface TrainingCompletionSummary {
  training_completion_mode: TrainingCompletionMode;
  assigned_count: number;
  completed_count: number;
  assigned_training_ids: string[];
  completed_training_ids: string[];
}

/**
 * Recorded "x de N" data for one day: stored completions intersected with the
 * trainings assigned that day, in assignment order. It reports recorded data;
 * it is not evidence and never promotes the stored day flag.
 */
export function trainingCompletionSummary(
  mode: TrainingCompletionMode | null | undefined,
  assignedTrainingIds: readonly string[],
  storedCompletedTrainingIds: Iterable<string>,
): TrainingCompletionSummary {
  const stored = new Set(storedCompletedTrainingIds);
  const assigned = [...new Set(assignedTrainingIds)];
  const completed = assigned.filter((id) => stored.has(id));
  return {
    training_completion_mode:
      mode === TrainingCompletionMode.ANY
        ? TrainingCompletionMode.ANY
        : TrainingCompletionMode.ALL,
    assigned_count: assigned.length,
    completed_count: completed.length,
    assigned_training_ids: assigned,
    completed_training_ids: completed,
  };
}

export interface TrainingDayAssignment {
  training_id?: string | null;
  training_completion_mode?: TrainingCompletionMode;
  trainings?: Array<{ training_id: string }>;
}

export interface TrainingDayProgress {
  training_completed?: boolean;
  trainings_completed?: string[];
}

/**
 * Day training status for read models (month calendar, week summary, weekly
 * admin notification), so all of them count the same days.
 *
 * Completion is the canonical stored day flag (`training_completed`): no
 * progress row means not completed. Stored IDs intersected with the assigned
 * trainings feed only the "x of N" counts; they never decide completion, so a
 * mode change that left the flag and the IDs disagreeing cannot make the read
 * models diverge from dashboard, streaks and achievements.
 */
export function trainingDayStatus(
  assignment: TrainingDayAssignment | undefined,
  progress: TrainingDayProgress | undefined,
) {
  const mode =
    assignment?.training_completion_mode ?? TrainingCompletionMode.ALL;
  const linkedIds =
    assignment?.trainings?.map((link) => link.training_id) ?? [];
  const storedIds = progress?.trainings_completed ?? [];
  const completed = progress?.training_completed === true;
  if (linkedIds.length === 0) {
    // Legacy single-training mirror without link rows.
    return {
      mode,
      assigned: assignment?.training_id ? 1 : 0,
      done: assignment?.training_id && completed ? 1 : 0,
      completed,
    };
  }
  const legacySingleCompletion =
    linkedIds.length === 1 && completed && storedIds.length === 0;
  return {
    mode,
    assigned: linkedIds.length,
    done: legacySingleCompletion
      ? 1
      : linkedIds.filter((id) => storedIds.includes(id)).length,
    completed,
  };
}

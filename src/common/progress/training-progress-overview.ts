// Pure read model for persisted DayProgress JSON. Validate unknown JSON at the
// boundary rather than treating legacy rows as trusted DTOs or prescribed sets.
export interface TrainingProgressDayInput {
  date: string;
  exercises_completed?: unknown;
  training_sessions?: unknown;
  notes?: unknown;
}

export interface PerformedSet {
  date: string;
  training_session_id: string | null;
  set_number: number;
  reps: number | null;
  seconds: number | null;
  weight_kg: number | null;
  rir: number | null;
}

export interface LoadPr {
  weight_kg: number;
  reps: number;
  date: string;
  training_session_id: string | null;
  set_number: number;
}

export interface ExerciseProgress {
  exercise_id: string;
  volume: number | null;
  mean_rir: number | null;
  pr: LoadPr | null;
  sets: PerformedSet[];
}

export interface TrainingSessionProgress {
  date: string;
  training_id: string;
  training_session_id: string | null;
  rpe: number | null;
  note: string | null;
}

export interface TrainingProgressOverview {
  exercises: ExerciseProgress[];
  sessions: TrainingSessionProgress[];
  mean_rpe: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberInRange(
  value: unknown,
  min: number,
  max = Infinity,
): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

function positiveInteger(value: unknown): number | null {
  const number = numberInRange(value, 1);
  return number !== null && Number.isSafeInteger(number) ? number : null;
}

function dateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function stableSetKey(
  set: PerformedSet,
  assignmentId: string | null,
  completedAt: string | null,
): string {
  return [
    set.training_session_id ?? '',
    assignmentId ?? '',
    completedAt ?? '',
    String(set.set_number).padStart(16, '0'),
  ].join('\0');
}

function betterPr(
  candidate: LoadPr,
  prior: LoadPr | null,
  candidateKey: string,
  priorKey: string,
): boolean {
  if (!prior) return true;
  if (candidate.weight_kg !== prior.weight_kg) {
    return candidate.weight_kg > prior.weight_kg;
  }
  if (candidate.reps !== prior.reps) return candidate.reps > prior.reps;
  if (candidate.date !== prior.date) return candidate.date > prior.date;
  return candidateKey < priorKey;
}

export function calculateTrainingProgress(
  days: readonly TrainingProgressDayInput[],
): TrainingProgressOverview {
  const exercises = new Map<string, ExerciseProgress>();
  // Null is a conflict tombstone: later duplicates cannot restore a valuation.
  const sessionByKey = new Map<string, TrainingSessionProgress | null>();
  const prKeys = new Map<string, string>();
  const rirCounts = new Map<string, number>();

  for (const day of days) {
    if (!dateOnly(day.date)) continue;
    if (Array.isArray(day.exercises_completed)) {
      for (const rawEntry of day.exercises_completed) {
        const entry = record(rawEntry);
        const exerciseId = id(entry?.exercise_id);
        if (!entry || !exerciseId || !Array.isArray(entry.sets)) continue;
        let exercise = exercises.get(exerciseId);
        if (!exercise) {
          exercise = {
            exercise_id: exerciseId,
            volume: null,
            mean_rir: null,
            pr: null,
            sets: [],
          };
          exercises.set(exerciseId, exercise);
        }
        const sessionId = id(entry.training_session_id);
        const assignmentId = id(entry.training_exercise_id);
        const completedAt = id(entry.completed_at);
        for (const rawSet of entry.sets) {
          const performed = record(rawSet);
          const setNumber = positiveInteger(performed?.set_number);
          if (!performed || setNumber === null) continue;
          const seconds = positiveInteger(performed.seconds);
          // A timed set cannot be interpreted as reps, even if legacy JSON has both.
          const reps =
            performed.seconds == null ? positiveInteger(performed.reps) : null;
          const weight = numberInRange(performed.weight_kg, 0);
          const rirValue = numberInRange(performed.rir, 0, 10);
          const rir =
            rirValue !== null && Number.isInteger(rirValue) ? rirValue : null;
          const set: PerformedSet = {
            date: day.date,
            training_session_id: sessionId,
            set_number: setNumber,
            reps,
            seconds,
            weight_kg: weight,
            rir,
          };
          exercise.sets.push(set);
          if (rir !== null) {
            const count = rirCounts.get(exerciseId) ?? 0;
            exercise.mean_rir =
              ((exercise.mean_rir ?? 0) * count + rir) / (count + 1);
            rirCounts.set(exerciseId, count + 1);
          }
          if (reps === null || weight === null) continue;
          const term = weight * reps;
          if (Number.isFinite(term)) {
            const total = (exercise.volume ?? 0) + term;
            if (Number.isFinite(total)) exercise.volume = total;
          }
          const candidate: LoadPr = {
            weight_kg: weight,
            reps,
            date: day.date,
            training_session_id: sessionId,
            set_number: setNumber,
          };
          const key = stableSetKey(set, assignmentId, completedAt);
          if (
            betterPr(candidate, exercise.pr, key, prKeys.get(exerciseId) ?? '')
          ) {
            exercise.pr = candidate;
            prKeys.set(exerciseId, key);
          }
        }
      }
    }
    if (Array.isArray(day.training_sessions)) {
      for (const rawSession of day.training_sessions) {
        const session = record(rawSession);
        const trainingId = id(session?.training_id);
        if (!session || !trainingId || session.confirmed === false) continue;
        const rawRpe = session.rpe;
        if (
          rawRpe !== null &&
          rawRpe !== undefined &&
          (numberInRange(rawRpe, 1, 10) === null || !Number.isInteger(rawRpe))
        ) {
          continue;
        }
        const sessionId = id(session.training_session_id);
        const key = JSON.stringify([day.date, trainingId, sessionId]);
        const candidate: TrainingSessionProgress = {
          date: day.date,
          training_id: trainingId,
          training_session_id: sessionId,
          rpe: typeof rawRpe === 'number' ? rawRpe : null,
          note: typeof session.note === 'string' ? session.note : null,
        };
        if (sessionByKey.has(key)) {
          const prior = sessionByKey.get(key);
          if (
            prior &&
            (prior.rpe !== candidate.rpe || prior.note !== candidate.note)
          ) {
            sessionByKey.set(key, null);
          }
        } else {
          sessionByKey.set(key, candidate);
        }
      }
    }
  }
  for (const exercise of exercises.values()) {
    exercise.sets.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.training_session_id ?? '').localeCompare(
          b.training_session_id ?? '',
        ) ||
        a.set_number - b.set_number,
    );
  }
  const sessions = [...sessionByKey.values()].filter(
    (session): session is TrainingSessionProgress => session !== null,
  );
  const rated = sessions.filter((session) => session.rpe !== null);
  return {
    exercises: [...exercises.values()].sort((a, b) =>
      a.exercise_id.localeCompare(b.exercise_id),
    ),
    sessions: sessions.sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.training_id.localeCompare(b.training_id) ||
        (a.training_session_id ?? '').localeCompare(
          b.training_session_id ?? '',
        ),
    ),
    mean_rpe: rated.length
      ? rated.reduce((sum, session) => sum + (session.rpe ?? 0), 0) /
        rated.length
      : null,
  };
}

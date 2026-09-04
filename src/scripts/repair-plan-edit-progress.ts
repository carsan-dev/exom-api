import 'dotenv/config';
import { Prisma } from '@prisma/client';
import {
  DAY_PROGRESS_TRANSACTION_OPTIONS,
  lockClientDayProgress,
} from '../common/progress/day-progress-lock';
import { reconcileTrainingProgress } from '../common/progress/plan-progress-reconciliation';
import { PrismaService } from '../prisma/prisma.service';

const apply = process.argv.includes('--apply');
const prisma = new PrismaService();

const assignmentInclude = {
  trainings: {
    orderBy: { position: 'asc' },
    include: {
      training: {
        select: {
          id: true,
          name: true,
          exercises: { select: { id: true, exercise_id: true } },
        },
      },
    },
  },
  training: {
    select: {
      id: true,
      name: true,
      exercises: { select: { id: true, exercise_id: true } },
    },
  },
  diet: {
    select: {
      id: true,
      name: true,
      meals: { select: { id: true } },
    },
  },
} satisfies Prisma.PlanAssignmentInclude;

type Assignment = Prisma.PlanAssignmentGetPayload<{
  include: typeof assignmentInclude;
}>;
type Progress = Prisma.DayProgressGetPayload<object>;
type AssignedTraining = NonNullable<Assignment['training']>;

type TrainingRepair =
  | { kind: 'none' }
  | {
      kind: 'ambiguous';
      trainings: AssignedTraining[];
      remainingStale: number;
    }
  | {
      kind: 'repairable';
      data: {
        exercises_completed: Prisma.InputJsonValue;
        training_completed: boolean;
        trainings_completed: string[];
      };
    };

function assignedTrainings(assignment: Assignment): AssignedTraining[] {
  return assignment.trainings.length
    ? assignment.trainings.map((link) => link.training)
    : assignment.training
      ? [assignment.training]
      : [];
}

function analyzeTrainingRepair(
  assignment: Assignment,
  progress: Progress,
): TrainingRepair {
  const trainings = assignedTrainings(assignment);
  if (trainings.length === 0) return { kind: 'none' };

  const exercises = trainings.flatMap((training) => training.exercises);
  const currentIds = new Set(exercises.map((exercise) => exercise.id));
  const original = Array.isArray(progress.exercises_completed)
    ? (progress.exercises_completed as Array<{
        training_exercise_id?: string;
      }>)
    : [];
  const hasStaleEntry = original.some(
    (entry) =>
      entry.training_exercise_id && !currentIds.has(entry.training_exercise_id),
  );
  if (!hasStaleEntry) return { kind: 'none' };

  const reconciled = reconcileTrainingProgress(
    progress.exercises_completed,
    exercises,
  );
  const remainingStale = reconciled.entries.filter(
    (entry) =>
      entry.training_exercise_id && !currentIds.has(entry.training_exercise_id),
  ).length;
  if (remainingStale > 0) {
    return { kind: 'ambiguous', trainings, remainingStale };
  }

  const completedExerciseIds = new Set(
    reconciled.entries
      .map((entry) => entry.training_exercise_id)
      .filter((id): id is string => Boolean(id)),
  );
  const completedTrainingIds = trainings
    .filter(
      (training) =>
        training.exercises.length > 0 &&
        training.exercises.every((exercise) =>
          completedExerciseIds.has(exercise.id),
        ),
    )
    .map((training) => training.id);

  return {
    kind: 'repairable',
    data: {
      exercises_completed:
        reconciled.entries as unknown as Prisma.InputJsonValue,
      training_completed: reconciled.trainingCompleted,
      trainings_completed: completedTrainingIds,
    },
  };
}

async function main() {
  await prisma.$connect();
  const assignments = await prisma.planAssignment.findMany({
    where: {
      OR: [
        { trainings: { some: {} } },
        { training_id: { not: null } },
        { diet_id: { not: null } },
      ],
    },
    include: assignmentInclude,
  });
  const clients = await prisma.user.findMany({
    where: {
      id: { in: [...new Set(assignments.map((item) => item.client_id))] },
    },
    select: {
      id: true,
      email: true,
      profile: { select: { first_name: true, last_name: true } },
    },
  });
  const clientById = new Map(clients.map((client) => [client.id, client]));

  const clientLabel = (clientId: string) => {
    const client = clientById.get(clientId);
    const name = [client?.profile?.first_name, client?.profile?.last_name]
      .filter(Boolean)
      .join(' ');
    return `${name || 'Sin nombre'} <${client?.email ?? 'sin-email'}>`;
  };

  let repairedTrainings = 0;
  let ambiguousTrainings = 0;
  let dietsWithStaleIds = 0;

  for (const scannedAssignment of assignments) {
    const inspected = apply
      ? await prisma.$transaction(async (tx) => {
          await lockClientDayProgress(tx, scannedAssignment.client_id);
          const assignment = await tx.planAssignment.findUnique({
            where: {
              client_id_date: {
                client_id: scannedAssignment.client_id,
                date: scannedAssignment.date,
              },
            },
            include: assignmentInclude,
          });
          const progress = await tx.dayProgress.findUnique({
            where: {
              client_id_date: {
                client_id: scannedAssignment.client_id,
                date: scannedAssignment.date,
              },
            },
          });
          if (!assignment || !progress) return null;

          const repair = analyzeTrainingRepair(assignment, progress);
          if (repair.kind === 'repairable') {
            await tx.dayProgress.update({
              where: { id: progress.id },
              data: repair.data,
            });
          }
          return { assignment, progress, repair };
        }, DAY_PROGRESS_TRANSACTION_OPTIONS)
      : await (async () => {
          const progress = await prisma.dayProgress.findUnique({
            where: {
              client_id_date: {
                client_id: scannedAssignment.client_id,
                date: scannedAssignment.date,
              },
            },
          });
          return progress
            ? {
                assignment: scannedAssignment,
                progress,
                repair: analyzeTrainingRepair(scannedAssignment, progress),
              }
            : null;
        })();
    if (!inspected) continue;

    const { assignment, progress, repair } = inspected;
    if (repair.kind === 'repairable') {
      repairedTrainings++;
    } else if (repair.kind === 'ambiguous') {
      ambiguousTrainings++;
      console.warn(
        `AMBIGUOUS trainings="${repair.trainings.map((training) => training.name).join(', ')}" training_ids=${repair.trainings.map((training) => training.id).join(',')} client="${clientLabel(assignment.client_id)}" client_id=${assignment.client_id} date=${assignment.date.toISOString().slice(0, 10)} stale_entries=${repair.remainingStale}`,
      );
    }

    if (assignment.diet) {
      const currentMealIds = new Set(
        assignment.diet.meals.map((meal) => meal.id),
      );
      const staleIds = progress.meals_completed.filter(
        (id) => !currentMealIds.has(id),
      );
      if (staleIds.length) {
        dietsWithStaleIds++;
        console.warn(
          `STALE diet="${assignment.diet.name}" diet_id=${assignment.diet.id} client="${clientLabel(assignment.client_id)}" client_id=${assignment.client_id} date=${assignment.date.toISOString().slice(0, 10)} stale_ids=${staleIds.length}; manual recovery required`,
        );
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        repaired_trainings: repairedTrainings,
        ambiguous_trainings: ambiguousTrainings,
        diets_with_stale_ids: dietsWithStaleIds,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

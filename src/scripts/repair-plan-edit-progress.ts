import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { reconcileTrainingProgress } from '../common/progress/plan-progress-reconciliation';

const apply = process.argv.includes('--apply');
const prisma = new PrismaService();

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
    include: {
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
    },
  });
  const clients = await prisma.user.findMany({
    where: { id: { in: [...new Set(assignments.map((item) => item.client_id))] } },
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

  for (const assignment of assignments) {
    const progress = await prisma.dayProgress.findUnique({
      where: {
        client_id_date: {
          client_id: assignment.client_id,
          date: assignment.date,
        },
      },
    });
    if (!progress) continue;

    const assignedTrainings = assignment.trainings.length
      ? assignment.trainings.map((link) => link.training)
      : assignment.training
        ? [assignment.training]
        : [];
    if (assignedTrainings.length > 0) {
      const assignedExercises = assignedTrainings.flatMap(
        (training) => training.exercises,
      );
      const original = Array.isArray(progress.exercises_completed)
        ? (progress.exercises_completed as Array<{ training_exercise_id?: string }>)
        : [];
      const currentIds = new Set(assignedExercises.map((item) => item.id));
      const staleCount = original.filter(
        (entry) => entry.training_exercise_id && !currentIds.has(entry.training_exercise_id),
      ).length;
      if (staleCount) {
        const reconciled = reconcileTrainingProgress(
          progress.exercises_completed,
          assignedExercises,
        );
        const remainingStale = reconciled.entries.filter(
          (entry) =>
            entry.training_exercise_id && !currentIds.has(entry.training_exercise_id),
        ).length;
        if (remainingStale) {
          ambiguousTrainings++;
          console.warn(
            `AMBIGUOUS trainings="${assignedTrainings.map((training) => training.name).join(', ')}" training_ids=${assignedTrainings.map((training) => training.id).join(',')} client="${clientLabel(assignment.client_id)}" client_id=${assignment.client_id} date=${assignment.date.toISOString().slice(0, 10)} stale_entries=${remainingStale}`,
          );
        } else {
          repairedTrainings++;
          if (apply) {
            const completedExerciseIds = new Set(
              reconciled.entries
                .map((entry) => entry.training_exercise_id)
                .filter((id): id is string => Boolean(id)),
            );
            const completedTrainingIds = assignedTrainings
              .filter(
                (training) =>
                  training.exercises.length > 0 &&
                  training.exercises.every((exercise) =>
                    completedExerciseIds.has(exercise.id),
                  ),
              )
              .map((training) => training.id);
            await prisma.dayProgress.update({
              where: { id: progress.id },
              data: {
                exercises_completed:
                  reconciled.entries as unknown as Prisma.InputJsonValue,
                training_completed: reconciled.trainingCompleted,
                trainings_completed: completedTrainingIds,
              },
            });
          }
        }
      }
    }

    if (assignment.diet) {
      const currentMealIds = new Set(assignment.diet.meals.map((meal) => meal.id));
      const staleIds = progress.meals_completed.filter((id) => !currentMealIds.has(id));
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

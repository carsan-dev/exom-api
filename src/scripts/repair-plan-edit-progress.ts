import 'dotenv/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { reconcileTrainingProgress } from '../common/progress/plan-progress-reconciliation';

const apply = process.argv.includes('--apply');
const prisma = new PrismaService();

function key(clientId: string, date: Date) {
  return `${clientId}:${date.toISOString()}`;
}

async function main() {
  await prisma.$connect();
  const assignments = await prisma.planAssignment.findMany({
    where: { OR: [{ training_id: { not: null } }, { diet_id: { not: null } }] },
    include: {
      training: { select: { exercises: { select: { id: true, exercise_id: true } } } },
      diet: { select: { meals: { select: { id: true } } } },
    },
  });

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

    if (assignment.training) {
      const original = Array.isArray(progress.exercises_completed)
        ? (progress.exercises_completed as Array<{ training_exercise_id?: string }>)
        : [];
      const currentIds = new Set(assignment.training.exercises.map((item) => item.id));
      const staleCount = original.filter(
        (entry) => entry.training_exercise_id && !currentIds.has(entry.training_exercise_id),
      ).length;
      if (staleCount) {
        const reconciled = reconcileTrainingProgress(
          progress.exercises_completed,
          assignment.training.exercises,
        );
        const remainingStale = reconciled.entries.filter(
          (entry) =>
            entry.training_exercise_id && !currentIds.has(entry.training_exercise_id),
        ).length;
        if (remainingStale) {
          ambiguousTrainings++;
          console.warn(
            `AMBIGUOUS training progress ${key(assignment.client_id, assignment.date)}: ${remainingStale} stale entries`,
          );
        } else {
          repairedTrainings++;
          if (apply) {
            await prisma.dayProgress.update({
              where: { id: progress.id },
              data: {
                exercises_completed:
                  reconciled.entries as unknown as Prisma.InputJsonValue,
                training_completed: reconciled.trainingCompleted,
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
          `STALE diet progress ${key(assignment.client_id, assignment.date)}: ${staleIds.length} ids; manual recovery required`,
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

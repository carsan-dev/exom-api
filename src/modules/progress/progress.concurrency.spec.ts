import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import type { AchievementsService } from '../achievements/achievements.service';
import type { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';
import type { ChallengesService } from '../challenges/challenges.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { StreakCalculatorService } from '../streaks/streak-calculator.service';
import type { UploadsService } from '../uploads/uploads.service';
import { ProgressService } from './progress.service';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? '';
const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;

interface CompletedExercise {
  training_exercise_id?: string;
  exercise_id: string;
  completed_at: string;
  sets?: Array<{ set_number: number; reps?: number }>;
}

describeWithDatabase('ProgressService PostgreSQL concurrency', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const clientId = `progress-client-${suffix}`;
  const trainingOneId = `progress-training-1-${suffix}`;
  const trainingTwoId = `progress-training-2-${suffix}`;
  const exerciseOneId = `progress-exercise-1-${suffix}`;
  const exerciseTwoId = `progress-exercise-2-${suffix}`;
  const exerciseThreeId = `progress-exercise-3-${suffix}`;
  const trainingExerciseOneId = `progress-training-exercise-1-${suffix}`;
  const trainingExerciseTwoId = `progress-training-exercise-2-${suffix}`;
  const trainingExerciseThreeId = `progress-training-exercise-3-${suffix}`;
  const dietId = `progress-diet-${suffix}`;
  const mealId = `progress-meal-${suffix}`;
  const mealTwoId = `progress-meal-2-${suffix}`;
  const date = '2099-01-05';
  const dateValue = new Date(`${date}T00:00:00.000Z`);

  let poolOne: Pool;
  let poolTwo: Pool;
  let prismaOne: PrismaClient;
  let prismaTwo: PrismaClient;
  let serviceOne: ProgressService;
  let serviceTwo: ProgressService;

  function createService(
    prisma: PrismaClient,
    failure?: 'challenge' | 'streak',
  ): ProgressService {
    return new ProgressService(
      prisma as unknown as PrismaService,
      {
        recalculateAutomaticProgress:
          failure === 'challenge'
            ? jest.fn().mockRejectedValue(new Error('challenge failure'))
            : jest.fn().mockResolvedValue(undefined),
      } as unknown as ChallengesService,
      {
        evaluateAutomaticAchievementsForUser: jest
          .fn()
          .mockResolvedValue(undefined),
      } as unknown as AchievementsService,
      {
        findSystemSenderId: jest.fn().mockResolvedValue(null),
      } as unknown as NotificationsService,
      {
        recalculateClient:
          failure === 'streak'
            ? jest.fn().mockRejectedValue(new Error('streak failure'))
            : jest.fn().mockResolvedValue({
                currentDays: 1,
                longestDays: 1,
                previousCurrentDays: 1,
                changed: false,
              }),
      } as unknown as StreakCalculatorService,
      {
        isConsumedManagedUrl: jest.fn().mockResolvedValue(true),
      } as unknown as UploadsService,
      {
        reconcile: jest.fn().mockResolvedValue(undefined),
      } as unknown as AutoAssignmentMaterializerService,
    );
  }

  function completedExercises(value: Prisma.JsonValue): CompletedExercise[] {
    return Array.isArray(value)
      ? (value as unknown as CompletedExercise[])
      : [];
  }

  async function readProgress() {
    return prismaOne.dayProgress.findUniqueOrThrow({
      where: { client_id_date: { client_id: clientId, date: dateValue } },
    });
  }

  beforeAll(async () => {
    poolOne = new Pool({ connectionString: testDatabaseUrl });
    poolTwo = new Pool({ connectionString: testDatabaseUrl });
    prismaOne = new PrismaClient({ adapter: new PrismaPg(poolOne) });
    prismaTwo = new PrismaClient({ adapter: new PrismaPg(poolTwo) });
    serviceOne = createService(prismaOne);
    serviceTwo = createService(prismaTwo);

    await prismaOne.user.create({
      data: {
        id: clientId,
        email: `${clientId}@example.test`,
        firebase_uid: clientId,
      },
    });
    await prismaOne.exercise.createMany({
      data: [exerciseOneId, exerciseTwoId, exerciseThreeId].map((id) => ({
        id,
        name: id,
        muscle_groups: [],
        equipment: [],
      })),
    });
    await prismaOne.training.createMany({
      data: [trainingOneId, trainingTwoId].map((id) => ({
        id,
        name: id,
        type: 'TEST',
        tags: [],
      })),
    });
    await prismaOne.trainingExercise.createMany({
      data: [
        {
          id: trainingExerciseOneId,
          training_id: trainingOneId,
          exercise_id: exerciseOneId,
          order: 0,
          sets: 1,
          reps_or_duration: '10',
        },
        {
          id: trainingExerciseTwoId,
          training_id: trainingOneId,
          exercise_id: exerciseTwoId,
          order: 1,
          sets: 1,
          reps_or_duration: '10',
        },
        {
          id: trainingExerciseThreeId,
          training_id: trainingTwoId,
          exercise_id: exerciseThreeId,
          order: 0,
          sets: 1,
          reps_or_duration: '10',
        },
      ],
    });
    await prismaOne.diet.create({
      data: { id: dietId, name: dietId, tags: [] },
    });
    await prismaOne.meal.createMany({
      data: [mealId, mealTwoId].map((id, order) => ({
        id,
        diet_id: dietId,
        type: 'LUNCH',
        name: id,
        nutritional_badges: [],
        order,
      })),
    });
    await prismaOne.planAssignment.create({
      data: {
        client_id: clientId,
        date: dateValue,
        diet_id: dietId,
        training_id: trainingOneId,
        trainings: {
          create: [
            { training_id: trainingOneId, position: 0 },
            { training_id: trainingTwoId, position: 1 },
          ],
        },
      },
    });
  });

  beforeEach(async () => {
    await prismaOne.dayProgress.deleteMany({ where: { client_id: clientId } });
  });

  afterAll(async () => {
    if (prismaOne) {
      await prismaOne.user.deleteMany({ where: { id: clientId } });
      await prismaOne.diet.deleteMany({ where: { id: dietId } });
      await prismaOne.training.deleteMany({
        where: { id: { in: [trainingOneId, trainingTwoId] } },
      });
      await prismaOne.exercise.deleteMany({
        where: {
          id: { in: [exerciseOneId, exerciseTwoId, exerciseThreeId] },
        },
      });
    }
    await prismaOne?.$disconnect();
    await prismaTwo?.$disconnect();
    await poolOne?.end();
    await poolTwo?.end();
  });

  it('preserves two different exercises completed simultaneously', async () => {
    await Promise.all([
      serviceOne.markExerciseCompleted(clientId, {
        date,
        exercise_id: exerciseOneId,
        training_exercise_id: trainingExerciseOneId,
      }),
      serviceTwo.markExerciseCompleted(clientId, {
        date,
        exercise_id: exerciseTwoId,
        training_exercise_id: trainingExerciseTwoId,
      }),
    ]);

    const entries = completedExercises(
      (await readProgress()).exercises_completed,
    );
    expect(new Set(entries.map((entry) => entry.training_exercise_id))).toEqual(
      new Set([trainingExerciseOneId, trainingExerciseTwoId]),
    );
  });

  it('preserves an exercise and a meal completed simultaneously', async () => {
    await Promise.all([
      serviceOne.markExerciseCompleted(clientId, {
        date,
        exercise_id: exerciseOneId,
        training_exercise_id: trainingExerciseOneId,
      }),
      serviceTwo.markMealCompleted(clientId, { date, meal_id: mealId }),
    ]);

    const progress = await readProgress();
    expect(completedExercises(progress.exercises_completed)).toHaveLength(1);
    expect(progress.meals_completed).toEqual([mealId]);
  });

  it('preserves two different meals completed simultaneously', async () => {
    await Promise.all([
      serviceOne.markMealCompleted(clientId, { date, meal_id: mealId }),
      serviceTwo.markMealCompleted(clientId, { date, meal_id: mealTwoId }),
    ]);

    expect(new Set((await readProgress()).meals_completed)).toEqual(
      new Set([mealId, mealTwoId]),
    );
  });

  it('keeps one canonical entry for two simultaneous writes to one exercise', async () => {
    await Promise.all([
      serviceOne.markExerciseCompleted(clientId, {
        date,
        exercise_id: exerciseOneId,
        training_exercise_id: trainingExerciseOneId,
        sets: [{ set_number: 1, reps: 8 }],
      }),
      serviceTwo.markExerciseCompleted(clientId, {
        date,
        exercise_id: exerciseOneId,
        training_exercise_id: trainingExerciseOneId,
        sets: [{ set_number: 1, reps: 12 }],
      }),
    ]);

    const entries = completedExercises(
      (await readProgress()).exercises_completed,
    );
    expect(entries).toHaveLength(1);
    expect([8, 12]).toContain(entries[0].sets?.[0].reps);
  });

  it('does not rewrite state when the same completion is retried', async () => {
    const command = {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
      sets: [{ set_number: 1, reps: 10 }],
    };
    await serviceOne.markExerciseCompleted(clientId, command);
    const first = await readProgress();

    await serviceTwo.markExerciseCompleted(clientId, command);
    const retried = await readProgress();

    expect(retried.exercises_completed).toEqual(first.exercises_completed);
    expect(retried.updated_at).toEqual(first.updated_at);

    await serviceOne.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    });
    const retriedWithoutOptionalFields = await readProgress();

    expect(retriedWithoutOptionalFields.exercises_completed).toEqual(
      first.exercises_completed,
    );
    expect(retriedWithoutOptionalFields.updated_at).toEqual(first.updated_at);
  });

  it('merges two trainings completed simultaneously', async () => {
    await Promise.all([
      serviceOne.completeTraining(clientId, {
        date,
        training_id: trainingOneId,
      }),
      serviceTwo.completeTraining(clientId, {
        date,
        training_id: trainingTwoId,
      }),
    ]);

    const progress = await readProgress();
    expect(new Set(progress.trainings_completed)).toEqual(
      new Set([trainingOneId, trainingTwoId]),
    );
    expect(completedExercises(progress.exercises_completed)).toHaveLength(3);
    expect(progress.training_completed).toBe(true);

    await serviceOne.completeTraining(clientId, {
      date,
      training_id: trainingOneId,
    });
    expect((await readProgress()).updated_at).toEqual(progress.updated_at);
  });

  it('keeps a repeated meal completion idempotent without reordering', async () => {
    await serviceOne.markMealCompleted(clientId, { date, meal_id: mealId });
    await serviceOne.markMealCompleted(clientId, { date, meal_id: mealTwoId });
    const first = await readProgress();

    await serviceTwo.markMealCompleted(clientId, { date, meal_id: mealId });
    const retried = await readProgress();

    expect(retried.meals_completed).toEqual([mealId, mealTwoId]);
    expect(retried.updated_at).toEqual(first.updated_at);
  });

  it('keeps repeated unmark operations idempotent', async () => {
    await serviceOne.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    });
    await serviceOne.unmarkExercise(clientId, date, trainingExerciseOneId);
    const first = await readProgress();

    await serviceTwo.unmarkExercise(clientId, date, trainingExerciseOneId);
    const retried = await readProgress();

    expect(retried.exercises_completed).toEqual([]);
    expect(retried.updated_at).toEqual(first.updated_at);
  });

  it('does not resurrect either exercise when two unmarks run simultaneously', async () => {
    await serviceOne.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    });
    await serviceOne.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseTwoId,
      training_exercise_id: trainingExerciseTwoId,
    });

    await Promise.all([
      serviceOne.unmarkExercise(clientId, date, trainingExerciseOneId),
      serviceTwo.unmarkExercise(clientId, date, trainingExerciseTwoId),
    ]);

    const progress = await readProgress();
    expect(progress.exercises_completed).toEqual([]);
    expect(progress.trainings_completed).toEqual([]);
    expect(progress.training_completed).toBe(false);
  });

  it('rolls back progress if in-transaction streak reconciliation fails', async () => {
    const failingService = createService(prismaOne, 'streak');

    await expect(
      failingService.markMealCompleted(clientId, { date, meal_id: mealId }),
    ).rejects.toThrow('streak failure');

    await expect(
      prismaOne.dayProgress.findUnique({
        where: { client_id_date: { client_id: clientId, date: dateValue } },
      }),
    ).resolves.toBeNull();
  });

  it('supports retry after post-commit reconciliation fails', async () => {
    const failingService = createService(prismaOne, 'challenge');
    const command = {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    };

    await expect(
      failingService.markExerciseCompleted(clientId, command),
    ).rejects.toThrow('challenge failure');
    const committed = await readProgress();

    await serviceTwo.markExerciseCompleted(clientId, command);
    const retried = await readProgress();

    expect(retried.exercises_completed).toEqual(committed.exercises_completed);
    expect(retried.updated_at).toEqual(committed.updated_at);
  });
});

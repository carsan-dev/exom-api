import { runProgressCommand } from '../../common/progress/progress-command';
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
  training_session_id?: string;
  exercise_id: string;
  completed_at: string;
  sets?: Array<{ set_number: number; reps?: number; rir?: number }>;
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
                changed: failure === 'challenge',
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
    await prismaOne.progressOperation.deleteMany({
      where: { owner_id: clientId },
    });
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

  it.each(['mark', 'complete'] as const)(
    'P3-T2: %s rejects a persisted provisional LAST_SET session claim for another training before writing day or receipt',
    async (action) => {
      const sessionId = `provisional-feedback-${action}-${suffix}`;
      await prismaOne.feedbackMedia.create({
        data: {
          client_id: clientId,
          exercise_id: exerciseOneId,
          training_id: trainingOneId,
          training_exercise_id: trainingExerciseOneId,
          assignment_date: dateValue,
          training_session_id: sessionId,
          feedback_kind: 'LAST_SET',
          media_type: 'VIDEO',
          media_url: `https://example.test/${sessionId}`,
        },
      });
      const command =
        action === 'mark'
          ? serviceTwo.markExerciseCompleted(clientId, {
              date,
              exercise_id: exerciseThreeId,
              training_exercise_id: trainingExerciseThreeId,
              training_session_id: sessionId,
              sets: [{ set_number: 1, reps: 8 }],
            })
          : serviceTwo.completeTraining(clientId, {
              date,
              training_id: trainingTwoId,
              training_session_id: sessionId,
            });
      await expect(command).rejects.toMatchObject({
        status: 409,
        response: { code: 'TRAINING_SESSION_CONFLICT' },
      });
      expect(
        await prismaOne.dayProgress.findUnique({
          where: { client_id_date: { client_id: clientId, date: dateValue } },
        }),
      ).toBeNull();
      expect(
        await prismaOne.progressOperation.count({
          where: { owner_id: clientId },
        }),
      ).toBe(0);
    },
  );

  it('P3-T6-A: marking the final session exercise does not claim completion until explicit completion without a rating', async () => {
    const sessionId = `explicit-completion-${suffix}`;
    await serviceOne.completeTraining(clientId, {
      date,
      training_id: trainingTwoId,
    });
    for (const [exercise_id, training_exercise_id] of [
      [exerciseOneId, trainingExerciseOneId],
      [exerciseTwoId, trainingExerciseTwoId],
    ] as const) {
      await serviceOne.markExerciseCompleted(clientId, {
        date,
        exercise_id,
        training_exercise_id,
        training_session_id: sessionId,
        sets: [{ set_number: 1, reps: 10 }],
      });
    }

    const marked = await readProgress();
    expect(completedExercises(marked.exercises_completed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          training_exercise_id: trainingExerciseTwoId,
          training_session_id: sessionId,
        }),
      ]),
    );
    expect(marked.trainings_completed).toEqual([trainingTwoId]);
    expect(marked.training_completed).toBe(false);
    expect(marked.training_sessions).toEqual([]);

    await serviceTwo.completeTraining(clientId, {
      date,
      training_id: trainingOneId,
      training_session_id: sessionId,
    });
    const completed = await readProgress();
    expect(completed.trainings_completed).toEqual([
      trainingOneId,
      trainingTwoId,
    ]);
    expect(completed.training_completed).toBe(true);
    expect(completed.training_sessions).toEqual([
      {
        training_session_id: sessionId,
        training_id: trainingOneId,
        rpe: null,
        note: null,
      },
    ]);
  });

  it('P3: concurrent executions of the same training retain independent seconds, RPE and replay identity', async () => {
    const sessionOne = `session-one-${suffix}`;
    const sessionTwo = `session-two-${suffix}`;
    const firstSets = [{ set_number: 1, seconds: 40, rir: 2 }];
    const secondSets = [{ set_number: 1, seconds: 70, rir: 4 }];
    await serviceOne.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
      training_session_id: sessionOne,
      sets: firstSets,
    });
    await serviceTwo.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
      training_session_id: sessionTwo,
      sets: secondSets,
    });
    const before = await readProgress();
    const firstDto = {
      date,
      training_id: trainingOneId,
      training_session_id: sessionOne,
      rpe: 8,
      session_note: 'Morning',
    };
    const secondDto = {
      date,
      training_id: trainingOneId,
      training_session_id: sessionTwo,
      rpe: 3,
      session_note: 'Evening',
    };
    const blocker = await poolOne.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`exom:day-progress:${clientId}`],
    );
    const writes = Promise.allSettled([
      runProgressCommand(
        `same-first-${suffix}`,
        String(before.sync_revision),
        ['completeTraining', firstDto],
        () => serviceOne.completeTraining(clientId, firstDto),
      ),
      runProgressCommand(
        `same-second-${suffix}`,
        String(before.sync_revision),
        ['completeTraining', secondDto],
        () => serviceTwo.completeTraining(clientId, secondDto),
      ),
    ]);
    let waiters = 0;
    try {
      for (let attempt = 0; attempt < 200 && waiters < 2; attempt++) {
        const result = await blocker.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        );
        waiters = result.rows[0].n;
        if (waiters < 2)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    const results = await writes;
    expect(waiters).toBe(2);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason as unknown).toMatchObject({
          response: { code: 'PROGRESS_VERSION_CONFLICT' },
        });
      }
    }
    const winner = results[0].status === 'fulfilled' ? firstDto : secondDto;
    const loser = results[0].status === 'fulfilled' ? secondDto : firstDto;
    const winnerOperation =
      results[0].status === 'fulfilled'
        ? `same-first-${suffix}`
        : `same-second-${suffix}`;
    const loserOperation =
      results[0].status === 'fulfilled'
        ? `same-second-${suffix}`
        : `same-first-${suffix}`;
    const winnerResult =
      results[0].status === 'fulfilled'
        ? results[0].value
        : results[1].status === 'fulfilled'
          ? results[1].value
          : undefined;
    expect(winnerResult).toBeDefined();
    const afterWinner = await readProgress();
    await runProgressCommand(
      loserOperation,
      String(afterWinner.sync_revision),
      ['completeTraining', loser],
      () => serviceTwo.completeTraining(clientId, loser),
    );
    const completed = await readProgress();
    expect(completed.training_sessions).toEqual(
      expect.arrayContaining([
        {
          training_session_id: sessionOne,
          training_id: trainingOneId,
          rpe: 8,
          note: 'Morning',
        },
        {
          training_session_id: sessionTwo,
          training_id: trainingOneId,
          rpe: 3,
          note: 'Evening',
        },
      ]),
    );
    expect(completed.trainings_completed).toEqual([trainingOneId]);
    expect(completedExercises(completed.exercises_completed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          training_session_id: sessionOne,
          sets: firstSets,
        }),
        expect.objectContaining({
          training_session_id: sessionTwo,
          sets: secondSets,
        }),
      ]),
    );
    const replay = await runProgressCommand(
      winnerOperation,
      String(before.sync_revision),
      ['completeTraining', winner],
      () => serviceOne.completeTraining(clientId, winner),
    );
    expect(replay.operation_revision).toBe(winnerResult?.operation_revision);
    expect(replay.training_sessions).toEqual(completed.training_sessions);
    expect(await readProgress()).toEqual(completed);
    expect(
      await prismaOne.progressOperation.count({
        where: { owner_id: clientId },
      }),
    ).toBe(2);
    const unmarked = await runProgressCommand(
      `same-unmark-${suffix}`,
      String(completed.sync_revision),
      ['unmark', date, trainingExerciseOneId, sessionOne],
      () =>
        serviceOne.unmarkExercise(
          clientId,
          date,
          trainingExerciseOneId,
          sessionOne,
        ),
    );
    if ('message' in unmarked) {
      throw new Error(
        'Expected persisted progress after unmarking the session',
      );
    }
    expect(completedExercises(unmarked.exercises_completed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          training_session_id: sessionTwo,
          sets: secondSets,
        }),
      ]),
    );
    expect(completedExercises(unmarked.exercises_completed)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          training_session_id: sessionOne,
          training_exercise_id: trainingExerciseOneId,
        }),
      ]),
    );
    expect(unmarked.training_sessions).toEqual([
      {
        training_session_id: sessionTwo,
        training_id: trainingOneId,
        rpe: 3,
        note: 'Evening',
      },
    ]);
    const afterUnmark = await readProgress();
    const staleReplay = await runProgressCommand(
      winnerOperation,
      String(before.sync_revision),
      ['completeTraining', winner],
      () => serviceOne.completeTraining(clientId, winner),
    );
    expect(staleReplay.operation_revision).toBe(
      winnerResult?.operation_revision,
    );
    expect(await readProgress()).toEqual(afterUnmark);
    await expect(
      runProgressCommand(
        `same-stale-complete-${suffix}`,
        String(completed.sync_revision),
        ['completeTraining', firstDto],
        () => serviceTwo.completeTraining(clientId, firstDto),
      ),
    ).rejects.toMatchObject({
      response: { code: 'PROGRESS_VERSION_CONFLICT' },
    });
    expect(await readProgress()).toEqual(afterUnmark);
  });

  it('P3: simultaneous completion and unmark of one partial session serialize with one semantic winner', async () => {
    const sessionId = `opposite-session-${suffix}`;
    const otherSessionId = `opposite-other-${suffix}`;
    const firstSets = [{ set_number: 1, reps: 8, rir: 0 }];
    const otherSets = [{ set_number: 1, seconds: 45, rir: 2 }];
    await serviceOne.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
      training_session_id: sessionId,
      sets: firstSets,
    });
    await serviceOne.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseThreeId,
      training_exercise_id: trainingExerciseThreeId,
      training_session_id: otherSessionId,
      sets: otherSets,
    });
    const before = await readProgress();
    expect(before.training_sessions).toEqual([]);
    expect(before.training_completed).toBe(false);
    expect(before.trainings_completed).toEqual([]);
    expect(completedExercises(before.exercises_completed)).toHaveLength(2);
    const otherEntry = completedExercises(before.exercises_completed).find(
      (entry) => entry.training_session_id === otherSessionId,
    );
    expect(otherEntry).toMatchObject({
      training_exercise_id: trainingExerciseThreeId,
      sets: otherSets,
    });
    expect(
      await prismaOne.progressOperation.count({
        where: { owner_id: clientId },
      }),
    ).toBe(0);

    const completion = {
      date,
      training_id: trainingOneId,
      training_session_id: sessionId,
      rpe: 7,
      session_note: 'Confirmed',
    };
    const completeId = `opposite-complete-${suffix}`;
    const unmarkId = `opposite-unmark-${suffix}`;
    // Dedicated connections give every waiter a server-side deadline, even if
    // polling or the assertion fails while the advisory lock is held.
    const writerPoolOne = new Pool({
      connectionString: testDatabaseUrl,
      connectionTimeoutMillis: 2000,
      statement_timeout: 6000,
      query_timeout: 7000,
    });
    const writerPoolTwo = new Pool({
      connectionString: testDatabaseUrl,
      connectionTimeoutMillis: 2000,
      statement_timeout: 6000,
      query_timeout: 7000,
    });
    const writerPrismaOne = new PrismaClient({
      adapter: new PrismaPg(writerPoolOne),
    });
    const writerPrismaTwo = new PrismaClient({
      adapter: new PrismaPg(writerPoolTwo),
    });
    let writes: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let waiters = 0;
    let results: PromiseSettledResult<unknown>[];
    try {
      const blocker = await poolOne.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query("SET LOCAL statement_timeout = '1500ms'");
        await blocker.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`exom:day-progress:${clientId}`],
        );
        writes = Promise.allSettled([
          runProgressCommand(
            completeId,
            String(before.sync_revision),
            ['completeTraining', completion],
            () =>
              createService(writerPrismaOne).completeTraining(
                clientId,
                completion,
              ),
          ),
          runProgressCommand(
            unmarkId,
            String(before.sync_revision),
            ['unmarkExercise', date, trainingExerciseOneId, sessionId],
            () =>
              createService(writerPrismaTwo).unmarkExercise(
                clientId,
                date,
                trainingExerciseOneId,
                sessionId,
              ),
          ),
        ]);
        // Observe only waiters on this transaction's exact advisory lock.
        for (let attempt = 0; attempt < 200 && waiters < 2; attempt++) {
          const { rows } = await blocker.query<{ n: number }>(
            `SELECT count(DISTINCT waiting.pid)::int AS n
              FROM pg_locks held JOIN pg_locks waiting
                ON waiting.locktype = held.locktype AND waiting.database = held.database
                AND waiting.classid = held.classid AND waiting.objid = held.objid
                AND waiting.objsubid = held.objsubid
              WHERE held.pid = pg_backend_pid() AND held.locktype = 'advisory'
                AND held.granted AND NOT waiting.granted`,
          );
          waiters = rows[0].n;
          if (waiters < 2)
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        try {
          await blocker.query('ROLLBACK');
          blocker.release();
        } catch {
          // Closing the socket also releases its transaction-scoped lock.
          blocker.release(true);
        }
      }
      if (writes === undefined)
        throw new Error('Concurrent commands did not start');
      // Server-side statement and client query deadlines bound both waiters;
      // fail the assertion if their settled outcomes are not available in time.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        results = await Promise.race([
          writes,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Concurrent commands did not settle')),
              10000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } finally {
      // On a barrier failure, still consume both outcomes after releasing it;
      // server-side statement/query timeouts prevent orphaned lock waiters.
      if (writes !== undefined) await writes;
      await writerPrismaOne.$disconnect();
      await writerPrismaTwo.$disconnect();
      await writerPoolOne.end();
      await writerPoolTwo.end();
    }
    expect(waiters).toBe(2);
    const [completeResult, unmarkResult] = results;
    expect(
      [completeResult, unmarkResult].filter(
        (result) => result.status === 'fulfilled',
      ),
    ).toHaveLength(1);
    const rejected = [completeResult, unmarkResult].find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      response: { code: 'PROGRESS_VERSION_CONFLICT' },
    });
    const after = await readProgress();
    expect(after.sync_revision).toBe(before.sync_revision + 1);
    expect(after.meals_completed).toEqual(before.meals_completed);
    const entries = completedExercises(after.exercises_completed);
    expect(
      entries.find((entry) => entry.training_session_id === otherSessionId),
    ).toEqual(otherEntry);
    expect(
      entries.filter((entry) => entry.training_session_id === sessionId),
    ).toEqual(
      completeResult.status === 'fulfilled'
        ? [
            expect.objectContaining({
              training_exercise_id: trainingExerciseOneId,
              sets: firstSets,
            }),
            expect.objectContaining({
              training_exercise_id: trainingExerciseTwoId,
            }),
          ]
        : [],
    );
    expect(after.training_sessions).toEqual(
      completeResult.status === 'fulfilled'
        ? [
            {
              training_session_id: sessionId,
              training_id: trainingOneId,
              rpe: 7,
              note: 'Confirmed',
            },
          ]
        : [],
    );
    expect(after.trainings_completed).toEqual(
      completeResult.status === 'fulfilled' ? [trainingOneId] : [],
    );
    // The other session has only exercise evidence, not an explicit claim.
    expect(after.training_completed).toBe(false);
    const receipts = await prismaOne.progressOperation.findMany({
      where: { owner_id: clientId },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].id).toBe(
      completeResult.status === 'fulfilled' ? completeId : unmarkId,
    );
  }, 15000);

  it('P3: an operation ID cannot be reused across completion and unmark', async () => {
    const sessionId = `opposite-reuse-${suffix}`;
    const dto = {
      date,
      training_id: trainingOneId,
      training_session_id: sessionId,
    };
    const operationId = `opposite-reuse-operation-${suffix}`;
    const completed = await runProgressCommand(
      operationId,
      '0',
      ['completeTraining', dto],
      () => serviceOne.completeTraining(clientId, dto),
    );
    const before = await readProgress();
    await expect(
      runProgressCommand(
        operationId,
        String(before.sync_revision),
        ['unmarkExercise', date, trainingExerciseOneId, sessionId],
        () =>
          serviceTwo.unmarkExercise(
            clientId,
            date,
            trainingExerciseOneId,
            sessionId,
          ),
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PROGRESS_OPERATION_CONFLICT' },
    });
    expect(await readProgress()).toEqual(before);
    expect(completed.operation_revision).toBe(before.sync_revision);
    expect(
      await prismaOne.progressOperation.count({
        where: { owner_id: clientId },
      }),
    ).toBe(1);
  });

  it('P3: stale NEW completion after unmark cannot create a receipt', async () => {
    const sessionId = `opposite-stale-${suffix}`;
    await serviceOne.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
      training_session_id: sessionId,
    });
    const before = await readProgress();
    const unmarked = await runProgressCommand(
      `opposite-stale-unmark-${suffix}`,
      String(before.sync_revision),
      ['unmarkExercise', date, trainingExerciseOneId, sessionId],
      () =>
        serviceOne.unmarkExercise(
          clientId,
          date,
          trainingExerciseOneId,
          sessionId,
        ),
    );
    const after = await readProgress();
    expect(after.sync_revision).toBe(unmarked.operation_revision);
    expect(completedExercises(after.exercises_completed)).toEqual([]);
    await expect(
      runProgressCommand(
        `opposite-stale-new-${suffix}`,
        String(before.sync_revision),
        ['completeTraining', date, trainingOneId, sessionId],
        () =>
          serviceTwo.completeTraining(clientId, {
            date,
            training_id: trainingOneId,
            training_session_id: sessionId,
          }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PROGRESS_VERSION_CONFLICT' },
    });
    expect(await readProgress()).toEqual(after);
    expect(
      await prismaOne.progressOperation.count({
        where: { owner_id: clientId },
      }),
    ).toBe(1);
  });

  it.each(['markExerciseCompleted', 'completeTraining'] as const)(
    'P3: PostgreSQL rejects %s reusing an exercise-only session for another training without changing progress or receipts',
    async (command) => {
      const sessionId = `exercise-only-${suffix}`;
      const seedDto = {
        date,
        exercise_id: exerciseOneId,
        training_exercise_id: trainingExerciseOneId,
        training_session_id: sessionId,
        sets: [{ set_number: 1, reps: 8, rir: 0 }],
      };
      const seedOperation = `session-owner-seed-${suffix}`;
      const seed = await runProgressCommand(
        seedOperation,
        '0',
        ['markExerciseCompleted', seedDto],
        () => serviceOne.markExerciseCompleted(clientId, seedDto),
      );
      const before = await readProgress();
      const receiptsBefore = await prismaOne.progressOperation.findMany({
        where: { owner_id: clientId },
      });
      expect(before.exercises_completed).toEqual([
        expect.objectContaining({
          training_exercise_id: trainingExerciseOneId,
          training_session_id: sessionId,
          sets: seedDto.sets,
        }),
      ]);
      expect(before.training_sessions).toEqual([]);
      expect(receiptsBefore).toHaveLength(1);
      expect(before.sync_revision).toBe(seed.operation_revision);

      const rejectedOperation = `session-owner-${command}-${suffix}`;
      const apply = () =>
        runProgressCommand(
          rejectedOperation,
          String(before.sync_revision),
          [command, trainingTwoId, sessionId],
          () =>
            command === 'markExerciseCompleted'
              ? serviceTwo.markExerciseCompleted(clientId, {
                  date,
                  exercise_id: exerciseThreeId,
                  training_exercise_id: trainingExerciseThreeId,
                  training_session_id: sessionId,
                })
              : serviceTwo.completeTraining(clientId, {
                  date,
                  training_id: trainingTwoId,
                  training_session_id: sessionId,
                }),
        );
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(apply()).rejects.toMatchObject({
          status: 409,
          response: { code: 'TRAINING_SESSION_CONFLICT' },
        });
        expect(await readProgress()).toEqual(before);
        expect(
          await prismaOne.progressOperation.findMany({
            where: { owner_id: clientId },
          }),
        ).toEqual(receiptsBefore);
      }
      const replay = await runProgressCommand(
        seedOperation,
        '0',
        ['markExerciseCompleted', seedDto],
        () => serviceOne.markExerciseCompleted(clientId, seedDto),
      );
      expect(replay.operation_revision).toBe(seed.operation_revision);
      expect(await readProgress()).toEqual(before);
    },
  );

  it('P3: old client without session ID or RPE retains one legacy occurrence and historical note', async () => {
    const historical = [
      {
        exercise_id: exerciseOneId,
        completed_at: '2020-01-01T12:00:00.000Z',
        sets: [{ set_number: 1, seconds: 45 }],
      },
    ];
    await prismaOne.dayProgress.create({
      data: {
        client_id: clientId,
        date: dateValue,
        exercises_completed: historical,
        notes: 'Historical daily note',
      },
    });
    const result = await serviceOne.completeTraining(clientId, {
      date,
      training_id: trainingOneId,
    });
    expect(result.notes).toBe('Historical daily note');
    expect(result.training_sessions).toEqual([]);
    expect(completedExercises(result.exercises_completed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          exercise_id: exerciseOneId,
          sets: historical[0].sets,
        }),
      ]),
    );
    const replay = await serviceTwo.completeTraining(clientId, {
      date,
      training_id: trainingOneId,
    });
    expect(replay.exercises_completed).toEqual(result.exercises_completed);
    expect(replay.training_sessions).toEqual([]);
  });

  it('P3: persists distinct session ratings, stable operation revision and safe unmark', async () => {
    const firstDto = {
      date,
      training_id: trainingOneId,
      rpe: 8,
      session_note: 'First',
    };
    const first = await runProgressCommand(
      'rpe-first-' + suffix,
      '0',
      ['completeTraining', firstDto],
      () => serviceOne.completeTraining(clientId, firstDto),
    );
    expect(first.training_sessions).toEqual([
      { training_id: trainingOneId, rpe: 8, note: 'First' },
    ]);
    const secondDto = {
      date,
      training_id: trainingTwoId,
      rpe: 3,
      session_note: 'Second',
    };
    if (typeof first.operation_revision !== 'number') {
      throw new Error('Expected a numeric revision for the first command');
    }
    const second = await runProgressCommand(
      'rpe-second-' + suffix,
      String(first.operation_revision),
      ['completeTraining', secondDto],
      () => serviceTwo.completeTraining(clientId, secondDto),
    );
    expect(second.training_sessions).toEqual([
      { training_id: trainingOneId, rpe: 8, note: 'First' },
      { training_id: trainingTwoId, rpe: 3, note: 'Second' },
    ]);
    const replay = await runProgressCommand(
      'rpe-first-' + suffix,
      '0',
      ['completeTraining', firstDto],
      () => serviceOne.completeTraining(clientId, firstDto),
    );
    expect(replay.operation_revision).toBe(first.operation_revision);
    expect(replay.training_sessions).toEqual(second.training_sessions);
    expect(
      await prismaOne.progressOperation.count({
        where: { owner_id: clientId },
      }),
    ).toBe(2);

    if (typeof second.operation_revision !== 'number') {
      throw new Error('Expected a numeric revision for the second command');
    }
    await runProgressCommand(
      'rpe-unmark-' + suffix,
      String(second.operation_revision),
      ['unmark', date, trainingExerciseOneId],
      () => serviceOne.unmarkExercise(clientId, date, trainingExerciseOneId),
    );
    expect((await readProgress()).training_sessions).toEqual([
      { training_id: trainingTwoId, rpe: 3, note: 'Second' },
    ]);
    await runProgressCommand(
      'rpe-first-' + suffix,
      '0',
      ['completeTraining', firstDto],
      () => serviceOne.completeTraining(clientId, firstDto),
    );
    expect((await readProgress()).training_sessions).toEqual([
      { training_id: trainingTwoId, rpe: 3, note: 'Second' },
    ]);
  });

  it('I007-P01: mixed formats preserve other training completion through edit, unmark and acknowledged replay', async () => {
    const legacy = [exerciseOneId, exerciseTwoId].map((exercise_id) => ({
      exercise_id,
      completed_at: '2020-01-01T12:00:00.000Z',
      sets: [{ set_number: 1, reps: 10, rir: 2 }],
    }));
    const original = await prismaOne.dayProgress.create({
      data: {
        client_id: clientId,
        date: dateValue,
        trainings_completed: [trainingOneId],
        exercises_completed: legacy,
      },
    });
    const dto = {
      date,
      exercise_id: exerciseThreeId,
      training_exercise_id: trainingExerciseThreeId,
    };
    const apply = () =>
      runProgressCommand(
        'mixed-' + suffix,
        String(original.sync_revision),
        ['complete', dto],
        () => serviceOne.markExerciseCompleted(clientId, dto),
      );
    await apply();
    const completed = await readProgress();
    expect(completed.training_completed).toBe(true);
    expect(completed.trainings_completed).toEqual([
      trainingOneId,
      trainingTwoId,
    ]);
    expect(
      completedExercises(completed.exercises_completed).slice(0, 2),
    ).toEqual(legacy);
    await serviceTwo.unmarkExercise(clientId, date, trainingExerciseOneId);
    const unmarked = await readProgress();
    expect(unmarked.training_completed).toBe(false);
    expect(unmarked.trainings_completed).toEqual([trainingTwoId]);
    expect(completedExercises(unmarked.exercises_completed)[0]).toEqual(
      legacy[1],
    );
    await expect(apply()).resolves.toMatchObject({
      sync_revision: unmarked.sync_revision,
      operation_revision: completed.sync_revision,
      training_completed: false,
      trainings_completed: [trainingTwoId],
    });
    expect(await readProgress()).toEqual(unmarked);
  });

  it.each(['mark', 'complete'] as const)(
    'I007-P02: %s rejects conflicting historical rows without receipts or side effects, including retry',
    async (command) => {
      const entries = [20, 30].map((weight_kg) => ({
        training_exercise_id: trainingExerciseOneId,
        exercise_id: exerciseOneId,
        completed_at: '2020-01-01T12:00:00.000Z',
        sets: [{ set_number: 1, reps: 8, seconds: 60, weight_kg, rir: 0 }],
        retained: { note: 'synthetic history' },
      }));
      const original = await prismaOne.dayProgress.create({
        data: {
          client_id: clientId,
          date: dateValue,
          exercises_completed: entries,
          trainings_completed: [trainingOneId],
          notes: 'preserved',
        },
      });
      const apply = () =>
        runProgressCommand(
          'historical-' + suffix,
          String(original.sync_revision),
          [command],
          () =>
            command === 'mark'
              ? serviceOne.markExerciseCompleted(clientId, {
                  date,
                  exercise_id: exerciseOneId,
                  training_exercise_id: trainingExerciseOneId,
                })
              : serviceOne.completeTraining(clientId, {
                  date,
                  training_id: trainingOneId,
                }),
        );
      for (let retry = 0; retry < 2; retry++) {
        await expect(apply()).rejects.toMatchObject({
          status: 409,
          response: { code: 'PROGRESS_HISTORY_AMBIGUOUS' },
        });
        expect(await readProgress()).toEqual(original);
        expect(
          await prismaOne.progressOperation.count({
            where: { owner_id: clientId },
          }),
        ).toBe(0);
      }
      await serviceTwo.markExerciseCompleted(clientId, {
        date,
        exercise_id: exerciseThreeId,
        training_exercise_id: trainingExerciseThreeId,
      });
      expect(
        completedExercises((await readProgress()).exercises_completed).slice(
          0,
          2,
        ),
      ).toEqual(entries);
    },
  );

  it('I007-P02: guard sees duplicate history committed by a writer while completion waits', async () => {
    await serviceOne.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    });
    const original = await readProgress();
    const entries = completedExercises(original.exercises_completed);
    const blocker = await poolOne.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`exom:day-progress:${clientId}`],
    );
    await blocker.query(
      'UPDATE day_progress SET exercises_completed=$1::jsonb WHERE id=$2',
      [
        JSON.stringify([...entries, { ...entries[0], weight_used: 99 }]),
        original.id,
      ],
    );
    const result = serviceTwo
      .completeTraining(clientId, { date, training_id: trainingOneId })
      .then(
        () => ({ status: 200 }),
        (error: unknown) => error,
      );
    let waiters = 0;
    try {
      for (let attempt = 0; attempt < 200 && waiters < 1; attempt++) {
        waiters = (
          await blocker.query<{ n: number }>(
            "SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
          )
        ).rows[0].n;
        if (!waiters) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    expect(waiters).toBe(1);
    await expect(result).resolves.toMatchObject({
      status: 409,
      response: { code: 'PROGRESS_HISTORY_AMBIGUOUS' },
    });
    expect((await readProgress()).exercises_completed).toEqual([
      ...entries,
      { ...entries[0], weight_used: 99 },
    ]);
    expect((await readProgress()).sync_revision).toBe(
      original.sync_revision + 1,
    );
  });

  it('P4: a lost completion response replay cannot undo a later unmark', async () => {
    const dto = {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    };
    const apply = () =>
      runProgressCommand('lost-' + suffix, '0', ['complete', dto], () =>
        serviceOne.markExerciseCompleted(clientId, dto),
      );
    await apply();
    const revision = (await readProgress()).sync_revision;
    await runProgressCommand(
      'unmark-' + suffix,
      String(revision),
      ['unmark', date, trainingExerciseOneId],
      () => serviceTwo.unmarkExercise(clientId, date, trainingExerciseOneId),
    );
    const after = await readProgress();
    const replay: unknown = await apply();
    expect(replay).toMatchObject({
      sync_revision: after.sync_revision,
      operation_revision: revision,
      exercises_completed: after.exercises_completed,
    });
    expect(await readProgress()).toEqual(after);
    expect(completedExercises(after.exercises_completed)).toEqual([]);
    expect(
      await prismaOne.progressOperation.count({
        where: { owner_id: clientId },
      }),
    ).toBe(2);
  });

  it('P4: an old first attempt conflicts with a newer device or legacy writer', async () => {
    const dto = {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
      sets: [{ set_number: 1, reps: 8, rir: 2 }],
    };
    await serviceOne.markExerciseCompleted(clientId, dto);
    await expect(
      runProgressCommand('stale-' + suffix, '0', ['edit', dto], () =>
        serviceTwo.markExerciseCompleted(clientId, {
          ...dto,
          sets: [{ set_number: 1, reps: 4 }],
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'PROGRESS_VERSION_CONFLICT' },
    });
    expect(
      completedExercises((await readProgress()).exercises_completed)[0].sets,
    ).toEqual(dto.sets);
  });

  it('P4: concurrent devices at the same revision have one winner and one explicit conflict', async () => {
    const blocker = await poolOne.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      ['exom:day-progress:' + clientId],
    );
    const dto = {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    };
    const writes = Promise.allSettled([
      runProgressCommand('device-one-' + suffix, '0', ['edit', 8], () =>
        serviceOne.markExerciseCompleted(clientId, {
          ...dto,
          sets: [{ set_number: 1, reps: 8 }],
        }),
      ),
      runProgressCommand('device-two-' + suffix, '0', ['edit', 9], () =>
        serviceTwo.markExerciseCompleted(clientId, {
          ...dto,
          sets: [{ set_number: 1, reps: 9 }],
        }),
      ),
    ]);
    let waiters = 0;
    try {
      for (let attempt = 0; attempt < 200 && waiters < 2; attempt++) {
        const result = await blocker.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",
        );
        waiters = result.rows[0].n;
        if (waiters < 2)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    const result = await writes;
    expect(waiters).toBe(2);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = result.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject({
      response: { code: 'PROGRESS_VERSION_CONFLICT' },
    });
    expect((await readProgress()).sync_revision).toBe(1);
  });

  it('P4: crash post-commit retains the receipt; rollback does not', async () => {
    const dto = {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    };
    const id = 'post-commit-' + suffix;
    await expect(
      runProgressCommand(id, '0', dto, () =>
        createService(prismaOne, 'challenge').markExerciseCompleted(
          clientId,
          dto,
        ),
      ),
    ).rejects.toThrow('challenge failure');
    const before = await readProgress();
    await runProgressCommand(id, '0', dto, () =>
      serviceTwo.markExerciseCompleted(clientId, dto),
    );
    expect(await readProgress()).toEqual(before);
    await expect(
      runProgressCommand(
        'rollback-' + suffix,
        String(before.sync_revision),
        ['meal', mealId],
        () =>
          createService(prismaOne, 'streak').markMealCompleted(clientId, {
            date,
            meal_id: mealId,
          }),
      ),
    ).rejects.toThrow('streak failure');
    expect(
      await prismaOne.progressOperation.findUnique({
        where: {
          owner_id_id: { owner_id: clientId, id: 'rollback-' + suffix },
        },
      }),
    ).toBeNull();
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

  it('merges different series written simultaneously without losing RIR', async () => {
    await Promise.all([
      serviceOne.markExerciseCompleted(clientId, {
        date,
        exercise_id: exerciseOneId,
        training_exercise_id: trainingExerciseOneId,
        sets: [{ set_number: 1, reps: 10, rir: 0 }],
      }),
      serviceTwo.markExerciseCompleted(clientId, {
        date,
        exercise_id: exerciseOneId,
        training_exercise_id: trainingExerciseOneId,
        sets: [{ set_number: 2, reps: 8, rir: 10 }],
      }),
    ]);

    const entries = completedExercises(
      (await readProgress()).exercises_completed,
    );
    expect(entries).toHaveLength(1);
    expect(
      [...(entries[0].sets ?? [])].sort((a, b) => a.set_number - b.set_number),
    ).toEqual([
      { set_number: 1, reps: 10, rir: 0 },
      { set_number: 2, reps: 8, rir: 10 },
    ]);
  });

  it('allows a partial RIR correction without resending the recorded reps', async () => {
    const command = {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    };
    await serviceOne.markExerciseCompleted(clientId, {
      ...command,
      sets: [{ set_number: 1, reps: 8, rir: 2 }],
    });
    await serviceTwo.markExerciseCompleted(clientId, {
      ...command,
      sets: [{ set_number: 1, rir: null }],
    });
    expect(
      completedExercises((await readProgress()).exercises_completed)[0].sets,
    ).toEqual([{ set_number: 1, reps: 8, rir: null }]);
  });

  it('serializes actual concurrent partial fields of an existing series', async () => {
    const command = {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    };
    await serviceOne.markExerciseCompleted(clientId, {
      ...command,
      sets: [{ set_number: 1, reps: 8, rir: 2 }],
    });
    const blocker = await poolOne.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`exom:day-progress:${clientId}`],
    );
    const writes = Promise.all([
      serviceOne.markExerciseCompleted(clientId, {
        ...command,
        sets: [{ set_number: 1, reps: 10 }],
      }),
      serviceTwo.markExerciseCompleted(clientId, {
        ...command,
        sets: [{ set_number: 1, rir: 5 }],
      }),
    ]);
    let waiters = 0;
    try {
      for (let attempt = 0; attempt < 200 && waiters < 2; attempt++) {
        const result = await blocker.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
        );
        waiters = result.rows[0].n;
        if (waiters < 2)
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    await writes;
    expect(waiters).toBe(2);
    expect(
      completedExercises((await readProgress()).exercises_completed)[0].sets,
    ).toEqual([{ set_number: 1, reps: 10, rir: 5 }]);
  });

  it('cannot use another training occurrence to satisfy required sets in completeTraining', async () => {
    await prismaOne.trainingExercise.update({
      where: { id: trainingExerciseThreeId },
      data: { exercise_id: exerciseOneId, request_set_tracking: true },
    });
    try {
      await serviceOne.markExerciseCompleted(clientId, {
        date,
        exercise_id: exerciseOneId,
        training_exercise_id: trainingExerciseOneId,
        sets: [{ set_number: 1, reps: 8, rir: 2 }],
      });
      await expect(
        serviceTwo.completeTraining(clientId, {
          date,
          training_id: trainingTwoId,
        }),
      ).rejects.toThrow();
      expect(
        completedExercises((await readProgress()).exercises_completed),
      ).toHaveLength(1);
    } finally {
      await prismaOne.trainingExercise.update({
        where: { id: trainingExerciseThreeId },
        data: { exercise_id: exerciseThreeId, request_set_tracking: false },
      });
    }
  });

  it('does not bypass required series through the individual completion command', async () => {
    await prismaOne.trainingExercise.update({
      where: { id: trainingExerciseOneId },
      data: { request_set_tracking: true, sets: 2 },
    });
    try {
      await expect(
        serviceOne.markExerciseCompleted(clientId, {
          date,
          exercise_id: exerciseOneId,
          training_exercise_id: trainingExerciseOneId,
          sets: [{ set_number: 1, reps: 8 }],
        }),
      ).rejects.toThrow();
      expect(
        await prismaOne.dayProgress.count({ where: { client_id: clientId } }),
      ).toBe(0);
    } finally {
      await prismaOne.trainingExercise.update({
        where: { id: trainingExerciseOneId },
        data: { request_set_tracking: false, sets: 1 },
      });
    }
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

  it('keeps completed training identities that are no longer in the current assignment', async () => {
    await prismaOne.dayProgress.create({
      data: {
        client_id: clientId,
        date: dateValue,
        trainings_completed: ['historical-training'],
        exercises_completed: [],
        meals_completed: [],
      },
    });
    await serviceOne.markExerciseCompleted(clientId, {
      date,
      exercise_id: exerciseOneId,
      training_exercise_id: trainingExerciseOneId,
    });
    expect((await readProgress()).trainings_completed).toContain(
      'historical-training',
    );
    expect((await readProgress()).training_completed).toBe(false);
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

  it('rejects ambiguous legacy unmark without deleting either occurrence', async () => {
    await prismaOne.trainingExercise.update({
      where: { id: trainingExerciseThreeId },
      data: { exercise_id: exerciseOneId },
    });
    try {
      for (const id of [trainingExerciseOneId, trainingExerciseThreeId]) {
        await serviceOne.markExerciseCompleted(clientId, {
          date,
          exercise_id: exerciseOneId,
          training_exercise_id: id,
          sets: [{ set_number: 1, reps: 8, rir: 2 }],
        });
      }
      await expect(
        serviceTwo.unmarkExercise(clientId, date, exerciseOneId),
      ).rejects.toThrow('training_exercise_id');
      expect(
        completedExercises((await readProgress()).exercises_completed),
      ).toHaveLength(2);
      await serviceTwo.unmarkExercise(clientId, date, trainingExerciseOneId);
      expect(
        completedExercises((await readProgress()).exercises_completed),
      ).toEqual([
        expect.objectContaining({
          training_exercise_id: trainingExerciseThreeId,
        }),
      ]);
    } finally {
      await prismaOne.trainingExercise.update({
        where: { id: trainingExerciseThreeId },
        data: { exercise_id: exerciseThreeId },
      });
    }
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

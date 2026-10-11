import { expect } from '@jest/globals';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  AchievementUnlockSource,
  PrismaClient,
  Role,
  TrainingCompletionMode,
} from '@prisma/client';
import { Pool } from 'pg';
import { runProgressCommand } from '../../common/progress/progress-command';
import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import type { ChallengesService } from '../challenges/challenges.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { StreakCalculatorService } from '../streaks/streak-calculator.service';
import type { UploadsService } from '../uploads/uploads.service';
import { ProgressService } from '../progress/progress.service';
import { AssignmentsService } from './assignments.service';
import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';
import { LastSetVideoPolicyService } from './last-set-video-policy.service';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';

const url = process.env.TEST_DATABASE_URL ?? '';
const suite = url ? describe : describe.skip;

suite('training completion mode on PostgreSQL', () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const clientId = `tcm-client-${suffix}`;
  const adminId = `tcm-admin-${suffix}`;
  const ruleId = `tcm-rule-${suffix}`;
  const achievementId = `tcm-achievement-${suffix}`;
  const trainingIds = ['1', '2', '3'].map((n) => `tcm-training-${n}-${suffix}`);
  const exerciseIds = ['1', '2', '3'].map((n) => `tcm-exercise-${n}-${suffix}`);
  const occurrenceIds = ['1', '2', '3'].map(
    (n) => `tcm-occurrence-${n}-${suffix}`,
  );
  // Past date: the materializer never rewrites it, only rule-mode propagation.
  const day = '2026-01-05';
  const dayValue = new Date(`${day}T00:00:00.000Z`);
  const admin = {
    id: adminId,
    email: `${adminId}@example.test`,
    role: Role.SUPER_ADMIN,
    firebase_uid: adminId,
  };

  let adminPool: Pool;
  let clientPool: Pool;
  let controlPool: Pool;
  let adminDb: PrismaClient;
  let clientDb: PrismaClient;
  let assignments: AssignmentsService;
  let progress: ProgressService;

  function progressService(db: PrismaClient) {
    return new ProgressService(
      db as unknown as PrismaService,
      {
        recalculateAutomaticProgress: jest.fn().mockResolvedValue(undefined),
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
        recalculateClient: jest.fn().mockResolvedValue({
          currentDays: 1,
          longestDays: 1,
          previousCurrentDays: 1,
          changed: false,
        }),
      } as unknown as StreakCalculatorService,
      {
        isConsumedManagedUrl: jest.fn().mockResolvedValue(true),
      } as unknown as UploadsService,
      new AutoAssignmentMaterializerService(
        db as unknown as PrismaService,
        new LastSetVideoPolicyService(db as unknown as PrismaService),
      ),
    );
  }

  const ruleDto = (mode: TrainingCompletionMode) => ({
    client_id: clientId,
    source_week_start: '2025-12-29',
    starts_on: '2025-12-29',
    ends_on: '2026-01-11',
    days: [
      {
        weekday: 1,
        trainings: trainingIds.map((training_id) => ({ training_id })),
      },
    ],
    training_completion_mode: mode,
  });

  async function readDay() {
    return adminDb.dayProgress.findUniqueOrThrow({
      where: { client_id_date: { client_id: clientId, date: dayValue } },
    });
  }

  async function advisoryWaiters(): Promise<number> {
    const { rows } = await controlPool.query<{ waiting: string }>(
      `SELECT count(*)::text AS waiting FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    return Number(rows[0].waiting);
  }

  async function waitForWaiters(expected: number) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if ((await advisoryWaiters()) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected ${expected} PostgreSQL lock waiters`);
  }

  /**
   * Runs `first` and `second` so that both are genuinely blocked on the
   * client's day-progress advisory lock, in that queue order, before release.
   */
  async function interleave<A, B>(
    first: () => Promise<A>,
    second: () => Promise<B>,
  ): Promise<[A, B]> {
    const blocker = await controlPool.connect();
    let released = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`exom:day-progress:${clientId}`],
      );
      const firstRun = first();
      firstRun.catch(() => undefined);
      await waitForWaiters(1);
      const secondRun = second();
      secondRun.catch(() => undefined);
      await waitForWaiters(2);
      await blocker.query('COMMIT');
      released = true;
      return await Promise.all([firstRun, secondRun]);
    } finally {
      if (!released) await blocker.query('ROLLBACK');
      blocker.release();
    }
  }

  beforeAll(async () => {
    controlPool = new Pool({ connectionString: url });
    await assertTestDatabase(controlPool);
    adminPool = new Pool({ connectionString: url });
    clientPool = new Pool({ connectionString: url });
    adminDb = new PrismaClient({ adapter: new PrismaPg(adminPool) });
    clientDb = new PrismaClient({ adapter: new PrismaPg(clientPool) });
    const notifications = {
      queueTemplate: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationsService;
    const lastSetVideoPolicy = new LastSetVideoPolicyService(
      adminDb as unknown as PrismaService,
    );
    assignments = new AssignmentsService(
      adminDb as unknown as PrismaService,
      notifications,
      new AutoAssignmentMaterializerService(
        adminDb as unknown as PrismaService,
        lastSetVideoPolicy,
      ),
      lastSetVideoPolicy,
    );
    progress = progressService(clientDb);

    await adminDb.user.createMany({
      data: [
        {
          id: clientId,
          email: `${clientId}@example.test`,
          firebase_uid: clientId,
          role: Role.CLIENT,
        },
        {
          id: adminId,
          email: `${adminId}@example.test`,
          firebase_uid: adminId,
          role: Role.SUPER_ADMIN,
        },
      ],
    });
    await adminDb.exercise.createMany({
      data: exerciseIds.map((id) => ({ id, name: id })),
    });
    await adminDb.training.createMany({
      data: trainingIds.map((id) => ({ id, name: id, type: 'TEST' })),
    });
    await adminDb.trainingExercise.createMany({
      data: trainingIds.map((training_id, index) => ({
        id: occurrenceIds[index],
        training_id,
        exercise_id: exerciseIds[index],
        order: 0,
        sets: 1,
        reps_or_duration: '10',
      })),
    });
  });

  beforeEach(async () => {
    await adminDb.dayProgress.deleteMany({ where: { client_id: clientId } });
    await adminDb.progressOperation.deleteMany({
      where: { owner_id: clientId },
    });
    await adminDb.planAssignment.deleteMany({ where: { client_id: clientId } });
    await adminDb.autoAssignmentRule.deleteMany({
      where: { client_id: clientId },
    });
    await adminDb.durableWork.deleteMany({ where: { owner_id: clientId } });
    await adminDb.autoAssignmentRule.create({
      data: {
        id: ruleId,
        client_id: clientId,
        admin_id: adminId,
        source_week_start: new Date('2025-12-29T00:00:00.000Z'),
        starts_on: new Date('2025-12-29T00:00:00.000Z'),
        ends_on: new Date('2026-01-11T00:00:00.000Z'),
      },
    });
    await adminDb.planAssignment.create({
      data: {
        client_id: clientId,
        admin_id: adminId,
        date: dayValue,
        auto_assignment_rule_id: ruleId,
        training_id: trainingIds[0],
        trainings: {
          create: trainingIds.map((training_id, position) => ({
            training_id,
            position,
          })),
        },
      },
    });
  });

  afterAll(async () => {
    try {
      await adminDb?.achievement.deleteMany({ where: { id: achievementId } });
      await adminDb?.user.deleteMany({
        where: { id: { in: [clientId, adminId] } },
      });
      await adminDb?.training.deleteMany({
        where: { id: { in: trainingIds } },
      });
      await adminDb?.exercise.deleteMany({
        where: { id: { in: exerciseIds } },
      });
    } finally {
      await adminDb?.$disconnect();
      await clientDb?.$disconnect();
      await adminPool?.end();
      await clientPool?.end();
      await controlPool?.end();
    }
  });

  const completeFirst = () =>
    progress.completeTraining(clientId, {
      date: day,
      training_id: trainingIds[0],
      training_session_id: `session-1-${suffix}`,
    });

  it.each(['admin-first', 'client-first'] as const)(
    'a rule switch to ANY racing one completed training ends completed without lost updates (%s)',
    async (order) => {
      const switchMode = () =>
        assignments.updateAutoRule(
          admin,
          ruleId,
          ruleDto(TrainingCompletionMode.ANY),
        );
      if (order === 'admin-first') await interleave(switchMode, completeFirst);
      else await interleave(completeFirst, switchMode);

      const final = await readDay();
      const assignment = await adminDb.planAssignment.findUniqueOrThrow({
        where: { client_id_date: { client_id: clientId, date: dayValue } },
        include: { trainings: true },
      });
      expect(assignment.training_completion_mode).toBe('ANY');
      // Mode-only propagation: rule link and link-row IDs are untouched.
      expect(assignment.auto_assignment_rule_id).toBe(ruleId);
      expect(assignment.trainings).toHaveLength(3);
      expect(final.training_completed).toBe(true);
      expect(final.trainings_completed).toEqual([trainingIds[0]]);
      expect(final.exercises_completed).toEqual([
        expect.objectContaining({
          training_exercise_id: occurrenceIds[0],
          training_session_id: `session-1-${suffix}`,
        }),
      ]);
      // Private provenance column (not in the Prisma model): stamped on flip.
      const { rows: activity } = await controlPool.query<{
        training: string | null;
      }>(
        `SELECT challenge_activity->>'training' AS training FROM day_progress
         WHERE client_id = $1 AND date = $2::date`,
        [clientId, day],
      );
      expect(activity[0].training).toEqual(expect.any(String));
      // Client write creates the row (revision 1). Under client-first the
      // admin promotion is one more change; admin-first writes once.
      expect(final.sync_revision).toBe(order === 'client-first' ? 2 : 1);
      const reconcile = await adminDb.durableWork.findMany({
        where: { owner_id: clientId, kind: 'RECONCILE' },
      });
      expect(
        reconcile.some((work) =>
          JSON.stringify(work.payload).includes('TRAINING_DAYS'),
        ),
      ).toBe(true);
    },
  );

  it('a promotion bumps the revision so a stale offline command conflicts', async () => {
    await progress.completeTraining(clientId, {
      date: day,
      training_id: trainingIds[0],
      training_session_id: `session-1-${suffix}`,
    });
    const before = await readDay();
    expect(before.training_completed).toBe(false);
    await assignments.updateAutoRule(
      admin,
      ruleId,
      ruleDto(TrainingCompletionMode.ANY),
    );
    const after = await readDay();
    expect(after.training_completed).toBe(true);
    expect(after.sync_revision).toBe(before.sync_revision + 1);
    expect(after.trainings_completed).toEqual(before.trainings_completed);
    expect(after.exercises_completed).toEqual(before.exercises_completed);

    const dto = {
      date: day,
      training_id: trainingIds[1],
      training_session_id: `session-2-${suffix}`,
    };
    await expect(
      runProgressCommand(
        `stale-${suffix}`,
        String(before.sync_revision),
        ['completeTraining', dto],
        () => progress.completeTraining(clientId, dto),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PROGRESS_VERSION_CONFLICT' }),
    });
    // Recomputing again (same mode) is a no-op.
    await assignments.updateAutoRule(
      admin,
      ruleId,
      ruleDto(TrainingCompletionMode.ANY),
    );
    expect((await readDay()).sync_revision).toBe(after.sync_revision);
  });

  it.each([
    ['admin-first', false],
    ['client-first', true],
  ] as const)(
    'a switch to ALL racing a client write serializes (%s ends completed=%s)',
    async (order, expected) => {
      await assignments.updateAutoRule(
        admin,
        ruleId,
        ruleDto(TrainingCompletionMode.ANY),
      );
      await completeFirst();
      expect((await readDay()).training_completed).toBe(true);
      const switchToAll = () =>
        assignments.updateAutoRule(
          admin,
          ruleId,
          ruleDto(TrainingCompletionMode.ALL),
        );
      const clientWrite = () =>
        progress.markExerciseCompleted(clientId, {
          date: day,
          exercise_id: exerciseIds[0],
          training_exercise_id: occurrenceIds[0],
          training_session_id: `session-1-${suffix}`,
          sets: [{ set_number: 1, reps: 10 }],
        });
      if (order === 'admin-first') await interleave(switchToAll, clientWrite);
      else await interleave(clientWrite, switchToAll);

      // Admin first: the client's own later write recomputes under ALL (one of
      // three is not a complete day), as any client write does today. Client
      // first: the later mode switch is promote-only and never demotes.
      const final = await readDay();
      expect(final.training_completed).toBe(expected);
      expect(final.trainings_completed).toEqual([trainingIds[0]]);
      expect(final.exercises_completed).toEqual([
        expect.objectContaining({
          training_exercise_id: occurrenceIds[0],
          sets: [{ set_number: 1, reps: 10 }],
        }),
      ]);
    },
  );

  it('switching ANY to ALL alone never demotes nor revokes an automatic unlock', async () => {
    await adminDb.achievement.upsert({
      where: { id: achievementId },
      create: {
        id: achievementId,
        name: 'TCM one training day',
        description: 'synthetic',
        criteria_type: 'TRAINING_DAYS',
        criteria_value: 1,
      },
      update: {},
    });
    await adminDb.userAchievement.deleteMany({ where: { user_id: clientId } });
    const achievements = new AchievementsService(
      adminDb as unknown as PrismaService,
      {} as NotificationsService,
    );
    await assignments.updateAutoRule(
      admin,
      ruleId,
      ruleDto(TrainingCompletionMode.ANY),
    );
    await completeFirst();
    await achievements.evaluateAutomaticAchievementsForUser(
      clientId,
      undefined,
      [achievementId],
    );
    const before = await readDay();

    await assignments.updateAutoRule(
      admin,
      ruleId,
      ruleDto(TrainingCompletionMode.ALL),
    );
    const again = await achievements.evaluateAutomaticAchievementsForUser(
      clientId,
      undefined,
      [achievementId],
    );

    const after = await readDay();
    expect(after.training_completed).toBe(true);
    expect(after.sync_revision).toBe(before.sync_revision);
    expect(again).toMatchObject({ granted: 0, revoked: 0 });
    expect(
      await adminDb.userAchievement.findMany({
        where: { user_id: clientId, achievement_id: achievementId },
        select: { unlock_source: true },
      }),
    ).toEqual([{ unlock_source: AchievementUnlockSource.AUTOMATIC }]);
  });
});

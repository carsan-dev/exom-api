import { PrismaClient, Prisma, DurableWork } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { StreakCalculatorService } from '../streaks/streak-calculator.service';
import { StreaksService } from '../streaks/streaks.service';
import { DomainWorkService } from '../jobs/domain-work.service';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { aggregateScope } from '../../common/progress/aggregate-scope';
import { lockClientDayProgress } from '../../common/progress/day-progress-lock';
import { Test } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { Server } from 'node:http';
import { ChallengesController } from '../challenges/challenges.controller';
import { AchievementsController } from '../achievements/achievements.controller';
import { StreaksController } from '../streaks/streaks.controller';
import { RolesGuard } from '../../common/guards/roles.guard';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)(
  'P7 scoped aggregates / real PostgreSQL',
  () => {
    let db: PrismaClient, pool: Pool;
    let achievements: AchievementsService, challenges: ChallengesService;
    let streak: StreakCalculatorService, domain: DomainWorkService;
    let isolated = false;
    const owner = `p7-${randomUUID()}`;
    const training = `${owner}-training`;
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    const day = (n: number) => new Date(now.getTime() - n * 86400000);
    const notify = { findSystemSenderId: jest.fn().mockResolvedValue(null) };
    const rules = [
      'TRAINING_DAYS',
      'MEAL_CHECKINS',
      'WEIGHT_LOGS',
      'STREAK_DAYS',
    ] as const;
    const challengeId = (rule: string) => `${owner}-${rule}`;

    beforeAll(async () => {
      const target = new URL(url!);
      if (
        target.hostname !== '127.0.0.1' ||
        target.port !== '55447' ||
        target.pathname !== '/exom_review'
      )
        throw Error('P7 disposable DB required');
      pool = new Pool({ connectionString: url });
      const identity = await pool.query<{ data_directory: string }>(
        'SHOW data_directory',
      );
      expect(resolve(identity.rows[0].data_directory)).toBe(
        resolve(process.cwd(), '../docs/operations/phase7-20260912/pgdata'),
      );
      db = new PrismaClient({ adapter: new PrismaPg(pool) });
      isolated = true;
      const prisma = db as PrismaService;
      Object.assign(prisma, { postgresqlPool: pool });
      achievements = new AchievementsService(
        prisma,
        notify as unknown as NotificationsService,
      );
      challenges = new ChallengesService(
        prisma,
        achievements,
        notify as unknown as NotificationsService,
      );
      streak = new StreakCalculatorService(prisma);
      domain = new DomainWorkService(
        prisma,
        new JobsService(prisma),
        challenges,
        achievements,
        notify as unknown as NotificationsService,
        streak,
      );
      await db.user.create({
        data: {
          id: owner,
          email: `${owner}@example.test`,
          firebase_uid: owner,
          role: 'CLIENT',
        },
      });
      await db.training.create({
        data: {
          id: training,
          name: 'P7 fixture',
          type: 'Strength',
          created_by: owner,
        },
      });
      for (let n = 0; n < 14; n++) {
        await db.planAssignment.create({
          data: { client_id: owner, date: day(n), training_id: training },
        });
        await db.dayProgress.create({
          data: {
            client_id: owner,
            date: day(n),
            training_completed: false,
            exercises_completed: [],
            meals_completed: [],
          },
        });
      }
      for (const rule of rules) {
        await db.challenge.create({
          data: {
            id: challengeId(rule),
            title: rule,
            description: 'fixture',
            type: 'MAIN_GOAL',
            target_value: 2,
            unit: 'days',
            rule_key: rule,
            is_manual: false,
            created_by: owner,
          },
        });
        await db.challengeClient.create({
          data: {
            challenge_id: challengeId(rule),
            client_id: owner,
            assigned_at: day(13),
          },
        });
      }
      for (const rule of [
        'TRAINING_DAYS',
        'WEIGHT_LOGS',
        'STREAK_DAYS',
        'CHALLENGES_COMPLETED',
      ]) {
        await db.achievement.create({
          data: {
            id: `${owner}-ach-${rule}`,
            name: rule,
            description: 'fixture',
            criteria_type: rule,
            criteria_value: 2,
            ...(rule === 'TRAINING_DAYS'
              ? { rule_config: { training_type: 'Strength' } }
              : {}),
          },
        });
      }
      await canonical();
      await db.durableWork.deleteMany({ where: { owner_id: owner } });
    });

    afterAll(async () => {
      if (isolated) {
        await db.challenge.deleteMany({ where: { id: { startsWith: owner } } });
        await db.achievement.deleteMany({
          where: { id: { startsWith: owner } },
        });
        await db.user.delete({ where: { id: owner } });
        await db.training.delete({ where: { id: training } });
        await db.durableWork.deleteMany({ where: { owner_id: owner } });
      }
      await db?.$disconnect();
      await pool?.end();
    });

    async function canonical() {
      await db.$transaction(async (tx) => {
        await lockClientDayProgress(tx, owner);
        await streak.recalculateClient(owner, { db: tx, asOf: now });
        await challenges.recalculateAutomaticProgress(owner, tx);
        await achievements.evaluateAutomaticAchievementsForUser(owner, tx);
      });
    }
    async function snapshot() {
      return {
        challenges: await db.challengeClient.findMany({
          where: { client_id: owner },
          orderBy: { challenge_id: 'asc' },
          select: {
            challenge_id: true,
            current_value: true,
            is_completed: true,
          },
        }),
        achievements: await db.userAchievement.findMany({
          where: { user_id: owner },
          orderBy: { achievement_id: 'asc' },
          select: { achievement_id: true, unlock_source: true },
        }),
        streak: await db.streak.findUnique({
          where: { client_id: owner },
          select: {
            current_days: true,
            longest_days: true,
            last_active_date: true,
          },
        }),
      };
    }
    async function reconcileAndCompare() {
      const work = await db.durableWork.findMany({
        where: { owner_id: owner, kind: 'RECONCILE' },
        orderBy: { created_at: 'desc' },
      });
      for (const entry of work) {
        await domain.reconcile(entry);
        await domain.reconcile(entry);
      }
      const scoped = await snapshot();
      const effects = await db.durableWork.count({
        where: { owner_id: owner, kind: { not: 'RECONCILE' } },
      });
      await canonical();
      expect(await snapshot()).toEqual(scoped);
      expect(
        await db.durableWork.count({
          where: { owner_id: owner, kind: { not: 'RECONCILE' } },
        }),
      ).toBe(effects);
      await db.durableWork.deleteMany({
        where: { owner_id: owner, kind: 'RECONCILE' },
      });
    }
    const updateDay = (n: number, data: Prisma.DayProgressUpdateInput) =>
      db.dayProgress.update({
        where: { client_id_date: { client_id: owner, date: day(n) } },
        data,
      });

    it('P7-01/03: complete, undo, historical correction, duplicates and reverse work order equal canonical state', async () => {
      await updateDay(0, { training_completed: true });
      await updateDay(1, { training_completed: true });
      await reconcileAndCompare();
      await updateDay(0, { training_completed: false });
      await updateDay(8, { training_completed: true });
      await updateDay(8, { training_completed: true });
      await reconcileAndCompare();
      await updateDay(1, { meals_completed: ['a', 'b'] });
      await updateDay(1, { meals_completed: ['c'] });
      await reconcileAndCompare();
      await db.bodyMetric.create({
        data: { client_id: owner, date: day(0), weight_kg: 80 },
      });
      await db.bodyMetric.create({
        data: { client_id: owner, date: day(3), weight_kg: 81 },
      });
      await reconcileAndCompare();
      await db.bodyMetric.update({
        where: { client_id_date: { client_id: owner, date: day(3) } },
        data: { date: day(10), weight_kg: null },
      });
      await reconcileAndCompare();
      await db.bodyMetric.delete({
        where: { client_id_date: { client_id: owner, date: day(0) } },
      });
      await reconcileAndCompare();
    });

    it('P7-01: catalog, assignment window, manual grants and reset preserve canonical semantics', async () => {
      await db.training.update({
        where: { id: training },
        data: { type: 'Cardio' },
      });
      await db.challenge.update({
        where: { id: challengeId('TRAINING_DAYS') },
        data: { target_value: 1, deadline: day(2) },
      });
      await db.planAssignment.update({
        where: { client_id_date: { client_id: owner, date: day(8) } },
        data: { is_rest_day: true },
      });
      await db.userAchievement.upsert({
        where: {
          user_id_achievement_id: {
            user_id: owner,
            achievement_id: `${owner}-ach-WEIGHT_LOGS`,
          },
        },
        create: {
          user_id: owner,
          achievement_id: `${owner}-ach-WEIGHT_LOGS`,
          unlock_source: 'MANUAL',
        },
        update: { unlock_source: 'MANUAL' },
      });
      await reconcileAndCompare();
      const service = new StreaksService(
        db as PrismaService,
        challenges,
        achievements,
      );
      const response = await service.resetStreak(owner, 'SUPER_ADMIN', owner);
      expect(() => JSON.stringify(response)).not.toThrow();
      await reconcileAndCompare();
      await updateDay(1, { exercises_completed: [{ exercise_id: 'a' }] });
      await reconcileAndCompare();
    });

    it('P7-02: notes, performance-only edits, duplicate weight and meal variants create no rule invalidation', async () => {
      await updateDay(0, { exercises_completed: [{ exercise_id: 'a' }] });
      await reconcileAndCompare();
      await updateDay(0, {
        notes: 'correction',
        exercises_completed: [
          { exercise_id: 'a', sets: [{ set_number: 1, reps: 12 }] },
        ],
      });
      await updateDay(1, { meals_completed: ['another-variant'] });
      await db.bodyMetric.update({
        where: { client_id_date: { client_id: owner, date: day(10) } },
        data: { sleep_hours: 7 },
      });
      expect(
        await db.durableWork.count({
          where: { owner_id: owner, kind: 'RECONCILE' },
        }),
      ).toBe(0);
    });

    it('P7-03: GETs retain response fields without reconciliation, inserts or BigInt leakage', async () => {
      const before = await snapshot();
      const workBefore = await db.durableWork.count({
        where: { owner_id: owner },
      });
      const lastUpdate = await db.streak.findUniqueOrThrow({
        where: { client_id: owner },
      });
      const service = new StreaksService(
        db as PrismaService,
        challenges,
        achievements,
      );
      expect(() => JSON.stringify(lastUpdate)).toThrow(); // Internal counters require explicit projection.
      const responses = await Promise.all([
        challenges.findMyChallenges(owner),
        achievements.findMyAchievements(owner),
        service.getStreak(owner),
      ]);
      expect(() => JSON.stringify(responses)).not.toThrow();
      expect(responses[2]).not.toHaveProperty('source_revision');
      expect(await snapshot()).toEqual(before);
      expect(
        await db.streak.findUniqueOrThrow({ where: { client_id: owner } }),
      ).toEqual(lastUpdate);
      expect(await db.durableWork.count({ where: { owner_id: owner } })).toBe(
        workBefore,
      );
      const missing = await service.getStreak('p7-unpersisted');
      expect(missing.current_days).toBe(0);
      expect(
        await db.streak.findUnique({ where: { client_id: 'p7-unpersisted' } }),
      ).toBeNull();
    });

    it('P7-03: HTTP reads serialize the existing contracts with no database changes', async () => {
      const before = await snapshot();
      const work = await db.durableWork.count({ where: { owner_id: owner } });
      const module = await Test.createTestingModule({
        controllers: [
          ChallengesController,
          AchievementsController,
          StreaksController,
        ],
        providers: [
          { provide: ChallengesService, useValue: challenges },
          { provide: AchievementsService, useValue: achievements },
          {
            provide: StreaksService,
            useValue: new StreaksService(
              db as PrismaService,
              challenges,
              achievements,
            ),
          },
          {
            provide: APP_GUARD,
            useValue: {
              canActivate(context: ExecutionContext) {
                context
                  .switchToHttp()
                  .getRequest<{ user: { id: string; role: string } }>().user = {
                  id: owner,
                  role: 'CLIENT',
                };
                return true;
              },
            },
          },
          { provide: APP_GUARD, useClass: RolesGuard },
        ],
      }).compile();
      const app = module.createNestApplication();
      await app.init();
      try {
        const server = app.getHttpServer() as Server;
        await request(server).get('/challenges/my').expect(200);
        await request(server).get('/achievements/my').expect(200);
        const response = await request(server).get('/streaks/me').expect(200);
        const body: unknown = response.body;
        expect(body).toMatchObject({ client_id: owner });
        if (!body || typeof body !== 'object' || !('current_days' in body)) {
          throw Error('Missing streak counter');
        }
        expect(typeof body.current_days).toBe('number');
        expect(body).not.toHaveProperty('source_revision');
        await request(server).get('/challenges').expect(403);
        expect(await snapshot()).toEqual(before);
        expect(await db.durableWork.count({ where: { owner_id: owner } })).toBe(
          work,
        );
      } finally {
        await app.close();
      }
    });
    it('P7-01/03: delayed work waits on the owner lock and reads a newer correction', async () => {
      await updateDay(0, { training_completed: true });
      const work = await db.durableWork.findFirstOrThrow({
        where: { owner_id: owner, kind: 'RECONCILE' },
      });

      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`exom:day-progress:${owner}`],
      );
      const pending = domain.reconcile(work);
      let waiting = false;
      try {
        for (let i = 0; i < 100; i++) {
          const check = await pool.query<{ waiting: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted) AS waiting",
          );
          if (check.rows[0].waiting) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(waiting).toBe(true);
        await blocker.query(
          'UPDATE day_progress SET training_completed=false WHERE client_id=$1 AND date=$2',
          [owner, day(0)],
        );
      } finally {
        await blocker.query('COMMIT');
        blocker.release();
      }
      await pending;
      await reconcileAndCompare();
    });

    it('P7-03: rollback removes invalidation and source revision; legacy payload repairs everything', async () => {
      const before = await db.streak.findUniqueOrThrow({
        where: { client_id: owner },
      });
      await expect(
        db.$transaction(async (tx) => {
          await tx.dayProgress.update({
            where: { client_id_date: { client_id: owner, date: day(0) } },
            data: {
              exercises_completed: [],
              meals_completed: [],
              training_completed: false,
            },
          });
          throw Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(
        await db.streak.findUniqueOrThrow({ where: { client_id: owner } }),
      ).toEqual(before);
      expect(aggregateScope({})).toBeUndefined();
      expect(
        aggregateScope({ version: 1, scopes: { WEIGHT_LOGS: false } }),
      ).toBeUndefined();
      expect(
        aggregateScope({ version: 2, scopes: { WEIGHT_LOGS: true } }),
      ).toBeUndefined();
      await domain.reconcile({ owner_id: owner, payload: {} } as DurableWork);
      await reconcileAndCompare();
    });

    it('P7-03: a seven-day milestone is not duplicated by undo, replay or full repair', async () => {
      await db.streak.update({
        where: { client_id: owner },
        data: { tracking_started_at: null },
      });
      await updateDay(7, {
        training_completed: false,
        exercises_completed: [],
        meals_completed: [],
      });
      for (let n = 0; n < 7; n++)
        await updateDay(n, { training_completed: true });
      await reconcileAndCompare();
      expect((await snapshot()).streak?.current_days).toBe(7);
      const milestoneCount = () =>
        db.durableWork.count({
          where: {
            owner_id: owner,
            kind: 'STREAK_MILESTONE',
            payload: { path: ['days'], equals: 7 },
          },
        });
      expect(await milestoneCount()).toBe(1);
      await updateDay(0, {
        training_completed: false,
        exercises_completed: [],
        meals_completed: [],
      });
      await reconcileAndCompare();
      await updateDay(0, { training_completed: true });
      await reconcileAndCompare();
      await canonical();
      expect(await milestoneCount()).toBe(1);
    });

    it('P7-01: deterministic mixed historical edits converge after every batch', async () => {
      let seed = 1729;
      for (let batch = 0; batch < 8; batch++) {
        for (let n = 0; n < 3; n++) {
          seed = (seed * 16807) % 2147483647;
          await updateDay(seed % 14, {
            training_completed: seed % 2 === 0,
            meals_completed: seed % 3 ? [] : ['meal'],
          });
        }
        await reconcileAndCompare();
      }
    });

    it('P7-03: canonical challenge repair accepts a fixed clock and is repeatable', async () => {
      const asOf = day(5);
      await challenges.recalculateAutomaticProgress(
        owner,
        undefined,
        undefined,
        undefined,
        asOf,
      );
      const first = await db.challengeClient.findMany({
        where: { client_id: owner },
        orderBy: { challenge_id: 'asc' },
      });
      await challenges.recalculateAutomaticProgress(
        owner,
        undefined,
        undefined,
        undefined,
        asOf,
      );
      expect(
        await db.challengeClient.findMany({
          where: { client_id: owner },
          orderBy: { challenge_id: 'asc' },
        }),
      ).toEqual(first);
      await canonical();
    });

    it('P7-01-R1: a historical repair does not poison the next unchanged-activity calculation', async () => {
      await db.streak.update({
        where: { client_id: owner },
        data: { tracking_started_at: null },
      });
      await db.dayProgress.updateMany({
        where: { client_id: owner },
        data: {
          training_completed: false,
          exercises_completed: [],
          meals_completed: [],
        },
      });
      for (const n of [0, 1, 2])
        await updateDay(n, { training_completed: true });
      const repair = await streak.recalculateClient(owner, { asOf: day(1) });
      expect(repair.currentDays).toBe(2);
      const previous = await db.dayProgress.findUniqueOrThrow({
        where: { client_id_date: { client_id: owner, date: day(0) } },
      });
      const result = await db.$transaction(async (tx) => {
        await lockClientDayProgress(tx, owner);
        await tx.dayProgress.update({
          where: { id: previous.id },
          data: { notes: 'same activity' },
        });
        return streak.recalculateClient(owner, {
          db: tx,
          asOf: now,
          unchangedActivitySince: previous.updated_at,
        });
      });
      expect(result.currentDays).toBe(3);
      await reconcileAndCompare();
    });

    it('P7-02: a weight scope never reads training, plan or streak sources', async () => {
      const trainingRead = jest.spyOn(db.dayProgress, 'findMany');
      const planRead = jest.spyOn(db.planAssignment, 'findMany');
      const streakRead = jest.spyOn(db.streak, 'findUnique');
      await domain.reconcile({
        owner_id: owner,
        payload: { version: 1, scopes: { WEIGHT_LOGS: true } },
      } as DurableWork);
      expect(trainingRead).not.toHaveBeenCalled();
      expect(planRead).not.toHaveBeenCalled();
      expect(streakRead).not.toHaveBeenCalled();
      trainingRead.mockRestore();
      planRead.mockRestore();
      streakRead.mockRestore();
    });
  },
);

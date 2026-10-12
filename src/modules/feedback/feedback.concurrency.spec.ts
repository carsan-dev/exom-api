import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  FeedbackKind,
  ManagedUploadStatus,
  MediaType,
  PrismaClient,
  type Prisma,
} from '@prisma/client';
import { Pool, type PoolClient } from 'pg';
import { runProgressCommand } from '../../common/progress/progress-command';
import { PrismaService } from '../../prisma/prisma.service';
import type { AchievementsService } from '../achievements/achievements.service';
import type { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';
import type { ChallengesService } from '../challenges/challenges.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { StreakCalculatorService } from '../streaks/streak-calculator.service';
import type { UploadsService } from '../uploads/uploads.service';
import { ProgressService } from '../progress/progress.service';
import { FeedbackService } from './feedback.service';

const url = process.env.TEST_DATABASE_URL ?? '';
const describeWithDatabase = url ? describe : describe.skip;

// Observe the real advisory lock queue, not just two concurrently started promises.
async function waitForWaiters(blocker: PoolClient, expected: number) {
  const deadline = Date.now() + 12000;
  let count = 0;
  while (Date.now() < deadline) {
    const { rows } = await blocker.query<{ n: number }>(
      `SELECT count(DISTINCT waiting.pid)::int AS n FROM pg_locks held
       JOIN pg_locks waiting ON waiting.locktype = held.locktype
         AND waiting.database = held.database AND waiting.classid = held.classid
         AND waiting.objid = held.objid AND waiting.objsubid = held.objsubid
       WHERE held.pid = pg_backend_pid() AND held.locktype = 'advisory'
         AND held.granted AND NOT waiting.granted`,
    );
    count = rows[0].n;
    if (count === expected) return;
    if (count > expected)
      throw new Error(`Expected ${expected} waiters, got ${count}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for ${expected} advisory waiters; got ${count}`,
  );
}

describeWithDatabase(
  'Feedback provisional claim vs progress (PostgreSQL)',
  () => {
    it.each(['feedback', 'progress'] as const)(
      'forces %s first on the day lock and preserves the losing claim',
      async (first) => {
        // Separate owner, date, session, upload and operation for each forced order.
        const tag = randomUUID();
        const clientId = `feedback-race-client-${tag}`;
        const trainingA = `feedback-race-a-${tag}`;
        const trainingB = `feedback-race-b-${tag}`;
        const exerciseA = `feedback-race-ex-a-${tag}`;
        const exerciseB = `feedback-race-ex-b-${tag}`;
        const occurrenceA = `feedback-race-occ-a-${tag}`;
        const occurrenceB = `feedback-race-occ-b-${tag}`;
        const sessionId = `feedback-race-session-${tag}`;
        const uploadId = `feedback-race-upload-${tag}`;
        const clientUploadId = `feedback-race-retry-${tag}`;
        const operationId = `feedback-race-progress-${tag}`;
        const date = first === 'feedback' ? '2099-02-06' : '2099-02-07';
        const dateValue = new Date(`${date}T00:00:00.000Z`);
        const pool = new Pool({ connectionString: url });
        const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
        let fixtureCreated = false;
        try {
          await prisma.user.create({
            data: {
              id: clientId,
              email: `${clientId}@example.test`,
              firebase_uid: clientId,
            },
          });
          fixtureCreated = true;
          await prisma.exercise.createMany({
            data: [exerciseA, exerciseB].map((id) => ({
              id,
              name: id,
              muscle_groups: [],
              equipment: [],
            })),
          });
          await prisma.training.createMany({
            data: [trainingA, trainingB].map((id) => ({
              id,
              name: id,
              type: 'TEST',
              tags: [],
            })),
          });
          await prisma.trainingExercise.createMany({
            data: [
              {
                id: occurrenceA,
                training_id: trainingA,
                exercise_id: exerciseA,
                order: 0,
                sets: 1,
                reps_or_duration: '8',
              },
              {
                id: occurrenceB,
                training_id: trainingB,
                exercise_id: exerciseB,
                order: 0,
                sets: 1,
                reps_or_duration: '8',
              },
            ],
          });
          await prisma.planAssignment.create({
            data: {
              client_id: clientId,
              date: dateValue,
              training_id: trainingA,
              trainings: {
                create: [
                  { training_id: trainingA, position: 0 },
                  { training_id: trainingB, position: 1 },
                ],
              },
            },
          });
          await prisma.managedUpload.create({
            data: {
              id: uploadId,
              owner_id: clientId,
              purpose: 'FEEDBACK_VIDEO',
              object_key: `feedback-race/${tag}`,
              mime_type: 'video/mp4',
              expected_bytes: 8,
              actual_bytes: 8,
              status: ManagedUploadStatus.VERIFIED,
              expires_at: new Date('2099-12-31T00:00:00Z'),
            },
          });

          const writerPools = [0, 1].map(
            () =>
              new Pool({
                connectionString: url,
                connectionTimeoutMillis: 5000,
                statement_timeout: 30000,
                query_timeout: 35000,
              }),
          );
          const writers = writerPools.map(
            (writerPool) =>
              new PrismaClient({ adapter: new PrismaPg(writerPool) }),
          );
          // consumePrepared is a test double that updates the real transaction;
          // this is NOT full UploadsService integration.
          const uploads = {
            prepareForConsumption: jest.fn().mockResolvedValue({
              id: uploadId,
              file_url: `https://example.test/feedback-race/${tag}`,
            }),
            consumePrepared: jest.fn(
              async (
                tx: Prisma.TransactionClient,
                owner: string,
                id: string,
              ) => {
                const updated = await tx.managedUpload.updateMany({
                  where: {
                    id,
                    owner_id: owner,
                    status: ManagedUploadStatus.VERIFIED,
                  },
                  data: {
                    status: ManagedUploadStatus.CONSUMED,
                    consumed_at: new Date(),
                  },
                });
                if (updated.count !== 1)
                  throw new Error('Upload was consumed more than once');
              },
            ),
            isConsumedManagedUrl: jest.fn().mockResolvedValue(true),
          };
          const notifications = {
            findSystemSenderId: jest.fn().mockResolvedValue(null),
          };
          const feedback = new FeedbackService(
            writers[0] as unknown as PrismaService,
            notifications as unknown as NotificationsService,
            uploads as unknown as UploadsService,
          );
          const progress = new ProgressService(
            writers[1] as unknown as PrismaService,
            {
              recalculateAutomaticProgress: jest
                .fn()
                .mockResolvedValue(undefined),
            } as unknown as ChallengesService,
            {
              evaluateAutomaticAchievementsForUser: jest
                .fn()
                .mockResolvedValue(undefined),
            } as unknown as AchievementsService,
            notifications as unknown as NotificationsService,
            {
              recalculateClient: jest.fn().mockResolvedValue({
                currentDays: 0,
                longestDays: 0,
                previousCurrentDays: 0,
                changed: false,
              }),
            } as unknown as StreakCalculatorService,
            uploads as unknown as UploadsService,
            {
              reconcile: jest.fn().mockResolvedValue(undefined),
            } as unknown as AutoAssignmentMaterializerService,
          );
          const feedbackDto = {
            client_upload_id: clientUploadId,
            upload_id: uploadId,
            feedback_kind: FeedbackKind.LAST_SET,
            media_type: MediaType.VIDEO,
            exercise_id: exerciseA,
            training_id: trainingA,
            training_exercise_id: occurrenceA,
            assignment_date: date,
            training_session_id: sessionId,
          };
          const progressDto = {
            date,
            exercise_id: exerciseB,
            training_exercise_id: occurrenceB,
            training_session_id: sessionId,
            sets: [{ set_number: 1, reps: 8, rir: 0 }],
          };
          const feedbackWrite = () => feedback.create(clientId, feedbackDto);
          const progressWrite = () =>
            runProgressCommand(
              operationId,
              '0',
              ['markExerciseCompleted', progressDto],
              () => progress.markExerciseCompleted(clientId, progressDto),
            );
          let blocker: PoolClient | undefined;
          let firstWrite: Promise<unknown> | undefined;
          let secondWrite: Promise<unknown> | undefined;
          try {
            try {
              blocker = await pool.connect();
              await blocker.query('BEGIN');
              await blocker.query("SET LOCAL statement_timeout = '25000ms'");
              await blocker.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                [`exom:day-progress:${clientId}`],
              );
              firstWrite =
                first === 'feedback' ? feedbackWrite() : progressWrite();
              // Attach rejection handlers immediately while polling the lock queue.
              void firstWrite.catch(() => undefined);
              await waitForWaiters(blocker, 1);
              secondWrite =
                first === 'feedback' ? progressWrite() : feedbackWrite();
              void secondWrite.catch(() => undefined);
              await waitForWaiters(blocker, 2);
            } finally {
              if (blocker) {
                try {
                  await blocker.query('ROLLBACK');
                  blocker.release();
                } catch {
                  blocker.release(true);
                }
              }
            }
            if (firstWrite === undefined || secondWrite === undefined)
              throw new Error('Both ordered commands did not start');
            const results = await Promise.allSettled([firstWrite, secondWrite]);
            expect(results[0].status).toBe('fulfilled');
            expect(results[1]).toMatchObject({
              status: 'rejected',
              reason: {
                status: 409,
                response: { code: 'TRAINING_SESSION_CONFLICT' },
              },
            });
            const saved = await prisma.feedbackMedia.findMany({
              where: {
                client_id: clientId,
                assignment_date: dateValue,
                training_session_id: sessionId,
              },
            });
            const day = await prisma.dayProgress.findUnique({
              where: {
                client_id_date: { client_id: clientId, date: dateValue },
              },
            });
            const receipt = await prisma.progressOperation.findMany({
              where: { owner_id: clientId },
            });
            const upload = await prisma.managedUpload.findUniqueOrThrow({
              where: { id: uploadId },
            });
            if (first === 'feedback') {
              expect(saved).toHaveLength(1);
              expect(saved[0]).toMatchObject({
                training_id: trainingA,
                client_upload_id: clientUploadId,
              });
              expect(day).toBeNull();
              expect(receipt).toHaveLength(0);
              expect(upload.status).toBe(ManagedUploadStatus.CONSUMED);
              expect(upload.consumed_at).not.toBeNull();
              const replay = await feedbackWrite();
              expect(replay.id).toBe(saved[0].id);
              expect(uploads.consumePrepared).toHaveBeenCalledTimes(1);
            } else {
              expect(saved).toHaveLength(0);
              expect(day?.sync_revision).toBe(1);
              expect(day?.exercises_completed).toEqual([
                expect.objectContaining({
                  training_session_id: sessionId,
                  training_exercise_id: occurrenceB,
                  sets: [{ set_number: 1, reps: 8, rir: 0 }],
                }),
              ]);
              expect(receipt).toHaveLength(1);
              expect(receipt[0].id).toBe(operationId);
              expect(upload.status).toBe(ManagedUploadStatus.VERIFIED);
              expect(upload.consumed_at).toBeNull();
              await expect(feedbackWrite()).rejects.toMatchObject({
                status: 409,
                response: { code: 'TRAINING_SESSION_CONFLICT' },
              });
              expect(uploads.consumePrepared).not.toHaveBeenCalled();
            }
            // Retry cannot add residue or mutate the winning state.
            expect(
              await prisma.feedbackMedia.count({
                where: { client_id: clientId },
              }),
            ).toBe(first === 'feedback' ? 1 : 0);
            expect(
              await prisma.progressOperation.count({
                where: { owner_id: clientId },
              }),
            ).toBe(first === 'progress' ? 1 : 0);
            expect(
              await prisma.dayProgress.findUnique({
                where: {
                  client_id_date: { client_id: clientId, date: dateValue },
                },
              }),
            ).toEqual(day);
            expect(
              await prisma.managedUpload.findUniqueOrThrow({
                where: { id: uploadId },
              }),
            ).toEqual(upload);
          } finally {
            await Promise.allSettled(
              [firstWrite, secondWrite].filter(
                (write): write is Promise<unknown> => write !== undefined,
              ),
            );
            await Promise.all(writers.map((writer) => writer.$disconnect()));
            await Promise.all(
              writerPools.map((writerPool) => writerPool.end()),
            );
          }
        } finally {
          if (fixtureCreated)
            await prisma.user.deleteMany({ where: { id: clientId } });
          await prisma.training.deleteMany({
            where: { id: { in: [trainingA, trainingB] } },
          });
          await prisma.exercise.deleteMany({
            where: { id: { in: [exerciseA, exerciseB] } },
          });
          await prisma.$disconnect();
          await pool.end();
        }
      },
      60000,
    );
  },
);

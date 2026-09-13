import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { TrainingsService } from './trainings.service';
import { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';
import { loadTrainingHistory } from '../../common/progress/training-history';
import { runProgressCommand } from '../../common/progress/progress-command';
import { ProgressService } from '../progress/progress.service';
import type { ChallengesService } from '../challenges/challenges.service';
import type { AchievementsService } from '../achievements/achievements.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { StreakCalculatorService } from '../streaks/streak-calculator.service';
import type { UploadsService } from '../uploads/uploads.service';
import { FeedbackService } from '../feedback/feedback.service';

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;
describeDb('F007 PostgreSQL prescription and history', () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let service: TrainingsService;
  const clients: string[] = [];
  const trainings: string[] = [];
  const exercises: string[] = [];
  const config = {
    version: 1,
    unit: 'MINUTES',
    segments: [
      { action: 'Corre', seconds: 120, unit: 'MINUTES' },
      { action: 'Camina', seconds: 60, unit: 'MINUTES' },
    ],
  };
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    // Only materialization is stubbed: fixtures explicitly assign each date. All writes/locks are PostgreSQL.
    service = new TrainingsService(
      prisma as PrismaService,
      {
        reconcile: jest.fn().mockResolvedValue(undefined),
      } as unknown as AutoAssignmentMaterializerService,
    );
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: clients } } });
    await prisma.training.deleteMany({ where: { id: { in: trainings } } });
    await prisma.exercise.deleteMany({ where: { id: { in: exercises } } });
    await prisma.$disconnect();
    await pool.end();
  });
  async function fixture() {
    const client = randomUUID();
    clients.push(client);
    const exercise = randomUUID();
    exercises.push(exercise);
    await prisma.user.create({
      data: {
        id: client,
        email: `${client}@example.test`,
        firebase_uid: client,
      },
    });
    await prisma.exercise.create({
      data: { id: exercise, name: 'Carrera', muscle_groups: [], equipment: [] },
    });
    const training = await service.create(client, {
      name: 'Temporal',
      type: 'CARDIO',
      level: 'PRINCIPIANTE',
      items: [
        {
          kind: 'EXERCISE',
          exercise_id: exercise,
          sets: 1,
          order: 0,
          reps_or_duration: '1440s',
          measure_type: 'SECONDS',
          target_value: 1440,
          timed_config: config,
          rest_seconds: 15,
        },
      ],
    });
    trainings.push(training.id);
    const occurrence = await prisma.trainingExercise.findFirstOrThrow({
      where: { training_id: training.id },
    });
    return {
      client,
      exercise,
      training: training.id,
      occurrence: occurrence.id,
    };
  }
  async function assign(f: Awaited<ReturnType<typeof fixture>>, date: string) {
    await prisma.planAssignment.create({
      data: {
        client_id: f.client,
        date: new Date(date),
        training_id: f.training,
      },
    });
  }
  function progressService() {
    // Only external/aggregate collaborators are inert. Command, receipts,
    // snapshots and progress use the real PostgreSQL transaction path.
    return new ProgressService(
      prisma as PrismaService,
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
        recalculateClient: jest.fn().mockResolvedValue({ changed: false }),
      } as unknown as StreakCalculatorService,
      {
        isConsumedManagedUrl: jest.fn().mockResolvedValue(true),
      } as unknown as UploadsService,
      {
        reconcile: jest.fn().mockResolvedValue(undefined),
      } as unknown as AutoAssignmentMaterializerService,
    );
  }
  it('keeps performed seconds separate after template deletion and idempotent legacy replay/unmark', async () => {
    const f = await fixture();
    const date = '2099-03-01';
    await assign(f, date);
    const progress = progressService();
    const dto = {
      date,
      exercise_id: f.exercise,
      training_exercise_id: f.occurrence,
      sets: [{ set_number: 1, seconds: 1000, rir: 2 }],
    };
    const id = randomUUID();
    const replay = () =>
      runProgressCommand(id, '0', dto, () =>
        progress.markExerciseCompleted(f.client, dto),
      );
    await replay();
    const before = await prisma.dayProgress.findUniqueOrThrow({
      where: { client_id_date: { client_id: f.client, date: new Date(date) } },
    });
    expect(JSON.stringify(before.exercises_completed)).toContain(
      '"seconds":1000',
    );
    await prisma.trainingExercise.delete({ where: { id: f.occurrence } });
    await replay();
    expect(
      await prisma.dayProgress.findUnique({ where: { id: before.id } }),
    ).toEqual(before);
    await runProgressCommand(
      randomUUID(),
      String(before.sync_revision),
      ['unmark', date, f.occurrence],
      () => progress.unmarkExercise(f.client, date, f.occurrence),
    );
    await replay();
    const after = await prisma.dayProgress.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.exercises_completed).toEqual([]);
    expect(
      (await service.findDay(f.client, new Date(date))).trainings[0]
        .exercises[0].target_value,
    ).toBe(1440);
    const other = await fixture();
    await expect(
      runProgressCommand(id, '0', dto, () =>
        progress.markExerciseCompleted(other.client, dto),
      ),
    ).rejects.toThrow();
  });
  it('preserves prior repetitions when a protected training is replaced by timed occurrences', async () => {
    const f = await fixture();
    await prisma.trainingExercise.update({
      where: { id: f.occurrence },
      data: {
        measure_type: 'REPS',
        target_value: 10,
        timed_config: Prisma.DbNull,
        reps_or_duration: '10',
      },
    });
    await assign(f, '2001-02-01');
    await service.update(f.training, {
      items: [
        {
          kind: 'EXERCISE',
          exercise_id: f.exercise,
          order: 0,
          sets: 1,
          reps_or_duration: '1440s',
          measure_type: 'SECONDS',
          target_value: 1440,
          timed_config: config,
          rest_seconds: 30,
        },
      ],
    });
    const before = await service.findOne(
      f.training,
      f.client,
      new Date('2001-02-01'),
    );
    expect(before.exercises[0]).toMatchObject({
      id: f.occurrence,
      measure_type: 'REPS',
      target_value: 10,
      timed_config: null,
    });
    expect((await service.findOne(f.training)).exercises[0]).toMatchObject({
      measure_type: 'SECONDS',
      target_value: 1440,
      timed_config: config,
    });
  });
  it('preserves timed circuit members through legacy editing and all response shapes', async () => {
    const f = await fixture();
    await service.update(f.training, {
      items: [
        {
          kind: 'CIRCUIT',
          order: 0,
          name: 'Circuito',
          rounds: 2,
          rest_between_rounds_seconds: 45,
          exercises: [
            {
              exercise_id: f.exercise,
              reps_or_duration: '1440s',
              measure_type: 'SECONDS',
              target_value: 1440,
              timed_config: config,
              rest_seconds: 15,
            },
          ],
        },
      ],
    });
    const block = await prisma.trainingBlock.findFirstOrThrow({
      where: { training_id: f.training },
      include: { exercises: true },
    });
    await assign(f, '2099-04-01');
    await prisma.dayProgress.create({
      data: {
        client_id: f.client,
        date: new Date('2099-04-01'),
        notes: 'Iniciado',
        meals_completed: [],
      },
    });
    await service.update(f.training, {
      items: [
        {
          kind: 'CIRCUIT',
          id: block.id,
          order: 0,
          name: 'Circuito',
          rounds: 3,
          rest_between_rounds_seconds: 60,
          exercises: [
            {
              id: block.exercises[0].id,
              exercise_id: f.exercise,
              reps_or_duration: '1440s',
              rest_seconds: 20,
            },
          ],
        },
      ],
    });
    const row = await prisma.trainingExercise.findUniqueOrThrow({
      where: { id: block.exercises[0].id },
    });
    expect(row).toMatchObject({
      target_value: 1440,
      timed_config: config,
      rest_seconds: 20,
    });
    const response = await service.findOne(
      f.training,
      f.client,
      new Date('2099-04-01'),
    );
    expect(response.blocks[0]).toMatchObject({
      rounds: 2,
      rest_between_rounds_seconds: 45,
    });
    expect(response.blocks[0].exercises[0]).toMatchObject({
      rest_seconds: 15,
      timed_config: config,
    });
    expect(JSON.stringify(response.items[0])).toContain(
      'Corre: 2 min; Camina: 1 min',
    );
    expect(JSON.stringify(response.exercises[0])).toContain(
      'Corre: 2 min; Camina: 1 min',
    );
  });
  it('saves canonical total and units, preserves omitted legacy edits, and supplies old-client explanation', async () => {
    const f = await fixture();
    await service.update(f.training, {
      exercises: [
        {
          id: f.occurrence,
          exercise_id: f.exercise,
          order: 0,
          sets: 1,
          reps_or_duration: '1440s',
          rest_seconds: 90,
        },
      ],
    });
    const row = await prisma.trainingExercise.findUniqueOrThrow({
      where: { id: f.occurrence },
    });
    expect(row).toMatchObject({
      target_value: 1440,
      timed_config: config,
      rest_seconds: 90,
    });
    const response = await service.findOne(f.training);
    expect(response.exercises[0]).toMatchObject({
      target_value: 1440,
      timed_config: config,
    });
    expect(JSON.stringify(response.exercises[0].exercise)).toContain(
      'Corre: 2 min; Camina: 1 min',
    );
    await expect(
      prisma.trainingExercise.update({
        where: { id: f.occurrence },
        data: {
          timed_config: {
            ...config,
            segments: [{ action: '', seconds: 0, unit: 'MINUTES' }],
          },
        },
      }),
    ).rejects.toThrow();
  });
  it('freezes past and started dates, keeps future live, survives source removal and rejects history mutation', async () => {
    const f = await fixture();
    await assign(f, '2001-01-01');
    await assign(f, '2099-01-01');
    await assign(f, '2099-01-02');
    await prisma.dayProgress.create({
      data: {
        client_id: f.client,
        date: new Date('2099-01-01'),
        notes: 'Iniciado',
        meals_completed: [],
      },
    });
    await prisma.trainingExercise.update({
      where: { id: f.occurrence },
      data: {
        target_value: 90,
        timed_config: { version: 1, unit: 'SECONDS', segments: [] },
      },
    });
    const past = await service.findOne(
      f.training,
      f.client,
      new Date('2001-01-01'),
    );
    const started = await service.findDay(f.client, new Date('2099-01-01'));
    const future = await service.findDay(f.client, new Date('2099-01-02'));
    expect(past.exercises[0].target_value).toBe(1440);
    expect(started.trainings[0].exercises[0].target_value).toBe(1440);
    expect(future.trainings[0].exercises[0].target_value).toBe(90);
    await prisma.trainingExercise.delete({ where: { id: f.occurrence } });
    expect(
      (await service.findOne(f.training, f.client, new Date('2001-01-01')))
        .exercises[0].id,
    ).toBe(f.occurrence);
    await expect(
      pool.query(
        "UPDATE training_day_snapshots SET payload='{}' WHERE client_id=$1",
        [f.client],
      ),
    ).rejects.toThrow('immutable');
    expect(
      (await loadTrainingHistory(prisma, randomUUID(), new Date('2001-01-01')))
        .size,
    ).toBe(0);
  });
  it('forces progress before concurrent catalog update and captures the pre-edit prescription', async () => {
    const f = await fixture();
    await assign(f, '2099-02-01');
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await first.query(
        "INSERT INTO day_progress(id,client_id,date,notes,meals_completed,updated_at) VALUES($1,$2,$3,'Iniciado','{}',now())",
        [randomUUID(), f.client, '2099-02-01'],
      );
      const pid = (
        await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0].pid;
      const update = second.query(
        'UPDATE training_exercises SET target_value=90 WHERE id=$1',
        [f.occurrence],
      );
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting =
          (
            await pool.query(
              'SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted',
              [pid],
            )
          ).rowCount! > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await first.query('COMMIT');
      await update;
      expect(
        (
          await loadTrainingHistory(prisma, f.client, new Date('2099-02-01'))
        ).get(f.training)?.exercises[0].target_value,
      ).toBe(1440);
    } finally {
      await first.query('ROLLBACK');
      first.release();
      second.release();
    }
  });
  it('preserves required video identity and accepts owned historical feedback after occurrence removal', async () => {
    const f = await fixture();
    const date = '2099-05-01';
    await assign(f, date);
    const assignment = await prisma.planAssignment.findUniqueOrThrow({
      where: {
        client_id_date: { client_id: f.client, date: new Date(date) },
      },
    });
    await prisma.planAssignmentTraining.create({
      data: {
        assignment_id: assignment.id,
        training_id: f.training,
        position: 0,
        requires_last_set_video: true,
      },
    });
    await prisma.dayProgress.create({
      data: {
        client_id: f.client,
        date: new Date(date),
        notes: 'Started',
        meals_completed: [],
      },
    });
    const feedback = new FeedbackService(
      prisma as PrismaService,
      { queueTemplate: jest.fn() } as unknown as NotificationsService,
      {
        prepareForConsumption: jest.fn().mockResolvedValue({
          id: 'synthetic-upload',
          file_url: 'https://example.test/video.mp4',
        }),
        consumePrepared: jest.fn().mockResolvedValue(undefined),
      } as unknown as UploadsService,
    );
    const dto = {
      feedback_kind: 'LAST_SET' as const,
      media_type: 'VIDEO' as const,
      training_id: f.training,
      exercise_id: f.exercise,
      training_exercise_id: f.occurrence,
      assignment_date: date,
      client_upload_id: randomUUID(),
      upload_id: 'synthetic-upload',
    };
    const original = await feedback.create(f.client, dto);
    await prisma.trainingExercise.delete({ where: { id: f.occurrence } });
    expect(
      (
        await prisma.feedbackMedia.findUniqueOrThrow({
          where: { id: original.id },
        })
      ).training_exercise_id,
    ).toBe(f.occurrence);
    expect((await feedback.create(f.client, dto)).id).toBe(original.id);
    const next = await feedback.create(f.client, {
      ...dto,
      client_upload_id: randomUUID(),
    });
    expect(next.training_exercise_id).toBe(f.occurrence);
    const progress = progressService();
    const performed = {
      date,
      exercise_id: f.exercise,
      training_exercise_id: f.occurrence,
      sets: [{ set_number: 1, seconds: 1400 }],
      last_set_feedback_client_upload_id: dto.client_upload_id,
    };
    const commandId = randomUUID();
    const revision = String(
      (
        await prisma.dayProgress.findUniqueOrThrow({
          where: {
            client_id_date: { client_id: f.client, date: new Date(date) },
          },
        })
      ).sync_revision,
    );
    await runProgressCommand(commandId, revision, performed, () =>
      progress.markExerciseCompleted(f.client, performed),
    );
    const completed = await prisma.dayProgress.findUniqueOrThrow({
      where: {
        client_id_date: { client_id: f.client, date: new Date(date) },
      },
    });
    await runProgressCommand(commandId, revision, performed, () =>
      progress.markExerciseCompleted(f.client, performed),
    );
    expect(
      await prisma.dayProgress.findUnique({ where: { id: completed.id } }),
    ).toEqual(completed);
    expect(JSON.stringify(completed.exercises_completed)).toContain(
      '"seconds":1400',
    );
    const other = await fixture();
    await expect(
      feedback.create(other.client, { ...dto, client_upload_id: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      feedback.create(f.client, {
        ...dto,
        assignment_date: '2099-05-02',
        client_upload_id: randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      feedback.create(f.client, {
        ...dto,
        exercise_id: other.exercise,
        client_upload_id: randomUUID(),
      }),
    ).rejects.toThrow();
  });
  it('serializes first video submission with catalogue removal and freezes its prescription without prior progress', async () => {
    const f = await fixture();
    const date = '2099-06-02';
    await assign(f, date);
    const assignment = await prisma.planAssignment.findUniqueOrThrow({
      where: {
        client_id_date: { client_id: f.client, date: new Date(date) },
      },
    });
    await prisma.planAssignmentTraining.create({
      data: {
        assignment_id: assignment.id,
        training_id: f.training,
        position: 0,
        requires_last_set_video: true,
      },
    });
    const first = await pool.connect();
    const second = await pool.connect();
    const feedbackId = randomUUID();
    let removal: Promise<unknown> | undefined;
    try {
      await first.query('BEGIN');
      await first.query(
        `INSERT INTO feedback_media(id,client_id,training_id,exercise_id,training_exercise_id,assignment_date,feedback_kind,media_type,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,'LAST_SET','VIDEO',now())`,
        [feedbackId, f.client, f.training, f.exercise, f.occurrence, date],
      );
      expect(
        (
          await first.query<{ protected: boolean }>(
            'SELECT exom_rir_protected($1,$2::date) AS protected',
            [f.client, date],
          )
        ).rows[0].protected,
      ).toBe(true);
      const pid = (
        await second.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      removal = second.query('DELETE FROM training_exercises WHERE id=$1', [
        f.occurrence,
      ]);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting =
          (
            await pool.query(
              'SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted',
              [pid],
            )
          ).rowCount! > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await first.query('COMMIT');
      await removal;
      expect(
        (
          await prisma.feedbackMedia.findUniqueOrThrow({
            where: { id: feedbackId },
          })
        ).training_exercise_id,
      ).toBe(f.occurrence);
      expect(
        (await loadTrainingHistory(prisma, f.client, new Date(date))).get(
          f.training,
        )?.exercises[0].target_value,
      ).toBe(1440);
    } finally {
      await first.query('ROLLBACK');
      await removal;
      first.release();
      second.release();
    }
  });
});

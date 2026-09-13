import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { backfillLegacyAssignmentLinks } from './legacy-assignment-backfill';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { LastSetVideoPolicyService } from './last-set-video-policy.service';
import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';
import {
  databaseUrl,
  verifyDatabase,
} from '../../../scripts/test-database.cjs';

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;
describeDb('P10 legacy link backfill on PostgreSQL', () => {
  let pool: Pool;
  let prisma: PrismaClient;
  const owners: string[] = [];
  const trainingIds: string[] = [];
  beforeAll(async () => {
    await verifyDatabase();
    pool = new Pool({ connectionString: databaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await prisma.training.deleteMany({ where: { id: { in: trainingIds } } });
    await prisma.$disconnect();
    await pool.end();
  });
  async function fixture() {
    const owner = randomUUID();
    owners.push(owner);
    await prisma.user.create({
      data: { id: owner, firebase_uid: owner, email: `${owner}@example.test` },
    });
    const training = await prisma.training.create({
      data: { name: 'Legacy retired', type: 'CARDIO', is_active: false },
    });
    trainingIds.push(training.id);
    const rule = await prisma.autoAssignmentRule.create({
      data: {
        client_id: owner,
        source_week_start: new Date('2020-01-06'),
        starts_on: new Date('2020-01-06'),
        days: { create: { weekday: 1, training_id: training.id } },
      },
      include: { days: true },
    });
    const assignment = await prisma.planAssignment.create({
      data: {
        client_id: owner,
        date: new Date('2020-01-06'),
        training_id: training.id,
        auto_assignment_rule_id: rule.id,
        notes: 'preserve provenance',
      },
    });
    await prisma.dayProgress.create({
      data: {
        client_id: owner,
        date: assignment.date,
        exercises_completed: [
          {
            exercise_id: 'missing-occurrence',
            sets: [{ set_number: 1, seconds: 90, rir: 0 }],
          },
        ],
      },
    });
    return { owner, training, rule, assignment };
  }
  it.each([true, false])(
    'preserves monthly video obligations when canonical assignment already exists=%s',
    async (existsBefore) => {
      const f = await fixture();
      const module = await Test.createTestingModule({
        providers: [
          LastSetVideoPolicyService,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile();
      const policy = module.get(LastSetVideoPolicyService);
      const createCanonical = () =>
        prisma.planAssignment.create({
          data: {
            client_id: f.owner,
            date: new Date('2020-01-13'),
            trainings: {
              create: {
                training_id: f.training.id,
                position: 0,
                last_set_video_policy: 'AUTO',
                requires_last_set_video: true,
              },
            },
          },
          include: { trainings: true },
        });
      try {
        let canonical = existsBefore ? await createCanonical() : undefined;
        await prisma.$transaction((tx) =>
          backfillLegacyAssignmentLinks(tx, f.owner),
        );
        canonical ??= await createCanonical();
        await prisma.$transaction((tx) =>
          policy.reconcile(f.owner, ['2020-01'], tx),
        );
        expect(
          await prisma.planAssignmentTraining.findUnique({
            where: { id: canonical.trainings[0].id },
          }),
        ).toMatchObject({ requires_last_set_video: true });
        expect(
          await prisma.planAssignmentTraining.findFirst({
            where: { assignment_id: f.assignment.id },
          }),
        ).toMatchObject({ requires_last_set_video: false });
      } finally {
        await module.close();
      }
    },
  );
  it('preserves scalar/provenance/history and owner boundaries; rollback and retry converge', async () => {
    const a = await fixture();
    const b = await fixture();
    const before = await prisma.dayProgress.findMany({
      where: { client_id: a.owner },
    });
    await expect(
      prisma.$transaction(async (tx) => {
        expect(await backfillLegacyAssignmentLinks(tx, a.owner)).toEqual({
          assignments: 1,
          ruleDays: 1,
        });
        throw new Error('simulated crash');
      }),
    ).rejects.toThrow('simulated crash');
    expect(
      await prisma.planAssignmentTraining.count({
        where: { assignment_id: a.assignment.id },
      }),
    ).toBe(0);
    expect(
      await prisma.$transaction((tx) =>
        backfillLegacyAssignmentLinks(tx, a.owner),
      ),
    ).toEqual({ assignments: 1, ruleDays: 1 });
    expect(
      await prisma.$transaction((tx) =>
        backfillLegacyAssignmentLinks(tx, a.owner),
      ),
    ).toEqual({ assignments: 0, ruleDays: 0 });
    expect(
      await prisma.planAssignment.findUnique({
        where: { id: a.assignment.id },
      }),
    ).toEqual(a.assignment);
    expect(
      await prisma.dayProgress.findMany({ where: { client_id: a.owner } }),
    ).toEqual(before);
    expect(
      await prisma.planAssignmentTraining.count({
        where: { assignment_id: b.assignment.id },
      }),
    ).toBe(0);
    expect(
      await prisma.planAssignmentTraining.findFirst({
        where: { assignment_id: a.assignment.id },
      }),
    ).toMatchObject({
      training_id: a.training.id,
      position: 0,
      last_set_video_policy: 'AUTO',
      requires_last_set_video: false,
    });
  });
  it('allows the normal future auto-materializer to replace a migrated legacy representation', async () => {
    const f = await fixture();
    const date = new Date('2099-01-05');
    await prisma.training.update({
      where: { id: f.training.id },
      data: { is_active: true },
    });
    await prisma.autoAssignmentRuleDay.update({
      where: { id: f.rule.days[0].id },
      data: { weekday: date.getUTCDay() },
    });
    const future = await prisma.planAssignment.create({
      data: {
        client_id: f.owner,
        date,
        training_id: f.training.id,
        auto_assignment_rule_id: f.rule.id,
      },
    });
    await prisma.$transaction((tx) =>
      backfillLegacyAssignmentLinks(tx, f.owner),
    );
    const module = await Test.createTestingModule({
      providers: [
        LastSetVideoPolicyService,
        AutoAssignmentMaterializerService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    try {
      await module
        .get(AutoAssignmentMaterializerService)
        .reconcile(f.owner, { start: date, end: date, dates: [date] });
      expect(
        await prisma.planAssignmentTraining.findFirst({
          where: { assignment_id: future.id },
        }),
      ).toMatchObject({
        legacy_video_exempt: false,
        requires_last_set_video: true,
      });
      expect(
        await prisma.planAssignmentTraining.findFirst({
          where: { assignment_id: f.assignment.id },
        }),
      ).toMatchObject({
        legacy_video_exempt: true,
        requires_last_set_video: false,
      });
    } finally {
      await module.close();
    }
  });
  it('waits behind a concurrent writer and preserves the canonical replacement', async () => {
    const f = await fixture();
    const writer = await pool.connect();
    let operation: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('exom:diet-history',0))",
      );
      await writer.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`exom:day-progress:${f.owner}`],
      );
      operation = prisma.$transaction((tx) =>
        backfillLegacyAssignmentLinks(tx, f.owner),
      );
      let waiting = false;
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        const result = await writer.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) waiting",
        );
        waiting = result.rows[0].waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writer.query(
        "INSERT INTO plan_assignment_trainings(id,assignment_id,training_id,position,last_set_video_policy,requires_last_set_video) VALUES($1,$2,$3,0,'NEVER',false)",
        [randomUUID(), f.assignment.id, f.training.id],
      );
      await writer.query('COMMIT');
      await operation;
      expect(
        await prisma.planAssignmentTraining.findMany({
          where: { assignment_id: f.assignment.id },
        }),
      ).toEqual([expect.objectContaining({ last_set_video_policy: 'NEVER' })]);
    } finally {
      await writer.query('ROLLBACK');
      await operation;
      writer.release();
    }
  });
});

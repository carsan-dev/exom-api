import { randomUUID } from 'node:crypto';
import { Server } from 'node:http';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { aggregateClosedAdherence } from '../src/common/progress/closed-adherence-aggregate';
import { PrismaModule } from '../src/prisma/prisma.module';
import { RolesGuard } from '../src/common/guards/roles.guard';
import { AdherenceConfigModule } from '../src/modules/adherence/adherence-config.module';
import {
  AdherenceEvaluationService,
  canonicalFallbackBasis,
  fallbackBasisDigest,
  type EvaluationBasis,
} from '../src/modules/adherence/adherence-evaluation.service';
import { AdherenceConfigService } from '../src/modules/adherence/adherence-config.service';
import { AdherencePeriodQueryDto } from '../src/modules/adherence/dto/adherence-period-query.dto';
import {
  AdherencePrescriptionService,
  PrismaPrescriptionPublisher,
} from '../src/modules/adherence/adherence-prescription.service';
import { enableAdherenceJournalTriggers } from './adherence-journal-triggers';

const date = '2020-01-01';
const sources =
  'catalog_colors,diet_groups,diets,exercises,ingredients,meal_ingredients,meals,plan_assignment_trainings,plan_assignments,training_blocks,training_exercises,training_groups,trainings,diet_day_snapshots,rir_day_targets,training_day_snapshots';

// Historical timestamp mapping is a synthetic fixture, not past activation
// proof. Actual SQL capture/cut/publisher and application reader are exercised.
describe('registered adherence HTTP and immutable evaluations on owned PG17', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let pool: Pool;
  let client: string;
  let admin: string;
  let superadmin: string;
  let training: string;
  let occurrence: string;
  let original: unknown;
  let actor: { id: string; role: string };
  async function blocked(waiter: number, blocker: number) {
    for (let i = 0; i < 200; i++) {
      const result = await pool.query<{ blocked: boolean }>(
        'SELECT $2=ANY(pg_blocking_pids($1)) blocked',
        [waiter, blocker],
      );
      if (result.rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected real PostgreSQL blocking PID');
  }
  async function fixture(rolling = false) {
    const fixtureDates = rolling
      ? [
          '2019-12-26',
          '2019-12-27',
          '2019-12-28',
          '2019-12-29',
          '2019-12-30',
          '2019-12-31',
          date,
        ]
      : [date];
    client = randomUUID();
    admin = randomUUID();
    superadmin = randomUUID();
    training = randomUUID();
    occurrence = randomUUID();
    for (const [id, role] of [
      [client, Role.CLIENT],
      [admin, Role.ADMIN],
      [superadmin, Role.SUPER_ADMIN],
    ])
      await prisma.user.create({
        data: {
          id,
          email: id + '@example.test',
          firebase_uid: id,
          role:
            role === Role.ADMIN
              ? Role.ADMIN
              : role === Role.SUPER_ADMIN
                ? Role.SUPER_ADMIN
                : Role.CLIENT,
        },
      });
    await prisma.adminClientAssignment.create({
      data: { admin_id: admin, client_id: client },
    });
    const exercise = await prisma.exercise.create({
      data: { name: 'Synthetic', muscle_groups: [], equipment: [] },
    });
    await prisma.training.create({
      data: {
        id: training,
        name: 'Synthetic',
        type: 'STRENGTH',
        types: ['STRENGTH'],
        tags: [],
        exercises: {
          create: {
            id: occurrence,
            exercise_id: exercise.id,
            order: 0,
            sets: 1,
            reps_or_duration: '10',
            request_set_tracking: false,
          },
        },
      },
    });
    const ingredient = await prisma.ingredient.create({
      data: {
        name: 'Synthetic',
        calories_per_100g: 100,
        protein_per_100g: 10,
        carbs_per_100g: 0,
        fat_per_100g: 0,
      },
    });
    const diet = await prisma.diet.create({
      data: {
        name: 'Synthetic',
        total_calories: 200,
        total_protein_g: 20,
        meals: {
          create: [0, 1].map((order) => ({
            name: 'Root ' + order,
            type: 'BREAKFAST',
            order,
            nutritional_badges: [],
            ingredients: {
              create: {
                ingredient_id: ingredient.id,
                quantity: 100,
                unit: 'g',
              },
            },
          })),
        },
      },
      include: { meals: { orderBy: { order: 'asc' } } },
    });
    const alternative = await prisma.meal.create({
      data: {
        diet_id: diet.id,
        parent_meal_id: diet.meals[0].id,
        type: 'BREAKFAST',
        name: 'Alternative',
        order: 1,
        nutritional_badges: [],
        ingredients: {
          create: { ingredient_id: ingredient.id, quantity: 100, unit: 'g' },
        },
      },
    });
    for (const fixtureDate of fixtureDates)
      await prisma.planAssignment.create({
        data: {
          client_id: client,
          date: new Date(fixtureDate),
          training_id: training,
          diet_id: diet.id,
          trainings: { create: { training_id: training, position: 0 } },
        },
      });
    const epoch = (
      await pool.query<{ id: string }>(
        'SELECT * FROM public.activate_adherence_history_origin()',
      )
    ).rows[0].id;
    const origin = randomUUID();
    const publisher = new AdherencePrescriptionService(
      prisma,
      new PrismaPrescriptionPublisher(prisma),
    );
    for (const fixtureDate of fixtureDates) {
      const end = new Date(fixtureDate + 'T00:00:00Z');
      end.setUTCDate(end.getUTCDate() + 1);
      const cutoff = end.toISOString().replace('.000Z', '.000000Z');
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          `LOCK TABLE ${sources
            .split(',')
            .map((s) => 'public.' + s)
            .join(',')} IN SHARE ROW EXCLUSIVE MODE`,
        );
        const barrier = (
          await connection.query<{
            value: { full_xids: string[]; barrier_boundary: string };
          }>('SELECT public.begin_adherence_history_cut($1,$2,128) value', [
            epoch,
            cutoff,
          ])
        ).rows[0].value;
        for (const xid of barrier.full_xids) {
          const content = (
            await connection.query<{ value: { content_digest: string } }>(
              'SELECT public.adherence_commit_payload($1,$2) value',
              [epoch, xid],
            )
          ).rows[0].value.content_digest;
          await connection.query(
            'SELECT public.issue_adherence_commit_evidence($1,$2,$3,$4,$5,$6)',
            [
              epoch,
              origin,
              xid,
              rolling
                ? '2019-12-25T23:59:59.999999Z'
                : '2020-01-01T23:59:59.999999Z',
              rolling ? '1577318399999999' : '1577923199999999',
              content,
            ],
          );
        }
        await connection.query(
          'SELECT public.issue_adherence_history_cut($1,$2,$3,$4::bigint)',
          [epoch, origin, cutoff, barrier.barrier_boundary],
        );
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
      original = await publisher.publish(client, fixtureDate, {
        epochId: epoch,
        origin,
        cutoffUtc: cutoff,
      });
      expect(original).toMatchObject({
        status: 'stored',
        prescription: {
          training: { units: [{ effective_content: { basis: 'known' } }] },
          nutrition: { basis: 'known' },
        },
      });
    }
    await prisma.adherenceConfigRevision.create({
      data: {
        client_id: client,
        version: 1,
        effective_date: new Date('2019-01-01'),
        steps_goal: 1000,
        calorie_lower_percent: 10,
        calorie_upper_percent: 10,
        protein_min_percent: 90,
        steps_min_percent: 100,
        low_global_percent: rolling ? 10 : 80,
      },
    });
    return {
      alternative: alternative.id,
      root: diet.meals[0].id,
      second: diet.meals[1].id,
      diet: diet.id,
    };
  }
  let food: Awaited<ReturnType<typeof fixture>>;
  let restoreJournalTriggers: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    // Fixtures publish originals through the journal / history-cut machinery:
    // journals are written only while the 16 capture triggers are enabled.
    restoreJournalTriggers = await enableAdherenceJournalTriggers(pool);
    const module = await Test.createTestingModule({
      imports: [PrismaModule, AdherenceConfigModule],
    }).compile();
    prisma = module.get(PrismaService);
    app = module.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = actor;
      next();
    });
    app.useGlobalGuards(new RolesGuard(module.get(Reflector)));
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    food = await fixture();
    actor = { id: client, role: Role.CLIENT };
    // Seed a real90 publisher row before proving the missing91 behavior.
    await pool.query(
      'SELECT 1 FROM public.adherence_evaluation_revisions LIMIT 0',
    );
  }, 30000);
  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      try {
        await restoreJournalTriggers?.();
      } finally {
        if (pool) await pool.end();
      }
    }
  });
  it('registers self/staff routes, keeps config route, validates DTO and isolates actors', async () => {
    const server: unknown = app.getHttpServer();
    if (!(server instanceof Server)) throw new Error('Expected HTTP server');
    actor = { id: client, role: Role.CLIENT };
    await request(server)
      .get('/adherence?start=2020-02-30&end=2020-03-01')
      .expect(400);
    await request(server)
      .get('/adherence?start=2020-01-01&end=2020-02-01')
      .expect(400);
    await request(server)
      .get(
        '/admin/clients/' +
          client +
          '/adherence?start=' +
          date +
          '&end=' +
          date,
      )
      .expect(403);
    actor = { id: admin, role: Role.ADMIN };
    await request(server)
      .get('/admin/clients/' + client + '/adherence/config?date=' + date)
      .expect(200);
    await request(server)
      .get(
        '/admin/clients/' +
          client +
          '/adherence?start=' +
          date +
          '&end=' +
          date,
      )
      .expect(200);
    actor = { id: superadmin, role: Role.SUPER_ADMIN };
    await request(server)
      .get('/admin/clients/missing/adherence?start=' + date + '&end=' + date)
      .expect(403);
  });
  it('appends accepted late session/meal evidence against the same original and preserves replay/prior JSON', async () => {
    const service = app.get(AdherenceEvaluationService);
    const query = { start: date, end: date };
    const first = await service.get(client, Role.CLIENT, client, query);
    const before = await prisma.adherenceEvaluationRevision.findMany({
      where: { client_id: client },
    });
    const repeated = await Promise.all([
      service.get(client, Role.CLIENT, client, query),
      service.get(client, Role.CLIENT, client, query),
    ]);
    expect(repeated.map((result) => result.days)).toEqual([
      first.days,
      first.days,
    ]);
    expect(
      await prisma.adherenceEvaluationRevision.count({
        where: { client_id: client },
      }),
    ).toBe(before.length);
    await expect(
      service.get(admin, Role.CLIENT, client, query),
    ).rejects.toThrow();
    expect(
      await prisma.adherenceEvaluationRevision.count({
        where: { client_id: client },
      }),
    ).toBe(before.length);
    const session = randomUUID();
    // Exact production DB shape/atomic receipt simulation; no ProgressService
    // effects, mobile queues, notifications or accepted payload mutations.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`exom:day-progress:${client}`},0))::text`;
      const progress = await tx.dayProgress.create({
        data: {
          client_id: client,
          date: new Date(date),
          sync_revision: 1,
          training_completed: true,
          trainings_completed: [training],
          training_sessions: [
            {
              training_session_id: session,
              training_id: training,
              rpe: 8,
              note: null,
            },
          ],
          exercises_completed: [
            {
              training_session_id: session,
              training_exercise_id: occurrence,
              exercise_id: 'synthetic',
              completed_at: '2020-01-01T12:00:00Z',
            },
          ],
          meals_completed: [food.alternative, food.second],
        },
      });
      await tx.progressOperation.create({
        data: {
          id: randomUUID(),
          owner_id: client,
          date: new Date(date),
          payload_hash: 'synthetic-command',
          response: JSON.parse(
            JSON.stringify({ ...progress, operation_revision: 1 }),
          ) as Prisma.InputJsonValue,
        },
      });
    });
    const results = await Promise.all([
      service.get(client, Role.CLIENT, client, query),
      service.get(client, Role.CLIENT, client, query),
    ]);
    expect(results[0].days[0]).toMatchObject({
      revision: first.days[0].revision! + 1,
      evaluation: { global: { ratio: 1 } },
      indicators: {
        calories: { status: 'met' },
        protein: { status: 'met' },
        weeklySteps: { status: 'insufficient' },
      },
    });
    expect(results[1].days).toEqual(results[0].days);
    expect(
      await prisma.adherenceEvaluationRevision.findMany({
        where: { client_id: client, revision: before[0].revision },
      }),
    ).toEqual(before);
    expect(
      await new AdherencePrescriptionService(
        prisma,
        new PrismaPrescriptionPublisher(prisma),
      ).read(client, date),
    ).toEqual(original);
    const progressBefore = await prisma.dayProgress.findMany({
      where: { client_id: client },
    });
    await prisma.diet.update({
      where: { id: food.diet },
      data: { total_calories: 9999 },
    });
    expect(
      (await service.get(client, Role.CLIENT, client, query)).days,
    ).toEqual(results[0].days);
    expect(
      await prisma.dayProgress.findMany({ where: { client_id: client } }),
    ).toEqual(progressBefore);
    expect(
      await prisma.adherenceEvaluationRevision.count({
        where: { client_id: client, date: new Date(date) },
      }),
    ).toBe(2);
    // Six preceding dates without an original have append-only evaluations too;
    // the accepted late evidence appends only the requested original day's row.
    expect(
      await prisma.adherenceEvaluationRevision.count({
        where: { client_id: client },
      }),
    ).toBe(before.length + 1);
  });
  it('uses all root groups, never double-credits alternatives or Profile targets', async () => {
    const service = app.get(AdherenceEvaluationService);
    await prisma.dayProgress.update({
      where: { client_id_date: { client_id: client, date: new Date(date) } },
      data: { meals_completed: [food.alternative] },
    });
    expect(
      (
        await service.get(client, Role.CLIENT, client, {
          start: date,
          end: date,
        })
      ).days[0].evaluation.nutrition,
    ).toMatchObject({ numerator: 0, denominator: 1 });
    await prisma.dayProgress.update({
      where: { client_id_date: { client_id: client, date: new Date(date) } },
      data: { meals_completed: [food.root, food.alternative, food.second] },
    });
    expect(
      (
        await service.get(client, Role.CLIENT, client, {
          start: date,
          end: date,
        })
      ).days[0].evaluation.nutrition.status,
    ).toBe('insufficient');
  });
  it('keeps latest revision monotonic when an accepted older-client meal edit returns to prior normalized state', async () => {
    const service = app.get(AdherenceEvaluationService);
    const query = { start: date, end: date };
    const previous = await service.get(client, Role.CLIENT, client, query);
    await prisma.dayProgress.update({
      where: { client_id_date: { client_id: client, date: new Date(date) } },
      data: { meals_completed: [food.alternative] },
    });
    const changed = await service.get(client, Role.CLIENT, client, query);
    expect(changed.days[0].revision).toBeGreaterThan(
      previous.days[0].revision!,
    );
    expect(
      (await service.get(client, Role.CLIENT, client, query)).days,
    ).toEqual(changed.days);
  });
  it('uses only submitted exact-week steps and keeps numerical targets out of global adherence', async () => {
    const service = app.get(AdherenceEvaluationService);
    const query = { start: date, end: date };
    const before = await service.get(client, Role.CLIENT, client, query);
    const recap = await prisma.weeklyRecap.create({
      data: {
        client_id: client,
        week_start_date: new Date('2019-12-30'),
        week_end_date: new Date('2020-01-05'),
        average_daily_steps: 1000,
        improvement_areas: [],
      },
    });
    expect(
      (await service.get(client, Role.CLIENT, client, query)).weeks[0]
        .average_daily_steps,
    ).toBeNull();
    await prisma.weeklyRecap.update({
      where: { id: recap.id },
      data: { submitted_at: new Date(), status: 'SUBMITTED' },
    });
    const submitted = await service.get(client, Role.CLIENT, client, query);
    expect(submitted.weeks[0]).toMatchObject({
      average_daily_steps: 1000,
      dailyTargets: Array.from({ length: 7 }, () => ({
        goal: 1000,
        status: 'met',
        version: 1,
      })),
    });
    expect(submitted.aggregate.global).toEqual(before.aggregate.global);
    expect(submitted.days[0].targets).toEqual({ calories: 200, protein_g: 20 });
  });
  it('leaves today provisional/future neutral and consolidates closed days only', async () => {
    const service = app.get(AdherenceEvaluationService);
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await prisma.planAssignment.create({
      data: {
        client_id: client,
        date: new Date(today),
        training_id: training,
        diet_id: food.diet,
        trainings: { create: { training_id: training, position: 0 } },
      },
    });
    const result = await service.get(client, Role.CLIENT, client, {
      start: today,
      end: future,
    });
    expect(result.days.map((day) => day.evaluation.period)).toEqual([
      'provisional',
      'future',
    ]);
    expect(result.days[0]).toMatchObject({
      basis: 'current_provisional',
      evaluation: { training: { denominator: 1, numerator: 0 } },
    });
    expect(result.aggregate.global.ratio).toBeNull();
    expect(result.days[1].calendar).toBe('future');
    expect(
      await prisma.adherenceEvaluationRevision.count({
        where: { client_id: client, date: { gte: new Date(today) } },
      }),
    ).toBe(0);
    // Contract changed by ADH-RESPALDO-PAUTA-ACTUAL (2026-11-17): a closed day
    // without a published original now uses the current plan of that date.
    // This date has no assignment, so it is "not assigned", still with no
    // ratio, instead of the former unknown/insufficient.
    const unknown = await service.get(client, Role.CLIENT, client, {
      start: '2019-12-31',
      end: '2019-12-31',
    });
    expect(unknown.days[0]).toMatchObject({
      basis: 'current_fallback',
      calendar: 'not_assigned',
      schedule: { training: 'not_assigned', nutrition: 'not_assigned' },
      evaluation: { global: { status: 'not_applicable', ratio: null } },
    });
  });
  it('forces competing evaluation/assignment writes to block until the authorized reader commits', async () => {
    const service = app.get(AdherenceEvaluationService);
    const query = { start: '2019-12-30', end: '2019-12-30' };
    const previous = await service.get(admin, Role.ADMIN, client, query);
    const before = await prisma.adherenceEvaluationRevision.findMany({
      where: { client_id: client, date: new Date(query.start) },
      orderBy: { revision: 'asc' },
    });
    // Real late evidence changes the fingerprint; cached replay cannot reach
    // a BEFORE INSERT gate. Do not backdate policy or edit immutable revisions.
    const recap = await prisma.weeklyRecap.update({
      where: {
        client_id_week_start_date: {
          client_id: client,
          week_start_date: new Date('2019-12-30'),
        },
      },
      data: {
        average_daily_steps: 1001,
        submitted_at: new Date(),
        status: 'SUBMITTED',
      },
    });
    expect(recap.average_daily_steps).toBe(1001);
    const holder = await pool.connect();
    const revoker = await pool.connect();
    const pending: Promise<unknown>[] = [];
    const nonce = randomUUID().replaceAll('-', '');
    const trigger = 'evaluation_fixture_' + nonce;
    const key = 'evaluation-fixture:' + nonce;
    try {
      await pool.query(
        `CREATE FUNCTION public.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.client_id='${client}' AND NEW.date='2019-12-30'::date THEN PERFORM pg_advisory_xact_lock(hashtextextended('${key}',0)); END IF; RETURN NEW; END $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON adherence_evaluation_revisions FOR EACH ROW EXECUTE FUNCTION public.${trigger}()`,
      );
      await holder.query('BEGIN');
      await holder.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [key],
      );
      const holderPid = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      const first = service.get(admin, Role.ADMIN, client, query);
      pending.push(Promise.allSettled([first]));
      let readerPid = 0;
      for (let i = 0; i < 200; i++) {
        const result = await pool.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [holderPid],
        );
        if (result.rows.length) {
          readerPid = result.rows[0].pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await blocked(readerPid, holderPid);
      const second = service.get(client, Role.CLIENT, client, query);
      pending.push(Promise.allSettled([second]));
      await revoker.query('BEGIN');
      const revokerPid = (
        await revoker.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      const revoke = revoker.query(
        'UPDATE admin_client_assignments SET is_active=false WHERE admin_id=$1 AND client_id=$2',
        [admin, client],
      );
      pending.push(Promise.allSettled([revoke]));
      await blocked(revokerPid, readerPid);
      let secondPid = 0;
      for (let i = 0; i < 200; i++) {
        const result = await pool.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND pid<>$2',
          [readerPid, revokerPid],
        );
        if (result.rows.length) {
          secondPid = result.rows[0].pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await blocked(secondPid, readerPid);
      await holder.query('COMMIT');
      const results = await Promise.all([first, second]);
      await revoke;
      await revoker.query('ROLLBACK');
      expect(results[0].days).toEqual(results[1].days);
      expect(results[0].days[0].revision).toBe(previous.days[0].revision! + 1);
      const after = await prisma.adherenceEvaluationRevision.findMany({
        where: { client_id: client, date: new Date(query.start) },
        orderBy: { revision: 'asc' },
      });
      expect(after).toHaveLength(before.length + 1);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after[after.length - 1].evidence_digest).not.toBe(
        before[before.length - 1].evidence_digest,
      );
    } finally {
      // Release the gate before draining readers/revoker, even on assertion
      // failure. allSettled is cleanup only; normal awaits above still fail.
      try {
        await holder.query('ROLLBACK');
        await Promise.allSettled(pending);
        await revoker.query('ROLLBACK');
        await pool.query(
          `DROP TRIGGER IF EXISTS ${trigger} ON adherence_evaluation_revisions; DROP FUNCTION IF EXISTS public.${trigger}()`,
        );
      } finally {
        holder.release();
        revoker.release();
      }
    }
  }, 15000);
  it('serializes current assignment revocation under a held barrier and denies without data leakage', async () => {
    const holder = await pool.connect();
    const service = app.get(AdherenceEvaluationService);
    let settled: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      const pid = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0].pid;
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('exom:diet-history',0))",
      );
      const pending = service.get(admin, Role.ADMIN, client, {
        start: date,
        end: date,
      });
      settled = Promise.allSettled([pending]);
      let waiter = 0;
      for (let i = 0; i < 200; i++) {
        const result = await pool.query<{ pid: number }>(
          'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
          [pid],
        );
        if (result.rows.length) {
          waiter = result.rows[0].pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await blocked(waiter, pid);
      await holder.query(
        'UPDATE admin_client_assignments SET is_active=false WHERE admin_id=$1 AND client_id=$2',
        [admin, client],
      );
      await holder.query('COMMIT');
      await expect(pending).rejects.toThrow('Client access denied');
      await expect(
        service.get(client, Role.CLIENT, randomUUID(), {
          start: date,
          end: date,
        }),
      ).rejects.toThrow('Client access denied');
    } finally {
      try {
        await holder.query('ROLLBACK');
        await settled;
      } finally {
        holder.release();
      }
    }
  });
  it('evaluates using runtime SELECT/INSERT permissions without private history privileges', async () => {
    const role = 'evaluation_reader_' + randomUUID().replaceAll('-', '');
    // Existing application tables intentionally have RLS with no client
    // policies. Model API server RLS bypass, while restricting table/function
    // ACLs; this is not a grant or activation for any production role.
    await pool.query(`CREATE ROLE ${role} NOLOGIN BYPASSRLS;
      GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT ON users,admin_client_assignments,day_progress,
        progress_operations,adherence_config_revisions,weekly_recaps,
        adherence_historical_prescriptions,adherence_evaluation_revisions TO ${role};
      -- Closed days without an original read the current plan and its
      -- day snapshots (ADH-RESPALDO-PAUTA-ACTUAL), as today's basis already did.
      GRANT SELECT ON plan_assignments,plan_assignment_trainings,trainings,
        training_exercises,diets,meals,meal_ingredients,ingredients,
        training_day_snapshots,diet_day_snapshots TO ${role};
      -- ... and, before that, their frozen day row (ADH-FREEZE-01 U2).
      GRANT SELECT ON adherence_day_bases TO ${role};
      GRANT UPDATE ON users,admin_client_assignments TO ${role};
      GRANT INSERT ON adherence_evaluation_revisions TO ${role}`);
    const runtimePool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: '-c role=' + role,
    });
    const runtime = new PrismaClient({ adapter: new PrismaPg(runtimePool) });
    const module = await Test.createTestingModule({
      imports: [PrismaModule, AdherenceConfigModule],
    })
      .overrideProvider(PrismaService)
      .useValue(runtime)
      .compile();
    try {
      const service = module.get(AdherenceEvaluationService);
      const result = await service.get(client, Role.CLIENT, client, {
        start: '2019-12-29',
        end: '2019-12-29',
      });
      expect(result.days[0].revision).toBe(1);
      // A closed date (not evaluated anywhere else in this suite) without an
      // original but with a frozen day row: the runtime role really reads
      // adherence_day_bases and resolves the referenced catalog diet.
      const frozenDate = '2019-11-15';
      await pool.query(
        `INSERT INTO public.adherence_day_bases(client_id, date, provenance, basis)
         VALUES ($1, $2::date, 'scheduled', $3::jsonb)`,
        [
          client,
          frozenDate,
          JSON.stringify({
            version: 1,
            assigned: true,
            assignment_id: 'frozen-' + client,
            rest: false,
            completion_mode: 'ALL',
            diet_id: food.diet,
            units: [
              {
                id: 'frozen-unit-' + client,
                training_id: training,
                occurrences: [occurrence],
              },
            ],
          }),
        ],
      );
      const frozen = await service.get(client, Role.CLIENT, client, {
        start: frozenDate,
        end: frozenDate,
      });
      // No diet snapshot exists for that date: the totals are the current
      // catalog ones (earlier cases of this suite edit the catalog diet).
      const catalog = await pool.query<{
        calories: number | null;
        protein_g: number | null;
      }>(
        'SELECT total_calories AS calories, total_protein_g AS protein_g FROM public.diets WHERE id = $1',
        [food.diet],
      );
      expect(frozen.days[0]).toMatchObject({
        basis: 'original',
        revision: 1,
        schedule: { training: 'assigned', nutrition: 'assigned' },
        targets: catalog.rows[0],
      });
      const frozenRevisions = await pool.query<{ digest: string }>(
        `SELECT original_basis_digest AS digest FROM public.adherence_evaluation_revisions
         WHERE client_id = $1 AND date = $2::date`,
        [client, frozenDate],
      );
      expect(frozenRevisions.rows).toHaveLength(1);
      expect(frozenRevisions.rows[0].digest).toMatch(
        /^frozen_day:v1:[0-9a-f]{64}$/,
      );
      const permissions = await runtimePool.query<{
        journal: boolean;
        baseline: boolean;
        publisher: boolean;
      }>(
        `SELECT has_table_privilege(current_user,'adherence_assignment_journal','SELECT') journal,
        has_table_privilege(current_user,'adherence_history_baselines','SELECT') baseline,
        has_function_privilege(current_user,'public.activate_adherence_history_origin()','EXECUTE') publisher`,
      );
      expect(permissions.rows[0]).toEqual({
        journal: false,
        baseline: false,
        publisher: false,
      });
    } finally {
      await module.close();
      await runtime.$disconnect();
      if (!runtimePool.ended) await runtimePool.end();
    }
  });
  it('T2-WEEKLY-STEPS-01 compares partial periods against the complete seven dated thresholds', async () => {
    await prisma.adherenceConfigRevision.create({
      data: {
        client_id: client,
        version: 2,
        effective_date: new Date('2020-01-01'),
        steps_goal: 7000,
        calorie_lower_percent: 10,
        calorie_upper_percent: 10,
        protein_min_percent: 90,
        steps_min_percent: 100,
        low_global_percent: 80,
      },
    });
    // This owned client/week already exists in the submitted-steps case.
    const weeklyFixture = {
      week_end_date: new Date('2020-01-05'),
      average_daily_steps: 6000,
      submitted_at: new Date(),
      status: 'SUBMITTED' as const,
      improvement_areas: [],
    };
    const recap = await prisma.weeklyRecap.upsert({
      where: {
        client_id_week_start_date: {
          client_id: client,
          week_start_date: new Date('2019-12-30'),
        },
      },
      create: {
        client_id: client,
        week_start_date: new Date('2019-12-30'),
        ...weeklyFixture,
      },
      update: weeklyFixture,
    });
    expect(recap.average_daily_steps).toBe(6000);
    actor = { id: client, role: Role.CLIENT };
    const server: unknown = app.getHttpServer();
    if (!(server instanceof Server)) throw new Error('Expected HTTP server');
    await request(server)
      .get('/adherence?start=2020-01-01&end=2020-01-05')
      .expect(200);
    const service = app.get(AdherenceEvaluationService);
    const partial = await service.get(client, Role.CLIENT, client, {
      start: '2020-01-01',
      end: '2020-01-05',
    });
    expect(
      partial.days.map((day) => day.indicators.weeklySteps.status),
    ).toEqual(Array<string>(5).fill('met'));
    expect(partial.weeks[0].dailyTargets).toHaveLength(7);
    expect(partial.weeks[0].dailyTargets).toMatchObject([
      { date: '2019-12-30', goal: 1000, version: 1 },
      { date: '2019-12-31', goal: 1000, version: 1 },
      { date: '2020-01-01', goal: 7000, version: 2 },
      { date: '2020-01-02', goal: 7000, version: 2 },
      { date: '2020-01-03', goal: 7000, version: 2 },
      { date: '2020-01-04', goal: 7000, version: 2 },
      { date: '2020-01-05', goal: 7000, version: 2 },
    ]);
    const whole = await service.get(client, Role.CLIENT, client, {
      start: '2019-12-30',
      end: '2020-01-05',
    });
    expect(whole.weeks[0].dailyTargets).toEqual(partial.weeks[0].dailyTargets);
    expect(whole.days.filter((day) => day.date >= '2020-01-01')).toEqual(
      partial.days,
    );
    const missingClient = await prisma.user.create({
      data: {
        email: randomUUID() + '@example.test',
        firebase_uid: randomUUID(),
        role: Role.CLIENT,
      },
    });
    await prisma.adherenceConfigRevision.create({
      data: {
        client_id: missingClient.id,
        version: 1,
        effective_date: new Date('2020-01-01'),
        steps_goal: 7000,
        calorie_lower_percent: 10,
        calorie_upper_percent: 10,
        protein_min_percent: 90,
        steps_min_percent: 100,
        low_global_percent: 80,
      },
    });
    await prisma.weeklyRecap.create({
      data: {
        client_id: missingClient.id,
        week_start_date: new Date('2019-12-30'),
        week_end_date: new Date('2020-01-05'),
        average_daily_steps: 6000,
        submitted_at: new Date(),
        status: 'SUBMITTED',
        improvement_areas: [],
      },
    });
    const missing = await service.get(
      missingClient.id,
      Role.CLIENT,
      missingClient.id,
      { start: '2020-01-01', end: '2020-01-05' },
    );
    expect(
      missing.days.map((day) => day.indicators.weeklySteps.status),
    ).toEqual(Array<string>(5).fill('insufficient'));
    expect(missing.weeks[0].dailyTargets.slice(0, 2)).toMatchObject([
      { date: '2019-12-30', goal: null, version: null },
      { date: '2019-12-31', goal: null, version: null },
    ]);
    // Fixed-clock fixture: exercise a genuinely future effective update via
    // the actual ConfigService, not a historical policy overwrite.
    class FixedEvaluation extends AdherenceEvaluationService {
      protected override utcInstant() {
        return new Date('2020-01-02T12:00:00Z');
      }
    }
    class FixedConfiguration extends AdherenceConfigService {
      protected override utcInstant() {
        return new Date('2020-01-02T12:00:00Z');
      }
    }
    const fixed = new FixedEvaluation(prisma);
    const query = { start: '2020-01-01', end: '2020-01-01' };
    const before = await fixed.get(client, Role.CLIENT, client, query);
    const rowBefore = await prisma.adherenceEvaluationRevision.findUnique({
      where: {
        client_id_date_revision: {
          client_id: client,
          date: new Date('2020-01-01'),
          revision: before.days[0].revision!,
        },
      },
    });
    await prisma.adherenceConfigHead.create({
      data: { client_id: client, version: 2 },
    });
    await new FixedConfiguration(prisma).update(
      superadmin,
      Role.SUPER_ADMIN,
      client,
      {
        expected_version: 2,
        effective_date: '2020-01-04',
        steps_goal: 21000,
        steps_min_percent: 100,
        calorie_lower_percent: 10,
        calorie_upper_percent: 10,
        protein_min_percent: 90,
        low_global_percent: 80,
      },
    );
    const changed = await fixed.get(client, Role.CLIENT, client, query);
    expect(changed.days[0].indicators.weeklySteps.status).toBe('below');
    expect(changed.days[0].revision).toBeGreaterThan(before.days[0].revision!);
    expect(changed.aggregate.global).toEqual(before.aggregate.global);
    expect(changed.days[0].configuration).toEqual(before.days[0].configuration);
    expect((await fixed.get(client, Role.CLIENT, client, query)).days).toEqual(
      changed.days,
    );
    expect(
      await prisma.adherenceEvaluationRevision.findUnique({
        where: {
          client_id_date_revision: {
            client_id: client,
            date: new Date('2020-01-01'),
            revision: before.days[0].revision!,
          },
        },
      }),
    ).toEqual(rowBefore);
    expect(
      await new AdherencePrescriptionService(
        prisma,
        new PrismaPrescriptionPublisher(prisma),
      ).read(client, date),
    ).toEqual(original);
  });
  it('rolling closed HTTP: preceding year dates differ from a one-day report and preserve originals', async () => {
    food = await fixture(true);
    actor = { id: client, role: Role.CLIENT };
    // Window-end historical policy wins over the first day's 10% threshold.
    await prisma.adherenceConfigRevision.create({
      data: {
        client_id: client,
        version: 2,
        effective_date: new Date(date),
        steps_goal: 1000,
        calorie_lower_percent: 10,
        calorie_upper_percent: 10,
        protein_min_percent: 90,
        steps_min_percent: 100,
        low_global_percent: 80,
      },
    });
    const session = randomUUID();
    const progress = await prisma.dayProgress.create({
      data: {
        client_id: client,
        date: new Date(date),
        sync_revision: 1,
        training_completed: true,
        trainings_completed: [training],
        training_sessions: [
          {
            training_session_id: session,
            training_id: training,
            rpe: 8,
            note: null,
          },
        ],
        exercises_completed: [
          {
            training_session_id: session,
            training_exercise_id: occurrence,
            exercise_id: 'synthetic',
            completed_at: '2020-01-01T12:00:00Z',
          },
        ],
        meals_completed: [food.alternative, food.second],
      },
    });
    await prisma.progressOperation.create({
      data: {
        id: randomUUID(),
        owner_id: client,
        date: new Date(date),
        payload_hash: 'rolling-synthetic',
        response: JSON.parse(
          JSON.stringify({ ...progress, operation_revision: 1 }),
        ) as Prisma.InputJsonValue,
      },
    });
    const server: unknown = app.getHttpServer();
    if (!(server instanceof Server)) throw new Error('Expected HTTP server');
    const response = await request(server)
      .get('/adherence?start=' + date + '&end=' + date)
      .expect(200);
    // HTTP serializes the same allowlisted service result; assert its public
    // contract below rather than accepting a distinct test-only payload shape.
    const result = response.body as Awaited<
      ReturnType<AdherenceEvaluationService['get']>
    >;
    expect(result.days.map((day) => day.date)).toEqual([date]);
    expect(result.aggregate.global.ratio).toBe(1);
    expect(result.recentClosed).toMatchObject({
      start: '2019-12-26',
      end: date,
      status: 'low',
      coverage: { available: 7, insufficient: 0 },
      configuration: {
        version: 2,
        low_global_percent: 80,
        effective_date: date,
      },
    });
    expect(result.recentClosed.aggregate.global.ratio).toBeCloseTo(1 / 7);
    const service = app.get(AdherenceEvaluationService);
    const full = await service.get(client, Role.CLIENT, client, {
      start: '2019-12-26',
      end: date,
    });
    expect(result.recentClosed.aggregate).toEqual(
      aggregateClosedAdherence(full.days.map((day) => day.evaluation)),
    );
    const rows = await prisma.adherenceEvaluationRevision.findMany({
      where: { client_id: client },
      orderBy: { date: 'asc' },
    });
    expect(rows).toHaveLength(7);
    await prisma.adherenceConfigRevision.create({
      data: {
        client_id: client,
        version: 3,
        effective_date: new Date('2020-01-02'),
        steps_goal: 99999,
        calorie_lower_percent: 10,
        calorie_upper_percent: 10,
        protein_min_percent: 90,
        steps_min_percent: 100,
        low_global_percent: 10,
      },
    });
    await prisma.diet.update({
      where: { id: food.diet },
      data: { total_calories: 9999 },
    });
    const replay = await request(server)
      .get('/adherence?start=' + date + '&end=' + date)
      .expect(200);
    const replayResult = replay.body as Awaited<
      ReturnType<AdherenceEvaluationService['get']>
    >;
    expect(replayResult.recentClosed).toEqual(result.recentClosed);
    // A future policy can append weekly-indicator revisions in the same week;
    // historical daily policy/global and every previously written row remain intact.
    expect(
      await prisma.adherenceEvaluationRevision.findMany({
        where: {
          client_id: client,
          OR: rows.map((row) => ({ date: row.date, revision: row.revision })),
        },
        orderBy: { date: 'asc' },
      }),
    ).toEqual(rows);
    const after = await prisma.adherenceEvaluationRevision.findMany({
      where: { client_id: client },
      orderBy: [{ date: 'asc' }, { revision: 'asc' }],
    });
    await request(server)
      .get('/adherence?start=' + date + '&end=' + date)
      .expect(200);
    expect(
      await prisma.adherenceEvaluationRevision.findMany({
        where: { client_id: client },
        orderBy: [{ date: 'asc' }, { revision: 'asc' }],
      }),
    ).toEqual(after);
    expect(
      await new AdherencePrescriptionService(
        prisma,
        new PrismaPrescriptionPublisher(prisma),
      ).read(client, date),
    ).toEqual(original);
    await request(server)
      .get('/adherence?start=2020-01-01&end=2020-02-01')
      .expect(400);
  }, 30000);
  // ADH-RESPALDO-PAUTA-ACTUAL (owner decision 2026-11-17): closed days without
  // a published original are estimated with the current plan of that date.
  // Dates are far from every window used above so earlier cases stay intact.
  it('ADH-RESPALDO evaluates proven closed days without an original against the current plan', async () => {
    const service = app.get(AdherenceEvaluationService);
    const proven = '2019-11-15';
    const rewritten = '2019-11-16';
    const legacy = '2019-11-05';
    for (const day of [proven, rewritten, legacy])
      await prisma.planAssignment.create({
        data: {
          client_id: client,
          date: new Date(day),
          training_id: training,
          diet_id: food.diet,
          trainings: { create: { training_id: training, position: 0 } },
        },
      });
    const session = randomUUID();
    await prisma.dayProgress.create({
      data: {
        client_id: client,
        date: new Date(proven),
        sync_revision: 1,
        training_completed: true,
        trainings_completed: [training],
        training_sessions: [
          { training_session_id: session, training_id: training, rpe: 8 },
        ],
        exercises_completed: [
          {
            training_session_id: session,
            training_exercise_id: occurrence,
            exercise_id: 'synthetic',
            completed_at: proven + 'T12:00:00Z',
          },
        ],
        meals_completed: [food.alternative, food.second],
      },
    });
    // Regression: formerly basis unknown / calendar insufficient.
    const evaluated = await service.get(client, Role.CLIENT, client, {
      start: proven,
      end: proven,
    });
    expect(evaluated.days[0]).toMatchObject({
      basis: 'current_fallback',
      calendar: 'complete',
      revision: 1,
      evaluation: { global: { ratio: 1 } },
      schedule: { training: 'assigned', nutrition: 'assigned' },
    });
    const provenRow = await prisma.adherenceEvaluationRevision.findFirstOrThrow(
      { where: { client_id: client, date: new Date(proven) } },
    );
    expect(provenRow).toMatchObject({
      original_basis_id: null,
      cut_binding: null,
    });
    expect(provenRow.original_basis_digest).toMatch(
      /^current_fallback:v1:[0-9a-f]{64}$/,
    );

    // A row persisted before this decision (missing_original) stays intact;
    // the fallback appends revision n+1 and a replay restores it.
    const legacyRow = await prisma.adherenceEvaluationRevision.create({
      data: {
        client_id: client,
        date: new Date(rewritten),
        revision: 1,
        idempotency_key: 'pre-fallback-' + randomUUID(),
        original_basis_digest: 'missing_original',
        config_digest: 'pre-fallback',
        evidence_digest: 'pre-fallback',
        evaluation: {
          date: rewritten,
          basis: 'unknown',
          calendar: 'insufficient',
          evaluation: {},
          indicators: {},
          intake: {},
        },
      },
    });
    const appended = await service.get(client, Role.CLIENT, client, {
      start: rewritten,
      end: rewritten,
    });
    expect(appended.days[0]).toMatchObject({
      basis: 'current_fallback',
      calendar: 'incomplete',
      revision: 2,
    });
    expect(
      (
        await service.get(client, Role.CLIENT, client, {
          start: rewritten,
          end: rewritten,
        })
      ).days,
    ).toEqual(appended.days);
    const rewrittenRows = await prisma.adherenceEvaluationRevision.findMany({
      where: { client_id: client, date: new Date(rewritten) },
      orderBy: { revision: 'asc' },
    });
    expect(rewrittenRows).toHaveLength(2);
    expect(rewrittenRows[0]).toEqual(legacyRow);

    // Fallback days follow the current plan: a later membership edit of the
    // past assignment appends a new revision on the next read.
    const extra = await prisma.training.create({
      data: {
        name: 'Synthetic extra',
        type: 'STRENGTH',
        types: ['STRENGTH'],
        tags: [],
        exercises: {
          create: {
            exercise_id: (
              await prisma.exercise.create({
                data: { name: 'Extra', muscle_groups: [], equipment: [] },
              })
            ).id,
            order: 0,
            sets: 1,
            reps_or_duration: '10',
            request_set_tracking: false,
          },
        },
      },
    });
    const assignment = await prisma.planAssignment.findUniqueOrThrow({
      where: {
        client_id_date: { client_id: client, date: new Date(rewritten) },
      },
    });
    await prisma.planAssignmentTraining.create({
      data: {
        assignment_id: assignment.id,
        training_id: extra.id,
        position: 1,
      },
    });
    const followed = await service.get(client, Role.CLIENT, client, {
      start: rewritten,
      end: rewritten,
    });
    expect(followed.days[0]).toMatchObject({
      basis: 'current_fallback',
      revision: 3,
      evaluation: { training: { denominator: 2, numerator: 0 } },
    });
    const followedRows = await prisma.adherenceEvaluationRevision.findMany({
      where: { client_id: client, date: new Date(rewritten) },
      orderBy: { revision: 'asc' },
    });
    expect(followedRows.slice(0, 2)).toEqual(rewrittenRows);
    expect(followedRows[2].original_basis_digest).not.toBe(
      rewrittenRows[1].original_basis_digest,
    );

    // Aggregates and the seven-day low-adherence verdict count fallback days.
    const range = await service.get(client, Role.CLIENT, client, {
      start: proven,
      end: rewritten,
    });
    expect(range.days.map((day) => day.basis)).toEqual([
      'current_fallback',
      'current_fallback',
    ]);
    expect(range.aggregate.global.status).toBe('evaluable');
    expect(range.recentClosed).toMatchObject({
      start: '2019-11-10',
      end: rewritten,
      coverage: {
        available: 7,
        evaluable: 2,
        not_applicable: 5,
        insufficient: 0,
      },
    });
    // Window global 5/12 (training 1/3, nutrition 1/2) against the 10% policy.
    expect(range.recentClosed.status).toBe('not_low');
    expect(range.recentClosed.aggregate.global.ratio).toBeCloseTo(5 / 12);

    // Session-less legacy evidence stays indeterminate on a fallback day.
    await prisma.dayProgress.create({
      data: {
        client_id: client,
        date: new Date(legacy),
        sync_revision: 1,
        training_completed: true,
        trainings_completed: [training],
        training_sessions: [],
        exercises_completed: [],
        meals_completed: [],
      },
    });
    const indeterminate = await service.get(client, Role.CLIENT, client, {
      start: legacy,
      end: legacy,
    });
    expect(indeterminate.days[0]).toMatchObject({
      basis: 'current_fallback',
      evaluation: {
        training: { ratio: null, caveats: ['indeterminate_training'] },
      },
    });

    // A published original still wins over the current plan.
    expect(
      (
        await service.get(client, Role.CLIENT, client, {
          start: date,
          end: date,
        })
      ).days[0].basis,
    ).toBe('original');
  }, 30000);
  // ADH-RESPALDO cost guard: a client with a plan on every closed day (REPS and
  // timed trainings, a diet switch mid-range) and captured day snapshots that
  // keep earlier catalog content after later edits.
  async function fallbackClient() {
    const owner = randomUUID();
    await prisma.user.create({
      data: {
        id: owner,
        email: owner + '@example.test',
        firebase_uid: owner,
        role: Role.CLIENT,
      },
    });
    return owner;
  }
  async function fallbackPlans(
    owner: string,
    assigned: string[],
    rest: string[] = [],
  ) {
    const exercise = await prisma.exercise.create({
      data: { name: 'Fallback', muscle_groups: [], equipment: [] },
    });
    const reps = await prisma.training.create({
      data: {
        name: 'Fallback reps',
        type: 'STRENGTH',
        types: ['STRENGTH'],
        tags: [],
        exercises: {
          create: [0, 1].map((order) => ({
            exercise_id: exercise.id,
            order,
            sets: 3,
            reps_or_duration: '10',
            request_set_tracking: false,
          })),
        },
      },
    });
    const timed = await prisma.training.create({
      data: {
        name: 'Fallback timed',
        type: 'STRENGTH',
        types: ['STRENGTH'],
        tags: [],
        exercises: {
          create: {
            exercise_id: exercise.id,
            order: 0,
            sets: 1,
            reps_or_duration: '30s',
            measure_type: 'SECONDS',
            target_value: 30,
            request_set_tracking: false,
          },
        },
      },
    });
    const ingredients: string[] = [];
    for (const name of ['Fallback rice', 'Fallback egg'])
      ingredients.push(
        (
          await prisma.ingredient.create({
            data: {
              name,
              calories_per_100g: 130,
              protein_per_100g: 7,
              carbs_per_100g: 0,
              fat_per_100g: 0,
            },
          })
        ).id,
      );
    const diets: { id: string; root: string }[] = [];
    for (const [index, name] of ['Fallback A', 'Fallback B'].entries()) {
      const diet = await prisma.diet.create({
        data: {
          name,
          total_calories: 1800 + index * 200,
          total_protein_g: 90 + index * 10,
          meals: {
            create: [0, 1].map((order) => ({
              name: name + ' ' + order,
              type: 'BREAKFAST',
              order,
              nutritional_badges: [],
              ingredients: {
                create: [
                  { ingredient_id: ingredients[0], quantity: 50 + order },
                  {
                    ingredient_id: ingredients[1],
                    quantity: 1,
                    unit: 'piece',
                    grams_equivalent: 60,
                  },
                ],
              },
            })),
          },
        },
        include: { meals: { orderBy: { order: 'asc' } } },
      });
      await prisma.meal.create({
        data: {
          diet_id: diet.id,
          parent_meal_id: diet.meals[0].id,
          type: 'BREAKFAST',
          name: name + ' alternative',
          order: 1,
          nutritional_badges: [],
          ingredients: {
            create: { ingredient_id: ingredients[0], quantity: 70 },
          },
        },
      });
      diets.push({ id: diet.id, root: diet.meals[0].id });
    }
    const sorted = [...assigned].sort();
    for (const [index, day] of sorted.entries()) {
      const isRest = rest.includes(day);
      await prisma.planAssignment.create({
        data: {
          client_id: owner,
          date: new Date(day),
          is_rest_day: isRest,
          training_id: isRest ? null : reps.id,
          diet_id: diets[index < sorted.length / 2 ? 0 : 1].id,
          trainings: isRest
            ? undefined
            : {
                create: [
                  { training_id: reps.id, position: 0 },
                  { training_id: timed.id, position: 1 },
                ],
              },
        },
      });
    }
    // Later catalog edits: the UPDATE triggers capture the protected (past)
    // days' diet and timed training snapshots with the earlier content, then
    // the timed training gains an occurrence that only the current plan has.
    await prisma.mealIngredient.updateMany({
      where: { meal: { diet_id: diets[0].id } },
      data: { quantity: 80 },
    });
    await prisma.trainingExercise.updateMany({
      where: { training_id: timed.id },
      data: { reps_or_duration: '40s', target_value: 40 },
    });
    await prisma.trainingExercise.create({
      data: {
        training_id: timed.id,
        exercise_id: exercise.id,
        order: 1,
        sets: 1,
        reps_or_duration: '45s',
        measure_type: 'SECONDS',
        target_value: 45,
        request_set_tracking: false,
      },
    });
    return { reps: reps.id, timed: timed.id, diets };
  }
  async function countingModule() {
    const countingPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    const counting = new PrismaClient({
      adapter: new PrismaPg(countingPool),
      log: [{ emit: 'event', level: 'query' }],
    });
    const statements: string[] = [];
    counting.$on('query', (event) => statements.push(event.query));
    const module = await Test.createTestingModule({
      imports: [PrismaModule, AdherenceConfigModule],
    })
      .overrideProvider(PrismaService)
      .useValue(counting)
      .compile();
    const service = module.get(AdherenceEvaluationService);
    return {
      statements,
      async measure(owner: string, start: string, end: string) {
        statements.length = 0;
        const started = performance.now();
        const result = await service.get(owner, Role.CLIENT, owner, {
          start,
          end,
        });
        return {
          result,
          queries: statements.length,
          ms: performance.now() - started,
        };
      },
      async close() {
        await module.close();
        await counting.$disconnect();
        if (!countingPool.ended) await countingPool.end();
      },
    };
  }
  it('ADH-RESPALDO bounds the fallback basis queries per GET independently of the closed days', async () => {
    const owner = await fallbackClient();
    const week = AdherencePeriodQueryDto.dates('2019-07-01', '2019-07-07');
    const month = AdherencePeriodQueryDto.dates('2019-08-01', '2019-08-31');
    await fallbackPlans(owner, week);
    await fallbackPlans(owner, month);
    const today = new Date().toISOString().slice(0, 10);
    await fallbackPlans(owner, [today]);
    const counting = await countingModule();
    try {
      const revisions = () =>
        prisma.adherenceEvaluationRevision.count({
          where: { client_id: owner },
        });
      const current = await counting.measure(owner, today, today);
      // Today keeps its own per-date current basis.
      expect(current.result.days[0]).toMatchObject({
        basis: 'current_provisional',
        schedule: { training: 'assigned', nutrition: 'assigned' },
      });
      const weekFirst = await counting.measure(owner, week[0], week[6]);
      const weekReread = await counting.measure(owner, week[0], week[6]);
      const monthFirst = await counting.measure(owner, month[0], month[30]);
      const afterFirst = await revisions();
      const monthReread = await counting.measure(owner, month[0], month[30]);
      // Rereading a multi-day fallback range appends no revision.
      expect(await revisions()).toBe(afterFirst);
      expect(monthReread.result.days).toEqual(monthFirst.result.days);
      expect(
        monthFirst.result.days.every(
          (day) =>
            day.basis === 'current_fallback' &&
            day.schedule.training === 'assigned' &&
            day.schedule.nutrition === 'assigned',
        ),
      ).toBe(true);
      // 24 more closed days cost exactly their revision lookup (plus the
      // n+1 lookup and insert on the first read); the plan basis is loaded
      // once per GET, not once per day.
      expect(monthReread.queries - weekReread.queries).toBe(24);
      expect(monthFirst.queries - weekFirst.queries).toBe(24 * 3);
    } finally {
      await counting.close();
    }
  }, 120000);
  it('ADH-RESPALDO batched fallback bases equal the per-date current basis day by day', async () => {
    const owner = await fallbackClient();
    const range = AdherencePeriodQueryDto.dates('2019-06-01', '2019-06-21');
    const unassigned = ['2019-06-03', '2019-06-12'];
    const rest = ['2019-06-05', '2019-06-15'];
    const legacy = '2019-06-21';
    const plan = await fallbackPlans(
      owner,
      range.filter((day) => !unassigned.includes(day) && day !== legacy),
      rest,
    );
    // Legacy single-training assignment (no membership links).
    await prisma.planAssignment.create({
      data: {
        client_id: owner,
        date: new Date(legacy),
        training_id: plan.timed,
        diet_id: plan.diets[1].id,
      },
    });
    const captured = await pool.query<{ training: number; diet: number }>(
      `SELECT (SELECT count(*) FROM training_day_snapshots WHERE client_id=$1)::int training,
        (SELECT count(*) FROM diet_day_snapshots WHERE client_id=$1)::int diet`,
      [owner],
    );
    expect(captured.rows[0].training).toBeGreaterThan(0);
    expect(captured.rows[0].diet).toBeGreaterThan(0);
    const service = app.get(AdherenceEvaluationService);
    const singles: EvaluationBasis[] = [];
    await prisma.$transaction(
      async (tx) => {
        const batch = await service['fallbackBases'](tx, owner, range);
        expect([...batch.keys()]).toEqual(range);
        for (const day of range) {
          const single = canonicalFallbackBasis(
            await service['todayBasis'](
              tx,
              owner,
              new Date(day + 'T00:00:00Z'),
            ),
          );
          const found = batch.get(day);
          if (!found) throw new Error('Missing batched basis ' + day);
          const batched = canonicalFallbackBasis(found);
          expect({ day, basis: batched }).toEqual({ day, basis: single });
          expect(fallbackBasisDigest(batched)).toBe(
            fallbackBasisDigest(single),
          );
          singles.push(single);
        }
      },
      { timeout: 60000 },
    );
    // The fixture exercises every shape the batch must reproduce.
    const at = (day: string) => singles[range.indexOf(day)];
    for (const day of unassigned)
      expect(at(day)).toMatchObject({ rest: false, units: [], groups: [] });
    for (const day of rest)
      expect(at(day)).toMatchObject({ rest: true, units: [] });
    expect(new Set(singles.map((basis) => basis.calories))).toEqual(
      new Set([null, 1800, 2000]),
    );
    const timedOccurrences = singles.flatMap((basis) =>
      basis.units
        .filter((unit) => unit.trainingId === plan.timed)
        .map((unit) => unit.occurrences.length),
    );
    // Captured timed snapshots (1 occurrence) and the current content (2).
    expect(new Set(timedOccurrences)).toEqual(new Set([1, 2]));
    expect(at(legacy).units).toEqual([
      expect.objectContaining({ trainingId: plan.timed }),
    ]);
    const quantities = singles
      .filter((basis) => basis.calories === 1800)
      .map((basis) => basis.groups[0].alternatives[0].ingredients[0].quantity);
    // Diet A days read their captured snapshot, not the edited quantity 80.
    expect(quantities.length).toBeGreaterThan(0);
    expect(quantities.every((quantity) => quantity !== 80)).toBe(true);
  }, 120000);
  it('ADH-RESPALDO keeps a closed day with an unreadable stored original unknown', async () => {
    const owner = await fallbackClient();
    const day = '2019-05-10';
    await fallbackPlans(owner, [day]);
    // Synthetic unreadable row (no provenance or digests), inserted by the
    // disposable database owner; readMany reports invalid_stored_basis.
    await pool.query(
      'INSERT INTO adherence_historical_prescriptions(client_id,date,payload) VALUES ($1,$2,$3)',
      [
        owner,
        day,
        JSON.stringify({ prescription: { client_id: owner, date: day } }),
      ],
    );
    const service = app.get(AdherenceEvaluationService);
    const result = await service.get(owner, Role.CLIENT, owner, {
      start: day,
      end: day,
    });
    expect(result.days[0]).toMatchObject({
      basis: 'unknown',
      calendar: 'insufficient',
      schedule: { training: 'unknown', nutrition: 'unknown' },
    });
    const rows = await prisma.adherenceEvaluationRevision.findMany({
      where: { client_id: owner },
      orderBy: { date: 'asc' },
    });
    // The six other window days have no row at all and use the fallback.
    expect(
      rows.map((row) =>
        row.original_basis_digest.startsWith('current_fallback:v1:')
          ? 'fallback'
          : row.original_basis_digest,
      ),
    ).toEqual([...Array<string>(6).fill('fallback'), 'missing_original']);
  }, 60000);
  it('rejects modification of earlier persisted evaluation rows', async () => {
    await expect(
      pool.query(
        'UPDATE adherence_evaluation_revisions SET evidence_digest=$1 WHERE client_id=$2',
        ['forged', client],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
});

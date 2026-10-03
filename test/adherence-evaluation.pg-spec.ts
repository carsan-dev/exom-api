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
import { AdherenceEvaluationService } from '../src/modules/adherence/adherence-evaluation.service';
import { AdherenceConfigService } from '../src/modules/adherence/adherence-config.service';
import {
  AdherencePrescriptionService,
  PrismaPrescriptionPublisher,
} from '../src/modules/adherence/adherence-prescription.service';

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
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
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
    if (app) await app.close();
    if (pool) await pool.end();
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
    // Six preceding unknown dates now have append-only evaluations too;
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
    const unknown = await service.get(client, Role.CLIENT, client, {
      start: '2019-12-31',
      end: '2019-12-31',
    });
    expect(unknown.days[0]).toMatchObject({
      basis: 'unknown',
      calendar: 'insufficient',
      evaluation: { global: { ratio: null } },
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
  it('rejects modification of earlier persisted evaluation rows', async () => {
    await expect(
      pool.query(
        'UPDATE adherence_evaluation_revisions SET evidence_digest=$1 WHERE client_id=$2',
        ['forged', client],
      ),
    ).rejects.toMatchObject({ code: '55000' });
  });
});

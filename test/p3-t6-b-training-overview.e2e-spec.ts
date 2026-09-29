import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { FirebaseAuthGuard } from '../src/common/guards/firebase-auth.guard';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  buildTrainingOverviewExerciseQuery,
  TrainingProgressReadService,
} from '../src/modules/progress/training-progress-read.service';
import { databaseUrl, verifyDatabase } from '../scripts/test-database.cjs';

// Run only against the parent-approved disposable v4 service. No HTTP listener,
// Firebase token, production account, catalogue exercise, or external job is used.
const prefix = `p3t6b-${randomUUID()}`;
const clients = [randomUUID(), randomUUID()] as const;
const from = '2024-01-01';
const to = '2024-12-31';
const day = '2025-01-01';
const cases = [
  { index: 0, days: 366, exercises: 20, sets: 366 * 20 * 3 },
  { index: 1, days: 1, exercises: 10_000, sets: 10_000 * 3 },
] as const;

jest.setTimeout(20 * 60_000);

type Overview = {
  success: boolean;
  data: {
    indicators: { trainings_completed: number; volume: number | null };
    exercises: Array<{
      exercise_id: string;
      sets: number;
      volume: number | null;
    }>;
    next_cursor?: string | null;
  };
};

function isPagedOverview(body: unknown): body is Overview {
  if (!body || typeof body !== 'object' || !('data' in body)) return false;
  const data = body.data;
  if (
    !data ||
    typeof data !== 'object' ||
    !('indicators' in data) ||
    !('exercises' in data) ||
    !('next_cursor' in data)
  )
    return false;
  const indicators = data.indicators;
  return (
    'success' in body &&
    body.success === true &&
    indicators !== null &&
    typeof indicators === 'object' &&
    'trainings_completed' in indicators &&
    typeof indicators.trainings_completed === 'number' &&
    'volume' in indicators &&
    (typeof indicators.volume === 'number' || indicators.volume === null) &&
    Array.isArray(data.exercises) &&
    data.exercises.every(
      (row: unknown) =>
        row !== null &&
        typeof row === 'object' &&
        'exercise_id' in row &&
        typeof row.exercise_id === 'string' &&
        'sets' in row &&
        typeof row.sets === 'number' &&
        'volume' in row &&
        (typeof row.volume === 'number' || row.volume === null),
    ) &&
    (typeof data.next_cursor === 'string' || data.next_cursor === null)
  );
}

function fixture(exerciseIds: string[]) {
  return exerciseIds.map((exercise_id) => ({
    exercise_id,
    sets: [1, 2, 3].map((set_number) => ({
      set_number,
      reps: 2,
      weight_kg: 1,
      rir: 1,
    })),
  }));
}

function assertEnvironment() {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.HOST !== '127.0.0.1' ||
    process.env.EXOM_SMOKE_DISABLE_SCHEDULERS !== '1' ||
    !process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
  ) {
    throw Error('Isolated test environment preflight failed');
  }
  // Enforces the existing loopback/database/role URL allowlist without logging it.
  databaseUrl();
}

// Whitelist plan metrics: PostgreSQL can include SQL text and parameters in
// other EXPLAIN fields, so never print the raw plan or an exception message.
function planObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid plan shape');
  return value as Record<string, unknown>;
}

function planMetric(node: Record<string, unknown>, key: string): number | null {
  const value = node[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function summarizePlan(raw: unknown): object {
  const result = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(result) || result.length !== 1)
    throw Error('Invalid plan root');
  const root = planObject(result[0]);
  const pending: unknown[] = [root.Plan];
  const nodes: object[] = [];
  while (pending.length && nodes.length < 24) {
    const node = planObject(pending.shift());
    const type = node['Node Type'];
    if (typeof type !== 'string' || !/^[A-Za-z ]{1,48}$/.test(type))
      throw Error('Invalid node type');
    nodes.push({
      type,
      rows: planMetric(node, 'Actual Rows'),
      loops: planMetric(node, 'Actual Loops'),
      timeMs: planMetric(node, 'Actual Total Time'),
      sharedHit: planMetric(node, 'Shared Hit Blocks'),
      sharedRead: planMetric(node, 'Shared Read Blocks'),
      sharedDirtied: planMetric(node, 'Shared Dirtied Blocks'),
      sharedWritten: planMetric(node, 'Shared Written Blocks'),
      tempRead: planMetric(node, 'Temp Read Blocks'),
      tempWritten: planMetric(node, 'Temp Written Blocks'),
    });
    if (Array.isArray(node.Plans)) {
      for (const child of (node.Plans as unknown[]).slice(0, 64))
        pending.push(child);
    }
  }
  return {
    planningMs: planMetric(root, 'Planning Time'),
    executionMs: planMetric(root, 'Execution Time'),
    nodes,
    truncated: pending.length > 0,
  };
}

function summarizeEstimatedPlan(raw: unknown): {
  nodes: number;
  truncated: boolean;
  root: { type: string; rows: number; cost: number };
  mostExpensiveSubtree: { type: string; rows: number; cost: number } | null;
} {
  const result = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(result) || result.length !== 1)
    throw Error('Invalid estimated plan root');
  const root = planObject(result[0]);
  const pending: unknown[] = [root.Plan];
  let nodes = 0;
  let first: { type: string; rows: number; cost: number } | undefined;
  let mostExpensiveSubtree: typeof first;
  while (pending.length && nodes < 64) {
    const node = planObject(pending.shift());
    const type = node['Node Type'];
    const rows = planMetric(node, 'Plan Rows');
    const cost = planMetric(node, 'Total Cost');
    if (
      typeof type !== 'string' ||
      !/^[A-Za-z ]{1,48}$/.test(type) ||
      rows === null ||
      cost === null
    )
      throw Error('Invalid estimated plan node');
    const summary = { type, rows, cost };
    if (nodes === 0) first = summary;
    else if (!mostExpensiveSubtree || cost > mostExpensiveSubtree.cost)
      mostExpensiveSubtree = summary;
    nodes += 1;
    if (Array.isArray(node.Plans)) {
      for (const child of (node.Plans as unknown[]).slice(0, 64))
        pending.push(child);
    }
  }
  if (!first) throw Error('Empty estimated plan');
  return {
    nodes,
    truncated: pending.length > 0,
    root: first,
    mostExpensiveSubtree: mostExpensiveSubtree ?? null,
  };
}

describe('P3-T6-B real HTTP training overview measurements', () => {
  let app: NestExpressApplication | undefined;
  let prisma: PrismaService | undefined;
  let fixtureCommitted = false;
  let serviceMs: number | undefined;
  const longIds = Array.from({ length: 20 }, () => randomUUID());
  const wideIds = Array.from({ length: 10_000 }, () => randomUUID());

  beforeAll(async () => {
    try {
      assertEnvironment();
      await verifyDatabase(); // Identity must precede every fixture write.
      const module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = module.createNestApplication<NestExpressApplication>();
      prisma = app.get(PrismaService);
      // Only Firebase authentication is replaced; RolesGuard, controller,
      // authorization in the read service, transaction and PostgreSQL stay real.
      jest
        .spyOn(FirebaseAuthGuard.prototype, 'canActivate')
        .mockImplementation((context: ExecutionContext) => {
          const req = context
            .switchToHttp()
            .getRequest<Request & { user?: unknown }>();
          const identity = req.headers['x-p3t6b-owner'];
          if (identity !== clients[0] && identity !== clients[1])
            throw new UnauthorizedException();
          req.user = {
            id: identity,
            email: `${prefix}-${identity}@example.test`,
            firebase_uid: identity,
            role: 'CLIENT',
          };
          return Promise.resolve(true);
        });
      configureApp(app);
      await app.init();
      const reader = app.get(TrainingProgressReadService);
      const uninstrumentedReader = new TrainingProgressReadService(prisma);
      jest
        .spyOn(reader, 'getAuthorizedOverview')
        .mockImplementation(async (actorId, targetId, range, options) => {
          const start = performance.now();
          try {
            return await uninstrumentedReader.getAuthorizedOverview(
              actorId,
              targetId,
              range,
              options,
            );
          } finally {
            serviceMs = performance.now() - start;
          }
        });
      if (
        (await prisma.user.count({
          where: { email: { startsWith: prefix } },
        })) !== 0 ||
        (await prisma.user.count({ where: { id: { in: [...clients] } } })) !==
          0 ||
        (await prisma.dayProgress.count({
          where: { client_id: { in: [...clients] } },
        })) !== 0
      )
        throw Error('Synthetic fixture collision');

      // One commit after identity and collision checks. No row is visible on a
      // partial insert; no delete is attempted if ownership is uncertain.
      await prisma.$transaction(
        async (tx) => {
          await tx.user.createMany({
            data: clients.map((id, index) => ({
              id,
              firebase_uid: id,
              email: `${prefix}-${index}@example.test`,
              role: 'CLIENT',
            })),
          });
          const longEntries = fixture(longIds);
          const wideEntries = fixture(wideIds);
          for (let offset = 0; offset < 366; offset += 1) {
            const date = new Date(Date.UTC(2024, 0, 1 + offset));
            await tx.dayProgress.create({
              data: {
                client_id: clients[0],
                date,
                exercises_completed: longEntries,
                meals_completed: [],
              },
            });
          }
          await tx.dayProgress.create({
            data: {
              client_id: clients[1],
              date: new Date(`${day}T00:00:00.000Z`),
              exercises_completed: wideEntries,
              meals_completed: [],
            },
          });
        },
        { timeout: 180_000 },
      );
      fixtureCommitted = true;
      if (
        (await prisma.dayProgress.count({
          where: { client_id: clients[0] },
        })) !== 366 ||
        (await prisma.dayProgress.count({
          where: { client_id: clients[1] },
        })) !== 1
      )
        throw Error('Fixture count mismatch');
    } catch {
      // Do not expose connection strings, SQL parameters or response bodies.
      throw Error(
        'P3-T6-B preflight or fixture setup failed; inspect isolated service privately',
      );
    }
  });

  for (const shape of cases) {
    it(`${shape.days} day(s), ${shape.exercises} exercises/day: full owner response`, async () => {
      if (!app || !prisma || !fixtureCommitted)
        throw Error('Fixture not committed');
      serviceMs = undefined;
      const route =
        shape.index === 0
          ? `/api/v1/progress/training-overview?from=${from}&to=${to}`
          : `/api/v1/progress/training-overview?from=${day}&to=${day}`;
      const start = performance.now();
      let stage = 'request';
      let responseStatus: number | null = null;
      try {
        const response = await request(app.getHttpServer())
          .get(route)
          .set('x-p3t6b-owner', clients[shape.index])
          .set('Accept-Encoding', 'identity')
          .timeout({ deadline: 60_000 });
        const clientMs = performance.now() - start;
        responseStatus = response.status;
        stage = 'http-status';
        if (response.status !== 200) throw Error('Unexpected HTTP status');
        stage = 'envelope';
        const body: unknown = response.body;
        if (
          !body ||
          typeof body !== 'object' ||
          !('success' in body) ||
          !('data' in body) ||
          body.success !== true ||
          !body.data ||
          typeof body.data !== 'object'
        )
          throw Error('Invalid envelope');
        const overview = body as Overview;
        stage = 'totals';
        const rows = overview.data.exercises;
        if (
          !Array.isArray(rows) ||
          rows.length !== shape.exercises ||
          overview.data.indicators.trainings_completed !== 0 ||
          overview.data.indicators.volume !== shape.sets * 2
        ) {
          throw Error('Overview shape or totals mismatch');
        }
        stage = 'rows';
        const expectedIds = shape.index === 0 ? longIds : wideIds;
        const actualIds = new Set(rows.map((row) => row.exercise_id));
        if (
          actualIds.size !== expectedIds.length ||
          expectedIds.some((id) => !actualIds.has(id)) ||
          rows.some(
            (row) =>
              row.sets !== shape.days * 3 || row.volume !== shape.days * 6,
          )
        ) {
          throw Error('Missing, duplicated or truncated exercise totals');
        }
        stage = 'raw-body';
        if (typeof response.text !== 'string' || serviceMs === undefined)
          throw Error('Missing raw body or service timing');
        const bytes = Buffer.byteLength(response.text, 'utf8');
        const declared = response.headers['content-length'];
        const contentLength =
          typeof declared === 'string' ? Number(declared) : null;
        if (contentLength !== null && contentLength !== bytes)
          throw Error('Content length mismatch');
        // Numbers and transport flags only; never include fixture IDs or bodies.
        console.info(
          JSON.stringify({
            case: shape.index + 1,
            days: shape.days,
            exercises: rows.length,
            sets: shape.sets,
            bytes,
            clientMs: Math.round(clientMs),
            serviceTransactionMs: Math.round(serviceMs),
            contentLength,
            encoded: Number(Boolean(response.headers['content-encoding'])),
            chunked: Number(
              response.headers['transfer-encoding'] === 'chunked',
            ),
            actualExplain: 'NOT_RUN',
          }),
        );
        stage = 'budget';
        expect(clientMs).toBeLessThan(30_000);
        expect(serviceMs).toBeLessThan(30_000);
      } catch {
        console.info(
          JSON.stringify({
            diagnostic: 'P3-T6-B',
            case: shape.index + 1,
            stage,
            status: responseStatus,
            elapsedMs: Math.round(performance.now() - start),
            serviceMs: serviceMs === undefined ? null : Math.round(serviceMs),
          }),
        );
        throw Error('P3-T6-B HTTP measurement or budget assertion failed');
      } finally {
        // Explicit opt-in only: EXPLAIN ANALYZE executes the full statement.
        // A diagnostic failure must not replace the original HTTP FAIL.
        if (shape.index === 1 && process.env.EXOM_P3_EXPLAIN === '1') {
          let diagnosticStage = 'plan-query';
          try {
            const [row] = await prisma.$transaction(
              async (tx) => {
                await tx.$executeRaw`SET TRANSACTION READ ONLY`;
                await tx.$executeRaw`SET LOCAL statement_timeout = '45s'`;
                return tx.$queryRaw<{ 'QUERY PLAN': unknown }[]>(Prisma.sql`
                  EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
                  ${buildTrainingOverviewExerciseQuery(clients[1], { from: day, to: day })}
                `);
              },
              {
                isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
                timeout: 50_000,
              },
            );
            diagnosticStage = 'plan-shape';
            const summary = summarizePlan(row?.['QUERY PLAN']);
            console.info(
              JSON.stringify({ diagnostic: 'P3-T6-B-plan', summary }),
            );
          } catch {
            console.info(
              JSON.stringify({
                diagnostic: 'P3-T6-B-plan',
                reason: diagnosticStage,
              }),
            );
          }
        }
      }
    });
  }

  it('reports sanitized 10000-exercise plan shape without execution', async () => {
    if (!prisma || !fixtureCommitted) throw Error('Fixture not committed');
    // EXPLAIN without ANALYZE plans but does not execute the query. A 5s
    // statement budget bounds planning; estimates are not measured latency.
    const [row] = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return tx.$queryRaw<{ 'QUERY PLAN': unknown }[]>(Prisma.sql`
          EXPLAIN (FORMAT JSON)
          ${buildTrainingOverviewExerciseQuery(clients[1], { from: day, to: day })}
        `);
      },
      { timeout: 8_000 },
    );
    const summary = summarizeEstimatedPlan(row?.['QUERY PLAN']);
    expect(summary.nodes).toBeGreaterThan(0);
    expect(summary.root.cost).toBeGreaterThanOrEqual(0);
    // Whitelisted plan fields only: no SQL, predicates, IDs or parameters.
    console.info(
      JSON.stringify({ diagnostic: 'P4-T3B-estimated-plan', ...summary }),
    );
  });

  it('diagnoses 10000-exercise query with nested loops disabled', async () => {
    if (!prisma || !fixtureCommitted) throw Error('Fixture not committed');
    const start = performance.now();
    try {
      const rows = await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '20s'`;
          await tx.$executeRaw`SET LOCAL enable_nestloop = off`;
          return tx.$queryRaw<unknown[]>(
            buildTrainingOverviewExerciseQuery(clients[1], {
              from: day,
              to: day,
            }),
          );
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: 25_000,
        },
      );
      console.info(
        JSON.stringify({
          diagnostic: 'P4-T3B-no-nested-loop-query',
          status: 'completed',
          elapsedMs: Math.round(performance.now() - start),
          rows: rows.length,
        }),
      );
      expect(rows).toHaveLength(10_000);
    } catch {
      console.info(
        JSON.stringify({
          diagnostic: 'P4-T3B-no-nested-loop-query',
          status: 'failed',
          elapsedMs: Math.round(performance.now() - start),
        }),
      );
      throw Error('P4-T3B isolated no-nested-loop query diagnosis failed');
    }
  });

  it('pages the 366-day training overview over HTTP with global indicators and bound cursors', async () => {
    if (!app || !fixtureCommitted) throw Error('Fixture not committed');
    const route = `/api/v1/progress/training-overview?from=${from}&to=${to}`;
    const first = await request(app.getHttpServer())
      .get(`${route}&limit=2`)
      .set('x-p3t6b-owner', clients[0]);
    expect(first.status).toBe(200);
    const firstBody: unknown = first.body;
    expect(isPagedOverview(firstBody)).toBe(true);
    if (!isPagedOverview(firstBody)) throw Error('Invalid paged overview');
    const orderedIds = [...longIds].sort();
    expect(firstBody.data.exercises.map((row) => row.exercise_id)).toEqual(
      orderedIds.slice(0, 2),
    );
    expect(firstBody.data.indicators).toEqual(
      expect.objectContaining({
        trainings_completed: 0,
        volume: 366 * 20 * 3 * 2,
      }),
    );
    const cursor = firstBody.data.next_cursor;
    expect(typeof cursor).toBe('string');
    if (typeof cursor !== 'string') throw Error('Missing page cursor');

    const second = await request(app.getHttpServer())
      .get(route)
      .query({ limit: 2, cursor })
      .set('x-p3t6b-owner', clients[0]);
    expect(second.status).toBe(200);
    const secondBody: unknown = second.body;
    expect(isPagedOverview(secondBody)).toBe(true);
    if (!isPagedOverview(secondBody)) throw Error('Invalid paged overview');
    expect(secondBody.data.exercises.map((row) => row.exercise_id)).toEqual(
      orderedIds.slice(2, 4),
    );
    expect(secondBody.data.indicators).toEqual(firstBody.data.indicators);

    const wrongOwner = await request(app.getHttpServer())
      .get(route)
      .query({ limit: 2, cursor })
      .set('x-p3t6b-owner', clients[1]);
    expect(wrongOwner.status).toBe(400);
    const wrongRange = await request(app.getHttpServer())
      .get(`/api/v1/progress/training-overview?from=2024-01-02&to=${to}`)
      .query({ limit: 2, cursor })
      .set('x-p3t6b-owner', clients[0]);
    expect(wrongRange.status).toBe(400);
    const missingLimit = await request(app.getHttpServer())
      .get(route)
      .query({ cursor })
      .set('x-p3t6b-owner', clients[0]);
    expect(missingLimit.status).toBe(400);
  });

  it('pages 10,000 same-day exercises over HTTP within the full-window budget', async () => {
    if (!app || !fixtureCommitted) throw Error('Fixture not committed');
    const route = `/api/v1/progress/training-overview?from=${day}&to=${day}`;
    const orderedIds = [...wideIds].sort();
    let cursor: string | undefined;
    for (let page = 0; page < 2; page += 1) {
      serviceMs = undefined;
      const start = performance.now();
      const response = await request(app.getHttpServer())
        .get(route)
        .query({ limit: 100, ...(cursor ? { cursor } : {}) })
        .set('x-p3t6b-owner', clients[1])
        .set('Accept-Encoding', 'identity')
        .timeout({ deadline: 60_000 });
      const clientMs = performance.now() - start;
      expect(response.status).toBe(200);
      const body: unknown = response.body;
      expect(isPagedOverview(body)).toBe(true);
      if (!isPagedOverview(body)) throw Error('Invalid paged overview');
      const ids = body.data.exercises.map((exercise) => exercise.exercise_id);
      expect(ids).toHaveLength(100);
      expect(new Set(ids).size).toBe(100);
      expect(ids).toEqual(orderedIds.slice(page * 100, (page + 1) * 100));
      expect(body.data.indicators).toMatchObject({
        trainings_completed: 0,
        volume: 60_000,
      });
      expect(typeof body.data.next_cursor).toBe('string');
      if (typeof body.data.next_cursor !== 'string')
        throw Error('Missing page cursor');
      cursor = body.data.next_cursor;
      expect(typeof response.text).toBe('string');
      const bytes = Buffer.byteLength(response.text, 'utf8');
      expect(bytes).toBeLessThan(3 * 1024 * 1024);
      expect(clientMs).toBeLessThan(30_000);
      if (serviceMs === undefined) throw Error('Missing service timing');
      expect(serviceMs).toBeLessThan(30_000);
      // Numeric-only evidence: never print IDs, cursors or response bodies.
      console.info(
        JSON.stringify({
          diagnostic: 'P3-T6-B-page',
          page: page + 1,
          rows: ids.length,
          bytes,
          clientMs: Math.round(clientMs),
          serviceMs: Math.round(serviceMs),
        }),
      );
    }
    if (process.env.EXOM_P3_PAGE_EXPLAIN === '1') {
      let diagnosticStage = 'plan-query';
      try {
        const [row] = await prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            await tx.$executeRaw`SET LOCAL statement_timeout = '45s'`;
            return tx.$queryRaw<{ 'QUERY PLAN': unknown }[]>(Prisma.sql`
              EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
              ${buildTrainingOverviewExerciseQuery(clients[1], { from: day, to: day }, { limit: 100, lastExerciseId: null })}
            `);
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
            timeout: 50_000,
          },
        );
        diagnosticStage = 'plan-shape';
        const summary = summarizePlan(row?.['QUERY PLAN']);
        console.info(
          JSON.stringify({ diagnostic: 'P3-T6-B-page-plan', summary }),
        );
      } catch {
        console.info(
          JSON.stringify({
            diagnostic: 'P3-T6-B-page-plan',
            reason: diagnosticStage,
          }),
        );
      }
    }
  });

  afterAll(async () => {
    try {
      if (prisma && fixtureCommitted) {
        const ids = [...clients];
        // Cascade only exact owned identities; preserve all fixtures if any
        // unknown side effect or ownership inconsistency is observed.
        const owners = await prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, email: true },
        });
        if (
          owners.length !== 2 ||
          owners.some(
            (owner) =>
              !ids.includes(owner.id) || !owner.email.startsWith(prefix),
          )
        )
          throw Error('Ownership not established');
        const ownedWork = await prisma.durableWork.findMany({
          where: { owner_id: { in: ids } },
          select: { kind: true, status: true },
        });
        if (
          (await prisma.dayProgress.count({
            where: { client_id: { in: ids } },
          })) !== 367 ||
          (await prisma.progressOperation.count({
            where: { owner_id: { in: ids } },
          })) !== 0 ||
          ownedWork.length !== 2 ||
          ownedWork.some(
            (work) => work.kind !== 'RECONCILE' || work.status !== 'PENDING',
          ) ||
          (await prisma.notification.count({
            where: {
              OR: [{ sender_id: { in: ids } }, { recipient_id: { in: ids } }],
            },
          })) !== 0
        )
          throw Error('Uncertain fixture side effects');
        await prisma.user.deleteMany({ where: { id: { in: ids } } });
        if (
          (await prisma.user.count({ where: { id: { in: ids } } })) !== 0 ||
          (await prisma.user.count({
            where: { email: { startsWith: prefix } },
          })) !== 0 ||
          (await prisma.dayProgress.count({
            where: { client_id: { in: ids } },
          })) !== 0 ||
          (await prisma.progressOperation.count({
            where: { owner_id: { in: ids } },
          })) !== 0 ||
          (await prisma.durableWork.count({
            where: { owner_id: { in: ids } },
          })) !== 0 ||
          (await prisma.notification.count({
            where: {
              OR: [{ sender_id: { in: ids } }, { recipient_id: { in: ids } }],
            },
          })) !== 0
        )
          throw Error('Cleanup residue');
      }
    } catch {
      throw Error(
        'P3-T6-B cleanup uncertain; preserve remaining synthetic fixtures for private inspection',
      );
    } finally {
      jest.restoreAllMocks();
      if (app) await app.close();
    }
  });
});

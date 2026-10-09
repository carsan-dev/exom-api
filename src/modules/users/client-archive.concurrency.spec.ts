import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import {
  ClientDeletionService,
  DeletionIdentityService,
} from '../client-deletion/client-deletion.service';
import { UploadsService } from '../uploads/uploads.service';
import { EmailService } from '../email/email.service';
import { MetricsService } from '../metrics/metrics.service';
import { CalendarService } from '../calendar/calendar.service';
import { ClientFollowUpTasksService } from '../client-followup-tasks/client-followup-tasks.service';
import { ClientFollowUpTaskType } from '@prisma/client';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ChallengesService } from '../challenges/challenges.service';
import { AchievementsService } from '../achievements/achievements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IdentityService } from '../identity/identity.service';
import { IdentityProvider } from '../identity/identity-provider';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from './users.service';
import { AdminClientsQueryDto } from './dto/admin-clients-query.dto';
import { lockClientDayProgress } from '../../common/progress/day-progress-lock';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('F005 archive PostgreSQL integration', () => {
  const prefix = `archive-${process.pid}-${Date.now()}`;
  const ids = [
    prefix,
    `${prefix}-admin`,
    `${prefix}-inactive`,
    `${prefix}-super`,
  ];
  let pool: Pool;
  let prisma: PrismaClient;
  let service: UsersService;

  function createService(
    database: PrismaClient,
    queueTemplate?: NotificationsService['queueTemplate'],
  ) {
    const db = database as PrismaService;
    const denyExternal = (): never => {
      throw new Error('External dependency called by archive fixture');
    };
    const provider = {
      get: denyExternal,
      create: denyExternal,
      update: denyExternal,
      revoke: denyExternal,
      remove: denyExternal,
    } satisfies IdentityProvider;
    // No Nest lifecycle/cron. Fail closed even if a future path queues/sends FCM.
    const notifications = new Proxy(new NotificationsService(db), {
      get: (_target, property) =>
        property === 'queueTemplate' && queueTemplate
          ? queueTemplate
          : denyExternal,
    });
    return new UsersService(
      db,
      new ChallengesService(db, undefined!, notifications),
      notifications,
      undefined!,
      undefined!,
      undefined,
      new IdentityService(db, provider),
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, application_name: prefix });
    await assertTestDatabase(pool);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    service = createService(prisma);
    await prisma.user.createMany({
      data: ids.map((id, n) => ({
        id,
        firebase_uid: id,
        email: `${id}@example.test`,
        role: n === 3 ? Role.SUPER_ADMIN : n === 1 ? Role.ADMIN : Role.CLIENT,
        is_active: n !== 2,
      })),
    });
    await prisma.adminClientAssignment.create({
      data: { admin_id: ids[1], client_id: ids[0] },
    });
    await prisma.bodyMetric.create({
      data: { client_id: ids[0], date: new Date('2026-09-07'), weight_kg: 80 },
    });
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });
  it.each(['insert', 'update'])(
    'preserves SQL NULL meals on %s without creating challenge activity',
    async (operation) => {
      const id = `${prefix}-null-meals-${operation}`;
      await pool.query(
        `INSERT INTO day_progress(id,client_id,date,meals_completed,updated_at)
         VALUES($1,$2,$3,$4,now())`,
        [
          id,
          ids[0],
          operation === 'insert' ? '2090-01-01' : '2090-01-02',
          operation === 'insert' ? null : ['earned-meal'],
        ],
      );
      if (operation === 'update') {
        const before = await pool.query<{ challenge_activity: unknown }>(
          'SELECT challenge_activity FROM day_progress WHERE id=$1',
          [id],
        );
        expect(before.rows[0].challenge_activity).toHaveProperty(
          'meals.earned-meal',
        );
        await pool.query(
          'UPDATE day_progress SET meals_completed=NULL WHERE id=$1',
          [id],
        );
      }
      const result = await pool.query<{
        meals_completed: string[] | null;
        challenge_activity: unknown;
      }>(
        'SELECT meals_completed,challenge_activity FROM day_progress WHERE id=$1',
        [id],
      );
      expect(result.rows).toEqual([
        { meals_completed: null, challenge_activity: { meals: {} } },
      ]);
      expect(
        JSON.stringify(await prisma.dayProgress.findUnique({ where: { id } })),
      ).not.toContain('challenge_activity');
    },
  );
  it.each([
    ['MEAL_CHECKINS', 0],
    ['MEAL_CHECKINS', 3],
    ['STREAK_DAYS', 0],
    ['STREAK_DAYS', 3],
  ] as const)(
    'recalculates GLOBAL %s with SQL NULL meals and preserves baseline %s',
    async (rule, baseline) => {
      const clientId = `${prefix}-null-recalc-${rule}-${baseline}`;
      const adminId = `${clientId}-admin`;
      await prisma.user.createMany({
        data: [clientId, adminId].map((id) => ({
          id,
          firebase_uid: id,
          email: `${id}@example.test`,
          role: id === clientId ? Role.CLIENT : Role.ADMIN,
        })),
      });
      await prisma.adminClientAssignment.create({
        data: { admin_id: adminId, client_id: clientId },
      });
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const challenge = await prisma.challenge.create({
        data: {
          title: clientId,
          description: 'Owned NULL meal recalculation fixture',
          type: 'MAIN_GOAL',
          target_value: 100,
          unit: 'days',
          is_global: true,
          is_manual: false,
          rule_key: rule,
          created_by: adminId,
        },
      });
      const assignment = await prisma.challengeClient.create({
        data: {
          challenge_id: challenge.id,
          client_id: clientId,
          assignment_source: 'GLOBAL',
          assigned_at: yesterday,
          current_value: baseline,
        },
      });
      const period = await prisma.challengeClientEligibilityPeriod.create({
        data: {
          challenge_client_id: assignment.id,
          starts_on: yesterday,
          opened_at: yesterday,
          baseline_value: baseline,
        },
      });
      const training = await prisma.training.create({
        data: { name: clientId, type: 'strength', tags: [] },
      });
      await prisma.planAssignment.create({
        data: { client_id: clientId, date: today, training_id: training.id },
      });
      await pool.query(
        `INSERT INTO day_progress(id,client_id,date,meals_completed,updated_at)
         VALUES($1,$2,$3,NULL,now())`,
        [clientId, clientId, today],
      );
      const stored = () =>
        pool.query<{
          meals_completed: string[] | null;
          training_completed: boolean;
          exercises_completed: unknown;
          challenge_activity: unknown;
        }>(
          'SELECT meals_completed,training_completed,exercises_completed,challenge_activity FROM day_progress WHERE id=$1',
          [clientId],
        );
      const before = await stored();
      expect(before.rows).toEqual([
        {
          meals_completed: null,
          training_completed: false,
          exercises_completed: [],
          challenge_activity: { meals: {} },
        },
      ]);
      const challenges = new ChallengesService(
        prisma as PrismaService,
        undefined!,
        undefined!,
      );
      await challenges.recalculateAutomaticProgress(
        clientId,
        undefined,
        [challenge.id],
        undefined,
        new Date(),
      );
      expect(
        await prisma.challengeClient.findUniqueOrThrow({
          where: { id: assignment.id },
        }),
      ).toEqual(assignment);
      expect(
        await prisma.challengeClientEligibilityPeriod.findUniqueOrThrow({
          where: { id: period.id },
        }),
      ).toEqual(period);
      expect((await stored()).rows).toEqual(before.rows);
    },
  );
  it('archives active and inactive clients without changing identity, access or historical data', async () => {
    const before = await prisma.user.findMany({
      where: { id: { in: [ids[0], ids[2]] } },
      orderBy: { id: 'asc' },
    });
    for (const id of [ids[0], ids[2]])
      await service.setClientArchived(ids[3], Role.SUPER_ADMIN, id, true);
    const after = await prisma.user.findMany({
      where: { id: { in: [ids[0], ids[2]] } },
      orderBy: { id: 'asc' },
    });
    expect(
      after.map(({ is_archived, updated_at, ...rest }) => ({
        ...rest,
        is_archived,
        updated_at: Boolean(updated_at),
      })),
    ).toEqual(
      before.map(({ updated_at, ...rest }) => ({
        ...rest,
        is_archived: true,
        updated_at: Boolean(updated_at),
      })),
    );
    expect(
      await prisma.bodyMetric.count({
        where: { client_id: ids[0], weight_kg: 80 },
      }),
    ).toBe(1);
    for (const id of [ids[0], ids[2]])
      await service.setClientArchived(ids[3], Role.SUPER_ADMIN, id, false);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: ids[2] } }))
        .is_active,
    ).toBe(false);
  });
  it('enforces role and assignment scope against real rows', async () => {
    await expect(
      service.setClientArchived(ids[1], Role.ADMIN, ids[2], true),
    ).rejects.toThrow();
    await expect(
      service.setClientArchived(ids[3], Role.SUPER_ADMIN, ids[1], true),
    ).rejects.toThrow();
    await service.setClientArchived(ids[1], Role.ADMIN, ids[0], true);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: ids[0] } }))
        .is_archived,
    ).toBe(true);
  });
  it('uses the same visibility predicate for search, pagination and totals', async () => {
    for (const role of [Role.SUPER_ADMIN, Role.ADMIN]) {
      const query = Object.assign(new AdminClientsQueryDto(), {
        search: `${ids[0]}@example.test`,
        archive: 'archived',
        limit: 1,
      });
      const result = await service.getMyClients(ids[1], role, query);
      expect(result.total).toBe(1);
      expect(result.data[0]).toMatchObject({ id: ids[0], is_archived: true });
      query.archive = 'visible';
      expect((await service.getMyClients(ids[1], role, query)).total).toBe(0);
    }
  });
  it('does not lose an account-state change when an archive write waits on its row', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('UPDATE users SET is_active=false WHERE id=$1', [
      ids[0],
    ]);
    const write = service.setClientArchived(ids[1], Role.ADMIN, ids[0], false);
    let waiting = false;
    try {
      for (let n = 0; n < 200 && !waiting; n++) {
        await blocker.query('SELECT pg_stat_clear_snapshot()');
        const result = await blocker.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0',
          [prefix],
        );
        waiting = result.rows[0].n > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    await write;
    expect(waiting).toBe(true);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: ids[0] } }),
    ).toMatchObject({ is_active: false, is_archived: false });
  });

  it.each(['assignment', 'role', 'active', 'locked'] as const)(
    'rejects archiving if %s permission is revoked while the request waits',
    async (permission) => {
      await prisma.user.update({
        where: { id: ids[0] },
        data: { is_archived: false },
      });
      const blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR UPDATE',
        [[ids[0], ids[1]]],
      );
      const writing = service
        .setClientArchived(ids[1], Role.ADMIN, ids[0], true)
        .then(
          () => 'accepted',
          () => 'rejected',
        );
      let waiting = false;
      try {
        for (let n = 0; n < 100 && !waiting; n++) {
          const result = await pool.query<{ waiting: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND cardinality(pg_blocking_pids(pid))>0) AS waiting',
            [prefix],
          );
          waiting = result.rows[0].waiting;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        if (permission === 'assignment')
          await blocker.query(
            'UPDATE admin_client_assignments SET is_active=false WHERE admin_id=$1 AND client_id=$2',
            [ids[1], ids[0]],
          );
        if (permission === 'role')
          await blocker.query("UPDATE users SET role='CLIENT' WHERE id=$1", [
            ids[1],
          ]);
        if (permission === 'active')
          await blocker.query('UPDATE users SET is_active=false WHERE id=$1', [
            ids[1],
          ]);
        if (permission === 'locked')
          await blocker.query('UPDATE users SET is_locked=true WHERE id=$1', [
            ids[1],
          ]);
      } finally {
        await blocker.query('COMMIT');
        blocker.release();
      }
      const result = await writing;
      await prisma.user.update({
        where: { id: ids[1] },
        data: { role: Role.ADMIN, is_active: true, is_locked: false },
      });
      await prisma.adminClientAssignment.updateMany({
        where: { admin_id: ids[1], client_id: ids[0] },
        data: { is_active: true },
      });
      expect(waiting).toBe(true);
      expect(result).toBe('rejected');
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: ids[0] } }))
          .is_archived,
      ).toBe(false);
    },
  );

  it.each(['role', 'assignment'] as const)(
    'rejects stale-coach archive behind the real production %s writer',
    async (permission) => {
      await prisma.user.update({
        where: { id: ids[0] },
        data: { is_archived: false },
      });
      const beforeClient = await prisma.user.findUniqueOrThrow({
        where: { id: ids[0] },
      });
      const beforeMetrics = await prisma.bodyMetric.findMany({
        where: { client_id: ids[0] },
        orderBy: { id: 'asc' },
      });
      const beforeAssignment =
        await prisma.adminClientAssignment.findFirstOrThrow({
          where: { admin_id: ids[1], client_id: ids[0] },
        });
      const writerDatabase = new PrismaClient({ adapter: new PrismaPg(pool) });
      let release!: () => void;
      let signal!: (pid: number) => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = new Promise<number>((resolve) => {
        signal = resolve;
      });
      // Instrument only the transaction boundary, not a business method/query.
      // The entire original callback (including sync/guards) executes first.
      const instrumented = new Proxy(writerDatabase, {
        get(target, property) {
          if (property !== '$transaction') {
            const value: unknown = Reflect.get(target, property, target);
            return value;
          }
          return async <T>(
            callback: (tx: Prisma.TransactionClient) => Promise<T>,
          ) =>
            target.$transaction(
              async (tx) => {
                const result = await callback(tx);
                expect(
                  await tx.user.findUniqueOrThrow({ where: { id: ids[1] } }),
                ).toMatchObject({
                  role: permission === 'role' ? Role.CLIENT : Role.ADMIN,
                });
                expect(
                  await tx.adminClientAssignment.findUniqueOrThrow({
                    where: { id: beforeAssignment.id },
                  }),
                ).toMatchObject({ is_active: false });
                const [row] = await tx.$queryRaw<
                  { pid: number }[]
                >`SELECT pg_backend_pid() AS pid`;
                signal(row.pid);
                await gate;
                return result;
              },
              { timeout: 15000 },
            );
        },
      });
      const writerService = createService(instrumented);
      const operation =
        permission === 'role'
          ? writerService.updateRole(ids[3], ids[1], { role: Role.CLIENT })
          : writerService.updateClientAssignments(
              ids[3],
              Role.SUPER_ADMIN,
              ids[0],
              { admin_ids: [] },
            );
      // Attach rejection handlers before observing waits: no unhandled rejection.
      const writing = operation.then(
        (value: unknown) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      let archive: Promise<unknown> | undefined;
      interface WaitProof {
        pid: number;
        blockers: number[];
        wait_event_type: string;
        query: string;
      }
      let proof: WaitProof | undefined;
      try {
        const writerPid = await Promise.race([
          held,
          writing.then(() => {
            throw new Error('Writer ended before barrier');
          }),
        ]);
        archive = service
          .setClientArchived(ids[1], Role.ADMIN, ids[0], true)
          .then(
            () => 'accepted',
            (error: unknown) => error,
          );
        const expectedRow =
          permission === 'role' ? 'users' : 'admin_client_assignments';
        for (let n = 0; n < 200 && !proof; n++) {
          const observed = await pool.query<WaitProof>(
            `SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, query
             FROM pg_stat_activity
             WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))
               AND query LIKE $3`,
            [prefix, writerPid, `%FROM ${expectedRow}%`],
          );
          proof = observed.rows[0];
          if (!proof) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(proof).toBeDefined();
        expect(proof?.pid).not.toBe(writerPid);
        expect(proof?.blockers).toContain(writerPid);
        expect(proof?.wait_event_type).toBe('Lock');
        expect(proof?.query).toContain(
          permission === 'role' ? 'FOR UPDATE' : 'FOR SHARE',
        );
        // Snapshot outside the writer still sees the committed active assignment.
        expect(
          await prisma.adminClientAssignment.findUniqueOrThrow({
            where: { id: beforeAssignment.id },
          }),
        ).toEqual(beforeAssignment);
        console.info('Production writer wait proof', {
          permission,
          writerPid,
          archivePid: proof?.pid,
          blockers: proof?.blockers,
          row: expectedRow,
          wait: proof?.wait_event_type,
        });
      } finally {
        release();
        await writing;
        await archive;
        await writerDatabase.$disconnect();
      }
      try {
        const result = await writing;
        expect(result.error).toBeUndefined();
        if (permission === 'role')
          expect(result.value).toEqual({
            message: 'Rol actualizado exitosamente',
          });
        else
          expect(result.value).toMatchObject({
            client_id: ids[0],
            active_admins: [],
          });
        expect(await archive).toBeInstanceOf(
          permission === 'role' ? ForbiddenException : NotFoundException,
        );
        expect(
          await prisma.user.findUniqueOrThrow({ where: { id: ids[1] } }),
        ).toMatchObject({
          role: permission === 'role' ? Role.CLIENT : Role.ADMIN,
        });
        expect(
          await prisma.adminClientAssignment.findUniqueOrThrow({
            where: { id: beforeAssignment.id },
          }),
        ).toEqual({ ...beforeAssignment, is_active: false });
        expect(
          await prisma.user.findUniqueOrThrow({ where: { id: ids[0] } }),
        ).toEqual(beforeClient);
        expect(
          await prisma.bodyMetric.findMany({
            where: { client_id: ids[0] },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(beforeMetrics);
      } finally {
        await prisma.user.update({
          where: { id: ids[1] },
          data: { role: Role.ADMIN },
        });
        await prisma.adminClientAssignment.update({
          where: { id: beforeAssignment.id },
          data: { is_active: true },
        });
      }
    },
  );

  it('finishes a real A-to-new-B replacement racing stale-coach archive without a database error', async () => {
    const adminB = `${prefix}-replacement-admin`;
    ids.push(adminB);
    await prisma.user.create({
      data: {
        id: adminB,
        firebase_uid: adminB,
        email: `${adminB}@example.test`,
        role: Role.ADMIN,
      },
    });
    await prisma.user.update({
      where: { id: ids[0] },
      data: { is_archived: false },
    });
    expect(
      await prisma.adminClientAssignment.count({
        where: { admin_id: adminB, client_id: ids[0] },
      }),
    ).toBe(0);
    const beforeClient = await prisma.user.findUniqueOrThrow({
      where: { id: ids[0] },
    });
    const beforeMetrics = await prisma.bodyMetric.findMany({
      where: { client_id: ids[0] },
      orderBy: { id: 'asc' },
    });
    const oldAssignment = await prisma.adminClientAssignment.findFirstOrThrow({
      where: { admin_id: ids[1], client_id: ids[0], is_active: true },
    });
    const queueTemplate = jest.fn<
      ReturnType<NotificationsService['queueTemplate']>,
      Parameters<NotificationsService['queueTemplate']>
    >(() => Promise.resolve(undefined));
    const writerDatabase = new PrismaClient({ adapter: new PrismaPg(pool) });
    let release!: () => void;
    let signal!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<number>((resolve) => {
      signal = resolve;
    });
    let deactivated = false;
    let createStarted = false;
    // Await original delegate execution, not merely PrismaPromise construction.
    // No SQL/business substitute or extra business lock; preserve the default 5s timeout.
    const instrumented = new Proxy(writerDatabase, {
      get(target, property) {
        if (property !== '$transaction') {
          const value: unknown = Reflect.get(target, property, target);
          return value;
        }
        return <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) =>
          target.$transaction(async (tx) => {
            const delegate = new Proxy(tx.adminClientAssignment, {
              get(original, method) {
                if (method === 'updateMany') {
                  return async (
                    args: Prisma.AdminClientAssignmentUpdateManyArgs,
                  ) => {
                    const result = await original.updateMany(args);
                    expect(result.count).toBe(1);
                    expect(
                      await original.findUniqueOrThrow({
                        where: { id: oldAssignment.id },
                      }),
                    ).toEqual({ ...oldAssignment, is_active: false });
                    const [row] = await tx.$queryRaw<
                      { pid: number }[]
                    >`SELECT pg_backend_pid() AS pid`;
                    deactivated = true;
                    signal(row.pid);
                    return result;
                  };
                }
                if (method === 'createMany') {
                  return async (
                    args: Prisma.AdminClientAssignmentCreateManyArgs,
                  ) => {
                    await gate;
                    expect(deactivated).toBe(true);
                    createStarted = true;
                    return original.createMany(args);
                  };
                }
                const value: unknown = Reflect.get(original, method, original);
                return value;
              },
            });
            return callback(
              new Proxy(tx, {
                get(original, key) {
                  const value: unknown =
                    key === 'adminClientAssignment'
                      ? delegate
                      : Reflect.get(original, key, original);
                  return value;
                },
              }),
            );
          });
      },
    });
    const writing = createService(instrumented, queueTemplate)
      .updateClientAssignments(ids[3], Role.SUPER_ADMIN, ids[0], {
        admin_ids: [adminB],
      })
      .then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
    interface WaitProof {
      pid: number;
      blockers: number[];
      wait_event_type: string;
      query: string;
    }
    let archive: Promise<unknown> | undefined;
    let forward: WaitProof | undefined;
    let reverse: WaitProof | undefined;
    try {
      const writerPid = await Promise.race([
        held,
        writing.then(() => {
          throw new Error('Replacement ended before real deactivation barrier');
        }),
      ]);
      expect(createStarted).toBe(false);
      archive = service
        .setClientArchived(ids[1], Role.ADMIN, ids[0], true)
        .then(
          () => 'accepted',
          (error: unknown) => error,
        );
      for (let n = 0; n < 100 && !forward; n++) {
        const result = await pool.query<WaitProof>(
          `SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, query
           FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))`,
          [prefix, writerPid],
        );
        forward = result.rows[0];
        if (!forward) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(forward).toBeDefined();
      expect(forward?.wait_event_type).toBe('Lock');
      expect(forward?.query).toMatch(/FROM (users|admin_client_assignments)/);
      expect(forward?.query).toMatch(/FOR (UPDATE|SHARE)/);
      console.info('Replacement forward wait', { writerPid, ...forward });
      release();
      // Observe the actual INSERT/FK wait, if present, before PG chooses a victim.
      for (let n = 0; n < 100 && !reverse; n++) {
        const result = await pool.query<WaitProof>(
          `SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, query
           FROM pg_stat_activity WHERE pid=$1 AND $2=ANY(pg_blocking_pids(pid))`,
          [writerPid, forward?.pid],
        );
        reverse = result.rows[0];
        if (!reverse) {
          const ended = await Promise.race([
            writing.then(() => true),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), 5),
            ),
          ]);
          if (ended) break;
        }
      }
      if (forward?.query.includes('admin_client_assignments')) {
        expect(reverse?.wait_event_type).toBe('Lock');
        expect(reverse?.query).toMatch(
          /INSERT INTO .*admin_client_assignments/,
        );
      } else expect(reverse).toBeUndefined();
      console.info(
        'Replacement reverse wait',
        reverse ?? 'none: canonical user wait',
      );
    } finally {
      release();
      await writing;
      await archive;
      await writerDatabase.$disconnect();
    }
    try {
      const result = await writing;
      // Owned fixture only; Prisma includes the PostgreSQL error code/message here.
      console.info('Replacement domain outcomes', {
        writerError: result.error,
        archive: await archive,
      });
      expect(result.error).toBeUndefined();
      expect(createStarted).toBe(true);
      expect(result.value).toMatchObject({
        client_id: ids[0],
        active_admins: [{ id: adminB }],
      });
      expect(await archive).toBeInstanceOf(NotFoundException);
      expect(
        await prisma.adminClientAssignment.findUniqueOrThrow({
          where: { id: oldAssignment.id },
        }),
      ).toEqual({ ...oldAssignment, is_active: false });
      expect(
        await prisma.adminClientAssignment.findFirstOrThrow({
          where: { admin_id: adminB, client_id: ids[0] },
        }),
      ).toMatchObject({ is_active: true });
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: ids[0] } }),
      ).toEqual(beforeClient);
      expect(
        await prisma.bodyMetric.findMany({
          where: { client_id: ids[0] },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(beforeMetrics);
      expect(queueTemplate).toHaveBeenCalledTimes(1);
      expect(queueTemplate.mock.calls[0].slice(1, 4)).toEqual([
        ids[3],
        [adminB],
        'admin_client_assigned',
      ]);
    } finally {
      // Restore owned state even on RED; do not contaminate the original replay case.
      await prisma.adminClientAssignment.update({
        where: { id: oldAssignment.id },
        data: { is_active: true },
      });
      await prisma.adminClientAssignment.updateMany({
        where: { admin_id: adminB, client_id: ids[0] },
        data: { is_active: false },
      });
    }
  });

  it.each([false, true])(
    'conserva la intención bulk multifila opuesta y las tareas con rollback=%s',
    async (rollback) => {
      const clientId = `${prefix}-bulk-${rollback}`;
      const admins = ['a', 'b', 'c', 'd', 'e', 'f'].map(
        (name) => `${clientId}-${name}`,
      );
      ids.push(clientId, ...admins);
      await prisma.user.createMany({
        data: [clientId, ...admins].map((id) => ({
          id,
          firebase_uid: id,
          email: `${id}@example.test`,
          role: id === clientId ? Role.CLIENT : Role.ADMIN,
        })),
      });
      await prisma.adminClientAssignment.createMany({
        data: admins.map((admin_id, index) => ({
          admin_id,
          client_id: clientId,
          is_active: [0, 1, 4].includes(index),
        })),
      });
      const metric = await prisma.bodyMetric.create({
        data: {
          client_id: clientId,
          date: new Date('2026-10-09'),
          weight_kg: 81,
        },
      });
      const tasks = new ClientFollowUpTasksService(prisma as PrismaService);
      const actor = { id: admins[0], role: Role.ADMIN };
      const task = await tasks.create(
        clientId,
        {
          id: randomUUID(),
          title: 'Revisión preservada',
          type: ClientFollowUpTaskType.REVIEW,
          due_date: '2026-10-12',
          assigned_to_id: admins[1],
        },
        actor,
      );
      const beforeAssignments = await prisma.adminClientAssignment.findMany({
        where: { client_id: clientId },
        orderBy: { admin_id: 'asc' },
      });
      const expectedResponse = (selected: string[]) => ({
        client_id: clientId,
        active_admins: [...beforeAssignments]
          .sort(
            (a, b) =>
              a.created_at.getTime() - b.created_at.getTime() ||
              a.id.localeCompare(b.id),
          )
          .filter((assignment) => selected.includes(assignment.admin_id))
          .map((assignment) => ({
            id: assignment.admin_id,
            email: `${assignment.admin_id}@example.test`,
            profile: null,
            assigned_at: assignment.created_at,
          })),
      });
      // FU05: progreso manual alcanzado; sin regla automática ni ventana semanal.
      const sharedClientId = `${clientId}-shared`;
      await prisma.user.create({
        data: {
          id: sharedClientId,
          firebase_uid: sharedClientId,
          email: `${sharedClientId}@example.test`,
          role: Role.CLIENT,
        },
      });
      await prisma.adminClientAssignment.create({
        data: { admin_id: admins[0], client_id: sharedClientId },
      });
      const challengeData = {
        title: 'Histórico GLOBAL manual FU05',
        description: 'Conservar logro y procedencia al cambiar coach',
        type: 'MAIN_GOAL',
        target_value: 10,
        unit: 'unidades',
        is_manual: true,
        is_global: true,
        created_by: admins[0],
        created_at: new Date('2026-09-01T00:00:00.000Z'),
      } satisfies Prisma.ChallengeCreateInput;
      const challenge = await prisma.challenge.create({ data: challengeData });
      const attained = {
        challenge_id: challenge.id,
        assignment_source: 'GLOBAL',
        current_value: 10,
        is_completed: true,
        completed_at: new Date('2026-09-03T00:00:00.000Z'),
        assigned_at: new Date('2026-09-02T00:00:00.000Z'),
      } satisfies Omit<Prisma.ChallengeClientUncheckedCreateInput, 'client_id'>;
      const beforeHistory = await prisma.challengeClient.create({
        data: { ...attained, client_id: clientId },
      });
      const beforeShared = await prisma.challengeClient.create({
        data: { ...attained, client_id: sharedClientId },
      });
      const historyWhere = {
        challenge_id_client_id: {
          challenge_id: challenge.id,
          client_id: clientId,
        },
      };
      const historySnapshots: {
        stage: string;
        row: typeof beforeHistory | null;
      }[] = [];
      const payload = { admin_ids: [admins[5], admins[3], admins[2]] };
      const opposite = { admin_ids: [admins[1], admins[0]] };
      const rollbackError = new Error('Rollback deliberado del bulk propio');
      // Solo fronteras de transacción: todos los delegates y callbacks originales.
      function barrier(database: PrismaClient, abort = false) {
        let release!: () => void;
        let signal!: (pid: number) => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const held = new Promise<number>((resolve) => {
          signal = resolve;
        });
        const instrumented = new Proxy(database, {
          get(target, property) {
            if (property !== '$transaction') {
              const value: unknown = Reflect.get(target, property, target);
              return value;
            }
            return <T>(
              callback: (tx: Prisma.TransactionClient) => Promise<T>,
              options?: Parameters<PrismaClient['$transaction']>[1],
            ) =>
              target.$transaction(async (tx) => {
                const result = await callback(tx);
                if (database === writerDatabase) {
                  console.info('FU05 primera intención dentro de TX', {
                    rollback,
                    before: beforeHistory,
                    after: await tx.challengeClient.findUnique({
                      where: historyWhere,
                    }),
                  });
                }
                const [row] = await tx.$queryRaw<{ pid: number }[]>`
                SELECT pg_backend_pid() AS pid`;
                signal(row.pid);
                await gate;
                if (abort) throw rollbackError;
                return result;
              }, options);
          },
        });
        return { instrumented, held, release };
      }
      interface WaitProof {
        pid: number;
        blockers: number[];
        wait_event_type: string;
        query: string;
      }
      async function waitFor(blocker: number): Promise<WaitProof> {
        for (let n = 0; n < 200; n++) {
          const result = await pool.query<WaitProof>(
            `SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, query
             FROM pg_stat_activity WHERE application_name=$1
             AND $2=ANY(pg_blocking_pids(pid))`,
            [prefix, blocker],
          );
          const proof = result.rows[0];
          if (proof) {
            expect(proof.wait_event_type).toBe('Lock');
            expect(proof.blockers).toContain(blocker);
            expect(proof.query).toBe(
              'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS "locked"',
            );
            console.info('Grafo bulk retenido antes de liberar', {
              rollback,
              blocker,
              ...proof,
            });
            return proof;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('No se observó el bloqueo bulk previsto');
      }
      const taskDatabase = new PrismaClient({ adapter: new PrismaPg(pool) });
      const writerDatabase = new PrismaClient({ adapter: new PrismaPg(pool) });
      const taskBarrier = barrier(taskDatabase);
      const writerBarrier = barrier(writerDatabase, rollback);
      const notifications = new NotificationsService(prisma as PrismaService);
      const queue: NotificationsService['queueTemplate'] = (...args) =>
        notifications.queueTemplate(...args);
      // El reto completado activa evaluación real de logros; no un mock.
      function createBulkService(database: PrismaClient) {
        const db = database as PrismaService;
        const denyExternal = (): never => {
          throw new Error('Proveedor externo prohibido en FU05');
        };
        const guardedNotifications = new Proxy(new NotificationsService(db), {
          get: (_target, property) =>
            property === 'queueTemplate' ? queue : denyExternal,
        });
        const provider = {
          get: denyExternal,
          create: denyExternal,
          update: denyExternal,
          revoke: denyExternal,
          remove: denyExternal,
        } satisfies IdentityProvider;
        return new UsersService(
          db,
          new ChallengesService(
            db,
            new AchievementsService(db, guardedNotifications),
            guardedNotifications,
          ),
          guardedNotifications,
          undefined!,
          undefined!,
          undefined,
          new IdentityService(db, provider),
        );
      }
      const observe = <T>(operation: Promise<T>) =>
        operation.then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
      const editing = observe(
        new ClientFollowUpTasksService(
          taskBarrier.instrumented as PrismaService,
        ).update(
          clientId,
          task.id,
          {
            expected_version: 1,
            title: 'Revisión editada antes del bulk',
            assigned_to_id: admins[1],
          },
          actor,
        ),
      );
      let first:
        | ReturnType<
            typeof observe<
              Awaited<ReturnType<UsersService['updateClientAssignments']>>
            >
          >
        | undefined;
      let second: typeof first;
      let firstProof: WaitProof | undefined;
      let secondProof: WaitProof | undefined;
      try {
        const taskPid = await Promise.race([
          taskBarrier.held,
          editing.then(() => {
            throw new Error('Tarea terminó antes de barrera');
          }),
        ]);
        first = observe(
          createBulkService(writerBarrier.instrumented).updateClientAssignments(
            ids[3],
            Role.SUPER_ADMIN,
            clientId,
            payload,
          ),
        );
        firstProof = await waitFor(taskPid);
        taskBarrier.release();
        const firstPid = await Promise.race([
          writerBarrier.held,
          first.then(() => {
            throw new Error('Bulk terminó antes de barrera');
          }),
        ]);
        expect(firstPid).toBe(firstProof.pid);
        // El bulk opuesto espera el mismo advisory ANTES de leer asignaciones;
        // solo calcula su intención después del commit/rollback del primero.
        second = observe(
          createBulkService(prisma).updateClientAssignments(
            ids[3],
            Role.SUPER_ADMIN,
            clientId,
            opposite,
          ),
        );
        secondProof = await waitFor(firstPid);
        expect(secondProof.pid).not.toBe(taskPid);
        expect(secondProof.pid).not.toBe(firstPid);
        expect(
          await prisma.adminClientAssignment.findMany({
            where: { client_id: clientId },
            orderBy: { admin_id: 'asc' },
          }),
        ).toEqual(beforeAssignments);
      } finally {
        taskBarrier.release();
        writerBarrier.release();
        await editing;
        await first;
        await second;
        await taskDatabase.$disconnect();
        await writerDatabase.$disconnect();
      }
      historySnapshots.push({
        stage: 'bulk opuesto: coach reactivado tras commit/rollback',
        row: await prisma.challengeClient.findUnique({ where: historyWhere }),
      });
      const edited = await editing;
      const firstResult = await first;
      const secondResult = await second;
      const assignments = await prisma.adminClientAssignment.findMany({
        where: { client_id: clientId },
        orderBy: { admin_id: 'asc' },
      });
      const messages = await prisma.notification.findMany({
        where: { recipient_id: { in: admins } },
        orderBy: { recipient_id: 'asc' },
      });
      console.info(
        'Resultados completos bulk opuestos',
        JSON.stringify({
          rollback,
          firstResult,
          secondResult,
          assignments,
          messages,
        }),
      );
      expect(firstProof).toBeDefined();
      expect(secondProof).toBeDefined();
      expect(edited.error).toBeUndefined();
      if (!edited.value) throw new Error('Falta el resultado de la tarea');
      expect(edited.value.updated_at).toBeInstanceOf(Date);
      expect(edited.value).toEqual({
        ...task,
        title: 'Revisión editada antes del bulk',
        version: 2,
        updated_at: edited.value.updated_at,
      });
      expect(
        await prisma.clientFollowUpTask.findUniqueOrThrow({
          where: { id: task.id },
        }),
      ).toEqual(edited.value);
      expect(
        await prisma.bodyMetric.findUniqueOrThrow({
          where: { id: metric.id },
        }),
      ).toEqual(metric);
      expect(firstResult?.error).toBe(rollback ? rollbackError : undefined);
      expect(secondResult?.error).toBeUndefined();
      if (!rollback) {
        expect(
          firstResult?.value?.active_admins.map((admin) => admin.id).sort(),
        ).toEqual([...payload.admin_ids].sort());
        expect(firstResult?.value).toEqual(expectedResponse(payload.admin_ids));
      }
      expect(
        messages.map((message) => ({
          sender: message.sender_id,
          recipient: message.recipient_id,
          status: message.status,
        })),
      ).toEqual(
        rollback
          ? []
          : [...payload.admin_ids, ...opposite.admin_ids]
              .sort()
              .map((recipient) => ({
                sender: ids[3],
                recipient,
                status: 'PENDING',
              })),
      );
      // Contrato: una respuesta exitosa debe reflejar la intención completa del
      // bulk opuesto; no basta con que ambas transacciones eviten un deadlock.
      expect(
        secondResult?.value?.active_admins.map((admin) => admin.id).sort(),
      ).toEqual([...opposite.admin_ids].sort());
      expect(secondResult?.value).toEqual(expectedResponse(opposite.admin_ids));
      expect(assignments).toEqual(
        beforeAssignments.map((assignment) => ({
          ...assignment,
          is_active: opposite.admin_ids.includes(assignment.admin_id),
        })),
      );
      await expect(tasks.get(clientId, task.id, actor)).resolves.toEqual(
        edited.value,
      );
      if (rollback) {
        const retry = await createBulkService(prisma).updateClientAssignments(
          ids[3],
          Role.SUPER_ADMIN,
          clientId,
          payload,
        );
        expect(retry.active_admins.map((admin) => admin.id).sort()).toEqual(
          [...payload.admin_ids].sort(),
        );
        historySnapshots.push({
          stage: 'retry confirmado: coach fuera de elegibilidad',
          row: await prisma.challengeClient.findUnique({ where: historyWhere }),
        });
        expect(retry).toEqual(expectedResponse(payload.admin_ids));
        expect(
          await prisma.adminClientAssignment.findMany({
            where: { client_id: clientId },
            orderBy: { admin_id: 'asc' },
          }),
        ).toEqual(
          beforeAssignments.map((assignment) => ({
            ...assignment,
            is_active: payload.admin_ids.includes(assignment.admin_id),
          })),
        );
        await expect(
          tasks.get(clientId, task.id, actor),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(
          await tasks.get(clientId, task.id, {
            id: ids[3],
            role: Role.SUPER_ADMIN,
          }),
        ).toEqual(edited.value);
        expect(
          await prisma.notification.findMany({
            where: { recipient_id: { in: admins } },
            orderBy: { recipient_id: 'asc' },
            select: { sender_id: true, recipient_id: true, status: true },
          }),
        ).toEqual(
          [...payload.admin_ids].sort().map((recipient_id) => ({
            sender_id: ids[3],
            recipient_id,
            status: 'PENDING',
          })),
        );
        expect(
          await prisma.bodyMetric.findUniqueOrThrow({
            where: { id: metric.id },
          }),
        ).toEqual(metric);
      }
      const afterChallenge = await prisma.challenge.findUnique({
        where: { id: challenge.id },
      });
      const afterShared = await prisma.challengeClient.findUnique({
        where: { id: beforeShared.id },
      });
      console.info('FU05 histórico durable antes/después', {
        rollback,
        before: beforeHistory,
        snapshots: historySnapshots,
        definitionPreserved:
          JSON.stringify(afterChallenge) === JSON.stringify(challenge),
        sharedPreserved:
          JSON.stringify(afterShared) === JSON.stringify(beforeShared),
      });
      expect(afterChallenge).toEqual(challenge);
      expect(afterShared).toEqual(beforeShared);
      // Hoy no existe archivo histórico alternativo: esta fila es la única
      // evidencia durable del valor, logro, fechas y procedencia alcanzados.
      expect(historySnapshots).toEqual(
        historySnapshots.map(({ stage }) => ({ stage, row: beforeHistory })),
      );
    },
  );

  it('rechaza la solicitud real de borrado tras esperar el commit de una revocación real de rol', async () => {
    const clientId = `${prefix}-fu01-cliente`;
    const requesterId = `${prefix}-fu01-solicitante`;
    // No se añaden a ids: este caso conserva sus filas propias, incluso al fallar.
    await prisma.user.createMany({
      data: [
        {
          id: clientId,
          firebase_uid: clientId,
          email: `${clientId}@example.test`,
          role: Role.CLIENT,
        },
        {
          id: requesterId,
          firebase_uid: requesterId,
          email: `${requesterId}@example.test`,
          role: Role.SUPER_ADMIN,
        },
      ],
    });
    await prisma.bodyMetric.create({
      data: {
        client_id: clientId,
        date: new Date('2026-10-09'),
        weight_kg: 81,
      },
    });
    await prisma.clientFollowUpTask.create({
      data: {
        client_id: clientId,
        created_by_id: requesterId,
        type: ClientFollowUpTaskType.REVIEW,
        title: 'Histórico propio FU01',
        due_date: new Date('2026-10-09'),
      },
    });
    await prisma.notification.create({
      data: {
        sender_id: requesterId,
        recipient_id: clientId,
        title: 'Histórico propio FU01',
        body: 'Conservar íntegro',
        data: { client_id: clientId },
      },
    });
    // Fotografía completa de todas las tablas públicas, no solo recuentos.
    // users se compara aparte porque el writer sí cambia el rol del solicitante.
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public'
       AND tablename NOT IN ('users', '_prisma_migrations') ORDER BY tablename`,
    );
    async function history() {
      const snapshot: Record<string, string> = {};
      for (const { tablename } of tables.rows) {
        const identifier = `"${tablename.replaceAll('"', '""')}"`;
        const result = await pool.query<{ contents: string }>(
          `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS contents FROM public.${identifier} t`,
        );
        snapshot[tablename] = result.rows[0].contents;
      }
      return snapshot;
    }
    const beforeClient = await prisma.user.findUniqueOrThrow({
      where: { id: clientId },
    });
    const beforeUsers = await prisma.user.findMany({ orderBy: { id: 'asc' } });
    const beforeRequester = beforeUsers.find((user) => user.id === requesterId);
    if (!beforeRequester) throw new Error('Falta el solicitante inicial FU01');
    const beforeHistory = await history();
    const beforeJobs = await prisma.clientDeletion.count();
    const beforeWork = await prisma.durableWork.count();
    const external = jest.fn((): never => {
      throw new Error('Proveedor externo prohibido en FU01');
    });
    function deniedProvider(prototype: object) {
      const methods: Record<string, typeof external> = {};
      for (const [name, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(prototype),
      )) {
        if (name !== 'constructor' && typeof descriptor.value === 'function')
          methods[name] = external;
      }
      return methods;
    }
    const identity = {
      credentialLifetimeMs: external,
      isAbsent: external,
      remove: external,
    } satisfies Pick<
      DeletionIdentityService,
      'credentialLifetimeMs' | 'isAbsent' | 'remove'
    >;
    const uploads = {
      ...deniedProvider(UploadsService.prototype),
      extractManagedFileKey: external,
      credentialLifetimeMs: external,
    } satisfies Pick<
      UploadsService,
      'extractManagedFileKey' | 'credentialLifetimeMs'
    >;
    const destructive = jest.fn((): never => {
      throw new Error('Borde destructivo prohibido en FU01');
    });
    let release: () => void = () => {
      throw new Error('Barrera no inicializada');
    };
    let signal: (pid: number) => void = () => {
      throw new Error('Señal no inicializada');
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<number>((resolve) => {
      signal = resolve;
    });
    const writerDatabase = new PrismaClient({ adapter: new PrismaPg(pool) });
    const requestDatabase = new PrismaClient({ adapter: new PrismaPg(pool) });
    let observedRole: Role | undefined;
    const writer = new Proxy(writerDatabase, {
      get(target, property) {
        if (property !== '$transaction') {
          const value: unknown = Reflect.get(target, property, target);
          return value;
        }
        return <T>(
          callback: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: Parameters<PrismaClient['$transaction']>[1],
        ) =>
          target.$transaction(async (tx) => {
            const result = await callback(tx);
            expect(
              await tx.user.findUniqueOrThrow({ where: { id: requesterId } }),
            ).toMatchObject({ role: Role.CLIENT });
            const [row] = await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            signal(row.pid);
            await gate;
            return result;
          }, options);
      },
    });
    const request = new Proxy(requestDatabase, {
      get(target, property) {
        if (property !== '$transaction') {
          const value: unknown = Reflect.get(target, property, target);
          return value;
        }
        return <T>(
          callback: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: Parameters<PrismaClient['$transaction']>[1],
        ) =>
          target.$transaction((tx) => {
            // Instalado ANTES del callback: impide delegates delete/deleteMany y
            // SQL destructivo (request solo usa executeRaw para DELETE notifications).
            const guarded = new Proxy(tx, {
              get(transaction, member) {
                if (member === '$executeRaw' || member === '$executeRawUnsafe')
                  return destructive;
                const value: unknown = Reflect.get(
                  transaction,
                  member,
                  transaction,
                );
                if (typeof value !== 'object' || value === null) return value;
                return new Proxy(value, {
                  get(delegate, method) {
                    if (method === 'delete' || method === 'deleteMany')
                      return destructive;
                    if (member === 'user' && method === 'findUnique') {
                      return async (args: Prisma.UserFindUniqueArgs) => {
                        const result = await transaction.user.findUnique(args);
                        if (args.where.id === requesterId)
                          observedRole = result?.role;
                        return result;
                      };
                    }
                    const original: unknown = Reflect.get(
                      delegate,
                      method,
                      delegate,
                    );
                    return original;
                  },
                });
              },
            });
            return callback(guarded);
          }, options);
      },
    });
    // compile únicamente; sin imports, AppModule, init, scheduler ni lifecycle.
    const writerModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: writer },
        ...[
          ChallengesService,
          NotificationsService,
          MetricsService,
          CalendarService,
          EmailService,
          IdentityService,
        ].map((provide) => ({
          provide,
          useValue: deniedProvider(provide.prototype),
        })),
      ],
    }).compile();
    const requestModule = await Test.createTestingModule({
      providers: [
        ClientDeletionService,
        { provide: PrismaService, useValue: request },
        { provide: UploadsService, useValue: uploads },
        { provide: DeletionIdentityService, useValue: identity },
      ],
    }).compile();
    const observe = <T>(operation: Promise<T>) =>
      operation.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
    const roleWriteStartedAt = Date.now();
    const writing = observe(
      writerModule
        .get(UsersService)
        .updateRole(ids[3], requesterId, { role: Role.CLIENT }),
    );
    let requesting:
      | ReturnType<
          typeof observe<Awaited<ReturnType<ClientDeletionService['request']>>>
        >
      | undefined;
    interface WaitProof {
      pid: number;
      blockers: number[];
      wait_event_type: string;
      query: string;
    }
    let proof: WaitProof | undefined;
    try {
      const writerPid = await Promise.race([
        held,
        writing.then(() => {
          throw new Error('Writer finalizó antes de la barrera FU01');
        }),
      ]);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: requesterId } }),
      ).toMatchObject({ role: Role.SUPER_ADMIN });
      requesting = observe(
        requestModule.get(ClientDeletionService).request(clientId, requesterId),
      );
      for (let n = 0; n < 200 && !proof; n++) {
        const result = await pool.query<WaitProof>(
          `SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, query
           FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))
           AND query LIKE '%FROM users%'`,
          [prefix, writerPid],
        );
        proof = result.rows[0];
        if (!proof) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(proof).toBeDefined();
      expect(proof?.pid).not.toBe(writerPid);
      expect(proof?.blockers).toContain(writerPid);
      expect(proof?.wait_event_type).toBe('Lock');
      expect(proof?.query).toContain('ORDER BY id FOR UPDATE');
      expect(observedRole).toBeUndefined();
      console.info('Grafo FU01 antes del commit del writer', {
        writerPid,
        ...proof,
      });
    } finally {
      release();
      await writing;
      await requesting;
      await writerDatabase.$disconnect();
      await requestDatabase.$disconnect();
    }
    const transactionsSettledAt = Date.now();
    const afterUsers = await prisma.user.findMany({ orderBy: { id: 'asc' } });
    const afterRequester = afterUsers.find((user) => user.id === requesterId);
    if (!afterRequester) throw new Error('Falta el solicitante final FU01');
    // updateRole: users.service.ts:374 solo escribe role; schema.prisma:192
    // declara User.updated_at @updatedAt, generado con el reloj local de Prisma.
    const changedAt = afterRequester.updated_at.getTime();
    expect(afterRequester.updated_at).toBeInstanceOf(Date);
    expect(transactionsSettledAt).toBeGreaterThanOrEqual(roleWriteStartedAt);
    expect(changedAt).toBeGreaterThanOrEqual(
      beforeRequester.updated_at.getTime(),
    );
    expect(changedAt).toBeGreaterThanOrEqual(roleWriteStartedAt);
    expect(changedAt).toBeLessThanOrEqual(transactionsSettledAt);
    expect(afterUsers).toHaveLength(beforeUsers.length);
    expect(afterUsers.map((user) => user.id)).toEqual(
      beforeUsers.map((user) => user.id),
    );
    expect(afterUsers).toEqual(
      beforeUsers.map((user) =>
        user.id === requesterId
          ? {
              ...user,
              role: Role.CLIENT,
              updated_at: afterRequester.updated_at,
            }
          : user,
      ),
    );
    expect((await writing).error).toBeUndefined();
    expect((await writing).value).toEqual({
      message: 'Rol actualizado exitosamente',
    });
    expect((await requesting)?.error).toBeInstanceOf(ForbiddenException);
    expect(observedRole).toBe(Role.CLIENT);
    expect(destructive).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: requesterId } }),
    ).toMatchObject({ role: Role.CLIENT });
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: clientId } }),
    ).toEqual(beforeClient);
    expect(await history()).toEqual(beforeHistory);
    expect(await prisma.clientDeletion.count()).toBe(beforeJobs);
    expect(await prisma.durableWork.count()).toBe(beforeWork);
    console.info('Relectura y persistencia FU01', {
      observedRole,
      usersBefore: beforeUsers.length,
      usersAfter: afterUsers.length,
      roleWriteStartedAt,
      changedAt,
      transactionsSettledAt,
      tables: tables.rows.length,
      deletionJobs: beforeJobs,
      durableWork: beforeWork,
      destructiveCalls: destructive.mock.calls.length,
      externalCalls: external.mock.calls.length,
    });
  });

  it.each([
    'TRAINING_DAYS',
    'MEAL_CHECKINS',
    'WEIGHT_LOGS',
    'STREAK_DAYS',
  ] as const)(
    'preserves GLOBAL %s history while excluding inactive provenance and allowing active undo',
    async (rule) => {
      const clientId = `${prefix}-${rule}`;
      const adminId = `${clientId}-admin`;
      await prisma.user.createMany({
        data: [clientId, adminId].map((id) => ({
          id,
          firebase_uid: id,
          email: `${id}@example.test`,
          role: id === clientId ? Role.CLIENT : Role.ADMIN,
        })),
      });
      const scope = await prisma.adminClientAssignment.create({
        data: { admin_id: adminId, client_id: clientId },
      });
      const challenges = new ChallengesService(
        prisma as PrismaService,
        undefined!,
        undefined!,
      );
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const tomorrow = new Date(today);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const challenge = await prisma.challenge.create({
        data: {
          title: rule,
          description: 'Owned eligibility fixture',
          type: 'MAIN_GOAL',
          target_value: 100,
          unit: 'days',
          is_global: true,
          is_manual: false,
          rule_key: rule,
          created_by: adminId,
        },
      });
      const row = await prisma.challengeClient.create({
        data: {
          challenge_id: challenge.id,
          client_id: clientId,
          assignment_source: 'GLOBAL',
          assigned_at: yesterday,
        },
      });
      await prisma.challengeClientEligibilityPeriod.create({
        data: {
          challenge_client_id: row.id,
          starts_on: yesterday,
          opened_at: yesterday,
        },
      });
      const training = await prisma.training.create({
        data: { name: clientId, type: 'strength', tags: [] },
      });
      await prisma.planAssignment.createMany({
        data: [yesterday, today, tomorrow].map((date) => ({
          client_id: clientId,
          date,
          training_id: training.id,
        })),
      });
      const addActivity = async (date: Date, meal: string) => {
        await prisma.dayProgress.create({
          data: {
            client_id: clientId,
            date,
            training_completed: true,
            meals_completed: [meal],
          },
        });
        await prisma.bodyMetric.create({
          data: { client_id: clientId, date, weight_kg: 70 },
        });
      };
      let asOf = today;
      const refresh = () =>
        challenges.recalculateAutomaticProgress(
          clientId,
          undefined,
          [challenge.id],
          undefined,
          asOf,
        );
      const history = () =>
        prisma.challengeClient.findUniqueOrThrow({ where: { id: row.id } });
      await addActivity(yesterday, 'historical');
      await refresh();
      expect((await history()).current_value).toBe(1);
      const attained = await history();
      await prisma.adminClientAssignment.update({
        where: { id: scope.id },
        data: { is_active: false },
      });
      expect(await challenges.findMyChallenges(clientId)).toEqual([]);
      await prisma.dayProgress.update({
        where: { client_id_date: { client_id: clientId, date: yesterday } },
        data: { meals_completed: ['historical', 'inactive'] },
      });
      await prisma.bodyMetric.updateMany({
        where: { client_id: clientId },
        data: { weight_kg: 71 },
      });
      await addActivity(today, 'inactive-today');
      await refresh();
      expect(await history()).toEqual(attained);
      await new Promise((resolve) => setTimeout(resolve, 2));
      await prisma.adminClientAssignment.update({
        where: { id: scope.id },
        data: { is_active: true },
      });
      const open =
        await prisma.challengeClientEligibilityPeriod.findFirstOrThrow({
          where: { challenge_client_id: row.id, ends_on: null },
        });
      expect(open.starts_on).toEqual(tomorrow);
      expect(open.baseline_value).toBe(1);
      await refresh();
      expect((await history()).current_value).toBe(1);
      // Advance only this owned fixture's eligibility clock; production re-entry remains next-day.
      await prisma.challengeClientEligibilityPeriod.update({
        where: { id: open.id },
        data: { starts_on: today },
      });
      await prisma.dayProgress.update({
        where: { client_id_date: { client_id: clientId, date: yesterday } },
        data: { notes: 'No activity reattribution' },
      });
      await prisma.dayProgress.update({
        where: { client_id_date: { client_id: clientId, date: today } },
        data: { notes: 'Carried inactive activity stays ineligible' },
      });
      await refresh();
      expect((await history()).current_value).toBe(1);
      await prisma.dayProgress.update({
        where: { client_id_date: { client_id: clientId, date: today } },
        data: { training_completed: false },
      });
      await prisma.dayProgress.update({
        where: { client_id_date: { client_id: clientId, date: today } },
        data: {
          training_completed: true,
          meals_completed: ['inactive-today', 'new-today'],
        },
      });
      await prisma.bodyMetric.updateMany({
        where: { client_id: clientId, date: today },
        data: { weight_kg: 72 },
      });
      await addActivity(tomorrow, 'new-tomorrow');
      asOf = tomorrow;
      await refresh();
      expect((await history()).current_value).toBe(
        rule === 'STREAK_DAYS' ? 2 : 3,
      );
      const publicRows = await challenges.findMyChallenges(clientId);
      expect(publicRows).toHaveLength(1);
      expect(JSON.stringify(publicRows)).not.toMatch(
        /eligibility_periods|baseline_value|opened_at|challenge_activity/,
      );
      expect(
        JSON.stringify(
          await prisma.dayProgress.findMany({ where: { client_id: clientId } }),
        ),
      ).not.toContain('challenge_activity');
      expect(
        JSON.stringify(
          await prisma.bodyMetric.findMany({ where: { client_id: clientId } }),
        ),
      ).not.toContain('challenge_activity_at');
      await prisma.dayProgress.update({
        where: { client_id_date: { client_id: clientId, date: tomorrow } },
        data: { training_completed: false, meals_completed: [] },
      });
      await prisma.bodyMetric.updateMany({
        where: { client_id: clientId, date: tomorrow },
        data: { weight_kg: null },
      });
      await refresh();
      expect((await history()).current_value).toBe(
        rule === 'STREAK_DAYS' ? 1 : 2,
      );
      await prisma.user.update({
        where: { id: adminId },
        data: { role: Role.CLIENT },
      });
      expect(await challenges.findMyChallenges(clientId)).toEqual([]);
      const frozen = await history();
      await refresh();
      expect(await history()).toEqual(frozen);
      await prisma.user.update({
        where: { id: adminId },
        data: { role: Role.ADMIN },
      });
      await prisma.challenge.update({
        where: { id: challenge.id },
        data: { is_global: false },
      });
      expect(await challenges.findMyChallenges(clientId)).toEqual([]);
      await prisma.challenge.update({
        where: { id: challenge.id },
        data: { is_global: true },
      });
      await prisma.user.update({
        where: { id: clientId },
        data: { role: Role.ADMIN },
      });
      expect(await challenges.findMyChallenges(clientId)).toEqual([]);
      await prisma.user.update({
        where: { id: clientId },
        data: { role: Role.CLIENT },
      });
      const periods = await prisma.challengeClientEligibilityPeriod.findMany({
        where: { challenge_client_id: row.id },
      });
      expect(periods.filter((period) => period.ends_on === null)).toHaveLength(
        1,
      );
      expect(
        periods.filter(
          (period) => period.ends_on?.getTime() === period.starts_on.getTime(),
        ).length,
      ).toBeGreaterThanOrEqual(2);
      await expect(
        prisma.challengeClientEligibilityPeriod.create({
          data: { challenge_client_id: row.id, starts_on: tomorrow },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.challengeClientEligibilityPeriod.create({
          data: {
            challenge_client_id: row.id,
            starts_on: yesterday,
            ends_on: today,
          },
        }),
      ).rejects.toThrow();
      expect((await history()).id).toBe(row.id);
      expect((await history()).assigned_at).toEqual(row.assigned_at);
    },
  );

  it.each(['edited', 'peer', 'creator-null'] as const)(
    'orders GLOBAL toggle before recalculation daily locks for %s scope',
    async (scope) => {
      const clientId = `${prefix}-toggle-${scope}`;
      const peerId = `${clientId}-peer`;
      const creatorId = `${clientId}-creator`;
      await prisma.user.createMany({
        data: [clientId, peerId, creatorId].map((id) => ({
          id,
          firebase_uid: id,
          email: `${id}@example.test`,
          role: id === creatorId ? Role.ADMIN : Role.CLIENT,
        })),
      });
      await prisma.adminClientAssignment.createMany({
        data: [clientId, peerId].map((id) => ({
          admin_id: creatorId,
          client_id: id,
        })),
      });
      const challenges = new ChallengesService(
        prisma as PrismaService,
        new AchievementsService(prisma as PrismaService, undefined!),
        undefined!,
      );
      const challenge = await prisma.challenge.create({
        data: {
          title: 'Toggle lock ordering',
          description: 'Owned fixture',
          type: 'MAIN_GOAL',
          target_value: 10,
          unit: 'days',
          is_global: true,
          is_manual: false,
          rule_key: 'TRAINING_DAYS',
          created_by: scope === 'creator-null' ? null : creatorId,
        },
      });
      const peer = await prisma.challenge.create({
        data: {
          title: 'Peer challenge',
          description: 'Owned fixture',
          type: 'MAIN_GOAL',
          target_value: 10,
          unit: 'days',
          is_global: true,
          is_manual: false,
          rule_key: 'TRAINING_DAYS',
          created_by: challenge.created_by,
        },
      });
      const history = await prisma.challengeClient.create({
        data: {
          challenge_id: challenge.id,
          client_id: clientId,
          assignment_source: 'GLOBAL',
          current_value: 3,
        },
      });
      const peerHistory = await prisma.challengeClient.create({
        data: {
          challenge_id: peer.id,
          client_id: peerId,
          assignment_source: 'GLOBAL',
          current_value: 3,
        },
      });
      await prisma.challengeClientEligibilityPeriod.createMany({
        data: [history, peerHistory].map((row) => ({
          challenge_client_id: row.id,
          starts_on: new Date(),
          baseline_value: 3,
        })),
      });
      const recalcClient = scope === 'edited' ? clientId : peerId;
      let ready!: (pid: number) => void;
      const prepared = new Promise<number>((resolve) => {
        ready = resolve;
      });
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const recalc = prisma
        .$transaction(
          async (tx) => {
            await lockClientDayProgress(tx, recalcClient);
            const [backend] = await tx.$queryRaw<
              Array<{ pid: number }>
            >`SELECT pg_backend_pid() AS pid`;
            ready(backend.pid);
            await barrier;
            await challenges.recalculateAutomaticProgress(recalcClient, tx);
          },
          { timeout: 15000 },
        )
        .then(
          () => 'committed',
          (error: unknown) => error,
        );
      const pid = await prepared;
      const toggle = challenges
        .update(challenge.id, creatorId, Role.SUPER_ADMIN, {
          is_global: false,
        })
        .then(
          () => 'committed',
          (error: unknown) => error,
        );
      let waiting = false;
      try {
        for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
          const proof = await pool.query<{ waiting: boolean }>(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2) AS waiting',
            [pid, '%pg_advisory_xact_lock%'],
          );
          waiting = proof.rows[0].waiting;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
        }
      } finally {
        release();
      }
      const results = await Promise.all([recalc, toggle]);
      expect(waiting).toBe(true);
      expect(results).toEqual(['committed', 'committed']);
      expect(
        await prisma.challengeClient.findUnique({ where: { id: history.id } }),
      ).toEqual(history);
      expect(
        await prisma.challengeClient.findUnique({
          where: { id: peerHistory.id },
        }),
      ).toEqual(peerHistory);
      expect(
        await prisma.challengeClientEligibilityPeriod.count({
          where: { challenge_client_id: history.id, ends_on: null },
        }),
      ).toBe(0);
      expect(
        await prisma.challengeClientEligibilityPeriod.count({
          where: { challenge_client_id: peerHistory.id, ends_on: null },
        }),
      ).toBe(1);
    },
  );

  it('rolls back a GLOBAL toggle when scope expands after daily locks and succeeds on retry', async () => {
    const creatorId = `${prefix}-expand-admin`;
    const clientId = `${prefix}-expand-client`;
    const newClientId = `${prefix}-expand-new`;
    await prisma.user.createMany({
      data: [creatorId, clientId, newClientId].map((id) => ({
        id,
        firebase_uid: id,
        email: `${id}@example.test`,
        role: id === creatorId ? Role.ADMIN : Role.CLIENT,
      })),
    });
    await prisma.adminClientAssignment.create({
      data: { admin_id: creatorId, client_id: clientId },
    });
    const challenge = await prisma.challenge.create({
      data: {
        title: 'Expansion rollback',
        description: 'Owned fixture',
        type: 'MAIN_GOAL',
        target_value: 10,
        unit: 'days',
        is_global: false,
        is_manual: false,
        rule_key: 'TRAINING_DAYS',
        created_by: creatorId,
      },
    });
    const history = await prisma.challengeClient.create({
      data: {
        challenge_id: challenge.id,
        client_id: clientId,
        assignment_source: 'GLOBAL',
        current_value: 3,
      },
    });
    const period = await prisma.challengeClientEligibilityPeriod.create({
      data: {
        challenge_client_id: history.id,
        starts_on: new Date(),
        ends_on: new Date(),
        baseline_value: 3,
      },
    });
    let expanded = false;
    const observed = new Proxy(prisma, {
      get(target, property) {
        if (property !== '$transaction')
          return Reflect.get(target, property, target) as unknown;
        return <T>(
          callback: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: Parameters<PrismaClient['$transaction']>[1],
        ) =>
          target.$transaction(async (tx) => {
            const challengeDelegate = new Proxy(tx.challenge, {
              get(delegate, method) {
                if (method !== 'update')
                  return Reflect.get(delegate, method, delegate) as unknown;
                return async (args: Parameters<typeof delegate.update>[0]) => {
                  if (!expanded) {
                    await prisma.adminClientAssignment.create({
                      data: { admin_id: creatorId, client_id: newClientId },
                    });
                    expanded = true;
                  }
                  return delegate.update(args);
                };
              },
            });
            return callback(
              new Proxy(tx, {
                get(transaction, method) {
                  return method === 'challenge'
                    ? challengeDelegate
                    : (Reflect.get(
                        transaction,
                        method,
                        transaction,
                      ) as unknown);
                },
              }),
            );
          }, options);
      },
    });
    const challenges = new ChallengesService(
      observed as PrismaService,
      new AchievementsService(prisma as PrismaService, undefined!),
      undefined!,
    );
    const error: unknown = await challenges
      .update(challenge.id, creatorId, Role.ADMIN, { is_global: true })
      .catch((failure: unknown) => failure);
    expect(expanded).toBe(true);
    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getStatus()).toBe(409);
    expect(
      await prisma.challenge.findUnique({ where: { id: challenge.id } }),
    ).toEqual(challenge);
    expect(
      await prisma.challengeClient.findUnique({ where: { id: history.id } }),
    ).toEqual(history);
    expect(
      await prisma.challengeClientEligibilityPeriod.findMany({
        where: { challenge_client_id: history.id },
      }),
    ).toEqual([period]);
    expect(
      await prisma.challengeClient.count({
        where: { challenge_id: challenge.id, client_id: newClientId },
      }),
    ).toBe(0);
    await challenges.update(challenge.id, creatorId, Role.ADMIN, {
      is_global: true,
    });
    expect(
      await prisma.challengeClient.count({
        where: {
          challenge_id: challenge.id,
          client_id: newClientId,
          assignment_source: 'GLOBAL',
        },
      }),
    ).toBe(1);
    expect(
      await prisma.challengeClient.findUnique({ where: { id: history.id } }),
    ).toEqual(history);
    expect(
      await prisma.challengeClientEligibilityPeriod.count({
        where: { challenge_client_id: history.id, ends_on: null },
      }),
    ).toBe(1);
    await expect(
      challenges.update(challenge.id, newClientId, Role.ADMIN, {
        is_global: false,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(
      (
        await prisma.challenge.findUniqueOrThrow({
          where: { id: challenge.id },
        })
      ).is_global,
    ).toBe(true);
  });

  it('does not invert scope-trigger challenge locks with a concurrent creator-role write', async () => {
    const clientId = `${prefix}-lock-client`,
      adminId = `${prefix}-lock-admin`;
    await prisma.user.createMany({
      data: [clientId, adminId].map((id) => ({
        id,
        firebase_uid: id,
        email: `${id}@example.test`,
        role: id === clientId ? Role.CLIENT : Role.ADMIN,
      })),
    });
    const scope = await prisma.adminClientAssignment.create({
      data: { admin_id: adminId, client_id: clientId },
    });
    const challenge = await prisma.challenge.create({
      data: {
        title: 'Lock order',
        description: 'Owned fixture',
        type: 'MAIN_GOAL',
        target_value: 10,
        unit: 'days',
        is_global: true,
        is_manual: false,
        rule_key: 'TRAINING_DAYS',
        created_by: adminId,
      },
    });
    const assignment = await prisma.challengeClient.create({
      data: {
        challenge_id: challenge.id,
        client_id: clientId,
        assignment_source: 'GLOBAL',
      },
    });
    await prisma.challengeClientEligibilityPeriod.create({
      data: { challenge_client_id: assignment.id, starts_on: new Date() },
    });
    const challenges = new ChallengesService(
      prisma as PrismaService,
      undefined!,
      undefined!,
    );
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: (pid: number) => void;
    const prepared = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const scopeWrite = prisma.$transaction(
      async (tx) => {
        const [backend] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        await tx.adminClientAssignment.update({
          where: { id: scope.id },
          data: { is_active: false },
        });
        ready(backend.pid);
        await barrier;
        await challenges.recalculateAutomaticProgress(clientId, tx, [
          challenge.id,
        ]);
      },
      { timeout: 10000 },
    );
    const scopeResult = scopeWrite.then(
      () => 'committed',
      (error: unknown) => error,
    );
    const pid = await prepared;
    const roleWrite = prisma.user.update({
      where: { id: adminId },
      data: { role: Role.CLIENT },
    });
    const roleResult = roleWrite.then(
      () => 'committed',
      (error: unknown) => error,
    );
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const proof = await pool.query<{ waiting: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
          [pid],
        );
        waiting = proof.rows[0].waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      release();
    }
    expect(waiting).toBe(true);
    expect(await scopeResult).toBe('committed');
    expect(await roleResult).toBe('committed');
    expect(await challenges.findMyChallenges(clientId)).toEqual([]);
    expect(
      await prisma.challengeClientEligibilityPeriod.count({
        where: { challenge_client_id: assignment.id, ends_on: null },
      }),
    ).toBe(0);
  });

  it('does not reopen GLOBAL eligibility from a scope snapshot preceding creator-role revocation', async () => {
    const clientId = `${prefix}-stale-client`,
      adminId = `${prefix}-stale-admin`;
    await prisma.user.createMany({
      data: [clientId, adminId].map((id) => ({
        id,
        firebase_uid: id,
        email: `${id}@example.test`,
        role: id === clientId ? Role.CLIENT : Role.ADMIN,
      })),
    });
    await prisma.adminClientAssignment.create({
      data: { admin_id: adminId, client_id: clientId },
    });
    const challenge = await prisma.challenge.create({
      data: {
        title: 'Stale scope',
        description: 'Owned fixture',
        type: 'MAIN_GOAL',
        target_value: 10,
        unit: 'days',
        is_global: true,
        is_manual: false,
        rule_key: 'TRAINING_DAYS',
        created_by: adminId,
      },
    });
    const assignment = await prisma.challengeClient.create({
      data: {
        challenge_id: challenge.id,
        client_id: clientId,
        assignment_source: 'GLOBAL',
      },
    });
    const db = prisma as PrismaService;
    const notifications = new Proxy(new NotificationsService(db), {
      get: () => () => {
        throw new Error('External dependency forbidden');
      },
    });
    const challenges = new ChallengesService(
      db,
      new AchievementsService(db, notifications),
      notifications,
    );
    let revoked = false;
    await prisma.$transaction(async (tx) => {
      const assignments = new Proxy(tx.challengeClient, {
        get: (target, property, receiver) =>
          property === 'findUnique'
            ? async (args: Parameters<typeof target.findUnique>[0]) => {
                const snapshot = await target.findUnique(args);
                await prisma.user.update({
                  where: { id: adminId },
                  data: { role: Role.CLIENT },
                });
                revoked = true;
                return snapshot;
              }
            : (Reflect.get(target, property, receiver) as unknown),
      });
      const observed = new Proxy(tx, {
        get: (target, property, receiver) =>
          property === 'challengeClient'
            ? assignments
            : (Reflect.get(target, property, receiver) as unknown),
      });
      await challenges.syncGlobalChallengesForCreatorClient(
        adminId,
        clientId,
        observed,
      );
    });
    expect(revoked).toBe(true);
    expect(
      await prisma.challengeClientEligibilityPeriod.count({
        where: { challenge_client_id: assignment.id, ends_on: null },
      }),
    ).toBe(0);
    expect(await challenges.findMyChallenges(clientId)).toEqual([]);
  });

  it('applies opposite states and a delayed replay according to last committed write', async () => {
    await service.setClientArchived(ids[3], Role.SUPER_ADMIN, ids[0], true);
    await service.setClientArchived(ids[1], Role.ADMIN, ids[0], false);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: ids[0] } }))
        .is_archived,
    ).toBe(false);
    // Explicit F005 policy: this reversible attribute follows commit order.
    // No automatic mutation retry sends an old intent behind a newer action.
    await service.setClientArchived(ids[3], Role.SUPER_ADMIN, ids[0], true);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: ids[0] } }))
        .is_archived,
    ).toBe(true);
  });
});

import { randomUUID } from 'node:crypto';
import { ClientFollowUpTasksService } from '../client-followup-tasks/client-followup-tasks.service';
import { ClientFollowUpTaskType } from '@prisma/client';
import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChallengesService } from '../challenges/challenges.service';
import { NotificationsService } from '../notifications/notifications.service';
import { IdentityService } from '../identity/identity.service';
import { IdentityProvider } from '../identity/identity-provider';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from './users.service';
import { AdminClientsQueryDto } from './dto/admin-clients-query.dto';

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
    await prisma?.user.deleteMany({ where: { id: { in: ids } } });
    await prisma?.$disconnect();
    await pool?.end();
  });
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
          createService(
            writerBarrier.instrumented,
            queue,
          ).updateClientAssignments(
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
          createService(prisma, queue).updateClientAssignments(
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
        const retry = await createService(
          prisma,
          queue,
        ).updateClientAssignments(ids[3], Role.SUPER_ADMIN, clientId, payload);
        expect(retry.active_admins.map((admin) => admin.id).sort()).toEqual(
          [...payload.admin_ids].sort(),
        );
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
    },
  );

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

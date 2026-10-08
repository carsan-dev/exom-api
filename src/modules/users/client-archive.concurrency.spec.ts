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

  function createService(database: PrismaClient) {
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
      get: () => denyExternal,
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

import { assertTestDatabase } from '../../../scripts/test-database.cjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '@prisma/client';
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
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, application_name: prefix });
    await assertTestDatabase(pool);
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    service = new UsersService(
      prisma as PrismaService,
      undefined!,
      undefined!,
      undefined!,
      undefined!,
    );
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

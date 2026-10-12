import type { NotificationsService } from '../notifications/notifications.service';
import { Prisma, RecapStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecapsService } from './recaps.service';

const adminScope = {
  client: {
    is: { clientOf: { some: { admin_id: 'admin-1', is_active: true } } },
  },
};
const visibleStatuses = {
  in: [RecapStatus.SUBMITTED, RecapStatus.REVIEWED],
};

describe('RecapsService.getStats', () => {
  type CountArgs = [{ where: Prisma.WeeklyRecapWhereInput }];
  type ReviewRow = { reviewed_count: number; avg_seconds: number | null };
  let count: jest.Mock<Promise<number>, CountArgs>;
  let queryRaw: jest.Mock<Promise<ReviewRow[]>, [Prisma.Sql]>;
  let service: RecapsService;

  beforeEach(() => {
    count = jest.fn<Promise<number>, CountArgs>().mockResolvedValue(0);
    queryRaw = jest
      .fn<Promise<ReviewRow[]>, [Prisma.Sql]>()
      .mockResolvedValue([{ reviewed_count: 0, avg_seconds: null }]);
    service = new RecapsService(
      {
        weeklyRecap: { count },
        $queryRaw: queryRaw,
      } as unknown as PrismaService,
      {} as NotificationsService,
    );
  });

  function rawSql(): Prisma.Sql {
    return queryRaw.mock.calls[0][0];
  }

  it('keeps the no-params counts identical and adds review fields', async () => {
    count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(2);
    queryRaw.mockResolvedValue([{ reviewed_count: 6, avg_seconds: 3600.5 }]);

    await expect(service.getStats('admin-1', Role.ADMIN)).resolves.toEqual({
      total: 10,
      submitted: 4,
      reviewed: 6,
      archived: 2,
      avg_review_seconds: 3600.5,
      reviewed_in_period: 6,
    });
    const base = { ...adminScope, status: visibleStatuses };
    expect(count.mock.calls).toEqual([
      [{ where: base }],
      [{ where: { ...base, status: RecapStatus.SUBMITTED } }],
      [{ where: { ...base, status: RecapStatus.REVIEWED } }],
      [{ where: { ...base, archived_at: { not: null } } }],
    ]);
    const sql = rawSql();
    expect(sql.sql).toContain('r.reviewed_at - r.submitted_at');
    expect(sql.sql).toContain('r.reviewed_at >= r.submitted_at');
    expect(sql.sql).not.toContain('::timestamp');
    expect(sql.values).toEqual(['admin-1']);
  });

  it('filters counts by submission date with an inclusive to and the review aggregate by review date', async () => {
    await service.getStats('admin-1', Role.ADMIN, {
      from: '2026-10-01',
      to: '2026-10-31',
      client_id: 'client-1',
    });

    const submitted_at = {
      gte: new Date('2026-10-01T00:00:00.000Z'),
      lt: new Date('2026-11-01T00:00:00.000Z'),
    };
    expect(count.mock.calls[0][0]).toEqual({
      where: {
        ...adminScope,
        status: visibleStatuses,
        client_id: 'client-1',
        submitted_at,
      },
    });
    const sql = rawSql();
    expect(sql.sql).toContain('r.client_id = ?');
    expect(sql.sql).toContain('r.reviewed_at >= ?::timestamp');
    expect(sql.sql).toContain('r.reviewed_at < ?::timestamp');
    expect(sql.values).toEqual([
      'admin-1',
      'client-1',
      '2026-10-01T00:00:00.000',
      '2026-11-01T00:00:00.000',
    ]);
  });

  it('returns null average when no reviewed recap matches', async () => {
    await expect(
      service.getStats('admin-1', Role.ADMIN, { from: '2026-10-01' }),
    ).resolves.toMatchObject({
      avg_review_seconds: null,
      reviewed_in_period: 0,
    });
  });

  it("scopes the aggregate to the admin's active assignments so another admin's client yields nothing", async () => {
    await service.getStats('admin-1', Role.ADMIN, { client_id: 'foreign' });

    expect(count.mock.calls[0][0].where).toMatchObject({
      ...adminScope,
      client_id: 'foreign',
    });
    const sql = rawSql();
    expect(sql.sql).toContain('FROM admin_client_assignments a');
    expect(sql.sql).toContain('a.admin_id = ?');
    expect(sql.sql).toContain('a.is_active = true');
  });

  it('scopes super admins to client users and denies other roles', async () => {
    await service.getStats('root', Role.SUPER_ADMIN);
    expect(rawSql().sql).toContain(`u.role = 'CLIENT'::"Role"`);
    expect(count.mock.calls[0][0].where.client).toEqual({
      is: { role: Role.CLIENT },
    });

    queryRaw.mockClear();
    await service.getStats('someone', Role.CLIENT);
    expect(rawSql().sql).toContain('AND FALSE');
  });
});

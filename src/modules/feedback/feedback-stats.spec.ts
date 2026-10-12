import { FeedbackStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { UploadsService } from '../uploads/uploads.service';
import { FeedbackService } from './feedback.service';

type CountArgs = [{ where: Prisma.FeedbackMediaWhereInput }];
type ReviewRow = { reviewed_count: number; avg_seconds: number | null };

const adminScope = {
  client: {
    is: { clientOf: { some: { admin_id: 'admin-1', is_active: true } } },
  },
};

describe('FeedbackService.getStats', () => {
  let count: jest.Mock<Promise<number>, CountArgs>;
  let queryRaw: jest.Mock<Promise<ReviewRow[]>, [Prisma.Sql]>;
  let service: FeedbackService;

  beforeEach(() => {
    count = jest.fn<Promise<number>, CountArgs>().mockResolvedValue(0);
    queryRaw = jest
      .fn<Promise<ReviewRow[]>, [Prisma.Sql]>()
      .mockResolvedValue([{ reviewed_count: 0, avg_seconds: null }]);
    service = new FeedbackService(
      {
        feedbackMedia: { count },
        $queryRaw: queryRaw,
      } as unknown as PrismaService,
      {} as NotificationsService,
      {} as UploadsService,
    );
  });

  const rawSql = () => queryRaw.mock.calls[0][0];

  it('keeps the no-params counts identical and adds review fields', async () => {
    count
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5);
    queryRaw.mockResolvedValue([{ reviewed_count: 5, avg_seconds: 120 }]);

    await expect(service.getStats('admin-1', Role.ADMIN)).resolves.toEqual({
      total: 9,
      pending: 4,
      reviewed: 5,
      avg_review_seconds: 120,
      reviewed_in_period: 5,
    });
    expect(count.mock.calls).toEqual([
      [{ where: adminScope }],
      [{ where: { ...adminScope, status: FeedbackStatus.PENDING } }],
      [{ where: { ...adminScope, status: FeedbackStatus.REVIEWED } }],
    ]);
    expect(rawSql().sql).toContain('f.reviewed_at - f.created_at');
    expect(rawSql().sql).toContain('f.reviewed_at >= f.created_at');
    expect(rawSql().values).toEqual(['admin-1']);
  });

  it('filters counts by creation date (inclusive to) and the average by review date', async () => {
    await service.getStats('admin-1', Role.ADMIN, {
      from: '2026-10-05',
      to: '2026-10-05',
      client_id: 'client-1',
    });

    expect(count.mock.calls[0][0]).toEqual({
      where: {
        ...adminScope,
        client_id: 'client-1',
        created_at: {
          gte: new Date('2026-10-05T00:00:00.000Z'),
          lt: new Date('2026-10-06T00:00:00.000Z'),
        },
      },
    });
    expect(rawSql().sql).toContain('f.reviewed_at >= ?::timestamp');
    expect(rawSql().sql).toContain('f.reviewed_at < ?::timestamp');
    expect(rawSql().values).toEqual([
      'admin-1',
      'client-1',
      '2026-10-05T00:00:00.000',
      '2026-10-06T00:00:00.000',
    ]);
  });

  it('returns null average when nothing was reviewed', async () => {
    await expect(
      service.getStats('admin-1', Role.ADMIN, { to: '2026-01-01' }),
    ).resolves.toMatchObject({
      avg_review_seconds: null,
      reviewed_in_period: 0,
    });
  });

  it("keeps the admin assignment scope when filtering by another admin's client", async () => {
    await service.getStats('admin-1', Role.ADMIN, { client_id: 'foreign' });
    expect(count.mock.calls[0][0].where).toMatchObject({
      ...adminScope,
      client_id: 'foreign',
    });
    expect(rawSql().sql).toContain('FROM admin_client_assignments a');
    expect(rawSql().sql).toContain('a.is_active = true');

    queryRaw.mockClear();
    await service.getStats('client-x', Role.CLIENT);
    expect(rawSql().sql).toContain('AND FALSE');
  });
});

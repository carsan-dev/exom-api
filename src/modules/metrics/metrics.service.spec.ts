import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;
  let prisma: {
    bodyMetric: {
      findMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      bodyMetric: {
        findMany: jest.fn(),
      },
    };

    service = new MetricsService(prisma as unknown as PrismaService);
  });

  it('deduplicates weight history by day keeping the latest value', async () => {
    prisma.bodyMetric.findMany.mockResolvedValue([
      {
        date: new Date('2026-03-20T00:00:00.000Z'),
        weight_kg: 80.1,
        created_at: new Date('2026-03-20T08:00:00.000Z'),
      },
      {
        date: new Date('2026-03-20T00:00:00.000Z'),
        weight_kg: 80.4,
        created_at: new Date('2026-03-20T10:00:00.000Z'),
      },
      {
        date: new Date('2026-03-21T00:00:00.000Z'),
        weight_kg: 79.9,
        created_at: new Date('2026-03-21T09:00:00.000Z'),
      },
    ]);

    await expect(service.getWeightHistory('client-1')).resolves.toEqual([
      { date: '2026-03-20', weight_kg: 80.4 },
      { date: '2026-03-21', weight_kg: 79.9 },
    ]);

    expect(prisma.bodyMetric.findMany).toHaveBeenCalledWith({
      where: {
        client_id: 'client-1',
        weight_kg: { not: null },
      },
      orderBy: [{ date: 'asc' }, { created_at: 'asc' }],
      select: { date: true, weight_kg: true, created_at: true },
    });
  });
});

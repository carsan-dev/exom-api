import { PrismaService } from '../../prisma/prisma.service';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;
  let prisma: {
    bodyMetric: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      bodyMetric: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
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

  it('requests the latest metric using date and creation time', async () => {
    prisma.bodyMetric.findFirst.mockResolvedValue({ id: 'metric-2' });

    await expect(service.findLatest('client-1')).resolves.toEqual({
      id: 'metric-2',
    });

    expect(prisma.bodyMetric.findFirst).toHaveBeenCalledWith({
      where: { client_id: 'client-1' },
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
    });
  });

  it('creates metrics using the provided date when present', async () => {
    prisma.bodyMetric.create.mockResolvedValue({ id: 'metric-3' });

    await expect(
      service.create('client-1', {
        date: '2026-03-22',
        sleep_hours: 7.5,
      }),
    ).resolves.toEqual({ id: 'metric-3' });

    expect(prisma.bodyMetric.create).toHaveBeenCalledWith({
      data: {
        client_id: 'client-1',
        date: new Date(2026, 2, 22),
        sleep_hours: 7.5,
      },
    });
  });

  it('finds the latest metric for a specific date', async () => {
    prisma.bodyMetric.findFirst.mockResolvedValue({ id: 'metric-4' });

    await expect(service.findLatest('client-1', '2026-03-22')).resolves.toEqual(
      {
        id: 'metric-4',
      },
    );

    expect(prisma.bodyMetric.findFirst).toHaveBeenCalledWith({
      where: {
        client_id: 'client-1',
        date: new Date(2026, 2, 22),
      },
      orderBy: [{ created_at: 'desc' }],
    });
  });
});

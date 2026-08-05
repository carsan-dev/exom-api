import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;
  let prisma: {
    bodyMetric: {
      upsert: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
    };
    profile: {
      update: jest.Mock;
    };
  };
  let challengesService: {
    recalculateAutomaticProgress: jest.Mock;
  };
  let achievementsService: {
    evaluateAutomaticAchievementsForUser: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      bodyMetric: {
        upsert: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      profile: {
        update: jest.fn(),
      },
    };
    challengesService = {
      recalculateAutomaticProgress: jest.fn(),
    };
    achievementsService = {
      evaluateAutomaticAchievementsForUser: jest.fn(),
    };

    service = new MetricsService(
      prisma as unknown as PrismaService,
      challengesService as unknown as ChallengesService,
      achievementsService as unknown as AchievementsService,
    );
  });

  it('returns weight history ordered by day', async () => {
    prisma.bodyMetric.findMany.mockResolvedValue([
      {
        date: new Date('2026-03-20T00:00:00.000Z'),
        weight_kg: 80.4,
      },
      {
        date: new Date('2026-03-21T00:00:00.000Z'),
        weight_kg: 79.9,
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
      orderBy: { date: 'asc' },
      select: { date: true, weight_kg: true },
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

  it('creates or updates metrics for the provided date', async () => {
    prisma.bodyMetric.upsert.mockResolvedValue({ id: 'metric-3' });

    await expect(
      service.create('client-1', {
        date: '2026-03-22',
        sleep_hours: 7.5,
      }),
    ).resolves.toEqual({ id: 'metric-3' });

    expect(prisma.bodyMetric.upsert).toHaveBeenCalledWith({
      where: {
        client_id_date: {
          client_id: 'client-1',
          date: new Date(Date.UTC(2026, 2, 22)),
        },
      },
      create: {
        client_id: 'client-1',
        date: new Date(Date.UTC(2026, 2, 22)),
        sleep_hours: 7.5,
      },
      update: { sleep_hours: 7.5 },
    });
    expect(challengesService.recalculateAutomaticProgress).toHaveBeenCalledWith(
      'client-1',
    );
    expect(
      achievementsService.evaluateAutomaticAchievementsForUser,
    ).toHaveBeenCalledWith('client-1');
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
        date: new Date(Date.UTC(2026, 2, 22)),
      },
      orderBy: [{ created_at: 'desc' }],
    });
  });

  it('creates an admin metric and refreshes derived client data', async () => {
    prisma.bodyMetric.create.mockResolvedValue({ id: 'metric-admin-1' });
    prisma.bodyMetric.findFirst.mockResolvedValue({ weight_kg: 72.5 });

    await expect(
      service.createForClient('client-1', {
        date: '2026-07-10',
        weight_kg: 72.5,
        waist_cm: 80,
      }),
    ).resolves.toEqual({ id: 'metric-admin-1' });

    expect(prisma.bodyMetric.create).toHaveBeenCalledWith({
      data: {
        client_id: 'client-1',
        date: new Date(Date.UTC(2026, 6, 10)),
        weight_kg: 72.5,
        waist_cm: 80,
      },
    });
    expect(prisma.profile.update).toHaveBeenCalledWith({
      where: { user_id: 'client-1' },
      data: { current_weight: 72.5 },
    });
    expect(challengesService.recalculateAutomaticProgress).toHaveBeenCalledWith('client-1');
    expect(achievementsService.evaluateAutomaticAchievementsForUser).toHaveBeenCalledWith('client-1');
  });

  it('edits date and clears optional metric values', async () => {
    prisma.bodyMetric.findFirst
      .mockResolvedValueOnce({
        id: 'metric-admin-2',
        client_id: 'client-1',
        weight_kg: 70,
        waist_cm: 82,
      })
      .mockResolvedValueOnce({ weight_kg: 69 });
    prisma.bodyMetric.update.mockResolvedValue({ id: 'metric-admin-2', waist_cm: 81 });

    await service.updateForClient('client-1', 'metric-admin-2', {
      date: '2026-07-11',
      weight_kg: null,
      waist_cm: 81,
    });

    expect(prisma.bodyMetric.update).toHaveBeenCalledWith({
      where: { id: 'metric-admin-2' },
      data: {
        date: new Date(Date.UTC(2026, 6, 11)),
        weight_kg: null,
        waist_cm: 81,
      },
    });
    expect(prisma.profile.update).toHaveBeenCalledWith({
      where: { user_id: 'client-1' },
      data: { current_weight: 69 },
    });
  });

  it('rejects empty and future admin metrics before writing', async () => {
    await expect(
      service.createForClient('client-1', { date: '2026-07-10' }),
    ).rejects.toThrow('Introduce al menos una métrica');
    await expect(
      service.createForClient('client-1', {
        date: '2999-01-01',
        weight_kg: 70,
      }),
    ).rejects.toThrow('La fecha de la métrica no puede ser futura');

    expect(prisma.bodyMetric.create).not.toHaveBeenCalled();
  });
});

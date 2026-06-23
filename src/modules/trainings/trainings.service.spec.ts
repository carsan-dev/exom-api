import { Level } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TrainingsQueryDto } from './dto/trainings-query.dto';
import { TrainingsService } from './trainings.service';

describe('TrainingsService', () => {
  let service: TrainingsService;
  let prisma: {
    $transaction: jest.Mock;
    training: {
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    achievement: {
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn().mockResolvedValue([]),
      training: {
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      achievement: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
    };

    service = new TrainingsService(prisma as unknown as PrismaService);
  });

  it('builds prisma filters for list mode', async () => {
    const query = Object.assign(new TrainingsQueryDto(), {
      page: 1,
      limit: 20,
      type: ['HIIT'],
      level: [Level.INTERMEDIO],
      tags: ['Core'],
      duration_min: 20,
      duration_max: 40,
    });
    const expectedWhere = {
      is_active: true,
      OR: [{ types: { hasSome: ['HIIT'] } }, { type: { in: ['HIIT'] } }],
      level: { in: [Level.INTERMEDIO] },
      tags: { hasSome: ['Core'] },
      estimated_duration_min: {
        gte: 20,
        lte: 40,
      },
    };

    prisma.training.findMany.mockResolvedValue([
      {
        id: 'training-1',
        type: 'HIIT',
        types: ['HIIT'],
        accentColor: null,
        _count: { exercises: 3 },
      },
    ]);
    prisma.training.count.mockResolvedValue(1);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [
        {
          id: 'training-1',
          type: 'HIIT',
          types: ['HIIT'],
          accentColor: null,
          exercises_count: 3,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });

    expect(prisma.training.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      skip: 0,
      take: 20,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: expect.objectContaining({
        _count: { select: { exercises: true } },
      }),
    });
    expect(prisma.training.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('keeps accent-insensitive search on already filtered trainings', async () => {
    const query = Object.assign(new TrainingsQueryDto(), {
      page: 2,
      limit: 1,
      search: 'movilidad',
      type: ['FLEXIBILIDAD'],
    });

    prisma.training.findMany.mockResolvedValue([
      {
        id: 'training-1',
        name: 'Movilidad articular',
        type: 'FLEXIBILIDAD',
        types: ['FLEXIBILIDAD'],
        accentColor: null,
        _count: { exercises: 2 },
      },
      {
        id: 'training-2',
        name: 'Movilidad de hombro',
        type: 'FLEXIBILIDAD',
        types: ['FLEXIBILIDAD'],
        accentColor: null,
        _count: { exercises: 4 },
      },
      {
        id: 'training-3',
        name: 'Cardio expres',
        type: 'CARDIO',
        types: ['CARDIO'],
        accentColor: null,
        _count: { exercises: 1 },
      },
    ]);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [
        {
          id: 'training-2',
          name: 'Movilidad de hombro',
          type: 'FLEXIBILIDAD',
          types: ['FLEXIBILIDAD'],
          accentColor: null,
          exercises_count: 4,
        },
      ],
      total: 2,
      page: 2,
      limit: 1,
      totalPages: 2,
    });

    expect(prisma.training.findMany).toHaveBeenCalledWith({
      where: {
        is_active: true,
        OR: [
          { types: { hasSome: ['FLEXIBILIDAD'] } },
          { type: { in: ['FLEXIBILIDAD'] } },
        ],
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: expect.objectContaining({
        _count: { select: { exercises: true } },
      }),
    });
    expect(prisma.training.count).not.toHaveBeenCalled();
  });

  it('filters ungrouped trainings and rejects conflicting group filters', async () => {
    const query = Object.assign(new TrainingsQueryDto(), {
      page: 1,
      limit: 20,
      ungrouped: true,
    });
    prisma.training.findMany.mockResolvedValue([]);
    prisma.training.count.mockResolvedValue(0);

    await service.findAll(query);
    expect(prisma.training.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { is_active: true, group_id: null } }),
    );

    await expect(
      service.findAll(
        Object.assign(new TrainingsQueryDto(), {
          page: 1,
          limit: 20,
          group_id: 'group-1',
          ungrouped: true,
        }),
      ),
    ).rejects.toThrow('No se puede combinar group_id con ungrouped');
  });

  it('lists unique training types from active trainings', async () => {
    prisma.training.findMany.mockResolvedValue([
      { type: 'FUERZA', types: ['FUERZA'] },
      { type: 'Pilates', types: ['Pilates', 'Cardio'] },
      { type: 'pilates', types: [] },
      { type: 'HIIT', types: ['HIIT', 'cardio'] },
    ]);

    await expect(service.findAllTypes()).resolves.toEqual({
      types: ['Cardio', 'FUERZA', 'HIIT', 'Pilates'],
    });
  });

  it('renames training types across trainings and achievement rules', async () => {
    prisma.training.findMany.mockResolvedValue([
      { id: 'training-1', type: 'Pilates', types: ['Pilates'] },
      { id: 'training-2', type: 'HIIT', types: ['HIIT', 'Pilates'] },
      { id: 'training-3', type: 'pilates', types: [] },
    ]);
    prisma.achievement.findMany.mockResolvedValue([
      {
        id: 'achievement-1',
        rule_config: { training_type: 'PILATES' },
      },
      {
        id: 'achievement-2',
        rule_config: { training_type: 'HIIT' },
      },
      {
        id: 'achievement-3',
        rule_config: null,
      },
    ]);
    prisma.training.update.mockResolvedValue({});
    prisma.achievement.update.mockResolvedValue({});

    await expect(service.renameType('Pilates', 'Movilidad')).resolves.toEqual({
      value: 'Movilidad',
      affected_count: 4,
    });

    expect(prisma.training.update).toHaveBeenCalledTimes(3);
    expect(prisma.training.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'training-1' },
      data: { type: 'Movilidad', types: ['Movilidad'] },
    });
    expect(prisma.training.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'training-2' },
      data: { types: ['HIIT', 'Movilidad'] },
    });
    expect(prisma.training.update).toHaveBeenNthCalledWith(3, {
      where: { id: 'training-3' },
      data: { type: 'Movilidad', types: ['Movilidad'] },
    });
    expect(prisma.achievement.update).toHaveBeenCalledWith({
      where: { id: 'achievement-1' },
      data: {
        rule_config: { training_type: 'Movilidad' },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(4);
  });
});

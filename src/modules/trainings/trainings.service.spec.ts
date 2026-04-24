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
      type: { in: ['HIIT'] },
      level: { in: [Level.INTERMEDIO] },
      tags: { hasSome: ['Core'] },
      estimated_duration_min: {
        gte: 20,
        lte: 40,
      },
    };

    prisma.training.findMany.mockResolvedValue([
      { id: 'training-1', exercises: [] },
    ]);
    prisma.training.count.mockResolvedValue(1);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [{ id: 'training-1', exercises: [] }],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });

    expect(prisma.training.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      skip: 0,
      take: 20,
      orderBy: { created_at: 'desc' },
      include: expect.objectContaining({
        exercises: expect.objectContaining({
          orderBy: { order: 'asc' },
        }),
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
      { id: 'training-1', name: 'Movilidad articular', exercises: [] },
      { id: 'training-2', name: 'Movilídad de hombro', exercises: [] },
      { id: 'training-3', name: 'Cardio exprés', exercises: [] },
    ]);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [{ id: 'training-2', name: 'Movilídad de hombro', exercises: [] }],
      total: 2,
      page: 2,
      limit: 1,
      totalPages: 2,
    });

    expect(prisma.training.findMany).toHaveBeenCalledWith({
      where: {
        is_active: true,
        type: { in: ['FLEXIBILIDAD'] },
      },
      orderBy: { created_at: 'desc' },
      include: expect.objectContaining({
        exercises: expect.any(Object),
      }),
    });
    expect(prisma.training.count).not.toHaveBeenCalled();
  });

  it('lists unique training types from active trainings', async () => {
    prisma.training.findMany.mockResolvedValue([
      { type: 'FUERZA' },
      { type: 'Pilates' },
      { type: 'pilates' },
      { type: 'HIIT' },
    ]);

    await expect(service.findAllTypes()).resolves.toEqual({
      types: ['FUERZA', 'HIIT', 'Pilates'],
    });
  });

  it('renames training types across trainings and achievement rules', async () => {
    prisma.training.findMany.mockResolvedValue([
      { id: 'training-1', type: 'Pilates' },
      { id: 'training-2', type: 'HIIT' },
      { id: 'training-3', type: 'pilates' },
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
      affected_count: 3,
    });

    expect(prisma.training.update).toHaveBeenCalledTimes(2);
    expect(prisma.training.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'training-1' },
      data: { type: 'Movilidad' },
    });
    expect(prisma.training.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'training-3' },
      data: { type: 'Movilidad' },
    });
    expect(prisma.achievement.update).toHaveBeenCalledWith({
      where: { id: 'achievement-1' },
      data: {
        rule_config: { training_type: 'Movilidad' },
      },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(3);
  });
});

import { Level, TrainingType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TrainingsQueryDto } from './dto/trainings-query.dto';
import { TrainingsService } from './trainings.service';

describe('TrainingsService', () => {
  let service: TrainingsService;
  let prisma: {
    training: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      training: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    service = new TrainingsService(prisma as unknown as PrismaService);
  });

  it('builds prisma filters for list mode', async () => {
    const query = Object.assign(new TrainingsQueryDto(), {
      page: 1,
      limit: 20,
      type: [TrainingType.HIIT],
      level: [Level.INTERMEDIO],
      tags: ['Core'],
      duration_min: 20,
      duration_max: 40,
    });
    const expectedWhere = {
      is_active: true,
      type: { in: [TrainingType.HIIT] },
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
      type: [TrainingType.FLEXIBILIDAD],
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
        type: { in: [TrainingType.FLEXIBILIDAD] },
      },
      orderBy: { created_at: 'desc' },
      include: expect.objectContaining({
        exercises: expect.any(Object),
      }),
    });
    expect(prisma.training.count).not.toHaveBeenCalled();
  });
});

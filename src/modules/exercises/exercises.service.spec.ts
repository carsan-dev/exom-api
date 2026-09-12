import { Prisma } from '@prisma/client';
import { Level } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ExercisesQueryDto } from './dto/exercises-query.dto';
import { ExercisesService } from './exercises.service';

describe('ExercisesService', () => {
  let service: ExercisesService;
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock<Promise<unknown>, [Prisma.Sql]>;
    exercise: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      count: jest.Mock;
    };
    trainingExercise: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
      $queryRaw: jest
        .fn<Promise<unknown>, [Prisma.Sql]>()
        .mockResolvedValue([]),
      exercise: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
      },
      trainingExercise: { findMany: jest.fn().mockResolvedValue([]) },
    };

    service = new ExercisesService(prisma as unknown as PrismaService);
  });

  it('applies prisma filters directly when search is empty', async () => {
    const query = Object.assign(new ExercisesQueryDto(), {
      page: 2,
      limit: 10,
      muscle_groups: ['Pecho'],
      equipment: ['Mancuernas'],
      level: [Level.INTERMEDIO],
    });
    const expectedWhere = {
      is_active: true,
      muscle_groups: { hasSome: ['Pecho'] },
      equipment: { hasSome: ['Mancuernas'] },
      level: { in: [Level.INTERMEDIO] },
    };

    prisma.exercise.findMany.mockResolvedValue([{ id: 'exercise-1' }]);
    prisma.exercise.count.mockResolvedValue(12);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [
        {
          id: 'exercise-1',
          training_usage_count: 0,
          is_used_in_training: false,
        },
      ],
      total: 12,
      page: 2,
      limit: 10,
      totalPages: 2,
    });

    expect(prisma.exercise.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      skip: 10,
      take: 10,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    expect(prisma.exercise.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      expect.objectContaining({ values: ['exercise-1'] }),
    );
  });

  it('hydrates only the normalized SQL search page', async () => {
    prisma.$transaction.mockImplementation(
      (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(prisma as unknown as Prisma.TransactionClient),
    );
    prisma.$queryRaw.mockResolvedValueOnce([
      { ids: ['exercise-2'], total: 2n },
    ]);
    const query = Object.assign(new ExercisesQueryDto(), {
      page: 2,
      limit: 1,
      search: 'sentadilla',
      muscle_groups: ['Pierna'],
    });

    prisma.exercise.findMany.mockResolvedValue([
      { id: 'exercise-1', name: 'Sentadilla frontal' },
      { id: 'exercise-2', name: 'Sentadílla búlgara' },
      { id: 'exercise-3', name: 'Press banca' },
    ]);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [
        {
          id: 'exercise-2',
          name: 'Sentadílla búlgara',
          training_usage_count: 0,
          is_used_in_training: false,
        },
      ],
      total: 2,
      page: 2,
      limit: 1,
      totalPages: 2,
    });

    expect(prisma.exercise.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['exercise-2'] } } }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(prisma.$queryRaw.mock.calls[0][0]).toHaveProperty(
      'values',
      expect.any(Array),
    );
    expect(prisma.exercise.count).not.toHaveBeenCalled();
  });

  it('counts distinct active trainings for current page only', async () => {
    const query = Object.assign(new ExercisesQueryDto(), {
      page: 1,
      limit: 10,
    });
    prisma.exercise.findMany.mockResolvedValue([
      { id: 'exercise-1' },
      { id: 'exercise-2' },
    ]);
    prisma.exercise.count.mockResolvedValue(2);
    prisma.$queryRaw.mockResolvedValueOnce([
      { exercise_id: 'exercise-1', count: 2n },
    ]);

    const result = await service.findAll(query);
    expect(result.data).toEqual([
      { id: 'exercise-1', training_usage_count: 2, is_used_in_training: true },
      { id: 'exercise-2', training_usage_count: 0, is_used_in_training: false },
    ]);
  });

  it('filters used exercises before paginating', async () => {
    prisma.$transaction.mockImplementation(
      (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(prisma as unknown as Prisma.TransactionClient),
    );
    prisma.$queryRaw.mockResolvedValueOnce([
      { ids: ['exercise-1'], total: 1n },
    ]);
    const query = Object.assign(new ExercisesQueryDto(), {
      page: 1,
      limit: 10,
      training_usage: 'used',
    });
    prisma.exercise.findMany.mockResolvedValue([
      { id: 'exercise-1' },
      { id: 'exercise-2' },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([
      { exercise_id: 'exercise-1', count: 1n },
    ]);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [
        {
          id: 'exercise-1',
          training_usage_count: 1,
          is_used_in_training: true,
        },
      ],
      total: 1,
      page: 1,
      limit: 10,
      totalPages: 1,
    });
    expect(prisma.exercise.count).not.toHaveBeenCalled();
  });

  it('filters unused exercises before paginating', async () => {
    prisma.$transaction.mockImplementation(
      (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(prisma as unknown as Prisma.TransactionClient),
    );
    prisma.$queryRaw.mockResolvedValueOnce([
      { ids: ['exercise-2'], total: 1n },
    ]);
    const query = Object.assign(new ExercisesQueryDto(), {
      page: 1,
      limit: 10,
      training_usage: 'unused',
    });
    prisma.exercise.findMany.mockResolvedValue([
      { id: 'exercise-1' },
      { id: 'exercise-2' },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([
      { exercise_id: 'exercise-1', count: 1n },
    ]);

    const result = await service.findAll(query);
    expect(result.data).toEqual([
      {
        id: 'exercise-2',
        training_usage_count: 0,
        is_used_in_training: false,
      },
    ]);
    expect(result.total).toBe(1);
  });

  it('sorts by training usage count before paginating', async () => {
    prisma.$transaction.mockImplementation(
      (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(prisma as unknown as Prisma.TransactionClient),
    );
    prisma.$queryRaw.mockResolvedValueOnce([
      { ids: ['exercise-3', 'exercise-1'], total: 3n },
    ]);
    const query = Object.assign(new ExercisesQueryDto(), {
      page: 1,
      limit: 2,
      sort_by: 'training_usage_count',
      sort_dir: 'desc',
    });
    prisma.exercise.findMany.mockResolvedValue([
      { id: 'exercise-1' },
      { id: 'exercise-2' },
      { id: 'exercise-3' },
    ]);
    prisma.$queryRaw.mockResolvedValueOnce([
      { exercise_id: 'exercise-1', count: 1n },
      { exercise_id: 'exercise-3', count: 2n },
    ]);

    const result = await service.findAll(query);
    expect(result.data.map((exercise) => exercise.id)).toEqual([
      'exercise-3',
      'exercise-1',
    ]);
    expect(result.total).toBe(3);
  });

  it('returns sorted unique active training usage detail', async () => {
    prisma.exercise.findFirst.mockResolvedValue({ id: 'exercise-1' });
    prisma.trainingExercise.findMany.mockResolvedValue([
      { training: { id: 'training-2', name: 'Zancadas' } },
      { training: { id: 'training-1', name: 'Ángeles' } },
    ]);

    await expect(service.getTrainingUsage('exercise-1')).resolves.toEqual({
      exercise_id: 'exercise-1',
      training_count: 2,
      trainings: [
        { id: 'training-1', name: 'Ángeles' },
        { id: 'training-2', name: 'Zancadas' },
      ],
    });
    expect(prisma.trainingExercise.findMany).toHaveBeenCalledWith({
      where: { exercise_id: 'exercise-1', training: { is_active: true } },
      select: { training: { select: { id: true, name: true } } },
      distinct: ['training_id'],
    });
  });
});

import { Level } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ExercisesQueryDto } from './dto/exercises-query.dto';
import { ExercisesService } from './exercises.service';

describe('ExercisesService', () => {
  let service: ExercisesService;
  let prisma: {
    exercise: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      exercise: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
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
      data: [{ id: 'exercise-1' }],
      total: 12,
      page: 2,
      limit: 10,
      totalPages: 2,
    });

    expect(prisma.exercise.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      skip: 10,
      take: 10,
      orderBy: { created_at: 'desc' },
    });
    expect(prisma.exercise.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('normalizes search after applying prisma filters and paginates in memory', async () => {
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
      data: [{ id: 'exercise-2', name: 'Sentadílla búlgara' }],
      total: 2,
      page: 2,
      limit: 1,
      totalPages: 2,
    });

    expect(prisma.exercise.findMany).toHaveBeenCalledWith({
      where: {
        is_active: true,
        muscle_groups: { hasSome: ['Pierna'] },
      },
      orderBy: { created_at: 'desc' },
    });
    expect(prisma.exercise.count).not.toHaveBeenCalled();
  });
});

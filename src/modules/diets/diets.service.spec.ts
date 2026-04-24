import { MealType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DietsQueryDto } from './dto/diets-query.dto';
import { DietsService } from './diets.service';

describe('DietsService', () => {
  let service: DietsService;
  let prisma: {
    diet: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      diet: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    service = new DietsService(prisma as unknown as PrismaService);
  });

  it('filters diets by nested meal data and updated date range', async () => {
    const query = Object.assign(new DietsQueryDto(), {
      page: 1,
      limit: 10,
      meal_types: [MealType.BREAKFAST],
      nutritional_badges: ['Alto en proteína'],
      updated_from: '2026-01-01',
      updated_to: '2026-01-31',
    });
    const expectedWhere = {
      is_active: true,
      meals: {
        some: {
          type: { in: [MealType.BREAKFAST] },
          nutritional_badges: {
            hasSome: ['Alto en proteína'],
          },
        },
      },
      updated_at: {
        gte: new Date('2026-01-01T00:00:00.000Z'),
        lte: new Date('2026-01-31T23:59:59.999Z'),
      },
    };

    prisma.diet.findMany.mockResolvedValue([{ id: 'diet-1', meals: [] }]);
    prisma.diet.count.mockResolvedValue(1);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [{ id: 'diet-1', meals: [] }],
      total: 1,
      page: 1,
      limit: 10,
      totalPages: 1,
    });

    expect(prisma.diet.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      skip: 0,
      take: 10,
      orderBy: { created_at: 'desc' },
      include: expect.objectContaining({
        meals: expect.objectContaining({
          orderBy: { order: 'asc' },
        }),
      }),
    });
    expect(prisma.diet.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('keeps accent-insensitive search on filtered diet subset', async () => {
    const query = Object.assign(new DietsQueryDto(), {
      page: 1,
      limit: 10,
      search: 'proteica',
      meal_types: [MealType.DINNER],
    });

    prisma.diet.findMany.mockResolvedValue([
      { id: 'diet-1', name: 'Dieta protéica', meals: [] },
      { id: 'diet-2', name: 'Plan proteíca avanzado', meals: [] },
      { id: 'diet-3', name: 'Menú vegetal', meals: [] },
    ]);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [
        { id: 'diet-1', name: 'Dieta protéica', meals: [] },
        { id: 'diet-2', name: 'Plan proteíca avanzado', meals: [] },
      ],
      total: 2,
      page: 1,
      limit: 10,
      totalPages: 1,
    });

    expect(prisma.diet.findMany).toHaveBeenCalledWith({
      where: {
        is_active: true,
        meals: {
          some: {
            type: { in: [MealType.DINNER] },
          },
        },
      },
      orderBy: { created_at: 'desc' },
      include: expect.objectContaining({
        meals: expect.any(Object),
      }),
    });
    expect(prisma.diet.count).not.toHaveBeenCalled();
  });
});

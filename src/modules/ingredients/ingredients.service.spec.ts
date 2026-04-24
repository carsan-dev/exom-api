import { PrismaService } from '../../prisma/prisma.service';
import { IngredientsQueryDto } from './dto/ingredients-query.dto';
import { IngredientsService } from './ingredients.service';

describe('IngredientsService', () => {
  let service: IngredientsService;
  let prisma: {
    ingredient: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      ingredient: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    service = new IngredientsService(prisma as unknown as PrismaService);
  });

  it('builds range and icon filters for ingredient list mode', async () => {
    const query = Object.assign(new IngredientsQueryDto(), {
      page: 1,
      limit: 10,
      has_icon: ['WITH_ICON'],
      calories_per_100g_min: 50,
      calories_per_100g_max: 300,
      protein_per_100g_min: 10,
      updated_from: '2026-01-01',
      updated_to: '2026-01-31',
    });
    const expectedWhere = {
      is_active: true,
      icon: {
        not: null,
      },
      calories_per_100g: {
        gte: 50,
        lte: 300,
      },
      protein_per_100g: {
        gte: 10,
      },
      updated_at: {
        gte: new Date('2026-01-01T00:00:00.000Z'),
        lte: new Date('2026-01-31T23:59:59.999Z'),
      },
    };

    prisma.ingredient.findMany.mockResolvedValue([{ id: 'ingredient-1' }]);
    prisma.ingredient.count.mockResolvedValue(1);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [{ id: 'ingredient-1' }],
      total: 1,
      page: 1,
      limit: 10,
      totalPages: 1,
    });

    expect(prisma.ingredient.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      skip: 0,
      take: 10,
      orderBy: { name: 'asc' },
    });
    expect(prisma.ingredient.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('keeps accent-insensitive search after applying ingredient filters', async () => {
    const query = Object.assign(new IngredientsQueryDto(), {
      page: 2,
      limit: 1,
      search: 'platano',
      has_icon: ['WITHOUT_ICON'],
    });

    prisma.ingredient.findMany.mockResolvedValue([
      { id: 'ingredient-1', name: 'Plátano' },
      { id: 'ingredient-2', name: 'Platáno macho' },
      { id: 'ingredient-3', name: 'Avena' },
    ]);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [{ id: 'ingredient-2', name: 'Platáno macho' }],
      total: 2,
      page: 2,
      limit: 1,
      totalPages: 2,
    });

    expect(prisma.ingredient.findMany).toHaveBeenCalledWith({
      where: {
        is_active: true,
        OR: [{ icon: null }, { icon: '' }],
      },
      orderBy: { name: 'asc' },
    });
    expect(prisma.ingredient.count).not.toHaveBeenCalled();
  });
});

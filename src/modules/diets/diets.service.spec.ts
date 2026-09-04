import { MealType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DietsQueryDto } from './dto/diets-query.dto';
import { DietsService } from './diets.service';
import type { UploadsService } from '../uploads/uploads.service';
import type { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';

describe('DietsService', () => {
  let service: DietsService;
  let prisma: {
    diet: {
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    meal: {
      findMany: jest.Mock;
      update: jest.Mock;
    };
    catalogColor: {
      findMany: jest.Mock;
      upsert: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let uploadsService: {
    referencesSame: jest.Mock;
    prepareForConsumption: jest.Mock;
  };
  let autoAssignmentMaterializer: { reconcile: jest.Mock };

  beforeEach(() => {
    prisma = {
      diet: {
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      meal: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      catalogColor: {
        findMany: jest.fn(),
        upsert: jest.fn(),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };

    uploadsService = {
      referencesSame: jest.fn(),
      prepareForConsumption: jest.fn(),
    };
    autoAssignmentMaterializer = {
      reconcile: jest.fn().mockResolvedValue(undefined),
    };

    service = new DietsService(
      prisma as unknown as PrismaService,
      uploadsService as unknown as UploadsService,
      autoAssignmentMaterializer as unknown as AutoAssignmentMaterializerService,
    );
  });

  it('deletes multiple diet tags in one transaction', async () => {
    prisma.diet.findMany.mockResolvedValue([
      { id: 'diet-1', tags: ['Mesociclo 1', 'Déficit'] },
      { id: 'diet-2', tags: ['Mesociclo 1'] },
    ]);
    prisma.diet.update.mockResolvedValue({});

    await expect(service.deleteTags(['mesociclo 1'])).resolves.toEqual({
      values: ['mesociclo 1'],
      affected_count: 2,
    });
    expect(prisma.diet.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'diet-1' },
      data: { tags: ['Déficit'] },
    });
    expect(prisma.diet.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'diet-2' },
      data: { tags: [] },
    });
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
      data: [{ id: 'diet-1', meals: [], meals_count: 0 }],
      total: 1,
      page: 1,
      limit: 10,
      totalPages: 1,
    });

    expect(prisma.diet.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      skip: 0,
      take: 10,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: expect.objectContaining({
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
        { id: 'diet-1', name: 'Dieta protéica', meals: [], meals_count: 0 },
        { id: 'diet-2', name: 'Plan proteíca avanzado', meals: [], meals_count: 0 },
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
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: expect.objectContaining({
        meals: expect.any(Object),
      }),
    });
    expect(prisma.diet.count).not.toHaveBeenCalled();
  });

  it('filters ungrouped diets and rejects conflicting group filters', async () => {
    const query = Object.assign(new DietsQueryDto(), {
      page: 1,
      limit: 10,
      ungrouped: true,
    });
    prisma.diet.findMany.mockResolvedValue([]);
    prisma.diet.count.mockResolvedValue(0);

    await service.findAll(query);
    expect(prisma.diet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { is_active: true, group_id: null } }),
    );

    await expect(
      service.findAll(
        Object.assign(new DietsQueryDto(), {
          page: 1,
          limit: 10,
          group_id: 'group-1',
          ungrouped: true,
        }),
      ),
    ).rejects.toThrow('No se puede combinar group_id con ungrouped');
  });

  it('lists nutritional badges with configured color and neutral fallback', async () => {
    prisma.meal.findMany.mockResolvedValue([
      { nutritional_badges: ['Alto en proteína', 'Bajo en grasa'] },
      { nutritional_badges: ['alto en proteína'] },
    ]);
    prisma.catalogColor.findMany.mockResolvedValue([
      { normalized_key: 'alto en proteina', color: '#22C55E' },
    ]);

    await expect(service.findAllNutritionalBadges()).resolves.toEqual({
      nutritional_badges: [
        { value: 'Alto en proteína', color: '#22C55E' },
        { value: 'Bajo en grasa', color: '#6B7280' },
      ],
    });
  });

  it('renames nutritional badges and preserves configured color row', async () => {
    prisma.meal.findMany.mockResolvedValue([
      { id: 'meal-1', nutritional_badges: ['Proteína'] },
      { id: 'meal-2', nutritional_badges: ['Fibra'] },
    ]);
    prisma.meal.update.mockResolvedValue({});
    prisma.catalogColor.upsert.mockResolvedValue({});

    await expect(service.renameNutritionalBadge('Proteína', 'Proteica')).resolves.toEqual({
      value: 'Proteica',
      affected_count: 1,
    });

    expect(prisma.catalogColor.upsert).toHaveBeenCalledWith({
      where: {
        catalog_type_normalized_key: {
          catalog_type: 'diet_nutritional_badge',
          normalized_key: 'proteina',
        },
      },
      update: {
        normalized_key: 'proteica',
        value: 'Proteica',
      },
      create: {
        catalog_type: 'diet_nutritional_badge',
        normalized_key: 'proteica',
        value: 'Proteica',
        color: '#6B7280',
      },
    });
  });

  it('updates nutritional badge color with hex validation', async () => {
    prisma.catalogColor.upsert.mockResolvedValue({
      value: 'Proteína',
      color: '#22C55E',
    });

    await expect(service.updateNutritionalBadgeColor('Proteína', '#22c55e')).resolves.toEqual({
      value: 'Proteína',
      color: '#22C55E',
    });

    await expect(service.updateNutritionalBadgeColor('Proteína', 'green')).rejects.toThrow(
      'El color del catálogo debe ser un valor hex #RRGGBB válido',
    );
  });

  it('preserves the canonical meal URL when a signed URL has the same key', async () => {
    const canonical = 'r2://meal-image/admin-1/meal.webp';
    const signed =
      'https://bucket.r2.example/meal-image/admin-1/meal.webp?X-Amz-Signature=abc';
    uploadsService.referencesSame.mockReturnValue(true);

    const prepared = await (
      service as unknown as {
        prepareMealImages(
          meals: unknown[],
          ownerId: string,
          existing: Map<string, string>,
        ): Promise<{ meals: Array<{ image_url?: string }> }>;
      }
    ).prepareMealImages(
      [
        {
          id: 'meal-1',
          type: MealType.BREAKFAST,
          name: 'Desayuno',
          image_url: signed,
          ingredients: [],
        },
      ],
      'admin-1',
      new Map([['meal-1', canonical]]),
    );

    expect(prepared.meals[0].image_url).toBe(canonical);
    expect(uploadsService.prepareForConsumption).not.toHaveBeenCalled();
  });
});

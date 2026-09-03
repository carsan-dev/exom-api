import { MealType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { UploadsService } from '../uploads/uploads.service';
import { MealsService } from './meals.service';

describe('MealsService', () => {
  it('does not persist an expiring signed URL for unchanged managed media', async () => {
    const canonical = 'r2://meal-image/admin-1/meal.webp';
    const signed =
      'https://bucket.r2.example/meal-image/admin-1/meal.webp?X-Amz-Signature=abc';
    const meal = {
      id: 'meal-1',
      diet_id: 'diet-1',
      type: MealType.BREAKFAST,
      name: 'Desayuno',
      image_url: canonical,
      ingredients: [],
      variants: [],
    };
    const prisma = {
      meal: {
        findUnique: jest.fn().mockResolvedValue(meal),
        update: jest.fn().mockResolvedValue(meal),
      },
      $transaction: jest.fn(
        async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
      ),
    };
    const uploadsService = {
      referencesSame: jest.fn().mockReturnValue(true),
      prepareForConsumption: jest.fn(),
      consumePrepared: jest.fn(),
    };
    const service = new MealsService(
      prisma as unknown as PrismaService,
      uploadsService as unknown as UploadsService,
    );

    await service.update('meal-1', { image_url: signed }, 'admin-1');

    expect(prisma.meal.update).toHaveBeenCalledWith({
      where: { id: 'meal-1' },
      data: {},
      include: expect.any(Object),
    });
    expect(uploadsService.prepareForConsumption).not.toHaveBeenCalled();
    expect(uploadsService.consumePrepared).not.toHaveBeenCalled();
  });
});

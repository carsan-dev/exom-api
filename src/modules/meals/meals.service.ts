import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateMealDto } from '../diets/dto/create-diet.dto';

const mealInclude = {
  ingredients: {
    include: {
      ingredient: true,
    },
  },
};

@Injectable()
export class MealsService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(id: string) {
    const meal = await this.prisma.meal.findUnique({
      where: { id },
      include: mealInclude,
    });

    if (!meal) {
      throw new NotFoundException('Comida no encontrada');
    }

    return meal;
  }

  async create(dietId: string, dto: CreateMealDto) {
    return this.prisma.meal.create({
      data: {
        diet_id: dietId,
        type: dto.type,
        name: dto.name,
        image_url: dto.image_url ?? null,
        calories: dto.calories ?? null,
        protein_g: dto.protein_g ?? null,
        carbs_g: dto.carbs_g ?? null,
        fat_g: dto.fat_g ?? null,
        nutritional_badges: dto.nutritional_badges ?? [],
        order: dto.order ?? 0,
        ingredients: {
          create: dto.ingredients.map((ing) => ({
            ingredient_id: ing.ingredient_id,
            quantity: ing.quantity,
            unit: ing.unit,
          })),
        },
      },
      include: mealInclude,
    });
  }

  async update(id: string, dto: Partial<CreateMealDto>) {
    await this.findOne(id);

    return this.prisma.meal.update({
      where: { id },
      data: {
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.image_url !== undefined && { image_url: dto.image_url }),
        ...(dto.calories !== undefined && { calories: dto.calories }),
        ...(dto.protein_g !== undefined && { protein_g: dto.protein_g }),
        ...(dto.carbs_g !== undefined && { carbs_g: dto.carbs_g }),
        ...(dto.fat_g !== undefined && { fat_g: dto.fat_g }),
        ...(dto.nutritional_badges !== undefined && {
          nutritional_badges: dto.nutritional_badges,
        }),
        ...(dto.order !== undefined && { order: dto.order }),
      },
      include: mealInclude,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.meal.delete({ where: { id } });
  }
}

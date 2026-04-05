import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateDietDto, UpdateDietDto } from './dto/create-diet.dto';

const dietInclude = {
  meals: {
    orderBy: { order: 'asc' as const },
    include: {
      ingredients: {
        include: {
          ingredient: true,
        },
      },
    },
  },
};

@Injectable()
export class DietsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.diet.findMany({
        where: { is_active: true },
        skip: pagination.skip,
        take: pagination.limit,
        orderBy: { created_at: 'desc' },
        include: dietInclude,
      }),
      this.prisma.diet.count({ where: { is_active: true } }),
    ]);

    return paginate(data, total, pagination);
  }

  async findToday(clientId: string, date?: Date) {
    const now = date ?? new Date();
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const assignment = await this.prisma.planAssignment.findUnique({
      where: { client_id_date: { client_id: clientId, date: target } },
      include: {
        diet: {
          include: dietInclude,
        },
      },
    });

    if (!assignment || !assignment.diet) {
      return null;
    }

    return assignment.diet;
  }

  async findOne(id: string) {
    const diet = await this.prisma.diet.findFirst({
      where: { id, is_active: true },
      include: dietInclude,
    });

    if (!diet) {
      throw new NotFoundException('Dieta no encontrada');
    }

    return diet;
  }

  async create(adminId: string, dto: CreateDietDto) {
    return this.prisma.$transaction(async (tx) => {
      const diet = await tx.diet.create({
        data: {
          name: dto.name,
          total_calories: dto.total_calories ?? null,
          total_protein_g: dto.total_protein_g ?? null,
          total_carbs_g: dto.total_carbs_g ?? null,
          total_fat_g: dto.total_fat_g ?? null,
          created_by: adminId,
          meals: {
            create: dto.meals.map((meal) => ({
              type: meal.type,
              name: meal.name,
              image_url: meal.image_url ?? null,
              calories: meal.calories ?? null,
              protein_g: meal.protein_g ?? null,
              carbs_g: meal.carbs_g ?? null,
              fat_g: meal.fat_g ?? null,
              nutritional_badges: meal.nutritional_badges ?? [],
              order: meal.order ?? 0,
              ingredients: {
                create: meal.ingredients.map((ing) => ({
                  ingredient_id: ing.ingredient_id,
                  quantity: ing.quantity,
                  unit: ing.unit,
                })),
              },
            })),
          },
        },
        include: dietInclude,
      });

      return diet;
    });
  }

  async update(id: string, dto: UpdateDietDto) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      if (dto.meals !== undefined) {
        const existingMeals = await tx.meal.findMany({
          where: { diet_id: id },
          select: { id: true },
        });
        const mealIds = existingMeals.map((m) => m.id);

        await tx.mealIngredient.deleteMany({ where: { meal_id: { in: mealIds } } });
        await tx.meal.deleteMany({ where: { diet_id: id } });
      }

      return tx.diet.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.total_calories !== undefined && { total_calories: dto.total_calories }),
          ...(dto.total_protein_g !== undefined && { total_protein_g: dto.total_protein_g }),
          ...(dto.total_carbs_g !== undefined && { total_carbs_g: dto.total_carbs_g }),
          ...(dto.total_fat_g !== undefined && { total_fat_g: dto.total_fat_g }),
          ...(dto.meals !== undefined && {
            meals: {
              create: dto.meals.map((meal) => ({
                type: meal.type,
                name: meal.name,
                image_url: meal.image_url ?? null,
                calories: meal.calories ?? null,
                protein_g: meal.protein_g ?? null,
                carbs_g: meal.carbs_g ?? null,
                fat_g: meal.fat_g ?? null,
                nutritional_badges: meal.nutritional_badges ?? [],
                order: meal.order ?? 0,
                ingredients: {
                  create: meal.ingredients.map((ing) => ({
                    ingredient_id: ing.ingredient_id,
                    quantity: ing.quantity,
                    unit: ing.unit,
                  })),
                },
              })),
            },
          }),
        },
        include: dietInclude,
      });
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    await this.prisma.diet.update({
      where: { id },
      data: { is_active: false },
    });
  }
}

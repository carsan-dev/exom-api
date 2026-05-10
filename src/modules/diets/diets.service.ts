import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import {
  CreateDietDto,
  CreateMealDto,
  CreateMealVariantDto,
  UpdateDietDto,
} from './dto/create-diet.dto';
import { DietsQueryDto } from './dto/diets-query.dto';

const mealInclude = {
  ingredients: {
    include: {
      ingredient: true,
    },
  },
  variants: {
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

const dietInclude = {
  meals: {
    where: { parent_meal_id: null },
    orderBy: { order: 'asc' as const },
    include: mealInclude,
  },
};

function normalizeSearchText(value: string) {
  return value
    .toLocaleLowerCase('es-ES')
    .normalize('NFD')
    .replace(/([aeiou])([\u0300-\u036f]+)/g, '$1')
    .normalize('NFC');
}

function getDateRange(
  from?: string,
  to?: string,
): Prisma.DateTimeFilter | undefined {
  if (!from && !to) {
    return undefined;
  }

  const range: Prisma.DateTimeFilter = {};

  if (from) {
    range.gte = new Date(`${from}T00:00:00.000Z`);
  }

  if (to) {
    range.lte = new Date(`${to}T23:59:59.999Z`);
  }

  return range;
}

@Injectable()
export class DietsService {
  constructor(private readonly prisma: PrismaService) {}

  private collectUnique(values: string[][]): string[] {
    const unique = new Map<string, string>();

    for (const list of values) {
      for (const raw of list) {
        const normalized = this.normalizeCatalogValue(raw);

        if (!normalized) {
          continue;
        }

        const key = this.getCatalogKey(normalized);

        if (!unique.has(key)) {
          unique.set(key, normalized);
        }
      }
    }

    return Array.from(unique.values()).sort((left, right) =>
      left.localeCompare(right, 'es', { sensitivity: 'base' }),
    );
  }

  private normalizeCatalogValue(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
  }

  private getCatalogKey(value: string): string {
    return this.normalizeCatalogValue(value)
      .toLocaleLowerCase('es-ES')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .normalize('NFC');
  }

  private normalizeCatalogValues(values: string[]): string[] {
    const unique = new Map<string, string>();

    for (const value of values) {
      const normalizedValue = this.normalizeCatalogValue(value);

      if (!normalizedValue) {
        continue;
      }

      const key = this.getCatalogKey(normalizedValue);

      if (!unique.has(key)) {
        unique.set(key, normalizedValue);
      }
    }

    return Array.from(unique.values());
  }

  private replaceCatalogValue(
    values: string[],
    from: string,
    to: string,
  ): string[] {
    const fromKey = this.getCatalogKey(from);
    const normalizedTo = this.normalizeCatalogValue(to);
    const unique = new Map<string, string>();

    for (const value of values) {
      const normalizedValue = this.normalizeCatalogValue(value);

      if (!normalizedValue) {
        continue;
      }

      const nextValue =
        this.getCatalogKey(normalizedValue) === fromKey
          ? normalizedTo
          : normalizedValue;
      const nextKey = this.getCatalogKey(nextValue);

      if (!unique.has(nextKey)) {
        unique.set(nextKey, nextValue);
      }
    }

    return Array.from(unique.values());
  }

  private removeCatalogValue(
    values: string[],
    valueToRemove: string,
  ): string[] {
    const valueToRemoveKey = this.getCatalogKey(valueToRemove);
    const unique = new Map<string, string>();

    for (const value of values) {
      const normalizedValue = this.normalizeCatalogValue(value);

      if (
        !normalizedValue ||
        this.getCatalogKey(normalizedValue) === valueToRemoveKey
      ) {
        continue;
      }

      const key = this.getCatalogKey(normalizedValue);

      if (!unique.has(key)) {
        unique.set(key, normalizedValue);
      }
    }

    return Array.from(unique.values());
  }

  private hasCatalogChanged(
    currentValues: string[],
    nextValues: string[],
  ): boolean {
    return (
      currentValues.length !== nextValues.length ||
      currentValues.some((value, index) => value !== nextValues[index])
    );
  }

  private async mutateNutritionalBadges(
    value: string,
    mutateValues: (values: string[]) => string[],
  ) {
    const normalizedValue = this.normalizeCatalogValue(value);

    if (!normalizedValue) {
      throw new BadRequestException(
        'El valor del catálogo no puede estar vacío',
      );
    }

    const meals = await this.prisma.meal.findMany({
      where: { diet: { is_active: true } },
      select: { id: true, nutritional_badges: true },
    });

    const updates = meals.flatMap((meal) => {
      const nextBadges = mutateValues(meal.nutritional_badges);

      if (!this.hasCatalogChanged(meal.nutritional_badges, nextBadges)) {
        return [];
      }

      return this.prisma.meal.update({
        where: { id: meal.id },
        data: { nutritional_badges: nextBadges },
      });
    });

    if (updates.length > 0) {
      await this.prisma.$transaction(updates);
    }

    return {
      value: normalizedValue,
      affected_count: updates.length,
    };
  }

  private async mutateTags(
    value: string,
    mutateValues: (values: string[]) => string[],
  ) {
    const normalizedValue = this.normalizeCatalogValue(value);

    if (!normalizedValue) {
      throw new BadRequestException(
        'El valor del catálogo no puede estar vacío',
      );
    }

    const diets = await this.prisma.diet.findMany({
      where: { is_active: true },
      select: { id: true, tags: true },
    });

    const updates = diets.flatMap((diet) => {
      const nextTags = mutateValues(diet.tags);

      if (!this.hasCatalogChanged(diet.tags, nextTags)) {
        return [];
      }

      return this.prisma.diet.update({
        where: { id: diet.id },
        data: { tags: nextTags },
      });
    });

    if (updates.length > 0) {
      await this.prisma.$transaction(updates);
    }

    return {
      value: normalizedValue,
      affected_count: updates.length,
    };
  }

  async findAllNutritionalBadges() {
    const meals = await this.prisma.meal.findMany({
      where: { diet: { is_active: true } },
      select: { nutritional_badges: true },
    });

    return {
      nutritional_badges: this.collectUnique(
        meals.map((meal) => meal.nutritional_badges),
      ),
    };
  }

  async findAllTags() {
    const diets = await this.prisma.diet.findMany({
      where: { is_active: true },
      select: { tags: true },
    });

    return {
      tags: this.collectUnique(diets.map((diet) => diet.tags)),
    };
  }

  renameTag(from: string, to: string) {
    const normalizedFrom = this.normalizeCatalogValue(from);
    const normalizedTo = this.normalizeCatalogValue(to);

    if (!normalizedFrom || !normalizedTo) {
      throw new BadRequestException(
        'Los valores del catálogo no pueden estar vacíos',
      );
    }

    if (
      this.getCatalogKey(normalizedFrom) === this.getCatalogKey(normalizedTo)
    ) {
      throw new BadRequestException('El valor nuevo debe ser diferente');
    }

    return this.mutateTags(normalizedTo, (tags) =>
      this.replaceCatalogValue(tags, normalizedFrom, normalizedTo),
    );
  }

  deleteTag(value: string) {
    return this.mutateTags(value, (tags) =>
      this.removeCatalogValue(tags, value),
    );
  }

  renameNutritionalBadge(from: string, to: string) {
    const normalizedFrom = this.normalizeCatalogValue(from);
    const normalizedTo = this.normalizeCatalogValue(to);

    if (!normalizedFrom || !normalizedTo) {
      throw new BadRequestException(
        'Los valores del catálogo no pueden estar vacíos',
      );
    }

    if (
      this.getCatalogKey(normalizedFrom) === this.getCatalogKey(normalizedTo)
    ) {
      throw new BadRequestException('El valor nuevo debe ser diferente');
    }

    return this.mutateNutritionalBadges(normalizedTo, (badges) =>
      this.replaceCatalogValue(badges, normalizedFrom, normalizedTo),
    );
  }

  deleteNutritionalBadge(value: string) {
    return this.mutateNutritionalBadges(value, (badges) =>
      this.removeCatalogValue(badges, value),
    );
  }

  async findAll(query: DietsQueryDto) {
    const {
      search,
      tags,
      nutritional_badges,
      meal_types,
      updated_from,
      updated_to,
      skip,
      limit,
    } = query;
    const pageSize = limit ?? 20;
    const normalizedSearch = search?.trim();
    const updatedAtRange = getDateRange(updated_from, updated_to);
    const where: Prisma.DietWhereInput = {
      is_active: true,
      ...(tags?.length ? { tags: { hasSome: tags } } : {}),
      ...(nutritional_badges?.length || meal_types?.length
        ? {
            meals: {
              some: {
                ...(meal_types?.length ? { type: { in: meal_types } } : {}),
                ...(nutritional_badges?.length
                  ? {
                      nutritional_badges: {
                        hasSome: nutritional_badges,
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
      ...(updatedAtRange ? { updated_at: updatedAtRange } : {}),
    };

    if (normalizedSearch) {
      const normalizedSearchTerm = normalizeSearchText(normalizedSearch);
      const diets = await this.prisma.diet.findMany({
        where,
        orderBy: { created_at: 'desc' },
        include: dietInclude,
      });

      const filteredDiets = diets.filter((diet) =>
        normalizeSearchText(diet.name).includes(normalizedSearchTerm),
      );

      const pageData = filteredDiets.slice(skip, skip + pageSize);

      return paginate(pageData, filteredDiets.length, query);
    }

    const [data, total] = await Promise.all([
      this.prisma.diet.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { created_at: 'desc' },
        include: dietInclude,
      }),
      this.prisma.diet.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async findToday(clientId: string, date?: Date) {
    const now = date ?? new Date();
    const target = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

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

    const { tags: _tags, ...clientDiet } = assignment.diet;
    return clientDiet;
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
          tags: this.normalizeCatalogValues(dto.tags ?? []),
          total_calories: dto.total_calories ?? null,
          total_protein_g: dto.total_protein_g ?? null,
          total_carbs_g: dto.total_carbs_g ?? null,
          total_fat_g: dto.total_fat_g ?? null,
          created_by: adminId,
        },
      });

      await this.createMeals(tx, diet.id, dto.meals);

      return tx.diet.findUniqueOrThrow({
        where: { id: diet.id },
        include: dietInclude,
      });
    });
  }

  async update(id: string, dto: UpdateDietDto) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      if (dto.meals !== undefined) {
        await tx.mealIngredient.deleteMany({
          where: { meal: { diet_id: id } },
        });
        await tx.meal.deleteMany({ where: { diet_id: id } });
      }

      await tx.diet.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.tags !== undefined && {
            tags: this.normalizeCatalogValues(dto.tags),
          }),
          ...(dto.total_calories !== undefined && {
            total_calories: dto.total_calories,
          }),
          ...(dto.total_protein_g !== undefined && {
            total_protein_g: dto.total_protein_g,
          }),
          ...(dto.total_carbs_g !== undefined && {
            total_carbs_g: dto.total_carbs_g,
          }),
          ...(dto.total_fat_g !== undefined && {
            total_fat_g: dto.total_fat_g,
          }),
        },
      });

      if (dto.meals !== undefined) {
        await this.createMeals(tx, id, dto.meals);
      }

      return tx.diet.findUniqueOrThrow({
        where: { id },
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

  private getMealCreateData(
    dietId: string,
    meal: CreateMealDto | CreateMealVariantDto,
    parentMealId?: string,
  ): Prisma.MealCreateInput {
    this.validateMealIngredientEquivalents(meal.ingredients);

    return {
      diet: { connect: { id: dietId } },
      ...(parentMealId ? { parent: { connect: { id: parentMealId } } } : {}),
      type: meal.type,
      name: meal.name,
      image_url: meal.image_url ?? null,
      calories: meal.calories ?? null,
      protein_g: meal.protein_g ?? null,
      carbs_g: meal.carbs_g ?? null,
      fat_g: meal.fat_g ?? null,
      nutritional_badges: this.normalizeCatalogValues(
        meal.nutritional_badges ?? [],
      ),
      order: meal.order ?? 0,
      ingredients: {
        create: meal.ingredients.map((ing) => ({
          ingredient_id: ing.ingredient_id,
          quantity: ing.quantity,
          unit: ing.unit,
          grams_equivalent:
            ing.unit === 'g' ? ing.quantity : (ing.grams_equivalent ?? null),
        })),
      },
    };
  }

  private validateMealIngredientEquivalents(
    ingredients: CreateMealDto['ingredients'],
  ) {
    const missingEquivalent = ingredients.some(
      (ingredient) =>
        ingredient.unit !== 'g' &&
        (!ingredient.grams_equivalent || ingredient.grams_equivalent <= 0),
    );

    if (missingEquivalent) {
      throw new BadRequestException(
        'Las medidas caseras necesitan equivalente en gramos',
      );
    }
  }

  private async createMeals(
    tx: Prisma.TransactionClient,
    dietId: string,
    meals: CreateMealDto[],
  ) {
    for (const meal of meals) {
      const createdMeal = await tx.meal.create({
        data: this.getMealCreateData(dietId, meal),
        select: { id: true },
      });

      for (const variant of meal.variants ?? []) {
        await tx.meal.create({
          data: this.getMealCreateData(dietId, variant, createdMeal.id),
          select: { id: true },
        });
      }
    }
  }
}

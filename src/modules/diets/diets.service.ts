import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CatalogColorType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import {
  CreateDietDto,
  CreateMealDto,
  CreateMealVariantDto,
  UpdateDietDto,
} from './dto/create-diet.dto';
import { DietsQueryDto } from './dto/diets-query.dto';

type DietSortField = 'name' | 'updated_at' | 'created_at';
const CATALOG_COLOR_REGEX = /^#(?:[0-9A-Fa-f]{6})$/;
const DEFAULT_CATALOG_COLOR = '#6B7280';

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
  group: { select: { id: true, name: true } },
  meals: {
    where: { parent_meal_id: null },
    orderBy: { order: 'asc' as const },
    include: mealInclude,
  },
};

const dietListSelect = {
  id: true,
  name: true,
  tags: true,
  total_calories: true,
  total_protein_g: true,
  total_carbs_g: true,
  total_fat_g: true,
  is_active: true,
  created_by: true,
  created_at: true,
  updated_at: true,
  group_id: true,
  group: { select: { id: true, name: true } },
  meals: {
    where: { parent_meal_id: null },
    orderBy: { order: 'asc' as const },
    select: {
      id: true,
      type: true,
      name: true,
      image_url: true,
      calories: true,
      protein_g: true,
      carbs_g: true,
      fat_g: true,
      nutritional_badges: true,
      order: true,
    },
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

  private normalizeCatalogColor(value: string) {
    const normalizedValue = value.trim().toUpperCase();

    if (!CATALOG_COLOR_REGEX.test(normalizedValue)) {
      throw new BadRequestException(
        'El color del catálogo debe ser un valor hex #RRGGBB válido',
      );
    }

    return normalizedValue;
  }

  private async enrichCatalogValuesWithColors(
    catalogType: CatalogColorType,
    values: string[],
  ) {
    if (values.length === 0) {
      return [];
    }

    const keys = values.map((value) => this.getCatalogKey(value));
    const colorRows = await this.prisma.catalogColor.findMany({
      where: {
        catalog_type: catalogType,
        normalized_key: { in: keys },
      },
      select: { normalized_key: true, color: true },
    });
    const colorsByKey = new Map(
      colorRows.map((row) => [row.normalized_key, row.color]),
    );

    return values.map((value) => ({
      value,
      color: colorsByKey.get(this.getCatalogKey(value)) ?? DEFAULT_CATALOG_COLOR,
    }));
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

  private serializeDietListItem<
    T extends {
      meals?: Array<Record<string, unknown>>;
    },
  >(diet: T) {
    return {
      ...diet,
      meals_count: diet.meals?.length ?? 0,
    };
  }

  private serializeDietList<T extends { meals?: Array<Record<string, unknown>> }>(
    diets: T[],
  ) {
    return diets.map((diet) => this.serializeDietListItem(diet));
  }

  async findAllNutritionalBadges() {
    const meals = await this.prisma.meal.findMany({
      where: { diet: { is_active: true } },
      select: { nutritional_badges: true },
    });

    const values = this.collectUnique(
      meals.map((meal) => meal.nutritional_badges),
    );

    return {
      nutritional_badges: await this.enrichCatalogValuesWithColors(
        CatalogColorType.diet_nutritional_badge,
        values,
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

  async renameNutritionalBadge(from: string, to: string) {
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

    const result = await this.mutateNutritionalBadges(normalizedTo, (badges) =>
      this.replaceCatalogValue(badges, normalizedFrom, normalizedTo),
    );

    await this.prisma.catalogColor.upsert({
      where: {
        catalog_type_normalized_key: {
          catalog_type: CatalogColorType.diet_nutritional_badge,
          normalized_key: this.getCatalogKey(normalizedFrom),
        },
      },
      update: {
        normalized_key: this.getCatalogKey(normalizedTo),
        value: normalizedTo,
      },
      create: {
        catalog_type: CatalogColorType.diet_nutritional_badge,
        normalized_key: this.getCatalogKey(normalizedTo),
        value: normalizedTo,
        color: DEFAULT_CATALOG_COLOR,
      },
    });

    return result;
  }

  deleteNutritionalBadge(value: string) {
    return this.mutateNutritionalBadges(value, (badges) =>
      this.removeCatalogValue(badges, value),
    );
  }

  async updateNutritionalBadgeColor(value: string, color: string) {
    const normalizedValue = this.normalizeCatalogValue(value);

    if (!normalizedValue) {
      throw new BadRequestException('El badge nutricional no puede estar vacío');
    }

    const normalizedColor = this.normalizeCatalogColor(color);
    const colorRow = await this.prisma.catalogColor.upsert({
      where: {
        catalog_type_normalized_key: {
          catalog_type: CatalogColorType.diet_nutritional_badge,
          normalized_key: this.getCatalogKey(normalizedValue),
        },
      },
      update: { value: normalizedValue, color: normalizedColor },
      create: {
        catalog_type: CatalogColorType.diet_nutritional_badge,
        normalized_key: this.getCatalogKey(normalizedValue),
        value: normalizedValue,
        color: normalizedColor,
      },
    });

    return { value: colorRow.value, color: colorRow.color };
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
      group_id,
      ungrouped,
    } = query;
    const pageSize = limit ?? 20;
    const sortBy = this.getDietSortField(query.sort_by);
    const sortDir = query.sort_by ? (query.sort_dir ?? 'asc') : 'desc';
    if (group_id && ungrouped) {
      throw new BadRequestException(
        'No se puede combinar group_id con ungrouped',
      );
    }
    const normalizedSearch = search?.trim();
    const updatedAtRange = getDateRange(updated_from, updated_to);
    const where: Prisma.DietWhereInput = {
      is_active: true,
      ...(group_id ? { group_id } : {}),
      ...(ungrouped ? { group_id: null } : {}),
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
        orderBy: this.getDietOrderBy(sortBy, sortDir),
        select: dietListSelect,
      });

      const filteredDiets = diets.filter((diet) =>
        normalizeSearchText(diet.name).includes(normalizedSearchTerm),
      );

      const pageData = this.serializeDietList(
        filteredDiets.slice(skip, skip + pageSize),
      );

      return paginate(pageData, filteredDiets.length, query);
    }

    const [data, total] = await Promise.all([
      this.prisma.diet.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: this.getDietOrderBy(sortBy, sortDir),
        select: dietListSelect,
      }),
      this.prisma.diet.count({ where }),
    ]);

    return paginate(this.serializeDietList(data), total, query);
  }

  private getDietSortField(value?: string): DietSortField {
    const allowed = new Set<DietSortField>(['name', 'updated_at', 'created_at']);

    return value && allowed.has(value as DietSortField)
      ? (value as DietSortField)
      : 'created_at';
  }

  private getDietOrderBy(
    sortBy: DietSortField,
    sortDir: 'asc' | 'desc',
  ): Prisma.DietOrderByWithRelationInput[] {
    return [{ [sortBy]: sortDir }, { id: sortDir }];
  }

  async updateGroupMembership(dietIds: string[], groupId: string | null) {
    const ids = [...new Set(dietIds)];

    return this.prisma.$transaction(async (tx) => {
      if (groupId) {
        const group = await tx.dietGroup.findUnique({ where: { id: groupId } });
        if (!group) throw new NotFoundException('Grupo de dietas no encontrado');
      }

      const activeCount = await tx.diet.count({ where: { id: { in: ids }, is_active: true } });
      if (activeCount !== ids.length) {
        throw new NotFoundException('Una o más dietas no existen o están inactivas');
      }

      const result = await tx.diet.updateMany({
        where: { id: { in: ids }, is_active: true },
        data: { group_id: groupId },
      });
      return { affected_count: result.count };
    });
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

  async findWeek(clientId: string, date: Date) {
    const target = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    const dayFromMonday = (target.getUTCDay() + 6) % 7;
    const start = new Date(target);
    start.setUTCDate(start.getUTCDate() - dayFromMonday);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);

    const assignments = await this.prisma.planAssignment.findMany({
      where: {
        client_id: clientId,
        date: { gte: start, lte: end },
        diet_id: { not: null },
      },
      include: {
        diet: { include: dietInclude },
      },
      orderBy: { date: 'asc' },
    });

    const assignmentsByDate = new Map(
      assignments.map((assignment) => [
        assignment.date.toISOString().split('T')[0],
        assignment.diet,
      ]),
    );

    const days = Array.from({ length: 7 }, (_, offset) => {
      const current = new Date(start);
      current.setUTCDate(current.getUTCDate() + offset);
      const dateKey = current.toISOString().split('T')[0];
      const diet = assignmentsByDate.get(dateKey);

      if (!diet) return { date: dateKey, diet: null };
      const { tags: _tags, ...clientDiet } = diet;
      return { date: dateKey, diet: clientDiet };
    });

    return {
      week_start: start.toISOString().split('T')[0],
      week_end: end.toISOString().split('T')[0],
      days,
    };
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

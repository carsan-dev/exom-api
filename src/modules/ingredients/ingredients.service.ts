import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import {
  CreateIngredientDto,
  UpdateIngredientDto,
} from './dto/create-ingredient.dto';
import { IngredientsQueryDto } from './dto/ingredients-query.dto';

type IngredientSortField =
  | 'name'
  | 'icon'
  | 'calories_per_100g'
  | 'protein_per_100g'
  | 'carbs_per_100g'
  | 'fat_per_100g'
  | 'updated_at'
  | 'created_at';

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
export class IngredientsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query: IngredientsQueryDto) {
    const {
      search,
      has_icon,
      calories_per_100g_min,
      calories_per_100g_max,
      protein_per_100g_min,
      protein_per_100g_max,
      carbs_per_100g_min,
      carbs_per_100g_max,
      fat_per_100g_min,
      fat_per_100g_max,
      updated_from,
      updated_to,
      skip,
      limit,
    } = query;
    const pageSize = limit ?? 20;
    const sortBy = this.getIngredientSortField(query.sort_by);
    const sortDir = query.sort_by ? (query.sort_dir ?? 'asc') : 'asc';
    const normalizedSearch = search?.trim();
    const updatedAtRange = getDateRange(updated_from, updated_to);
    const iconStates = has_icon ?? [];
    const shouldFilterWithIcon =
      iconStates.length === 1 && iconStates[0] === 'WITH_ICON';
    const shouldFilterWithoutIcon =
      iconStates.length === 1 && iconStates[0] === 'WITHOUT_ICON';
    const where: Prisma.IngredientWhereInput = {
      is_active: true,
      ...(shouldFilterWithIcon
        ? {
            icon: {
              not: null,
            },
          }
        : {}),
      ...(shouldFilterWithoutIcon
        ? {
            OR: [{ icon: null }, { icon: '' }],
          }
        : {}),
      ...(calories_per_100g_min != null || calories_per_100g_max != null
        ? {
            calories_per_100g: {
              ...(calories_per_100g_min != null
                ? { gte: calories_per_100g_min }
                : {}),
              ...(calories_per_100g_max != null
                ? { lte: calories_per_100g_max }
                : {}),
            },
          }
        : {}),
      ...(protein_per_100g_min != null || protein_per_100g_max != null
        ? {
            protein_per_100g: {
              ...(protein_per_100g_min != null
                ? { gte: protein_per_100g_min }
                : {}),
              ...(protein_per_100g_max != null
                ? { lte: protein_per_100g_max }
                : {}),
            },
          }
        : {}),
      ...(carbs_per_100g_min != null || carbs_per_100g_max != null
        ? {
            carbs_per_100g: {
              ...(carbs_per_100g_min != null
                ? { gte: carbs_per_100g_min }
                : {}),
              ...(carbs_per_100g_max != null
                ? { lte: carbs_per_100g_max }
                : {}),
            },
          }
        : {}),
      ...(fat_per_100g_min != null || fat_per_100g_max != null
        ? {
            fat_per_100g: {
              ...(fat_per_100g_min != null ? { gte: fat_per_100g_min } : {}),
              ...(fat_per_100g_max != null ? { lte: fat_per_100g_max } : {}),
            },
          }
        : {}),
      ...(updatedAtRange ? { updated_at: updatedAtRange } : {}),
    };

    if (normalizedSearch) {
      const normalizedSearchTerm = normalizeSearchText(normalizedSearch);
      const ingredients = await this.prisma.ingredient.findMany({
        where,
        orderBy: this.getIngredientOrderBy(sortBy, sortDir),
      });

      const filteredIngredients = ingredients.filter((ingredient) =>
        normalizeSearchText(ingredient.name).includes(normalizedSearchTerm),
      );

      const pageData = filteredIngredients.slice(
        skip,
        skip + pageSize,
      );

      return paginate(pageData, filteredIngredients.length, query);
    }

    const [data, total] = await Promise.all([
      this.prisma.ingredient.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: this.getIngredientOrderBy(sortBy, sortDir),
      }),
      this.prisma.ingredient.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  private getIngredientSortField(value?: string): IngredientSortField {
    const allowed = new Set<IngredientSortField>([
      'name',
      'icon',
      'calories_per_100g',
      'protein_per_100g',
      'carbs_per_100g',
      'fat_per_100g',
      'updated_at',
      'created_at',
    ]);

    return value && allowed.has(value as IngredientSortField)
      ? (value as IngredientSortField)
      : 'name';
  }

  private getIngredientOrderBy(
    sortBy: IngredientSortField,
    sortDir: 'asc' | 'desc',
  ): Prisma.IngredientOrderByWithRelationInput[] {
    return [{ [sortBy]: sortDir }, { id: sortDir }];
  }

  async findOne(id: string) {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id, is_active: true },
    });

    if (!ingredient) {
      throw new NotFoundException('Ingrediente no encontrado');
    }

    return ingredient;
  }

  async create(dto: CreateIngredientDto, userId: string) {
    return this.prisma.ingredient.create({
      data: {
        name: dto.name,
        icon: dto.icon ?? null,
        calories_per_100g: dto.calories_per_100g,
        protein_per_100g: dto.protein_per_100g,
        carbs_per_100g: dto.carbs_per_100g,
        fat_per_100g: dto.fat_per_100g,
        created_by: userId,
      },
    });
  }

  async update(id: string, dto: UpdateIngredientDto) {
    await this.findOne(id);

    return this.prisma.ingredient.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.calories_per_100g !== undefined && {
          calories_per_100g: dto.calories_per_100g,
        }),
        ...(dto.protein_per_100g !== undefined && {
          protein_per_100g: dto.protein_per_100g,
        }),
        ...(dto.carbs_per_100g !== undefined && {
          carbs_per_100g: dto.carbs_per_100g,
        }),
        ...(dto.fat_per_100g !== undefined && {
          fat_per_100g: dto.fat_per_100g,
        }),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    await this.prisma.ingredient.update({
      where: { id },
      data: { is_active: false },
    });
  }
}

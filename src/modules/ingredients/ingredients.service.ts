import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import {
  CreateIngredientDto,
  UpdateIngredientDto,
} from './dto/create-ingredient.dto';

function normalizeSearchText(value: string) {
  return value
    .toLocaleLowerCase('es-ES')
    .normalize('NFD')
    .replace(/([aeiou])([\u0300-\u036f]+)/g, '$1')
    .normalize('NFC');
}

@Injectable()
export class IngredientsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(search: string | undefined, pagination: PaginationDto) {
    const normalizedSearch = search?.trim();

    if (normalizedSearch) {
      const normalizedSearchTerm = normalizeSearchText(normalizedSearch);
      const ingredients = await this.prisma.ingredient.findMany({
        where: { is_active: true },
        orderBy: { name: 'asc' },
      });

      const filteredIngredients = ingredients.filter((ingredient) =>
        normalizeSearchText(ingredient.name).includes(normalizedSearchTerm),
      );

      const pageData = filteredIngredients.slice(
        pagination.skip,
        pagination.skip + (pagination.limit ?? 20),
      );

      return paginate(pageData, filteredIngredients.length, pagination);
    }

    const where = {
      is_active: true,
    };

    const [data, total] = await Promise.all([
      this.prisma.ingredient.findMany({
        where,
        skip: pagination.skip,
        take: pagination.limit,
        orderBy: { name: 'asc' },
      }),
      this.prisma.ingredient.count({ where }),
    ]);

    return paginate(data, total, pagination);
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

  async create(dto: CreateIngredientDto) {
    return this.prisma.ingredient.create({
      data: {
        name: dto.name,
        icon: dto.icon ?? null,
        calories_per_100g: dto.calories_per_100g,
        protein_per_100g: dto.protein_per_100g,
        carbs_per_100g: dto.carbs_per_100g,
        fat_per_100g: dto.fat_per_100g,
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

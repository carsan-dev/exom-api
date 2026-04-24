import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import {
  CreateExerciseDto,
  UpdateExerciseDto,
} from './dto/create-exercise.dto';
import { ExercisesQueryDto } from './dto/exercises-query.dto';

type ExerciseCatalogField = 'muscle_groups' | 'equipment';

function normalizeSearchText(value: string) {
  return value
    .toLocaleLowerCase('es-ES')
    .normalize('NFD')
    .replace(/([aeiou])([\u0300-\u036f]+)/g, '$1')
    .normalize('NFC');
}

@Injectable()
export class ExercisesService {
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

  private async mutateExerciseCatalog(
    field: ExerciseCatalogField,
    value: string,
    mutateValues: (values: string[]) => string[],
  ) {
    const normalizedValue = this.normalizeCatalogValue(value);

    if (!normalizedValue) {
      throw new BadRequestException(
        'El valor del catálogo no puede estar vacío',
      );
    }

    const exercises =
      field === 'muscle_groups'
        ? await this.prisma.exercise.findMany({
            where: { is_active: true },
            select: { id: true, muscle_groups: true },
          })
        : await this.prisma.exercise.findMany({
            where: { is_active: true },
            select: { id: true, equipment: true },
          });

    const updates = exercises.flatMap((exercise) => {
      const currentValues =
        field === 'muscle_groups' ? exercise.muscle_groups : exercise.equipment;
      const nextValues = mutateValues(currentValues);

      if (!this.hasCatalogChanged(currentValues, nextValues)) {
        return [];
      }

      return this.prisma.exercise.update({
        where: { id: exercise.id },
        data:
          field === 'muscle_groups'
            ? { muscle_groups: nextValues }
            : { equipment: nextValues },
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

  private async renameExerciseCatalogValue(
    field: ExerciseCatalogField,
    from: string,
    to: string,
  ) {
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

    return this.mutateExerciseCatalog(field, normalizedTo, (values) =>
      this.replaceCatalogValue(values, normalizedFrom, normalizedTo),
    );
  }

  renameMuscleGroup(from: string, to: string) {
    return this.renameExerciseCatalogValue('muscle_groups', from, to);
  }

  deleteMuscleGroup(value: string) {
    return this.mutateExerciseCatalog('muscle_groups', value, (values) =>
      this.removeCatalogValue(values, value),
    );
  }

  renameEquipment(from: string, to: string) {
    return this.renameExerciseCatalogValue('equipment', from, to);
  }

  deleteEquipment(value: string) {
    return this.mutateExerciseCatalog('equipment', value, (values) =>
      this.removeCatalogValue(values, value),
    );
  }

  async findAllMuscleGroups() {
    const exercises = await this.prisma.exercise.findMany({
      where: { is_active: true },
      select: { muscle_groups: true },
    });

    return {
      muscle_groups: this.collectUnique(exercises.map((e) => e.muscle_groups)),
    };
  }

  async findAllEquipment() {
    const exercises = await this.prisma.exercise.findMany({
      where: { is_active: true },
      select: { equipment: true },
    });

    return {
      equipment: this.collectUnique(exercises.map((e) => e.equipment)),
    };
  }

  async findAll(query: ExercisesQueryDto) {
    const { search, muscle_groups, equipment, level, skip, limit } = query;
    const pageSize = limit ?? 20;
    const normalizedSearch = search?.trim();
    const where: Prisma.ExerciseWhereInput = {
      is_active: true,
      ...(muscle_groups?.length
        ? { muscle_groups: { hasSome: muscle_groups } }
        : {}),
      ...(equipment?.length ? { equipment: { hasSome: equipment } } : {}),
      ...(level?.length ? { level: { in: level } } : {}),
    };

    if (normalizedSearch) {
      const normalizedSearchTerm = normalizeSearchText(normalizedSearch);
      const exercises = await this.prisma.exercise.findMany({
        where,
        orderBy: { created_at: 'desc' },
      });

      const filteredExercises = exercises.filter((exercise) =>
        normalizeSearchText(exercise.name).includes(normalizedSearchTerm),
      );

      const pageData = filteredExercises.slice(skip, skip + pageSize);

      return paginate(pageData, filteredExercises.length, query);
    }

    const [data, total] = await Promise.all([
      this.prisma.exercise.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.exercise.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async findOne(id: string) {
    const exercise = await this.prisma.exercise.findFirst({
      where: { id, is_active: true },
    });

    if (!exercise) {
      throw new NotFoundException('Ejercicio no encontrado');
    }

    return exercise;
  }

  async create(dto: CreateExerciseDto, userId: string) {
    return this.prisma.exercise.create({
      data: {
        name: dto.name,
        muscle_groups: this.normalizeCatalogValues(dto.muscle_groups),
        equipment: this.normalizeCatalogValues(dto.equipment),
        level: dto.level,
        video_url: dto.video_url ?? null,
        video_stream_id: dto.video_stream_id ?? null,
        thumbnail_url: dto.thumbnail_url ?? null,
        technique_text: dto.technique_text ?? null,
        common_errors_text: dto.common_errors_text ?? null,
        explanation_text: dto.explanation_text ?? null,
        created_by: userId,
      },
    });
  }

  async update(id: string, dto: UpdateExerciseDto) {
    await this.findOne(id);

    return this.prisma.exercise.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.muscle_groups !== undefined && {
          muscle_groups: this.normalizeCatalogValues(dto.muscle_groups),
        }),
        ...(dto.equipment !== undefined && {
          equipment: this.normalizeCatalogValues(dto.equipment),
        }),
        ...(dto.level !== undefined && { level: dto.level }),
        ...(dto.video_url !== undefined && { video_url: dto.video_url }),
        ...(dto.video_stream_id !== undefined && {
          video_stream_id: dto.video_stream_id,
        }),
        ...(dto.thumbnail_url !== undefined && {
          thumbnail_url: dto.thumbnail_url,
        }),
        ...(dto.technique_text !== undefined && {
          technique_text: dto.technique_text,
        }),
        ...(dto.common_errors_text !== undefined && {
          common_errors_text: dto.common_errors_text,
        }),
        ...(dto.explanation_text !== undefined && {
          explanation_text: dto.explanation_text,
        }),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    await this.prisma.exercise.update({
      where: { id },
      data: { is_active: false },
    });
  }
}

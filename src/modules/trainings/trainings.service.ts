import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import {
  CreateTrainingDto,
  UpdateTrainingDto,
} from './dto/create-training.dto';
import { TrainingsQueryDto } from './dto/trainings-query.dto';

type PrismaClientLike = PrismaService | Prisma.TransactionClient;

type AchievementRuleConfigLike = {
  training_type?: string;
};

const trainingExercisesInclude = {
  exercises: {
    orderBy: { order: 'asc' as const },
    include: {
      exercise: true,
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

@Injectable()
export class TrainingsService {
  constructor(private readonly prisma: PrismaService) {}

  private collectUniqueCatalogValues(values: string[]): string[] {
    const unique = new Map<string, string>();

    for (const rawValue of values) {
      const normalizedValue = this.normalizeCatalogValue(rawValue);

      if (!normalizedValue) {
        continue;
      }

      const key = this.getCatalogKey(normalizedValue);

      if (!unique.has(key)) {
        unique.set(key, normalizedValue);
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

  private normalizeTrainingTypeValue(value: string) {
    const normalizedValue = this.normalizeCatalogValue(value);

    if (!normalizedValue) {
      throw new BadRequestException(
        'El tipo de entrenamiento no puede estar vacÃ­o',
      );
    }

    return normalizedValue;
  }

  private parseAchievementRuleConfig(
    ruleConfig: Prisma.JsonValue | null,
  ): AchievementRuleConfigLike | null {
    if (!ruleConfig || typeof ruleConfig !== 'object' || Array.isArray(ruleConfig)) {
      return null;
    }

    return ruleConfig as AchievementRuleConfigLike;
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

    const trainings = await this.prisma.training.findMany({
      where: { is_active: true },
      select: { id: true, tags: true },
    });

    const updates = trainings.flatMap((training) => {
      const nextTags = mutateValues(training.tags);

      if (!this.hasCatalogChanged(training.tags, nextTags)) {
        return [];
      }

      return this.prisma.training.update({
        where: { id: training.id },
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

  async renameType(from: string, to: string) {
    const normalizedFrom = this.normalizeTrainingTypeValue(from);
    const normalizedTo = this.normalizeTrainingTypeValue(to);

    if (
      this.getCatalogKey(normalizedFrom) === this.getCatalogKey(normalizedTo)
    ) {
      throw new BadRequestException('El valor nuevo debe ser diferente');
    }

    const [trainings, achievements] = await Promise.all([
      this.prisma.training.findMany({
        where: { is_active: true },
        select: { id: true, type: true },
      }),
      this.prisma.achievement.findMany({
        where: { criteria_type: 'TRAINING_DAYS' },
        select: { id: true, rule_config: true },
      }),
    ]);

    const trainingUpdates = trainings.flatMap((training) =>
      this.getCatalogKey(training.type) === this.getCatalogKey(normalizedFrom)
        ? [
            this.prisma.training.update({
              where: { id: training.id },
              data: { type: normalizedTo },
            }),
          ]
        : [],
    );

    const achievementUpdates = achievements.flatMap((achievement) => {
      const ruleConfig = this.parseAchievementRuleConfig(achievement.rule_config);
      const trainingType = ruleConfig?.training_type;

      if (
        !trainingType ||
        this.getCatalogKey(trainingType) !== this.getCatalogKey(normalizedFrom)
      ) {
        return [];
      }

      return [
        this.prisma.achievement.update({
          where: { id: achievement.id },
          data: {
            rule_config: {
              ...ruleConfig,
              training_type: normalizedTo,
            } as Prisma.InputJsonValue,
          },
        }),
      ];
    });

    const updates = [...trainingUpdates, ...achievementUpdates];

    if (updates.length > 0) {
      await this.prisma.$transaction(updates);
    }

    return {
      value: normalizedTo,
      affected_count: updates.length,
    };
  }

  async findAllTags() {
    const trainings = await this.prisma.training.findMany({
      where: { is_active: true },
      select: { tags: true },
    });

    return {
      tags: this.collectUniqueCatalogValues(
        trainings.flatMap((training) => training.tags),
      ),
    };
  }

  async findAllTypes() {
    const trainings = await this.prisma.training.findMany({
      where: { is_active: true },
      select: { type: true },
    });

    return {
      types: this.collectUniqueCatalogValues(
        trainings.map((training) => training.type),
      ),
    };
  }

  async findAll(query: TrainingsQueryDto) {
    const {
      search,
      type,
      level,
      tags,
      duration_min,
      duration_max,
      skip,
      limit,
    } = query;
    const pageSize = limit ?? 20;
    const normalizedSearch = search?.trim();
    const where: Prisma.TrainingWhereInput = {
      is_active: true,
      ...(type?.length ? { type: { in: type } } : {}),
      ...(level?.length ? { level: { in: level } } : {}),
      ...(tags?.length ? { tags: { hasSome: tags } } : {}),
      ...(duration_min != null || duration_max != null
        ? {
            estimated_duration_min: {
              ...(duration_min != null ? { gte: duration_min } : {}),
              ...(duration_max != null ? { lte: duration_max } : {}),
            },
          }
        : {}),
    };

    if (normalizedSearch) {
      const normalizedSearchTerm = normalizeSearchText(normalizedSearch);
      const trainings = await this.prisma.training.findMany({
        where,
        orderBy: { created_at: 'desc' },
        include: trainingExercisesInclude,
      });

      const filteredTrainings = trainings.filter((training) =>
        normalizeSearchText(training.name).includes(normalizedSearchTerm),
      );

      const pageData = filteredTrainings.slice(skip, skip + pageSize);

      return paginate(pageData, filteredTrainings.length, query);
    }

    const [data, total] = await Promise.all([
      this.prisma.training.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { created_at: 'desc' },
        include: trainingExercisesInclude,
      }),
      this.prisma.training.count({ where }),
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
        training: {
          include: trainingExercisesInclude,
        },
      },
    });

    if (!assignment || !assignment.training) {
      return null;
    }

    return assignment.training;
  }

  async findOne(id: string) {
    const training = await this.prisma.training.findFirst({
      where: { id, is_active: true },
      include: trainingExercisesInclude,
    });

    if (!training) {
      throw new NotFoundException('Entrenamiento no encontrado');
    }

    return training;
  }

  async create(adminId: string, dto: CreateTrainingDto) {
    return this.prisma.$transaction(async (tx) => {
      const training = await tx.training.create({
        data: {
          name: dto.name,
          type: this.normalizeTrainingTypeValue(dto.type),
          level: dto.level,
          estimated_duration_min: dto.estimated_duration_min ?? null,
          estimated_calories: dto.estimated_calories ?? null,
          warmup_description: dto.warmup_description ?? null,
          warmup_duration_min: dto.warmup_duration_min ?? null,
          cooldown_description: dto.cooldown_description ?? null,
          tags: this.normalizeCatalogValues(dto.tags ?? []),
          created_by: adminId,
        },
      });

      if (dto.exercises && dto.exercises.length > 0) {
        await tx.trainingExercise.createMany({
          data: dto.exercises.map((ex) => ({
            training_id: training.id,
            exercise_id: ex.exercise_id,
            order: ex.order,
            sets: ex.sets,
            reps_or_duration: ex.reps_or_duration,
            rest_seconds: ex.rest_seconds ?? 60,
          })),
        });
      }

      return tx.training.findUnique({
        where: { id: training.id },
        include: trainingExercisesInclude,
      });
    });
  }

  async update(id: string, dto: UpdateTrainingDto) {
    await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      await tx.training.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.type !== undefined && {
            type: this.normalizeTrainingTypeValue(dto.type),
          }),
          ...(dto.level !== undefined && { level: dto.level }),
          ...(dto.estimated_duration_min !== undefined && {
            estimated_duration_min: dto.estimated_duration_min,
          }),
          ...(dto.estimated_calories !== undefined && {
            estimated_calories: dto.estimated_calories,
          }),
          ...(dto.warmup_description !== undefined && {
            warmup_description: dto.warmup_description,
          }),
          ...(dto.warmup_duration_min !== undefined && {
            warmup_duration_min: dto.warmup_duration_min,
          }),
          ...(dto.cooldown_description !== undefined && {
            cooldown_description: dto.cooldown_description,
          }),
          ...(dto.tags !== undefined && {
            tags: this.normalizeCatalogValues(dto.tags),
          }),
        },
      });

      if (dto.exercises !== undefined) {
        // Re-sync: delete all existing and recreate
        await tx.trainingExercise.deleteMany({ where: { training_id: id } });

        if (dto.exercises.length > 0) {
          await tx.trainingExercise.createMany({
            data: dto.exercises.map((ex) => ({
              training_id: id,
              exercise_id: ex.exercise_id,
              order: ex.order,
              sets: ex.sets,
              reps_or_duration: ex.reps_or_duration,
              rest_seconds: ex.rest_seconds ?? 60,
            })),
          });
        }
      }

      return tx.training.findUnique({
        where: { id },
        include: trainingExercisesInclude,
      });
    });
  }

  async remove(id: string) {
    await this.findOne(id);

    await this.prisma.training.update({
      where: { id },
      data: { is_active: false },
    });
  }
}

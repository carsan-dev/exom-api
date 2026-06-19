import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TrainingBlockType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import {
  CreateTrainingDto,
  TrainingCircuitItemDto,
  TrainingItemExerciseDto,
  UpdateTrainingDto,
} from './dto/create-training.dto';
import { TrainingsQueryDto } from './dto/trainings-query.dto';

type PrismaClientLike = PrismaService | Prisma.TransactionClient;

type AchievementRuleConfigLike = {
  training_type?: string;
};

type TrainingCatalogRecord = {
  type: string;
  types?: string[] | null;
};

type TrainingResponseLike = TrainingCatalogRecord & {
  accentColor?: string | null;
  blocks?: Array<{
    id: string;
    order: number;
    type: TrainingBlockType;
    name: string | null;
    rounds: number;
    rest_between_rounds_seconds: number;
    exercises: Array<Record<string, unknown>>;
  }>;
  exercises?: Array<
    Record<string, unknown> & {
      id?: string;
      order?: number;
      block_id?: string | null;
      position_in_block?: number | null;
    }
  >;
};

const trainingExercisesInclude = {
  group: { select: { id: true, name: true } },
  blocks: {
    orderBy: { order: 'asc' as const },
    include: {
      exercises: {
        orderBy: { position_in_block: 'asc' as const },
        include: { exercise: true },
      },
    },
  },
  exercises: {
    orderBy: { order: 'asc' as const },
    include: {
      exercise: true,
    },
  },
};

const TRAINING_ACCENT_COLOR_REGEX = /^#?(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

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

  private resolveTrainingTypes(training: TrainingCatalogRecord): string[] {
    return this.normalizeCatalogValues([
      ...(training.types ?? []),
      ...(training.type ? [training.type] : []),
    ]);
  }

  private normalizeTrainingTypesInput(
    training: Partial<TrainingCatalogRecord>,
    requireAtLeastOne = true,
  ): string[] {
    const normalizedTypes = this.normalizeCatalogValues([
      ...(training.types ?? []),
      ...(training.type ? [training.type] : []),
    ]);

    if (requireAtLeastOne && normalizedTypes.length === 0) {
      throw new BadRequestException(
        'Debes indicar al menos un tipo de entrenamiento',
      );
    }

    return normalizedTypes;
  }

  private resolveLegacyTrainingType(
    training: Partial<TrainingCatalogRecord>,
    normalizedTypes: string[],
  ): string {
    return (
      normalizedTypes[0] ?? this.normalizeCatalogValue(training.type ?? '')
    );
  }

  private normalizeTrainingAccentColor(value: string | null | undefined) {
    if (value == null) {
      return null;
    }

    const normalizedValue = value.trim();

    if (!normalizedValue) {
      return null;
    }

    if (!TRAINING_ACCENT_COLOR_REGEX.test(normalizedValue)) {
      throw new BadRequestException(
        'El color del entrenamiento debe ser un valor hex valido',
      );
    }

    return `#${normalizedValue.replace(/^#/, '').toUpperCase()}`;
  }

  private serializeTraining<T extends TrainingResponseLike>(training: T) {
    const types = this.resolveTrainingTypes(training);
    const blocks = training.blocks ?? [];
    const flatExercises = (training.exercises ?? []).map((exercise) => {
      const block = blocks.find((candidate) => candidate.id === exercise.block_id);

      return {
        ...exercise,
        block: block
          ? {
              id: block.id,
              order: block.order,
              type: block.type,
              name: block.name,
              rounds: block.rounds,
              rest_between_rounds_seconds:
                block.rest_between_rounds_seconds,
            }
          : null,
      };
    });
    const blockExerciseIds = new Set(
      flatExercises
        .filter((exercise) => exercise.block_id && exercise.id)
        .map((exercise) => exercise.id),
    );
    const items = [
      ...flatExercises
        .filter((exercise) => !blockExerciseIds.has(exercise.id))
        .map((exercise) => ({ kind: 'EXERCISE' as const, ...exercise })),
      ...blocks.map((block) => ({
        kind: 'CIRCUIT' as const,
        id: block.id,
        order: block.order,
        type: block.type,
        name: block.name,
        rounds: block.rounds,
        rest_between_rounds_seconds: block.rest_between_rounds_seconds,
        exercises: block.exercises,
      })),
    ].sort((left, right) => (left.order as number) - (right.order as number));

    return {
      ...training,
      type: this.resolveLegacyTrainingType(training, types),
      types,
      accentColor: training.accentColor ?? null,
      exercises: flatExercises,
      items,
    };
  }

  private resolveTrainingItems(dto: CreateTrainingDto | UpdateTrainingDto) {
    if (dto.items !== undefined) {
      return dto.items;
    }

    return (dto.exercises ?? []).map(
      (exercise): TrainingItemExerciseDto => ({
        kind: 'EXERCISE',
        ...exercise,
      }),
    );
  }

  private async replaceTrainingItems(
    tx: Prisma.TransactionClient,
    trainingId: string,
    dto: CreateTrainingDto | UpdateTrainingDto,
  ) {
    const items = this.resolveTrainingItems(dto);
    const hasCircuits = items.some((item) => item.kind === 'CIRCUIT');

    await tx.trainingExercise.deleteMany({ where: { training_id: trainingId } });
    await tx.trainingBlock.deleteMany({ where: { training_id: trainingId } });

    for (const [index, item] of items.entries()) {
      const order = item.order ?? index;

      if (item.kind === 'CIRCUIT') {
        const circuit = item as TrainingCircuitItemDto;
        const block = await tx.trainingBlock.create({
          data: {
            training_id: trainingId,
            order,
            type: TrainingBlockType.CIRCUIT,
            name: circuit.name?.trim() || 'Circuito',
            rounds: circuit.rounds,
            rest_between_rounds_seconds:
              circuit.rest_between_rounds_seconds ?? 60,
          },
        });

        await tx.trainingExercise.createMany({
          data: circuit.exercises.map((exercise, position) => ({
            training_id: trainingId,
            block_id: block.id,
            exercise_id: exercise.exercise_id,
            order: order * 1000 + position,
            position_in_block: position,
            sets: 1,
            reps_or_duration: exercise.reps_or_duration,
            rest_seconds: exercise.rest_seconds ?? 15,
          })),
        });

        continue;
      }

      const exercise = item as TrainingItemExerciseDto;
      await tx.trainingExercise.create({
        data: {
          training_id: trainingId,
          exercise_id: exercise.exercise_id,
          order: hasCircuits ? order * 1000 : order,
          sets: exercise.sets,
          reps_or_duration: exercise.reps_or_duration,
          rest_seconds: exercise.rest_seconds ?? 60,
        },
      });
    }
  }

  private serializeTrainingCollection<T extends TrainingResponseLike>(
    trainings: T[],
  ) {
    return trainings.map((training) => this.serializeTraining(training));
  }

  private normalizeTrainingTypeValue(value: string) {
    const normalizedValue = this.normalizeCatalogValue(value);

    if (!normalizedValue) {
      throw new BadRequestException(
        'El tipo de entrenamiento no puede estar vací­o',
      );
    }

    return normalizedValue;
  }

  private parseAchievementRuleConfig(
    ruleConfig: Prisma.JsonValue | null,
  ): AchievementRuleConfigLike | null {
    if (
      !ruleConfig ||
      typeof ruleConfig !== 'object' ||
      Array.isArray(ruleConfig)
    ) {
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
        select: { id: true, type: true, types: true },
      }),
      this.prisma.achievement.findMany({
        where: { criteria_type: 'TRAINING_DAYS' },
        select: { id: true, rule_config: true },
      }),
    ]);

    const trainingUpdates = trainings.flatMap((training) => {
      const currentTypes = this.resolveTrainingTypes(training);
      const nextTypes = this.replaceCatalogValue(
        currentTypes,
        normalizedFrom,
        normalizedTo,
      );
      const currentLegacyType = this.resolveLegacyTrainingType(
        training,
        currentTypes,
      );
      const nextLegacyType = this.resolveLegacyTrainingType(
        training,
        nextTypes,
      );
      const shouldUpdateTypes = this.hasCatalogChanged(currentTypes, nextTypes);
      const shouldUpdateLegacyType = currentLegacyType !== nextLegacyType;

      if (!shouldUpdateTypes && !shouldUpdateLegacyType) {
        return [];
      }

      return [
        this.prisma.training.update({
          where: { id: training.id },
          data: {
            ...(shouldUpdateTypes ? { types: nextTypes } : {}),
            ...(shouldUpdateLegacyType ? { type: nextLegacyType } : {}),
          },
        }),
      ];
    });

    const achievementUpdates = achievements.flatMap((achievement) => {
      const ruleConfig = this.parseAchievementRuleConfig(
        achievement.rule_config,
      );
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
      select: { type: true, types: true },
    });

    return {
      types: this.collectUniqueCatalogValues(
        trainings.flatMap((training) => this.resolveTrainingTypes(training)),
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
      group_id,
    } = query;
    const pageSize = limit ?? 20;
    const normalizedSearch = search?.trim();
    const normalizedTypeFilters = type?.length
      ? this.normalizeCatalogValues(type)
      : [];
    const where: Prisma.TrainingWhereInput = {
      is_active: true,
      ...(group_id ? { group_id } : {}),
      ...(normalizedTypeFilters.length
        ? {
            OR: [
              { types: { hasSome: normalizedTypeFilters } },
              { type: { in: normalizedTypeFilters } },
            ],
          }
        : {}),
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

      const pageData = this.serializeTrainingCollection(
        filteredTrainings.slice(skip, skip + pageSize),
      );

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

    return paginate(this.serializeTrainingCollection(data), total, query);
  }

  async updateGroupMembership(trainingIds: string[], groupId: string | null) {
    const ids = [...new Set(trainingIds)];

    return this.prisma.$transaction(async (tx) => {
      if (groupId) {
        const group = await tx.trainingGroup.findUnique({ where: { id: groupId } });
        if (!group) throw new NotFoundException('Grupo de entrenamientos no encontrado');
      }

      const activeCount = await tx.training.count({
        where: { id: { in: ids }, is_active: true },
      });
      if (activeCount !== ids.length) {
        throw new NotFoundException('Uno o más entrenamientos no existen o están inactivos');
      }

      const result = await tx.training.updateMany({
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
        training: {
          include: trainingExercisesInclude,
        },
      },
    });

    if (!assignment || !assignment.training) {
      return null;
    }

    return this.serializeTraining(assignment.training);
  }

  async findOne(id: string) {
    const training = await this.prisma.training.findFirst({
      where: { id, is_active: true },
      include: trainingExercisesInclude,
    });

    if (!training) {
      throw new NotFoundException('Entrenamiento no encontrado');
    }

    return this.serializeTraining(training);
  }

  async create(adminId: string, dto: CreateTrainingDto) {
    const normalizedTypes = this.normalizeTrainingTypesInput(dto);
    const legacyType = this.resolveLegacyTrainingType(dto, normalizedTypes);
    const accentColor = this.normalizeTrainingAccentColor(dto.accentColor);

    return this.prisma
      .$transaction(async (tx) => {
        const training = await tx.training.create({
          data: {
            name: dto.name,
            type: legacyType,
            types: normalizedTypes,
            accentColor,
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

        await this.replaceTrainingItems(tx, training.id, dto);

        return tx.training.findUnique({
          where: { id: training.id },
          include: trainingExercisesInclude,
        });
      })
      .then((training) => this.serializeTraining(training!));
  }

  async update(id: string, dto: UpdateTrainingDto) {
    await this.findOne(id);

    const shouldUpdateTrainingTypes =
      dto.types !== undefined || dto.type !== undefined;
    const normalizedTypes = shouldUpdateTrainingTypes
      ? this.normalizeTrainingTypesInput(dto)
      : null;
    const legacyType =
      normalizedTypes != null
        ? this.resolveLegacyTrainingType(dto, normalizedTypes)
        : null;
    const accentColor =
      dto.accentColor !== undefined
        ? this.normalizeTrainingAccentColor(dto.accentColor)
        : undefined;

    return this.prisma
      .$transaction(async (tx) => {
        await tx.training.update({
          where: { id },
          data: {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(normalizedTypes !== null && {
              type: legacyType!,
              types: normalizedTypes,
            }),
            ...(dto.accentColor !== undefined && {
              accentColor,
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

        if (dto.items !== undefined || dto.exercises !== undefined) {
          await this.replaceTrainingItems(tx, id, dto);
        }

        return tx.training.findUnique({
          where: { id },
          include: trainingExercisesInclude,
        });
      })
      .then((training) => this.serializeTraining(training!));
  }

  async remove(id: string) {
    await this.findOne(id);

    await this.prisma.training.update({
      where: { id },
      data: { is_active: false },
    });
  }
}

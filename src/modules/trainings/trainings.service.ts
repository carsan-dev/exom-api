import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CatalogColorType, Prisma, TrainingBlockType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import {
  CreateTrainingDto,
  TrainingCircuitItemDto,
  TrainingItemExerciseDto,
  UpdateTrainingDto,
} from './dto/create-training.dto';
import { TrainingsQueryDto } from './dto/trainings-query.dto';
import { reconcileTrainingProgress } from '../../common/progress/plan-progress-reconciliation';
import { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';
import { lockClientsDayProgress } from '../../common/progress/day-progress-lock';

type TrainingSortField =
  | 'name'
  | 'level'
  | 'estimated_duration_min'
  | 'estimated_calories'
  | 'updated_at'
  | 'created_at';

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
      exercise_id?: string;
      order?: number;
      block_id?: string | null;
      position_in_block?: number | null;
    }
  >;
};

type TrainingProgressLike = {
  training_completed: boolean;
  trainings_completed: string[];
  exercises_completed: Prisma.JsonValue;
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

const trainingListSelect = {
  id: true,
  name: true,
  type: true,
  types: true,
  accentColor: true,
  level: true,
  estimated_duration_min: true,
  estimated_calories: true,
  total_volume: true,
  warmup_description: true,
  warmup_duration_min: true,
  cooldown_description: true,
  tags: true,
  is_active: true,
  created_by: true,
  created_at: true,
  updated_at: true,
  group_id: true,
  group: { select: { id: true, name: true } },
  _count: { select: { exercises: true } },
};

const TRAINING_ACCENT_COLOR_REGEX = /^#?(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const CATALOG_COLOR_REGEX = /^#(?:[0-9A-Fa-f]{6})$/;
const DEFAULT_CATALOG_COLOR = '#6B7280';

function normalizeSearchText(value: string) {
  return value
    .toLocaleLowerCase('es-ES')
    .normalize('NFD')
    .replace(/([aeiou])([\u0300-\u036f]+)/g, '$1')
    .normalize('NFC');
}

@Injectable()
export class TrainingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoAssignmentMaterializer: AutoAssignmentMaterializerService,
  ) {}

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

  private hasRecordedTrainingProgress(
    training: {
      id: string;
      exercises?: Array<{ id?: string; exercise_id?: string }>;
    },
    progress: TrainingProgressLike | null | undefined,
    assignedTrainingCount: number,
  ): boolean {
    if (!progress) return false;
    if (progress.trainings_completed.includes(training.id)) return true;

    const completedEntries = Array.isArray(progress.exercises_completed)
      ? (progress.exercises_completed as Array<{
          training_exercise_id?: string;
          exercise_id?: string;
        }>)
      : [];
    const trainingExerciseIds = new Set(
      (training.exercises ?? [])
        .map((exercise) => exercise.id)
        .filter((id): id is string => Boolean(id)),
    );
    const exerciseIds = new Set(
      (training.exercises ?? [])
        .map((exercise) => exercise.exercise_id)
        .filter((id): id is string => Boolean(id)),
    );

    if (
      completedEntries.some((entry) =>
        entry.training_exercise_id
          ? trainingExerciseIds.has(entry.training_exercise_id)
          : Boolean(entry.exercise_id && exerciseIds.has(entry.exercise_id)),
      )
    ) {
      return true;
    }

    return assignedTrainingCount === 1 && progress.training_completed;
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
  ): Promise<Set<string>> {
    const items = this.resolveTrainingItems(dto);
    const hasCircuits = items.some((item) => item.kind === 'CIRCUIT');
    const existingBlocks = await tx.trainingBlock.findMany({
      where: { training_id: trainingId },
      select: { id: true },
    });
    const existingExercises = await tx.trainingExercise.findMany({
      where: { training_id: trainingId },
      select: { id: true },
    });
    const existingBlockIds = new Set(existingBlocks.map((block) => block.id));
    const existingExerciseIds = new Set(
      existingExercises.map((exercise) => exercise.id),
    );
    const nextBlockIds = new Set(
      items
        .filter((item) => item.kind === 'CIRCUIT' && item.id)
        .map((item) => item.id!),
    );
    const nextExerciseIds = new Set(
      items.flatMap((item) =>
        item.kind === 'CIRCUIT'
          ? item.exercises
              .filter((exercise) => exercise.id)
              .map((exercise) => exercise.id!)
          : item.id
            ? [item.id]
            : [],
      ),
    );

    for (const blockId of nextBlockIds) {
      if (!existingBlockIds.has(blockId)) {
        throw new BadRequestException('El circuito indicado no pertenece al entrenamiento');
      }
    }
    for (const exerciseId of nextExerciseIds) {
      if (!existingExerciseIds.has(exerciseId)) {
        throw new BadRequestException('El ejercicio indicado no pertenece al entrenamiento');
      }
    }

    const deletedExerciseIds = new Set(
      [...existingExerciseIds].filter((id) => !nextExerciseIds.has(id)),
    );
    await tx.trainingExercise.deleteMany({
      where: {
        training_id: trainingId,
        id: { in: [...deletedExerciseIds] },
      },
    });
    await tx.trainingBlock.deleteMany({
      where: {
        training_id: trainingId,
        id: { in: [...existingBlockIds].filter((id) => !nextBlockIds.has(id)) },
      },
    });

    await Promise.all(
      [...nextBlockIds].map((blockId, index) =>
        tx.trainingBlock.update({
          where: { id: blockId },
          data: { order: -100000 - index },
        }),
      ),
    );
    await Promise.all(
      [...nextExerciseIds].map((exerciseId, index) =>
        tx.trainingExercise.update({
          where: { id: exerciseId },
          data: { order: -100000 - index, position_in_block: null },
        }),
      ),
    );

    for (const [index, item] of items.entries()) {
      const order = item.order ?? index;

      if (item.kind === 'CIRCUIT') {
        const circuit = item as TrainingCircuitItemDto;
        const blockData = {
            training_id: trainingId,
            order,
            type: TrainingBlockType.CIRCUIT,
            name: circuit.name?.trim() || 'Circuito',
            rounds: circuit.rounds,
            rest_between_rounds_seconds:
              circuit.rest_between_rounds_seconds ?? 60,
        };
        const block = circuit.id
          ? await tx.trainingBlock.update({
              where: { id: circuit.id },
              data: blockData,
              select: { id: true },
            })
          : await tx.trainingBlock.create({
              data: blockData,
              select: { id: true },
            });

        for (const [position, exercise] of circuit.exercises.entries()) {
          const exerciseData = {
            training_id: trainingId,
            block_id: block.id,
            exercise_id: exercise.exercise_id,
            order: order * 1000 + position,
            position_in_block: position,
            sets: 1,
            reps_or_duration: exercise.reps_or_duration,
            request_set_tracking: exercise.request_set_tracking ?? false,
            rest_seconds: exercise.rest_seconds ?? 15,
          };

          if (exercise.id) {
            await tx.trainingExercise.update({
              where: { id: exercise.id },
              data: exerciseData,
            });
          } else {
            await tx.trainingExercise.create({ data: exerciseData });
          }
        }

        continue;
      }

      const exercise = item as TrainingItemExerciseDto;
      const exerciseData = {
          training_id: trainingId,
          block_id: null,
          exercise_id: exercise.exercise_id,
          order: hasCircuits ? order * 1000 : order,
          position_in_block: null,
          sets: exercise.sets,
          reps_or_duration: exercise.reps_or_duration,
          request_set_tracking: exercise.request_set_tracking ?? false,
          rest_seconds: exercise.rest_seconds ?? 60,
      };

      if (exercise.id) {
        await tx.trainingExercise.update({
          where: { id: exercise.id },
          data: exerciseData,
        });
      } else {
        await tx.trainingExercise.create({ data: exerciseData });
      }
    }

    return deletedExerciseIds;
  }

  private async reconcileAssignedProgress(
    tx: Prisma.TransactionClient,
    trainingId: string,
    explicitlyDeletedIds: ReadonlySet<string>,
  ) {
    const [currentExercises, assignments] = await Promise.all([
      tx.trainingExercise.findMany({
        where: { training_id: trainingId },
        select: { id: true, exercise_id: true },
      }),
      tx.planAssignment.findMany({
        where: {
          OR: [
            { training_id: trainingId },
            { trainings: { some: { training_id: trainingId } } },
          ],
        },
        select: {
          client_id: true,
          date: true,
          trainings: { orderBy: { position: 'asc' }, select: { training_id: true } },
          training_id: true,
        },
      }),
    ]);
    if (!assignments.length) return;

    await lockClientsDayProgress(
      tx,
      assignments.map((assignment) => assignment.client_id),
    );

    const progresses = await tx.dayProgress.findMany({
      where: {
        OR: assignments.map(({ client_id, date }) => ({ client_id, date })),
      },
    });
    const assignedKeys = new Set(
      assignments.map(({ client_id, date }) => `${client_id}:${date.toISOString()}`),
    );

    for (const progress of progresses) {
      const key = `${progress.client_id}:${progress.date.toISOString()}`;
      if (!assignedKeys.has(key)) continue;
      const reconciled = reconcileTrainingProgress(
        progress.exercises_completed,
        currentExercises,
        explicitlyDeletedIds,
      );
      const completedIds = new Set(progress.trainings_completed);
      if (reconciled.trainingCompleted) completedIds.add(trainingId);
      else completedIds.delete(trainingId);
      const assignment = assignments.find(
        (item) => `${item.client_id}:${item.date.toISOString()}` === key,
      )!;
      const assignedIds = assignment.trainings.length
        ? assignment.trainings.map((link) => link.training_id)
        : assignment.training_id ? [assignment.training_id] : [];
      await tx.dayProgress.update({
        where: { id: progress.id },
        data: {
          exercises_completed: reconciled.entries as unknown as Prisma.InputJsonValue,
          trainings_completed: [...completedIds].filter((id) => assignedIds.includes(id)),
          training_completed: assignedIds.length > 0 && assignedIds.every((id) => completedIds.has(id)),
        },
      });
    }
  }

  private serializeTrainingCollection<T extends TrainingResponseLike>(
    trainings: T[],
  ) {
    return trainings.map((training) => this.serializeTraining(training));
  }

  private serializeTrainingListItem<
    T extends TrainingCatalogRecord & {
      accentColor?: string | null;
      _count?: { exercises: number };
    },
  >(training: T) {
    const { _count, ...data } = training;
    const types = this.resolveTrainingTypes(training);

    return {
      ...data,
      type: this.resolveLegacyTrainingType(training, types),
      types,
      accentColor: training.accentColor ?? null,
      exercises_count: _count?.exercises ?? 0,
    };
  }

  private serializeTrainingList<
    T extends TrainingCatalogRecord & {
      accentColor?: string | null;
      _count?: { exercises: number };
    },
  >(trainings: T[]) {
    return trainings.map((training) => this.serializeTrainingListItem(training));
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

  deleteTags(values: string[]) {
    const keys = new Set(values.map((value) => this.getCatalogKey(value)));
    return this.mutateTags(values[0], (current) =>
      current.filter((value) => !keys.has(this.getCatalogKey(value))),
    ).then((result) => ({ values, affected_count: result.affected_count }));
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

    const colorUpdate = this.prisma.catalogColor.upsert({
      where: {
        catalog_type_normalized_key: {
          catalog_type: CatalogColorType.training_type,
          normalized_key: this.getCatalogKey(normalizedFrom),
        },
      },
      update: {
        normalized_key: this.getCatalogKey(normalizedTo),
        value: normalizedTo,
      },
      create: {
        catalog_type: CatalogColorType.training_type,
        normalized_key: this.getCatalogKey(normalizedTo),
        value: normalizedTo,
        color: DEFAULT_CATALOG_COLOR,
      },
    });
    const updates = [...trainingUpdates, ...achievementUpdates, colorUpdate];

    if (updates.length > 0) {
      await this.prisma.$transaction(updates);
    }

    return {
      value: normalizedTo,
      affected_count: trainingUpdates.length + achievementUpdates.length,
    };
  }

  async deleteTypes(values: string[]) {
    const normalizedValues = this.normalizeCatalogValues(values);
    const keys = new Set(
      normalizedValues.map((value) => this.getCatalogKey(value)),
    );
    const [trainings, achievements] = await Promise.all([
      this.prisma.training.findMany({
        where: { is_active: true },
        select: { id: true, name: true, type: true, types: true },
      }),
      this.prisma.achievement.findMany({
        where: { criteria_type: 'TRAINING_DAYS' },
        select: { id: true, name: true, rule_config: true },
      }),
    ]);

    const referencedAchievements = achievements.filter((achievement) => {
      const trainingType = this.parseAchievementRuleConfig(
        achievement.rule_config,
      )?.training_type;
      return Boolean(trainingType && keys.has(this.getCatalogKey(trainingType)));
    });
    const plannedUpdates = trainings.flatMap((training) => {
      const currentTypes = this.resolveTrainingTypes(training);
      const nextTypes = currentTypes.filter(
        (value) => !keys.has(this.getCatalogKey(value)),
      );
      return this.hasCatalogChanged(currentTypes, nextTypes)
        ? [{ training, nextTypes }]
        : [];
    });
    const trainingsWithoutType = plannedUpdates.filter(
      ({ nextTypes }) => nextTypes.length === 0,
    );

    const blockers = [
      ...(trainingsWithoutType.length > 0
        ? [`dejaría ${trainingsWithoutType.length} ${trainingsWithoutType.length === 1 ? 'entrenamiento' : 'entrenamientos'} sin tipo`]
        : []),
      ...(referencedAchievements.length > 0
        ? [`afectaría ${referencedAchievements.length} ${referencedAchievements.length === 1 ? 'logro configurado' : 'logros configurados'}`]
        : []),
    ];
    if (blockers.length > 0) {
      throw new BadRequestException(
        `No se pueden eliminar los tipos seleccionados: ${blockers.join(' y ')}.`,
      );
    }

    const updates = plannedUpdates.map(({ training, nextTypes }) =>
      this.prisma.training.update({
        where: { id: training.id },
        data: { types: nextTypes, type: nextTypes[0] },
      }),
    );
    if (updates.length > 0) {
      await this.prisma.$transaction(updates);
    }

    return { values: normalizedValues, affected_count: updates.length };
  }

  async deleteType(value: string) {
    const result = await this.deleteTypes([value]);
    return { value: result.values[0], affected_count: result.affected_count };
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

    const values = this.collectUniqueCatalogValues(
      trainings.flatMap((training) => this.resolveTrainingTypes(training)),
    );

    return {
      types: await this.enrichCatalogValuesWithColors(
        CatalogColorType.training_type,
        values,
      ),
    };
  }

  async updateTypeColor(value: string, color: string) {
    const normalizedValue = this.normalizeTrainingTypeValue(value);
    const normalizedColor = this.normalizeCatalogColor(color);
    const colorRow = await this.prisma.catalogColor.upsert({
      where: {
        catalog_type_normalized_key: {
          catalog_type: CatalogColorType.training_type,
          normalized_key: this.getCatalogKey(normalizedValue),
        },
      },
      update: { value: normalizedValue, color: normalizedColor },
      create: {
        catalog_type: CatalogColorType.training_type,
        normalized_key: this.getCatalogKey(normalizedValue),
        value: normalizedValue,
        color: normalizedColor,
      },
    });

    return { value: colorRow.value, color: colorRow.color };
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
      ungrouped,
    } = query;
    const pageSize = limit ?? 20;
    const sortBy = this.getTrainingSortField(query.sort_by);
    const sortDir = query.sort_by ? (query.sort_dir ?? 'asc') : 'desc';
    if (group_id && ungrouped) {
      throw new BadRequestException(
        'No se puede combinar group_id con ungrouped',
      );
    }
    const normalizedSearch = search?.trim();
    const normalizedTypeFilters = type?.length
      ? this.normalizeCatalogValues(type)
      : [];
    const where: Prisma.TrainingWhereInput = {
      is_active: true,
      ...(group_id ? { group_id } : {}),
      ...(ungrouped ? { group_id: null } : {}),
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
        orderBy: this.getTrainingOrderBy(sortBy, sortDir),
        select: trainingListSelect,
      });

      const filteredTrainings = trainings.filter((training) =>
        normalizeSearchText(training.name).includes(normalizedSearchTerm),
      );

      const pageData = this.serializeTrainingList(
        filteredTrainings.slice(skip, skip + pageSize),
      );

      return paginate(pageData, filteredTrainings.length, query);
    }

    const [data, total] = await Promise.all([
      this.prisma.training.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: this.getTrainingOrderBy(sortBy, sortDir),
        select: trainingListSelect,
      }),
      this.prisma.training.count({ where }),
    ]);

    return paginate(this.serializeTrainingList(data), total, query);
  }

  private getTrainingSortField(value?: string): TrainingSortField {
    const allowed = new Set<TrainingSortField>([
      'name',
      'level',
      'estimated_duration_min',
      'estimated_calories',
      'updated_at',
      'created_at',
    ]);

    return value && allowed.has(value as TrainingSortField)
      ? (value as TrainingSortField)
      : 'created_at';
  }

  private getTrainingOrderBy(
    sortBy: TrainingSortField,
    sortDir: 'asc' | 'desc',
  ): Prisma.TrainingOrderByWithRelationInput[] {
    return [{ [sortBy]: sortDir }, { id: sortDir }];
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
    const day = await this.findDay(clientId, date);
    return day.trainings[0] ?? null;
  }

  async findDay(clientId: string, date?: Date) {
    const now = date ?? new Date();
    const target = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    // Rules are indefinite. Reconcile this independently requested day before
    // resolving its actionable trainings.
    await this.autoAssignmentMaterializer.reconcile(clientId, {
      start: target,
      end: target,
      dates: [target],
    });

    const assignment = await this.prisma.planAssignment.findUnique({
      where: { client_id_date: { client_id: clientId, date: target } },
      include: {
        trainings: {
          orderBy: { position: 'asc' },
          include: { training: { include: trainingExercisesInclude } },
        },
        training: {
          include: trainingExercisesInclude,
        },
      },
    });

    const progress = await this.prisma.dayProgress.findUnique({
      where: { client_id_date: { client_id: clientId, date: target } },
      select: {
        training_completed: true,
        trainings_completed: true,
        exercises_completed: true,
      },
    });
    type AssignedTraining = NonNullable<
      NonNullable<typeof assignment>['training']
    >;
    const candidateTrainingLinks: Array<{
      training: AssignedTraining;
      assignmentTrainingId: string | null;
      requiresLastSetVideo: boolean;
    }> = assignment?.trainings.length
      ? assignment.trainings.map((link) => ({
          training: link.training,
          assignmentTrainingId: link.id,
          requiresLastSetVideo: link.requires_last_set_video,
        }))
      : assignment?.training
        ? [
            {
              training: assignment.training,
              assignmentTrainingId: null,
              requiresLastSetVideo: false,
            },
          ]
        : [];
    const hasRecordedAssignmentProgress = candidateTrainingLinks.some((link) =>
      this.hasRecordedTrainingProgress(
        link.training,
        progress,
        candidateTrainingLinks.length,
      ),
    );
    const assignedTrainingLinks = candidateTrainingLinks.filter(
      (link) => link.training.is_active || hasRecordedAssignmentProgress,
    );
    const assignedTrainings = assignedTrainingLinks.map(
      (link) => link.training,
    );
    const completedIds = new Set(progress?.trainings_completed ?? []);
    const completedEntries = Array.isArray(progress?.exercises_completed)
      ? (progress.exercises_completed as Array<{
          training_exercise_id?: string;
          exercise_id?: string;
        }>)
      : [];
    const completedTrainingExerciseIds = new Set(
      completedEntries
        .map((entry) => entry.training_exercise_id)
        .filter((id): id is string => Boolean(id)),
    );
    const legacyExerciseCounts = new Map<string, number>();
    for (const entry of completedEntries) {
      if (entry.training_exercise_id || !entry.exercise_id) continue;
      legacyExerciseCounts.set(
        entry.exercise_id,
        (legacyExerciseCounts.get(entry.exercise_id) ?? 0) + 1,
      );
    }
    const currentCompletedTrainingExerciseIds = new Set<string>();
    for (const training of assignedTrainings) {
      for (const exercise of training.exercises) {
        if (completedTrainingExerciseIds.has(exercise.id)) {
          currentCompletedTrainingExerciseIds.add(exercise.id);
          continue;
        }
        const legacyCount = legacyExerciseCounts.get(exercise.exercise_id) ?? 0;
        if (legacyCount === 0) continue;
        currentCompletedTrainingExerciseIds.add(exercise.id);
        if (legacyCount === 1)
          legacyExerciseCounts.delete(exercise.exercise_id);
        else legacyExerciseCounts.set(exercise.exercise_id, legacyCount - 1);
      }
    }
    const legacyDayCompletion = Boolean(
      assignedTrainings.length === 1 &&
      progress?.training_completed &&
      completedIds.size === 0 &&
      completedEntries.length === 0,
    );
    const serializedTrainings = assignedTrainingLinks.map(
      ({ training, assignmentTrainingId, requiresLastSetVideo }) => ({
        ...this.serializeTraining(training),
        assignment_training_id: assignmentTrainingId,
        assignment_date: target.toISOString().split('T')[0],
        requires_last_set_video: requiresLastSetVideo,
        completed:
          completedIds.has(training.id) ||
          (training.exercises.length > 0 &&
            training.exercises.every((exercise) =>
              currentCompletedTrainingExerciseIds.has(exercise.id),
            )) ||
          legacyDayCompletion,
      }),
    );
    return {
      date: target.toISOString().split('T')[0],
      training_completed:
        serializedTrainings.length > 0 &&
        serializedTrainings.every((training) => training.completed),
      trainings: serializedTrainings,
    };
  }

  async findOne(id: string, clientId?: string, date?: Date) {
    const hasAssignmentContext = Boolean(clientId && date);
    const training = await this.prisma.training.findFirst({
      where: hasAssignmentContext ? { id } : { id, is_active: true },
      include: trainingExercisesInclude,
    });

    if (!training) {
      throw new NotFoundException('Entrenamiento no encontrado');
    }

    const serialized = this.serializeTraining(training);
    if (!clientId || !date) return serialized;
    const target = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    await this.autoAssignmentMaterializer.reconcile(clientId, {
      start: target,
      end: target,
      dates: [target],
    });
    const assignment = await this.prisma.planAssignment.findUnique({
      where: { client_id_date: { client_id: clientId, date: target } },
      select: {
        trainings: {
          select: {
            id: true,
            training_id: true,
            requires_last_set_video: true,
            training: {
              select: {
                id: true,
                exercises: { select: { id: true, exercise_id: true } },
              },
            },
          },
        },
        training_id: true,
        training: {
          select: {
            id: true,
            exercises: { select: { id: true, exercise_id: true } },
          },
        },
      },
    });
    const link = assignment?.trainings.find((item) => item.training_id === id);
    const isLegacyAssignment = assignment?.training_id === id;
    if (training.is_active === false) {
      const progress = await this.prisma.dayProgress.findUnique({
        where: { client_id_date: { client_id: clientId, date: target } },
        select: {
          training_completed: true,
          trainings_completed: true,
          exercises_completed: true,
        },
      });
      const assignedTrainingCount = assignment?.trainings.length
        ? assignment.trainings.length
        : assignment?.training_id
          ? 1
          : 0;
      const assignedTrainings = assignment?.trainings.length
        ? assignment.trainings.map((item) => item.training)
        : assignment?.training
          ? [assignment.training]
          : [];
      const hasRecordedAssignmentProgress = assignedTrainings.some(
        (assignedTraining) =>
          this.hasRecordedTrainingProgress(
            assignedTraining,
            progress,
            assignedTrainingCount,
          ),
      );
      if ((!link && !isLegacyAssignment) || !hasRecordedAssignmentProgress) {
        throw new NotFoundException('Entrenamiento no encontrado');
      }
    }
    return {
      ...serialized,
      assignment_training_id: link?.id ?? null,
      assignment_date: target.toISOString().split('T')[0],
      requires_last_set_video: link?.requires_last_set_video ?? false,
    };
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
          const deletedIds = await this.replaceTrainingItems(tx, id, dto);
          await this.reconcileAssignedProgress(tx, id, deletedIds);
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

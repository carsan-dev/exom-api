import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ManagedUploadPurpose, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { paginate } from '../../common/dto/pagination.dto';
import {
  CreateExerciseDto,
  UpdateExerciseDto,
} from './dto/create-exercise.dto';
import { ExercisesQueryDto } from './dto/exercises-query.dto';
import { UploadsService } from '../uploads/uploads.service';

type ExerciseCatalogField = 'muscle_groups' | 'equipment';
type ExerciseSortField =
  | 'name'
  | 'level'
  | 'video'
  | 'training_usage_count'
  | 'created_at'
  | 'updated_at';

function normalizeSearchText(value: string) {
  return value
    .toLocaleLowerCase('es-ES')
    .normalize('NFD')
    .replace(/([aeiou])([\u0300-\u036f]+)/g, '$1')
    .normalize('NFC');
}

@Injectable()
export class ExercisesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
  ) {}

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

  deleteMuscleGroups(values: string[]) {
    const keys = new Set(values.map((value) => this.getCatalogKey(value)));
    return this.mutateExerciseCatalog('muscle_groups', values[0], (current) =>
      current.filter((value) => !keys.has(this.getCatalogKey(value))),
    ).then((result) => ({ values, affected_count: result.affected_count }));
  }

  renameEquipment(from: string, to: string) {
    return this.renameExerciseCatalogValue('equipment', from, to);
  }

  deleteEquipment(value: string) {
    return this.mutateExerciseCatalog('equipment', value, (values) =>
      this.removeCatalogValue(values, value),
    );
  }


  deleteEquipmentValues(values: string[]) {
    const keys = new Set(values.map((value) => this.getCatalogKey(value)));
    return this.mutateExerciseCatalog('equipment', values[0], (current) =>
      current.filter((value) => !keys.has(this.getCatalogKey(value))),
    ).then((result) => ({ values, affected_count: result.affected_count }));
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
    const {
      search,
      muscle_groups,
      equipment,
      level,
      training_usage,
      skip,
      limit,
    } = query;
    const pageSize = limit ?? 20;
    const normalizedSearch = search?.trim();
    const sortBy = this.getExerciseSortField(query.sort_by);
    const sortDir = query.sort_by ? (query.sort_dir ?? 'asc') : 'desc';
    const where: Prisma.ExerciseWhereInput = {
      is_active: true,
      ...(muscle_groups?.length
        ? { muscle_groups: { hasSome: muscle_groups } }
        : {}),
      ...(equipment?.length ? { equipment: { hasSome: equipment } } : {}),
      ...(level?.length ? { level: { in: level } } : {}),
    };
    const requiresMemoryPagination =
      Boolean(normalizedSearch) ||
      training_usage === 'used' ||
      training_usage === 'unused' ||
      sortBy === 'training_usage_count' ||
      sortBy === 'video';

    if (requiresMemoryPagination) {
      const normalizedSearchTerm = normalizedSearch
        ? normalizeSearchText(normalizedSearch)
        : '';
      const exercises = await this.prisma.exercise.findMany({
        where,
        orderBy: this.getExerciseOrderBy(sortBy, sortDir),
      });

      const filteredExercises = normalizedSearch
        ? exercises.filter((exercise) =>
            normalizeSearchText(exercise.name).includes(normalizedSearchTerm),
          )
        : exercises;

      let exercisesWithUsage = await this.withTrainingUsage(filteredExercises);

      if (training_usage === 'used') {
        exercisesWithUsage = exercisesWithUsage.filter(
          (exercise) => exercise.training_usage_count > 0,
        );
      }

      if (training_usage === 'unused') {
        exercisesWithUsage = exercisesWithUsage.filter(
          (exercise) => exercise.training_usage_count === 0,
        );
      }

      if (sortBy === 'training_usage_count' || sortBy === 'video') {
        exercisesWithUsage = this.sortExercisesInMemory(
          exercisesWithUsage,
          sortBy,
          sortDir,
        );
      }

      const pageData = exercisesWithUsage.slice(skip, skip + pageSize);

      return paginate(pageData, exercisesWithUsage.length, query);
    }

    const [data, total] = await Promise.all([
      this.prisma.exercise.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: this.getExerciseOrderBy(sortBy, sortDir),
      }),
      this.prisma.exercise.count({ where }),
    ]);

    return paginate(await this.withTrainingUsage(data), total, query);
  }

  private getExerciseSortField(value?: string): ExerciseSortField {
    const allowed = new Set<ExerciseSortField>([
      'name',
      'level',
      'video',
      'training_usage_count',
      'created_at',
      'updated_at',
    ]);

    return value && allowed.has(value as ExerciseSortField)
      ? (value as ExerciseSortField)
      : 'created_at';
  }

  private getExerciseOrderBy(
    sortBy: ExerciseSortField,
    sortDir: 'asc' | 'desc',
  ): Prisma.ExerciseOrderByWithRelationInput[] {
    if (sortBy === 'training_usage_count' || sortBy === 'video') {
      return [{ created_at: 'desc' }, { id: 'desc' }];
    }

    return [{ [sortBy]: sortDir }, { id: sortDir }];
  }

  private sortExercisesInMemory<T extends { id: string; video_url?: string | null; training_usage_count: number }>(
    exercises: T[],
    sortBy: Extract<ExerciseSortField, 'training_usage_count' | 'video'>,
    sortDir: 'asc' | 'desc',
  ) {
    const direction = sortDir === 'asc' ? 1 : -1;

    return [...exercises].sort((left, right) => {
      const leftValue =
        sortBy === 'video'
          ? Number(Boolean(left.video_url))
          : left.training_usage_count;
      const rightValue =
        sortBy === 'video'
          ? Number(Boolean(right.video_url))
          : right.training_usage_count;

      if (leftValue !== rightValue) {
        return (leftValue - rightValue) * direction;
      }

      return left.id.localeCompare(right.id) * direction;
    });
  }

  private async withTrainingUsage<T extends { id: string }>(
    exercises: T[],
  ): Promise<Array<T & { training_usage_count: number; is_used_in_training: boolean }>> {
    if (exercises.length === 0) {
      return [];
    }

    const usages = await this.prisma.trainingExercise.findMany({
      where: {
        exercise_id: { in: exercises.map((exercise) => exercise.id) },
        training: { is_active: true },
      },
      select: { exercise_id: true, training_id: true },
      distinct: ['exercise_id', 'training_id'],
    });
    const counts = new Map<string, number>();
    for (const usage of usages) {
      counts.set(usage.exercise_id, (counts.get(usage.exercise_id) ?? 0) + 1);
    }

    return exercises.map((exercise) => {
      const trainingUsageCount = counts.get(exercise.id) ?? 0;
      return {
        ...exercise,
        training_usage_count: trainingUsageCount,
        is_used_in_training: trainingUsageCount > 0,
      };
    });
  }

  async getTrainingUsage(id: string) {
    await this.findOne(id);
    const usages = await this.prisma.trainingExercise.findMany({
      where: { exercise_id: id, training: { is_active: true } },
      select: { training: { select: { id: true, name: true } } },
      distinct: ['training_id'],
    });
    const trainings = usages
      .map((usage) => usage.training)
      .sort((left, right) => left.name.localeCompare(right.name, 'es', { sensitivity: 'base' }));

    return { exercise_id: id, training_count: trainings.length, trainings };
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
    const video = dto.video_upload_id || dto.video_url
      ? await this.uploadsService.prepareForConsumption({
          ownerId: userId,
          uploadId: dto.video_upload_id,
          legacyUrl: dto.video_url,
          purposes: [ManagedUploadPurpose.EXERCISE_VIDEO],
        })
      : null;
    const thumbnail = dto.thumbnail_upload_id || dto.thumbnail_url
      ? await this.uploadsService.prepareForConsumption({
          ownerId: userId,
          uploadId: dto.thumbnail_upload_id,
          legacyUrl: dto.thumbnail_url,
          purposes: [ManagedUploadPurpose.EXERCISE_THUMBNAIL],
        })
      : null;
    return this.prisma.$transaction(async (tx) => {
      const exercise = await tx.exercise.create({
        data: {
        name: dto.name,
        muscle_groups: this.normalizeCatalogValues(dto.muscle_groups),
        equipment: this.normalizeCatalogValues(dto.equipment),
        level: dto.level,
        video_url: video?.file_url ?? null,
        video_stream_id: dto.video_stream_id ?? null,
        thumbnail_url: thumbnail?.file_url ?? null,
        technique_text: dto.technique_text ?? null,
        common_errors_text: dto.common_errors_text ?? null,
        explanation_text: dto.explanation_text ?? null,
        created_by: userId,
        },
      });
      if (video) {
        await this.uploadsService.consumePrepared(tx, userId, video.id, [ManagedUploadPurpose.EXERCISE_VIDEO]);
      }
      if (thumbnail) {
        await this.uploadsService.consumePrepared(tx, userId, thumbnail.id, [ManagedUploadPurpose.EXERCISE_THUMBNAIL]);
      }
      return exercise;
    });
  }

  async update(
    id: string,
    dto: UpdateExerciseDto,
    userId?: string,
    approvalRequestId?: string,
  ) {
    const existing = await this.findOne(id);
    const shouldReplaceVideo = dto.video_upload_id ||
      (dto.video_url !== undefined && dto.video_url !== null &&
        !this.uploadsService.referencesSame(dto.video_url, existing.video_url));
    const shouldReplaceThumbnail = dto.thumbnail_upload_id ||
      (dto.thumbnail_url !== undefined && dto.thumbnail_url !== null &&
        !this.uploadsService.referencesSame(dto.thumbnail_url, existing.thumbnail_url));
    if ((shouldReplaceVideo || shouldReplaceThumbnail) && !userId) {
      throw new BadRequestException('Falta el propietario de la subida gestionada');
    }
    const video = shouldReplaceVideo
      ? await this.uploadsService.prepareForConsumption({
          ownerId: userId!, uploadId: dto.video_upload_id, legacyUrl: dto.video_url,
          purposes: [ManagedUploadPurpose.EXERCISE_VIDEO],
          approvalRequestId,
        })
      : null;
    const thumbnail = shouldReplaceThumbnail
      ? await this.uploadsService.prepareForConsumption({
          ownerId: userId!, uploadId: dto.thumbnail_upload_id, legacyUrl: dto.thumbnail_url,
          purposes: [ManagedUploadPurpose.EXERCISE_THUMBNAIL],
          approvalRequestId,
        })
      : null;

    return this.prisma.$transaction(async (tx) => {
      const exercise = await tx.exercise.update({
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
        ...(dto.video_url === null && { video_url: null }),
        ...(video && { video_url: video.file_url }),
        ...(dto.video_stream_id !== undefined && {
          video_stream_id: dto.video_stream_id,
        }),
        ...(dto.thumbnail_url === null && { thumbnail_url: null }),
        ...(thumbnail && { thumbnail_url: thumbnail.file_url }),
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
      if (video) await this.uploadsService.consumePrepared(tx, userId!, video.id, [ManagedUploadPurpose.EXERCISE_VIDEO], approvalRequestId);
      if (thumbnail) await this.uploadsService.consumePrepared(tx, userId!, thumbnail.id, [ManagedUploadPurpose.EXERCISE_THUMBNAIL], approvalRequestId);
      return exercise;
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

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  FeedbackKind,
  ManagedUploadPurpose,
  MediaType,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { PrismaService } from '../../prisma/prisma.service';

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StreakCalculatorService } from '../streaks/streak-calculator.service';
import {
  CompleteTrainingDto,
  MarkExerciseDto,
  MarkMealDto,
} from './dto/mark-completed.dto';
import { parseDateOnly } from '../../common/date-only';
import { UploadsService } from '../uploads/uploads.service';
import { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';
import {
  DAY_PROGRESS_TRANSACTION_OPTIONS,
  lockClientDayProgress,
} from '../../common/progress/day-progress-lock';

interface ExerciseCompletedEntry {
  training_exercise_id?: string;
  exercise_id: string;
  weight_used?: number;
  sets?: Array<{
    set_number: number;
    reps?: number;
    seconds?: number;
    weight_kg?: number;
  }>;
  completed_at: string;
  last_set_feedback_client_upload_id?: string;
}

interface AssignmentContext {
  date: Date;
  trainingIds: string[];
  trainingExerciseIds: Set<string>;
  exerciseIdByTrainingExerciseId: Map<string, string>;
  trainingIdByTrainingExerciseId: Map<string, string>;
  trainingExerciseIdsByTrainingId: Map<string, Set<string>>;
  exerciseIdsByTrainingId: Map<string, Set<string>>;
  requiredTrainingExerciseIds: Set<string>;
  mealIds: Set<string>;
  mealGroupById: Map<string, string>;
}

@Injectable()
export class ProgressService {
  private readonly logger = new Logger(ProgressService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly challengesService: ChallengesService,
    private readonly achievementsService: AchievementsService,
    private readonly notifications: NotificationsService,
    private readonly streakCalculator: StreakCalculatorService,
    private readonly uploadsService: UploadsService,
    private readonly autoAssignmentMaterializer: AutoAssignmentMaterializerService,
  ) {}

  private parseExercisesCompleted(
    value: Prisma.JsonValue | null,
  ): ExerciseCompletedEntry[] {
    return Array.isArray(value)
      ? (value as unknown as ExerciseCompletedEntry[])
      : [];
  }

  private serializeExercisesCompleted(
    entries: ExerciseCompletedEntry[],
  ): Prisma.InputJsonValue {
    return entries as unknown as Prisma.InputJsonValue;
  }

  private parseDate(dateStr: string): Date {
    return parseDateOnly(dateStr);
  }

  private async getAssignmentContext(
    db: TransactionClient,
    clientId: string,
    date: Date,
  ): Promise<AssignmentContext> {
    const assignment = await db.planAssignment.findUnique({
      where: { client_id_date: { client_id: clientId, date } },
      include: {
        trainings: {
          orderBy: { position: 'asc' },
          include: {
            training: {
              select: { id: true, exercises: { select: { id: true, exercise_id: true } } },
            },
          },
        },
        training: {
          select: {
            id: true,
            exercises: {
              select: { id: true, exercise_id: true },
            },
          },
        },
        diet: {
          select: {
            meals: {
              select: { id: true, parent_meal_id: true },
            },
          },
        },
      },
    });

    const dietMeals = assignment?.diet?.meals ?? [];
    const assignedTrainingLinks = (assignment?.trainings ?? []).length
      ? assignment!.trainings!.map((link) => ({
          training: link.training,
          requiresLastSetVideo: link.requires_last_set_video,
        }))
      : assignment?.training
        ? [{
            training: {
              ...assignment.training,
              id: assignment.training.id ?? assignment.training_id ?? '__legacy_training__',
            },
            requiresLastSetVideo: false,
          }]
        : [];
    const assignedTrainings = assignedTrainingLinks.map((link) => link.training);
    const allExercises = assignedTrainings.flatMap((training) => training.exercises);

    return {
      date,
      trainingIds: assignedTrainings.map((training) => training.id),
      trainingExerciseIds: new Set(
        allExercises.map((exercise) => exercise.id),
      ),
      exerciseIdByTrainingExerciseId: new Map(
        allExercises.map((exercise) => [
          exercise.id,
          exercise.exercise_id,
        ]),
      ),
      trainingIdByTrainingExerciseId: new Map(
        assignedTrainings.flatMap((training) =>
          training.exercises.map((exercise) => [exercise.id, training.id] as const),
        ),
      ),
      trainingExerciseIdsByTrainingId: new Map(
        assignedTrainings.map((training) => [
          training.id,
          new Set(training.exercises.map((exercise) => exercise.id)),
        ]),
      ),
      exerciseIdsByTrainingId: new Map(
        assignedTrainings.map((training) => [
          training.id,
          new Set(training.exercises.map((exercise) => exercise.exercise_id)),
        ]),
      ),
      requiredTrainingExerciseIds: new Set(
        assignedTrainingLinks
          .filter((link) => link.requiresLastSetVideo)
          .flatMap((link) => link.training.exercises.map((exercise) => exercise.id)),
      ),
      mealIds: new Set(dietMeals.map((meal) => meal.id)),
      mealGroupById: new Map(
        dietMeals.map((meal) => [meal.id, meal.parent_meal_id ?? meal.id]),
      ),
    };
  }

  private async withLockedDayProgress<T>(
    clientId: string,
    date: Date,
    operation: (
      tx: TransactionClient,
      assignment: AssignmentContext,
    ) => Promise<T>,
  ): Promise<T> {
    await this.autoAssignmentMaterializer.reconcile(clientId, {
      start: date,
      end: date,
      dates: [date],
    });

    return this.prisma.$transaction(async (tx) => {
      await lockClientDayProgress(tx, clientId);
      const assignment = await this.getAssignmentContext(tx, clientId, date);
      return operation(tx, assignment);
    }, DAY_PROGRESS_TRANSACTION_OPTIONS);
  }

  private sameStringArray(left: string[], right: string[]): boolean {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  private sameExerciseEntries(
    left: ExerciseCompletedEntry[],
    right: ExerciseCompletedEntry[],
  ): boolean {
    return isDeepStrictEqual(left, right);
  }

  private getTrainingCompletedStatus(
    assignedTrainingExerciseIds: Set<string>,
    assignedExerciseIds: Set<string>,
    completedEntries: ExerciseCompletedEntry[],
  ): boolean {
    if (assignedTrainingExerciseIds.size === 0) {
      return false;
    }

    const completedTrainingExerciseIds = new Set(
      completedEntries
        .map((entry) => entry.training_exercise_id)
        .filter((id): id is string => Boolean(id)),
    );

    if (completedTrainingExerciseIds.size > 0) {
      return [...assignedTrainingExerciseIds].every((trainingExerciseId) =>
        completedTrainingExerciseIds.has(trainingExerciseId),
      );
    }

    const completedExerciseIds = new Set(
      completedEntries.map((entry) => entry.exercise_id),
    );

    return [...assignedExerciseIds].every((exerciseId) =>
      completedExerciseIds.has(exerciseId),
    );
  }

  private getCompletedTrainingIds(
    assignment: AssignmentContext,
    completedEntries: ExerciseCompletedEntry[],
  ): string[] {
    return assignment.trainingIds.filter((trainingId) =>
      this.getTrainingCompletedStatus(
        assignment.trainingExerciseIdsByTrainingId.get(trainingId) ?? new Set(),
        assignment.exerciseIdsByTrainingId.get(trainingId) ?? new Set(),
        completedEntries,
      ),
    );
  }

  private async notifyStreakMilestone(clientId: string, days: number) {
    try {
      const senderId = await this.notifications.findSystemSenderId(clientId);
      if (!senderId) return;

      await this.notifications.sendInternalTemplate(
        senderId,
        [clientId],
        'streak_milestone',
        { days },
        {
          title: `${days} días de racha!`,
          body: 'Sigue así. Tu constancia está creciendo.',
          route: '/',
        },
        { type: 'streak' },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send streak milestone notification to ${clientId}: ${(err as Error).message}`,
      );
    }
  }

  async getDayProgress(clientId: string, dateStr: string) {
    const date = this.parseDate(dateStr);

    const progress = await this.prisma.dayProgress.findUnique({
      where: { client_id_date: { client_id: clientId, date } },
    });

    if (!progress) {
      return {
        client_id: clientId,
        date,
        training_completed: false,
        trainings_completed: [],
        exercises_completed: [],
        meals_completed: [],
        notes: null,
        admin_reply_text: null,
        admin_reply_sent_at: null,
      };
    }

    return progress;
  }

  async getPreviousExercisePerformances(
    clientId: string,
    exerciseIdsCsv: string,
    beforeStr: string,
  ) {
    const exerciseIds = [
      ...new Set(
        exerciseIdsCsv
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (!exerciseIds.length) {
      return {};
    }

    const before = this.parseDate(beforeStr);
    const pending = new Set(exerciseIds);
    const result: Record<string, ExerciseCompletedEntry & { date: Date }> = {};

    const progressDays = await this.prisma.dayProgress.findMany({
      where: {
        client_id: clientId,
        date: { lt: before },
      },
      orderBy: { date: 'desc' },
      take: 180,
    });

    for (const day of progressDays) {
      if (!pending.size) break;

      const entries = this.parseExercisesCompleted(day.exercises_completed);
      for (const entry of entries) {
        if (!pending.has(entry.exercise_id)) continue;
        if (!entry.sets?.length && entry.weight_used == null) continue;

        result[entry.exercise_id] = { ...entry, date: day.date };
        pending.delete(entry.exercise_id);
      }
    }

    return result;
  }

  private async validateLastSetFeedback(
    clientId: string,
    date: Date,
    trainingId: string,
    trainingExerciseId: string,
    clientUploadId?: string,
  ): Promise<void> {
    if (!clientUploadId) {
      throw new UnprocessableEntityException({
        code: 'LAST_SET_VIDEO_REQUIRED',
        message: 'Debes adjuntar el vídeo de la última serie',
      });
    }
    const feedback = await this.prisma.feedbackMedia.findUnique({
      where: {
        client_id_client_upload_id: {
          client_id: clientId,
          client_upload_id: clientUploadId,
        },
      },
      select: {
        feedback_kind: true,
        assignment_date: true,
        training_id: true,
        training_exercise_id: true,
        media_type: true,
        media_url: true,
      },
    });
    if (!feedback) {
      throw new ConflictException({
        code: 'LAST_SET_FEEDBACK_PENDING',
        message: 'El vídeo de la última serie todavía se está sincronizando',
      });
    }
    const matches =
      feedback.feedback_kind === FeedbackKind.LAST_SET &&
      feedback.media_type === MediaType.VIDEO &&
      feedback.training_id === trainingId &&
      feedback.training_exercise_id === trainingExerciseId &&
      feedback.assignment_date?.getTime() === date.getTime() &&
      Boolean(feedback.media_url) &&
      (await this.uploadsService.isConsumedManagedUrl(
        clientId,
        feedback.media_url,
        [ManagedUploadPurpose.FEEDBACK_VIDEO],
      ));
    if (!matches) {
      throw new UnprocessableEntityException({
        code: 'LAST_SET_FEEDBACK_INVALID',
        message: 'El vídeo no corresponde a este cliente, fecha, entrenamiento y ejercicio',
      });
    }
  }

  async markExerciseCompleted(clientId: string, dto: MarkExerciseDto) {
    if (dto.sets) {
      if (
        dto.sets.some(
          (set) =>
            set.reps == null && set.seconds == null && set.weight_kg == null,
        )
      ) {
        throw new BadRequestException(
          'Cada serie debe incluir repeticiones, segundos o peso',
        );
      }
      const setNumbers = dto.sets.map((set) => set.set_number);
      if (new Set(setNumbers).size !== setNumbers.length) {
        throw new BadRequestException('No se puede repetir el número de serie');
      }
    }
    const date = this.parseDate(dto.date);
    const progress = await this.withLockedDayProgress(
      clientId,
      date,
      async (tx, assignment) => {
        if (!assignment.trainingExerciseIds.size) {
          throw new ForbiddenException(
            'No tienes entrenamiento asignado para esa fecha',
          );
        }

        const requestedTrainingExerciseId = dto.training_exercise_id;
        const currentIdsForExercise = [
          ...assignment.exerciseIdByTrainingExerciseId.entries(),
        ]
          .filter(([, exerciseId]) => exerciseId === dto.exercise_id)
          .map(([trainingExerciseId]) => trainingExerciseId);
        if (!currentIdsForExercise.length) {
          throw new ForbiddenException(
            'Ese ejercicio no pertenece al entrenamiento asignado',
          );
        }
        if (
          !requestedTrainingExerciseId &&
          currentIdsForExercise.length !== 1
        ) {
          throw new UnprocessableEntityException({
            code: 'TRAINING_EXERCISE_AMBIGUOUS',
            message:
              'training_exercise_id es obligatorio cuando un ejercicio se repite',
          });
        }
        const trainingExerciseId =
          requestedTrainingExerciseId ?? currentIdsForExercise[0];
        if (!currentIdsForExercise.includes(trainingExerciseId)) {
          throw new ForbiddenException(
            'La ocurrencia indicada no corresponde a ese ejercicio asignado',
          );
        }
        const exerciseId =
          assignment.exerciseIdByTrainingExerciseId.get(trainingExerciseId)!;

        if (assignment.requiredTrainingExerciseIds.has(trainingExerciseId)) {
          await this.validateLastSetFeedback(
            clientId,
            date,
            assignment.trainingIdByTrainingExerciseId.get(trainingExerciseId)!,
            trainingExerciseId,
            dto.last_set_feedback_client_upload_id,
          );
        }

        const existing = await tx.dayProgress.findUnique({
          where: { client_id_date: { client_id: clientId, date } },
        });

        const currentExercises = existing
          ? this.parseExercisesCompleted(existing.exercises_completed)
          : [];

        const matchingEntry = currentExercises.find(
          (entry) =>
            entry.training_exercise_id === trainingExerciseId ||
            (!entry.training_exercise_id && entry.exercise_id === exerciseId),
        );
        const replacement: ExerciseCompletedEntry = {
          ...matchingEntry,
          training_exercise_id: trainingExerciseId,
          exercise_id: exerciseId,
          completed_at: matchingEntry?.completed_at ?? new Date().toISOString(),
          ...(dto.weight_used !== undefined && {
            weight_used: dto.weight_used,
          }),
          ...(dto.sets !== undefined && { sets: dto.sets }),
          ...(dto.last_set_feedback_client_upload_id && {
            last_set_feedback_client_upload_id:
              dto.last_set_feedback_client_upload_id,
          }),
        };
        let replaced = false;
        const completedExercises: ExerciseCompletedEntry[] = [];
        for (const entry of currentExercises) {
          const matches =
            entry.training_exercise_id === trainingExerciseId ||
            (!entry.training_exercise_id && entry.exercise_id === exerciseId);
          if (!matches) {
            completedExercises.push(entry);
          } else if (!replaced) {
            completedExercises.push(replacement);
            replaced = true;
          }
        }
        if (!replaced) completedExercises.push(replacement);

        const trainingsCompleted = this.getCompletedTrainingIds(
          assignment,
          completedExercises,
        );
        const allTrainingsCompleted =
          assignment.trainingIds.length > 0 &&
          trainingsCompleted.length === assignment.trainingIds.length;

        const unchanged =
          existing &&
          this.sameExerciseEntries(currentExercises, completedExercises) &&
          existing.training_completed === allTrainingsCompleted &&
          this.sameStringArray(
            existing.trainings_completed ?? [],
            trainingsCompleted,
          );
        if (unchanged) return existing;

        const result = await tx.dayProgress.upsert({
          where: { client_id_date: { client_id: clientId, date } },
          create: {
            client_id: clientId,
            date,
            exercises_completed:
              this.serializeExercisesCompleted(completedExercises),
            meals_completed: existing?.meals_completed ?? [],
            notes: existing?.notes ?? null,
            training_completed: allTrainingsCompleted,
            trainings_completed: trainingsCompleted,
          },
          update: {
            exercises_completed:
              this.serializeExercisesCompleted(completedExercises),
            training_completed: allTrainingsCompleted,
            trainings_completed: trainingsCompleted,
          },
        });

        await this.updateStreak(clientId, date, tx);
        return result;
      },
    );

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
    );

    return progress;
  }

  async completeTraining(clientId: string, dto: CompleteTrainingDto) {
    const date = this.parseDate(dto.date);
    const progress = await this.withLockedDayProgress(
      clientId,
      date,
      async (tx, assignment) => {
        if (!assignment.trainingIds.length) {
          throw new ForbiddenException(
            'No tienes entrenamiento asignado para esa fecha',
          );
        }

        const existing = await tx.dayProgress.findUnique({
          where: { client_id_date: { client_id: clientId, date } },
        });

        const currentExercises = existing
          ? this.parseExercisesCompleted(existing.exercises_completed)
          : [];
        const currentByTrainingExercise = new Map(
          currentExercises
            .filter((entry) => entry.training_exercise_id)
            .map((entry) => [entry.training_exercise_id!, entry]),
        );
        const currentByExercise = new Map(
          currentExercises.map((entry) => [entry.exercise_id, entry]),
        );

        const targetTrainingId = dto.training_id ?? assignment.trainingIds[0];
        if (!assignment.trainingIds.includes(targetTrainingId)) {
          throw new ForbiddenException(
            'Ese entrenamiento no está asignado para esa fecha',
          );
        }
        const targetExerciseIds =
          assignment.trainingExerciseIdsByTrainingId.get(targetTrainingId) ??
          new Set<string>();
        for (const trainingExerciseId of targetExerciseIds) {
          if (!assignment.requiredTrainingExerciseIds.has(trainingExerciseId)) {
            continue;
          }
          const entry = currentByTrainingExercise.get(trainingExerciseId);
          await this.validateLastSetFeedback(
            clientId,
            date,
            targetTrainingId,
            trainingExerciseId,
            entry?.last_set_feedback_client_upload_id,
          );
        }
        const completedTargetExercises = [...targetExerciseIds].map(
          (trainingExerciseId) => {
            const exerciseId =
              assignment.exerciseIdByTrainingExerciseId.get(
                trainingExerciseId,
              )!;
            const existingEntry =
              currentByTrainingExercise.get(trainingExerciseId) ??
              currentByExercise.get(exerciseId);

            return {
              ...existingEntry,
              training_exercise_id: trainingExerciseId,
              exercise_id: exerciseId,
              completed_at:
                existingEntry?.completed_at ?? new Date().toISOString(),
            };
          },
        );
        const completedTargetById = new Map(
          completedTargetExercises.map((entry) => [
            entry.training_exercise_id,
            entry,
          ]),
        );
        const targetCatalogExerciseIds =
          assignment.exerciseIdsByTrainingId.get(targetTrainingId) ?? new Set();
        const consumedTargetIds = new Set<string>();
        const completedExercises: ExerciseCompletedEntry[] = [];
        for (const entry of currentExercises) {
          const trainingExerciseId = entry.training_exercise_id;
          if (trainingExerciseId && targetExerciseIds.has(trainingExerciseId)) {
            if (!consumedTargetIds.has(trainingExerciseId)) {
              completedExercises.push(
                completedTargetById.get(trainingExerciseId) ?? entry,
              );
              consumedTargetIds.add(trainingExerciseId);
            }
          } else if (
            !trainingExerciseId &&
            targetCatalogExerciseIds.has(entry.exercise_id)
          ) {
            continue;
          } else {
            completedExercises.push(entry);
          }
        }
        completedExercises.push(
          ...completedTargetExercises.filter(
            (entry) => !consumedTargetIds.has(entry.training_exercise_id),
          ),
        );
        const trainingsCompleted = this.getCompletedTrainingIds(
          assignment,
          completedExercises,
        );
        const allTrainingsCompleted =
          trainingsCompleted.length === assignment.trainingIds.length;
        const notes = dto.notes?.trim() || existing?.notes || null;
        const unchanged =
          existing &&
          this.sameExerciseEntries(currentExercises, completedExercises) &&
          existing.notes === notes &&
          existing.training_completed === allTrainingsCompleted &&
          this.sameStringArray(
            existing.trainings_completed ?? [],
            trainingsCompleted,
          );
        if (unchanged) return existing;

        const result = await tx.dayProgress.upsert({
          where: { client_id_date: { client_id: clientId, date } },
          create: {
            client_id: clientId,
            date,
            exercises_completed:
              this.serializeExercisesCompleted(completedExercises),
            meals_completed: existing?.meals_completed ?? [],
            notes,
            training_completed: allTrainingsCompleted,
            trainings_completed: trainingsCompleted,
          },
          update: {
            exercises_completed:
              this.serializeExercisesCompleted(completedExercises),
            notes,
            training_completed: allTrainingsCompleted,
            trainings_completed: trainingsCompleted,
          },
        });

        await this.updateStreak(clientId, date, tx);
        return result;
      },
    );

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
    );

    return progress;
  }

  async markMealCompleted(clientId: string, dto: MarkMealDto) {
    const date = this.parseDate(dto.date);
    const progress = await this.withLockedDayProgress(
      clientId,
      date,
      async (tx, assignment) => {
        if (!assignment.mealIds.size) {
          throw new ForbiddenException(
            'No tienes dieta asignada para esa fecha',
          );
        }

        if (!assignment.mealIds.has(dto.meal_id)) {
          throw new ForbiddenException(
            'Esa comida no pertenece a la dieta asignada',
          );
        }

        const existing = await tx.dayProgress.findUnique({
          where: { client_id_date: { client_id: clientId, date } },
        });

        const currentMeals: string[] = existing ? existing.meals_completed : [];
        const targetGroupId =
          assignment.mealGroupById.get(dto.meal_id) ?? dto.meal_id;
        const updatedMeals: string[] = [];
        let targetGroupReplaced = false;
        for (const mealId of currentMeals) {
          const groupId = assignment.mealGroupById.get(mealId) ?? mealId;
          if (groupId !== targetGroupId) {
            updatedMeals.push(mealId);
          } else if (!targetGroupReplaced) {
            updatedMeals.push(dto.meal_id);
            targetGroupReplaced = true;
          }
        }
        if (!targetGroupReplaced) updatedMeals.push(dto.meal_id);
        if (existing && this.sameStringArray(currentMeals, updatedMeals)) {
          return existing;
        }

        const result = await tx.dayProgress.upsert({
          where: { client_id_date: { client_id: clientId, date } },
          create: {
            client_id: clientId,
            date,
            exercises_completed: existing?.exercises_completed ?? [],
            meals_completed: updatedMeals,
            notes: existing?.notes ?? null,
            training_completed: existing?.training_completed ?? false,
            trainings_completed: existing?.trainings_completed ?? [],
          },
          update: {
            meals_completed: updatedMeals,
          },
        });

        await this.updateStreak(clientId, date, tx);
        return result;
      },
    );

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
    );

    return progress;
  }

  async unmarkExercise(clientId: string, dateStr: string, exerciseId: string) {
    const date = this.parseDate(dateStr);
    const progress = await this.withLockedDayProgress(
      clientId,
      date,
      async (tx, assignment) => {
        if (!assignment.trainingExerciseIds.size) {
          throw new ForbiddenException(
            'No tienes entrenamiento asignado para esa fecha',
          );
        }

        const existing = await tx.dayProgress.findUnique({
          where: { client_id_date: { client_id: clientId, date } },
        });

        if (!existing) {
          return { message: 'No progress record found' };
        }

        const currentExercises = this.parseExercisesCompleted(
          existing.exercises_completed,
        );
        const filtered = currentExercises.filter(
          (entry) =>
            entry.training_exercise_id !== exerciseId &&
            entry.exercise_id !== exerciseId,
        );
        if (filtered.length === currentExercises.length) return existing;
        const trainingsCompleted = this.getCompletedTrainingIds(
          assignment,
          filtered,
        );

        const result = await tx.dayProgress.update({
          where: { client_id_date: { client_id: clientId, date } },
          data: {
            exercises_completed: this.serializeExercisesCompleted(filtered),
            training_completed:
              assignment.trainingIds.length > 0 &&
              trainingsCompleted.length === assignment.trainingIds.length,
            trainings_completed: trainingsCompleted,
          },
        });

        await this.updateStreak(clientId, date, tx);
        return result;
      },
    );

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
    );

    return progress;
  }

  async unmarkMeal(clientId: string, dateStr: string, mealId: string) {
    const date = this.parseDate(dateStr);
    const progress = await this.withLockedDayProgress(
      clientId,
      date,
      async (tx, assignment) => {
        if (!assignment.mealIds.size) {
          throw new ForbiddenException(
            'No tienes dieta asignada para esa fecha',
          );
        }

        if (!assignment.mealIds.has(mealId)) {
          throw new ForbiddenException(
            'Esa comida no pertenece a la dieta asignada',
          );
        }

        const existing = await tx.dayProgress.findUnique({
          where: { client_id_date: { client_id: clientId, date } },
        });

        if (!existing) {
          return { message: 'No progress record found' };
        }

        const filtered = existing.meals_completed.filter((id) => id !== mealId);
        if (filtered.length === existing.meals_completed.length)
          return existing;

        const result = await tx.dayProgress.update({
          where: { client_id_date: { client_id: clientId, date } },
          data: { meals_completed: filtered },
        });

        await this.updateStreak(clientId, date, tx);
        return result;
      },
    );

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
    );

    return progress;
  }

  private async updateStreak(
    clientId: string,
    date: Date,
    tx?: TransactionClient,
  ) {
    const today = new Date();
    const asOf = date.getTime() > today.getTime() ? date : today;
    const result = await this.streakCalculator.recalculateClient(clientId, {
      asOf,
      db: tx,
    });

    if (
      result.currentDays !== result.previousCurrentDays &&
      [7, 30, 100, 365].includes(result.currentDays)
    ) {
      await this.notifyStreakMilestone(clientId, result.currentDays);
    }
  }
}

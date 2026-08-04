import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
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
}

interface AssignmentContext {
  date: Date;
  trainingIds: string[];
  trainingExerciseIds: Set<string>;
  exerciseIds: Set<string>;
  exerciseIdByTrainingExerciseId: Map<string, string>;
  trainingExerciseIdsByTrainingId: Map<string, Set<string>>;
  exerciseIdsByTrainingId: Map<string, Set<string>>;
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
    const d = new Date(dateStr);
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }

  private async getAssignmentContext(
    clientId: string,
    date: Date,
  ): Promise<AssignmentContext> {
    const assignment = await this.prisma.planAssignment.findUnique({
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
    const assignedTrainings = (assignment?.trainings ?? []).length
      ? assignment!.trainings!.map((link) => link.training)
      : assignment?.training
        ? [{
            ...assignment.training,
            id: assignment.training.id ?? assignment.training_id ?? '__legacy_training__',
          }]
        : [];
    const allExercises = assignedTrainings.flatMap((training) => training.exercises);

    return {
      date,
      trainingIds: assignedTrainings.map((training) => training.id),
      trainingExerciseIds: new Set(
        allExercises.map((exercise) => exercise.id),
      ),
      exerciseIds: new Set(
        allExercises.map((exercise) => exercise.exercise_id),
      ),
      exerciseIdByTrainingExerciseId: new Map(
        allExercises.map((exercise) => [
          exercise.id,
          exercise.exercise_id,
        ]),
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
      mealIds: new Set(dietMeals.map((meal) => meal.id)),
      mealGroupById: new Map(
        dietMeals.map((meal) => [meal.id, meal.parent_meal_id ?? meal.id]),
      ),
    };
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
    const assignment = await this.getAssignmentContext(clientId, date);

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
    const trainingExerciseId = requestedTrainingExerciseId
      ? assignment.trainingExerciseIds.has(requestedTrainingExerciseId)
        ? requestedTrainingExerciseId
        : currentIdsForExercise.length === 1
          ? currentIdsForExercise[0]
          : undefined
      : undefined;
    // Training edits may recreate TrainingExercise rows while a client is
    // already executing the workout. Keep the started result valid when the
    // underlying exercise is still part of today's assigned training.
    const exerciseId = requestedTrainingExerciseId
      ? trainingExerciseId
        ? assignment.exerciseIdByTrainingExerciseId.get(trainingExerciseId)
        : undefined
      : dto.exercise_id;

    if (
      (requestedTrainingExerciseId && !exerciseId) ||
      (!requestedTrainingExerciseId &&
        !assignment.exerciseIds.has(dto.exercise_id))
    ) {
      throw new ForbiddenException(
        'Ese ejercicio no pertenece al entrenamiento asignado',
      );
    }

    const existing = await this.prisma.dayProgress.findUnique({
      where: { client_id_date: { client_id: clientId, date } },
    });

    const currentExercises = existing
      ? this.parseExercisesCompleted(existing.exercises_completed)
      : [];

    const filtered = currentExercises.filter((entry) =>
      trainingExerciseId
        ? entry.training_exercise_id !== trainingExerciseId &&
          !(!entry.training_exercise_id && entry.exercise_id === exerciseId)
        : entry.exercise_id !== dto.exercise_id,
    );

    filtered.push({
      ...(trainingExerciseId && { training_exercise_id: trainingExerciseId }),
      exercise_id: exerciseId!,
      completed_at: new Date().toISOString(),
      ...(dto.weight_used !== undefined && { weight_used: dto.weight_used }),
      ...(dto.sets !== undefined && { sets: dto.sets }),
    });

    const trainingsCompleted = this.getCompletedTrainingIds(assignment, filtered);
    const allTrainingsCompleted = assignment.trainingIds.length > 0 &&
      trainingsCompleted.length === assignment.trainingIds.length;

    const progress = await this.prisma.$transaction(async (tx) => {
      const result = await tx.dayProgress.upsert({
        where: { client_id_date: { client_id: clientId, date } },
        create: {
          client_id: clientId,
          date,
          exercises_completed: this.serializeExercisesCompleted(filtered),
          meals_completed: existing?.meals_completed ?? [],
          notes: existing?.notes ?? null,
          training_completed: this.getTrainingCompletedStatus(
            assignment.trainingExerciseIds, assignment.exerciseIds, filtered,
          ) && allTrainingsCompleted,
          trainings_completed: trainingsCompleted,
        },
        update: {
          exercises_completed: this.serializeExercisesCompleted(filtered),
          training_completed: allTrainingsCompleted,
          trainings_completed: trainingsCompleted,
        },
      });

      await this.updateStreak(clientId, date, tx);
      return result;
    });

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
    );

    return progress;
  }

  async completeTraining(clientId: string, dto: CompleteTrainingDto) {
    const date = this.parseDate(dto.date);
    const assignment = await this.getAssignmentContext(clientId, date);

    if (!assignment.trainingIds.length) {
      throw new ForbiddenException(
        'No tienes entrenamiento asignado para esa fecha',
      );
    }

    const existing = await this.prisma.dayProgress.findUnique({
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
      throw new ForbiddenException('Ese entrenamiento no está asignado para esa fecha');
    }
    const targetExerciseIds = assignment.trainingExerciseIdsByTrainingId.get(targetTrainingId) ?? new Set<string>();
    const completedTargetExercises = [...targetExerciseIds].map(
      (trainingExerciseId) => {
        const exerciseId =
          assignment.exerciseIdByTrainingExerciseId.get(trainingExerciseId)!;
        const existingEntry =
          currentByTrainingExercise.get(trainingExerciseId) ??
          currentByExercise.get(exerciseId);

        return {
          ...existingEntry,
          training_exercise_id: trainingExerciseId,
          exercise_id: exerciseId,
          completed_at: existingEntry?.completed_at ?? new Date().toISOString(),
        };
      },
    );
    const completedExercises = [
      ...currentExercises.filter((entry) =>
        entry.training_exercise_id
          ? !targetExerciseIds.has(entry.training_exercise_id)
          : ![...(assignment.exerciseIdsByTrainingId.get(targetTrainingId) ?? new Set())].includes(entry.exercise_id),
      ),
      ...completedTargetExercises,
    ];
    const trainingsCompleted = this.getCompletedTrainingIds(assignment, completedExercises);
    const allTrainingsCompleted = trainingsCompleted.length === assignment.trainingIds.length;

    const progress = await this.prisma.$transaction(async (tx) => {
      const result = await tx.dayProgress.upsert({
        where: { client_id_date: { client_id: clientId, date } },
        create: {
          client_id: clientId,
          date,
          exercises_completed:
            this.serializeExercisesCompleted(completedExercises),
          meals_completed: existing?.meals_completed ?? [],
          notes: dto.notes?.trim() || existing?.notes || null,
          training_completed: allTrainingsCompleted,
          trainings_completed: trainingsCompleted,
        },
        update: {
          exercises_completed:
            this.serializeExercisesCompleted(completedExercises),
          notes: dto.notes?.trim() || existing?.notes || null,
          training_completed: allTrainingsCompleted,
          trainings_completed: trainingsCompleted,
        },
      });

      await this.updateStreak(clientId, date, tx);
      return result;
    });

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
    );

    return progress;
  }

  async markMealCompleted(clientId: string, dto: MarkMealDto) {
    const date = this.parseDate(dto.date);
    const assignment = await this.getAssignmentContext(clientId, date);

    if (!assignment.mealIds.size) {
      throw new ForbiddenException('No tienes dieta asignada para esa fecha');
    }

    if (!assignment.mealIds.has(dto.meal_id)) {
      throw new ForbiddenException(
        'Esa comida no pertenece a la dieta asignada',
      );
    }

    const existing = await this.prisma.dayProgress.findUnique({
      where: { client_id_date: { client_id: clientId, date } },
    });

    const currentMeals: string[] = existing ? existing.meals_completed : [];
    const targetGroupId =
      assignment.mealGroupById.get(dto.meal_id) ?? dto.meal_id;
    const updatedMeals = [
      ...currentMeals.filter(
        (mealId) =>
          (assignment.mealGroupById.get(mealId) ?? mealId) !== targetGroupId,
      ),
      dto.meal_id,
    ];

    const progress = await this.prisma.$transaction(async (tx) => {
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
    });

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
    );

    return progress;
  }

  async unmarkExercise(clientId: string, dateStr: string, exerciseId: string) {
    const date = this.parseDate(dateStr);
    const assignment = await this.getAssignmentContext(clientId, date);

    if (!assignment.trainingExerciseIds.size) {
      throw new ForbiddenException(
        'No tienes entrenamiento asignado para esa fecha',
      );
    }

    const existing = await this.prisma.dayProgress.findUnique({
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
    const trainingsCompleted = this.getCompletedTrainingIds(assignment, filtered);

    const progress = await this.prisma.dayProgress.update({
      where: { client_id_date: { client_id: clientId, date } },
      data: {
        exercises_completed: this.serializeExercisesCompleted(filtered),
        training_completed: assignment.trainingIds.length > 0 &&
          trainingsCompleted.length === assignment.trainingIds.length,
        trainings_completed: trainingsCompleted,
      },
    });

    await this.updateStreak(clientId, date);

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
    );

    return progress;
  }

  async unmarkMeal(clientId: string, dateStr: string, mealId: string) {
    const date = this.parseDate(dateStr);
    const assignment = await this.getAssignmentContext(clientId, date);

    if (!assignment.mealIds.size) {
      throw new ForbiddenException('No tienes dieta asignada para esa fecha');
    }

    if (!assignment.mealIds.has(mealId)) {
      throw new ForbiddenException(
        'Esa comida no pertenece a la dieta asignada',
      );
    }

    const existing = await this.prisma.dayProgress.findUnique({
      where: { client_id_date: { client_id: clientId, date } },
    });

    if (!existing) {
      return { message: 'No progress record found' };
    }

    const filtered = existing.meals_completed.filter((id) => id !== mealId);

    const progress = await this.prisma.dayProgress.update({
      where: { client_id_date: { client_id: clientId, date } },
      data: { meals_completed: filtered },
    });

    await this.updateStreak(clientId, date);

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

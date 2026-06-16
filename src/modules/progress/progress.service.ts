import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CompleteTrainingDto,
  MarkExerciseDto,
  MarkMealDto,
} from './dto/mark-completed.dto';

interface ExerciseCompletedEntry {
  training_exercise_id?: string;
  exercise_id: string;
  weight_used?: number;
  completed_at: string;
}

interface AssignmentContext {
  date: Date;
  trainingExerciseIds: Set<string>;
  exerciseIds: Set<string>;
  exerciseIdByTrainingExerciseId: Map<string, string>;
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
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  private async getAssignmentContext(
    clientId: string,
    date: Date,
  ): Promise<AssignmentContext> {
    const assignment = await this.prisma.planAssignment.findUnique({
      where: { client_id_date: { client_id: clientId, date } },
      include: {
        training: {
          select: {
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

    return {
      date,
      trainingExerciseIds: new Set(
        assignment?.training?.exercises.map((exercise) => exercise.id) ?? [],
      ),
      exerciseIds: new Set(
        assignment?.training?.exercises.map((exercise) => exercise.exercise_id) ??
          [],
      ),
      exerciseIdByTrainingExerciseId: new Map(
        assignment?.training?.exercises.map((exercise) => [
          exercise.id,
          exercise.exercise_id,
        ]) ?? [],
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
        exercises_completed: [],
        meals_completed: [],
        notes: null,
      };
    }

    return progress;
  }

  async markExerciseCompleted(clientId: string, dto: MarkExerciseDto) {
    const date = this.parseDate(dto.date);
    const assignment = await this.getAssignmentContext(clientId, date);

    if (!assignment.trainingExerciseIds.size) {
      throw new ForbiddenException(
        'No tienes entrenamiento asignado para esa fecha',
      );
    }

    const trainingExerciseId = dto.training_exercise_id;
    const exerciseId = trainingExerciseId
      ? assignment.exerciseIdByTrainingExerciseId.get(trainingExerciseId)
      : dto.exercise_id;

    if (
      (trainingExerciseId && !exerciseId) ||
      (!trainingExerciseId && !assignment.exerciseIds.has(dto.exercise_id))
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

    const filtered = currentExercises.filter(
      (entry) =>
        trainingExerciseId
          ? entry.training_exercise_id !== trainingExerciseId
          : entry.exercise_id !== dto.exercise_id,
    );

    filtered.push({
      ...(trainingExerciseId && { training_exercise_id: trainingExerciseId }),
      exercise_id: exerciseId!,
      completed_at: new Date().toISOString(),
      ...(dto.weight_used !== undefined && { weight_used: dto.weight_used }),
    });

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
            assignment.trainingExerciseIds,
            assignment.exerciseIds,
            filtered,
          ),
        },
        update: {
          exercises_completed: this.serializeExercisesCompleted(filtered),
          training_completed: this.getTrainingCompletedStatus(
            assignment.trainingExerciseIds,
            assignment.exerciseIds,
            filtered,
          ),
        },
      });

      await this.updateStreak(clientId, date, tx);
      return result;
    });

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(clientId);

    return progress;
  }

  async completeTraining(clientId: string, dto: CompleteTrainingDto) {
    const date = this.parseDate(dto.date);
    const assignment = await this.getAssignmentContext(clientId, date);

    if (!assignment.trainingExerciseIds.size) {
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

    const completedExercises = [...assignment.trainingExerciseIds].map(
      (trainingExerciseId) => {
        const exerciseId =
          assignment.exerciseIdByTrainingExerciseId.get(trainingExerciseId)!;
        return (
          currentByTrainingExercise.get(trainingExerciseId) ??
          currentByExercise.get(exerciseId) ?? {
            training_exercise_id: trainingExerciseId,
            exercise_id: exerciseId,
            completed_at: new Date().toISOString(),
          }
        );
      },
    );

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
          training_completed: true,
        },
        update: {
          exercises_completed:
            this.serializeExercisesCompleted(completedExercises),
          notes: dto.notes?.trim() || existing?.notes || null,
          training_completed: true,
        },
      });

      await this.updateStreak(clientId, date, tx);
      return result;
    });

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(clientId);

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
        },
        update: {
          meals_completed: updatedMeals,
        },
      });

      await this.updateStreak(clientId, date, tx);
      return result;
    });

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(clientId);

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

    const progress = await this.prisma.dayProgress.update({
      where: { client_id_date: { client_id: clientId, date } },
      data: {
        exercises_completed: this.serializeExercisesCompleted(filtered),
        training_completed: this.getTrainingCompletedStatus(
          assignment.trainingExerciseIds,
          assignment.exerciseIds,
          filtered,
        ),
      },
    });

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(clientId);

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

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(clientId);

    return progress;
  }

  private async updateStreak(clientId: string, date: Date, tx?: TransactionClient) {
    const db = tx ?? this.prisma;
    const dateOnly = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

    const yesterday = new Date(dateOnly);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);

    const streak = await db.streak.findUnique({
      where: { client_id: clientId },
    });

    if (!streak) {
      await db.streak.create({
        data: {
          client_id: clientId,
          current_days: 1,
          longest_days: 1,
          last_active_date: dateOnly,
        },
      });
      return;
    }

    const lastActive = streak.last_active_date
      ? new Date(streak.last_active_date)
      : null;

    if (lastActive) {
      lastActive.setUTCHours(0, 0, 0, 0);
    }

    const todayStr = dateOnly.toISOString().split('T')[0];
    const lastActiveStr = lastActive?.toISOString().split('T')[0];
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    let newCurrentDays = streak.current_days;

    if (lastActiveStr === todayStr) {
      return;
    } else if (lastActiveStr === yesterdayStr) {
      newCurrentDays = streak.current_days + 1;
    } else {
      newCurrentDays = 1;
    }

    const newLongest = Math.max(newCurrentDays, streak.longest_days);

    await db.streak.update({
      where: { client_id: clientId },
      data: {
        current_days: newCurrentDays,
        longest_days: newLongest,
        last_active_date: dateOnly,
      },
    });

    if (
      newCurrentDays !== streak.current_days &&
      [7, 30, 100, 365].includes(newCurrentDays)
    ) {
      await this.notifyStreakMilestone(clientId, newCurrentDays);
    }
  }
}

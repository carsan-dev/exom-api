import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import {
  CompleteTrainingDto,
  MarkExerciseDto,
  MarkMealDto,
} from './dto/mark-completed.dto';

interface ExerciseCompletedEntry {
  exercise_id: string;
  weight_used?: number;
  completed_at: string;
}

interface AssignmentContext {
  date: Date;
  trainingExerciseIds: Set<string>;
  mealIds: Set<string>;
}

@Injectable()
export class ProgressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly challengesService: ChallengesService,
    private readonly achievementsService: AchievementsService,
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
    d.setHours(0, 0, 0, 0);
    return d;
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
              select: { exercise_id: true },
            },
          },
        },
        diet: {
          select: {
            meals: {
              select: { id: true },
            },
          },
        },
      },
    });

    return {
      date,
      trainingExerciseIds: new Set(
        assignment?.training?.exercises.map(
          (exercise) => exercise.exercise_id,
        ) ?? [],
      ),
      mealIds: new Set(assignment?.diet?.meals.map((meal) => meal.id) ?? []),
    };
  }

  private getTrainingCompletedStatus(
    assignedExerciseIds: Set<string>,
    completedEntries: ExerciseCompletedEntry[],
  ): boolean {
    if (assignedExerciseIds.size === 0) {
      return false;
    }

    const completedIds = new Set(
      completedEntries.map((entry) => entry.exercise_id),
    );

    return [...assignedExerciseIds].every((exerciseId) =>
      completedIds.has(exerciseId),
    );
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

    if (!assignment.trainingExerciseIds.has(dto.exercise_id)) {
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
      (entry) => entry.exercise_id !== dto.exercise_id,
    );

    filtered.push({
      exercise_id: dto.exercise_id,
      completed_at: new Date().toISOString(),
      ...(dto.weight_used !== undefined && { weight_used: dto.weight_used }),
    });

    const progress = await this.prisma.dayProgress.upsert({
      where: { client_id_date: { client_id: clientId, date } },
      create: {
        client_id: clientId,
        date,
        exercises_completed: this.serializeExercisesCompleted(filtered),
        meals_completed: existing?.meals_completed ?? [],
        notes: existing?.notes ?? null,
        training_completed: this.getTrainingCompletedStatus(
          assignment.trainingExerciseIds,
          filtered,
        ),
      },
      update: {
        exercises_completed: this.serializeExercisesCompleted(filtered),
        training_completed: this.getTrainingCompletedStatus(
          assignment.trainingExerciseIds,
          filtered,
        ),
      },
    });

    await this.updateStreak(clientId, date);
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
    const currentByExercise = new Map(
      currentExercises.map((entry) => [entry.exercise_id, entry]),
    );

    const completedExercises = [...assignment.trainingExerciseIds].map(
      (exerciseId) =>
        currentByExercise.get(exerciseId) ?? {
          exercise_id: exerciseId,
          completed_at: new Date().toISOString(),
        },
    );

    const progress = await this.prisma.dayProgress.upsert({
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

    await this.updateStreak(clientId, date);
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
    const updatedMeals = currentMeals.includes(dto.meal_id)
      ? currentMeals
      : [...currentMeals, dto.meal_id];

    const progress = await this.prisma.dayProgress.upsert({
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

    await this.updateStreak(clientId, date);
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
      (entry) => entry.exercise_id !== exerciseId,
    );

    const progress = await this.prisma.dayProgress.update({
      where: { client_id_date: { client_id: clientId, date } },
      data: {
        exercises_completed: this.serializeExercisesCompleted(filtered),
        training_completed: this.getTrainingCompletedStatus(
          assignment.trainingExerciseIds,
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

  private async updateStreak(clientId: string, date: Date) {
    const dateOnly = new Date(date);
    dateOnly.setHours(0, 0, 0, 0);

    const yesterday = new Date(dateOnly);
    yesterday.setDate(yesterday.getDate() - 1);

    const streak = await this.prisma.streak.findUnique({
      where: { client_id: clientId },
    });

    if (!streak) {
      await this.prisma.streak.create({
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
      lastActive.setHours(0, 0, 0, 0);
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

    await this.prisma.streak.update({
      where: { client_id: clientId },
      data: {
        current_days: newCurrentDays,
        longest_days: newLongest,
        last_active_date: dateOnly,
      },
    });
  }
}

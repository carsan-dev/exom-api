import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MarkExerciseDto, MarkMealDto } from './dto/mark-completed.dto';

interface ExerciseCompletedEntry {
  exercise_id: string;
  weight_used?: number;
  completed_at: string;
}

@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService) {}

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

  async markExerciseCompleted(
    clientId: string,
    dto: MarkExerciseDto,
  ) {
    const date = this.parseDate(dto.date);

    const existing = await this.prisma.dayProgress.findUnique({
      where: { client_id_date: { client_id: clientId, date } },
    });

    const currentExercises = existing
      ? this.parseExercisesCompleted(existing.exercises_completed)
      : [];

    // Remove any existing entry for this exercise and re-add
    const filtered = currentExercises.filter(
      (e) => e.exercise_id !== dto.exercise_id,
    );

    const newEntry: ExerciseCompletedEntry = {
      exercise_id: dto.exercise_id,
      completed_at: new Date().toISOString(),
      ...(dto.weight_used !== undefined && { weight_used: dto.weight_used }),
    };

    filtered.push(newEntry);

    const progress = await this.prisma.dayProgress.upsert({
      where: { client_id_date: { client_id: clientId, date } },
      create: {
        client_id: clientId,
        date,
        exercises_completed: this.serializeExercisesCompleted(filtered),
        meals_completed: [],
        training_completed: false,
      },
      update: {
        exercises_completed: this.serializeExercisesCompleted(filtered),
      },
    });

    await this.updateStreak(clientId, date);

    return progress;
  }

  async markMealCompleted(clientId: string, dto: MarkMealDto) {
    const date = this.parseDate(dto.date);

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
        exercises_completed: [],
        meals_completed: updatedMeals,
        training_completed: false,
      },
      update: {
        meals_completed: updatedMeals,
      },
    });

    await this.updateStreak(clientId, date);

    return progress;
  }

  async unmarkExercise(clientId: string, dateStr: string, exerciseId: string) {
    const date = this.parseDate(dateStr);

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
      (e) => e.exercise_id !== exerciseId,
    );

    return this.prisma.dayProgress.update({
      where: { client_id_date: { client_id: clientId, date } },
      data: {
        exercises_completed: this.serializeExercisesCompleted(filtered),
      },
    });
  }

  async unmarkMeal(clientId: string, dateStr: string, mealId: string) {
    const date = this.parseDate(dateStr);

    const existing = await this.prisma.dayProgress.findUnique({
      where: { client_id_date: { client_id: clientId, date } },
    });

    if (!existing) {
      return { message: 'No progress record found' };
    }

    const filtered = existing.meals_completed.filter((id) => id !== mealId);

    return this.prisma.dayProgress.update({
      where: { client_id_date: { client_id: clientId, date } },
      data: { meals_completed: filtered },
    });
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
      // Already recorded today — no change
      return;
    } else if (lastActiveStr === yesterdayStr) {
      // Consecutive day
      newCurrentDays = streak.current_days + 1;
    } else {
      // Streak broken — reset
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

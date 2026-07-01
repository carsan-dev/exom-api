import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { countCompletedMealGroups } from '../../common/progress/plan-progress-reconciliation';
import { AutoAssignmentMaterializerService } from '../assignments/auto-assignment-materializer.service';

export interface CalendarDay {
  date: string;
  has_training: boolean;
  has_diet: boolean;
  is_rest_day: boolean;
  training_completed: boolean;
  diet_completed: boolean;
}

@Injectable()
export class CalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly autoAssignmentMaterializer: AutoAssignmentMaterializerService,
  ) {}

  private buildRange(start: Date, end: Date) {
    const dates: Date[] = [];
    for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
      dates.push(new Date(date));
    }
    return { start, end, dates };
  }

  async getMonthCalendar(
    clientId: string,
    year: number,
    month: number,
  ): Promise<CalendarDay[]> {
    const firstDay = new Date(Date.UTC(year, month - 1, 1));
    const lastDay = new Date(Date.UTC(year, month, 0));

    await this.autoAssignmentMaterializer.materialize(
      clientId,
      this.buildRange(firstDay, lastDay),
    );

    const [assignments, progresses] = await Promise.all([
      this.prisma.planAssignment.findMany({
        where: {
          client_id: clientId,
          date: { gte: firstDay, lte: lastDay },
        },
        include: {
          diet: {
            select: {
              meals: { select: { id: true, parent_meal_id: true } },
            },
          },
        },
      }),
      this.prisma.dayProgress.findMany({
        where: {
          client_id: clientId,
          date: { gte: firstDay, lte: lastDay },
        },
      }),
    ]);

    const assignmentMap = new Map(
      assignments.map((a) => [new Date(a.date).toISOString().split('T')[0], a]),
    );

    const progressMap = new Map(
      progresses.map((p) => [new Date(p.date).toISOString().split('T')[0], p]),
    );

    const days: CalendarDay[] = [];
    const daysInMonth = lastDay.getUTCDate();

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const assignment = assignmentMap.get(dateStr);
      const progress = progressMap.get(dateStr);

      const assignedMeals = assignment?.diet?.meals ?? [];
      const mealsCompletedCount = countCompletedMealGroups(
        progress?.meals_completed ?? [],
        assignedMeals,
      );
      const assignedMealsCount = assignedMeals.filter(
        (meal) => meal.parent_meal_id === null,
      ).length;

      days.push({
        date: dateStr,
        has_training: !!assignment?.training_id,
        has_diet: !!assignment?.diet_id,
        is_rest_day: assignment?.is_rest_day ?? false,
        training_completed: progress?.training_completed ?? false,
        diet_completed:
          assignedMealsCount > 0 && mealsCompletedCount >= assignedMealsCount,
      });
    }

    return days;
  }

  async getWeekSummary(clientId: string, weekStart: string) {
    const [y, m, d] = weekStart.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, d));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);

    await this.autoAssignmentMaterializer.materialize(
      clientId,
      this.buildRange(start, end),
    );

    const [assignments, progresses] = await Promise.all([
      this.prisma.planAssignment.findMany({
        where: {
          client_id: clientId,
          date: { gte: start, lte: end },
        },
        include: {
          diet: {
            select: {
              meals: { select: { id: true, parent_meal_id: true } },
            },
          },
        },
      }),
      this.prisma.dayProgress.findMany({
        where: {
          client_id: clientId,
          date: { gte: start, lte: end },
        },
      }),
    ]);

    const trainingsAssigned = assignments.filter(
      (a) => !!a.training_id && !a.is_rest_day,
    ).length;

    const progressMap = new Map(
      progresses.map((progress) => [
        `${progress.client_id}:${progress.date.toISOString()}`,
        progress,
      ]),
    );

    const trainingsCompleted = assignments.filter((assignment) => {
      if (!assignment.training_id || assignment.is_rest_day) return false;
      return (
        progressMap.get(
          `${assignment.client_id}:${assignment.date.toISOString()}`,
        )?.training_completed ?? false
      );
    }).length;

    const totalMeals = assignments.reduce((sum, a) => {
      return (
        sum +
        (a.diet?.meals.filter((meal) => meal.parent_meal_id === null).length ?? 0)
      );
    }, 0);

    const mealsCompleted = assignments.reduce((sum, assignment) => {
      const progress = progressMap.get(
        `${assignment.client_id}:${assignment.date.toISOString()}`,
      );
      return (
        sum +
        countCompletedMealGroups(
          progress?.meals_completed ?? [],
          assignment.diet?.meals ?? [],
        )
      );
    }, 0);

    return {
      week_start: weekStart,
      trainings_assigned: trainingsAssigned,
      trainings_completed: trainingsCompleted,
      total_meals: totalMeals,
      meals_completed: mealsCompleted,
    };
  }
}

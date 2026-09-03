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

    await this.autoAssignmentMaterializer.reconcile(
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
          trainings: { select: { training_id: true } },
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
        has_training: Boolean(assignment && ((assignment.trainings?.length ?? 0) > 0 || assignment.training_id)),
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

    await this.autoAssignmentMaterializer.reconcile(
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
          trainings: { select: { training_id: true } },
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

    const trainingsAssigned = assignments.reduce(
      (sum, assignment) => sum + (assignment.is_rest_day
        ? 0
        : assignment.trainings?.length || (assignment.training_id ? 1 : 0)),
      0,
    );

    const progressMap = new Map(
      progresses.map((progress) => [
        `${progress.client_id}:${progress.date.toISOString()}`,
        progress,
      ]),
    );

    const trainingsCompleted = assignments.reduce((sum, assignment) => {
      if (assignment.is_rest_day) return sum;
      const progress = progressMap.get(
        `${assignment.client_id}:${assignment.date.toISOString()}`,
      );
      if (assignment.trainings?.length) {
        const assignedIds = new Set(assignment.trainings.map((link) => link.training_id));
        return sum + (progress?.trainings_completed.filter((id) => assignedIds.has(id)).length ?? 0);
      }
      return sum + (assignment.training_id && progress?.training_completed ? 1 : 0);
    }, 0);

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

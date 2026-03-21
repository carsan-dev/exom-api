import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

  async getMonthCalendar(
    clientId: string,
    year: number,
    month: number,
  ): Promise<CalendarDay[]> {
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);

    const [assignments, progresses] = await Promise.all([
      this.prisma.planAssignment.findMany({
        where: {
          client_id: clientId,
          date: { gte: firstDay, lte: lastDay },
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
      assignments.map((a) => [
        new Date(a.date).toISOString().split('T')[0],
        a,
      ]),
    );

    const progressMap = new Map(
      progresses.map((p) => [
        new Date(p.date).toISOString().split('T')[0],
        p,
      ]),
    );

    const days: CalendarDay[] = [];
    const daysInMonth = lastDay.getDate();

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const assignment = assignmentMap.get(dateStr);
      const progress = progressMap.get(dateStr);

      const mealsCompletedCount = progress?.meals_completed?.length ?? 0;

      days.push({
        date: dateStr,
        has_training: !!assignment?.training_id,
        has_diet: !!assignment?.diet_id,
        is_rest_day: assignment?.is_rest_day ?? false,
        training_completed: progress?.training_completed ?? false,
        diet_completed: mealsCompletedCount > 0,
      });
    }

    return days;
  }

  async getWeekSummary(clientId: string, weekStart: string) {
    const start = new Date(weekStart);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);

    const [assignments, progresses] = await Promise.all([
      this.prisma.planAssignment.findMany({
        where: {
          client_id: clientId,
          date: { gte: start, lte: end },
        },
        include: {
          diet: { include: { meals: true } },
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

    const trainingsCompleted = progresses.filter(
      (p) => p.training_completed,
    ).length;

    const totalMeals = assignments.reduce((sum, a) => {
      return sum + (a.diet?.meals?.length ?? 0);
    }, 0);

    const mealsCompleted = progresses.reduce((sum, p) => {
      return sum + (p.meals_completed?.length ?? 0);
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

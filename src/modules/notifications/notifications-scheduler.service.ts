import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MealType, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const TZ = 'Europe/Madrid';

@Injectable()
export class NotificationsSchedulerService {
  private readonly logger = new Logger(NotificationsSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private todayUtcDate(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  private addUtcDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private previousWeekRange(referenceDate: Date) {
    const day = referenceDate.getUTCDay();
    const daysSinceMonday = day === 0 ? 6 : day - 1;
    const currentMonday = this.addUtcDays(referenceDate, -daysSinceMonday);
    const start = this.addUtcDays(currentMonday, -7);
    const end = this.addUtcDays(currentMonday, -1);

    return { start, end };
  }

  private buildClientName(client: {
    email?: string | null;
    profile?: {
      first_name?: string | null;
      last_name?: string | null;
    } | null;
  }) {
    const fullName = [
      client.profile?.first_name,
      client.profile?.last_name,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    return fullName || client.email || 'Cliente';
  }

  private async resolveSender(): Promise<string | null> {
    const id = await this.notifications.findSystemSenderId();
    if (!id) {
      this.logger.warn(
        'No system sender (SUPER_ADMIN) available; skipping cron',
      );
    }
    return id;
  }

  private async activeClientIds(): Promise<Set<string>> {
    const rows = await this.prisma.user.findMany({
      where: { role: Role.CLIENT, is_active: true },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  @Cron('0 9 * * *', { timeZone: TZ })
  async remindDailyTraining() {
    const sender = await this.resolveSender();
    if (!sender) return;

    const today = this.todayUtcDate();
    const active = await this.activeClientIds();
    if (active.size === 0) return;

    const assignments = await this.prisma.planAssignment.findMany({
      where: {
        date: today,
        training_id: { not: null },
        is_rest_day: false,
        client_id: { in: [...active] },
      },
      select: { client_id: true },
    });

    if (assignments.length === 0) return;

    const clientIds = assignments.map((a) => a.client_id);

    const completed = await this.prisma.dayProgress.findMany({
      where: {
        date: today,
        client_id: { in: clientIds },
        training_completed: true,
      },
      select: { client_id: true },
    });
    const completedSet = new Set(completed.map((c) => c.client_id));
    const pending = clientIds.filter((id) => !completedSet.has(id));

    if (pending.length === 0) return;

    this.logger.log(`[cron] remindDailyTraining → ${pending.length} clients`);
    await this.notifications.sendInternalTemplate(
      sender,
      pending,
      'training_reminder_daily',
      {},
      {
        title: 'Tu entreno de hoy te espera',
        body: 'Abre la app y empieza cuando puedas.',
        route: '/trainings',
      },
      { type: 'training_reminder' },
    );
  }

  @Cron('0 8 * * *', { timeZone: TZ })
  async remindBreakfast() {
    await this.remindMeal(MealType.BREAKFAST, 'desayuno');
  }

  @Cron('0 13 * * *', { timeZone: TZ })
  async remindLunch() {
    await this.remindMeal(MealType.LUNCH, 'comida');
  }

  @Cron('0 17 * * *', { timeZone: TZ })
  async remindSnack() {
    await this.remindMeal(MealType.SNACK, 'snack');
  }

  @Cron('30 20 * * *', { timeZone: TZ })
  async remindDinner() {
    await this.remindMeal(MealType.DINNER, 'cena');
  }

  private async remindMeal(mealType: MealType, label: string) {
    const sender = await this.resolveSender();
    if (!sender) return;

    const today = this.todayUtcDate();
    const active = await this.activeClientIds();
    if (active.size === 0) return;

    const assignments = await this.prisma.planAssignment.findMany({
      where: {
        date: today,
        diet_id: { not: null },
        is_rest_day: false,
        client_id: { in: [...active] },
        diet: { meals: { some: { type: mealType } } },
      },
      select: { client_id: true, diet_id: true },
    });

    if (assignments.length === 0) return;

    const dietIds = [
      ...new Set(
        assignments
          .map((a) => a.diet_id)
          .filter((d): d is string => Boolean(d)),
      ),
    ];

    const meals = await this.prisma.meal.findMany({
      where: { diet_id: { in: dietIds }, type: mealType },
      select: { id: true, diet_id: true },
    });

    const mealsByDiet = new Map<string, string[]>();
    for (const m of meals) {
      const list = mealsByDiet.get(m.diet_id) ?? [];
      list.push(m.id);
      mealsByDiet.set(m.diet_id, list);
    }

    const clientIds = assignments.map((a) => a.client_id);
    const progress = await this.prisma.dayProgress.findMany({
      where: { date: today, client_id: { in: clientIds } },
      select: { client_id: true, meals_completed: true },
    });
    const progressByClient = new Map(
      progress.map((p) => [p.client_id, new Set(p.meals_completed)]),
    );

    const pending: string[] = [];
    for (const a of assignments) {
      if (!a.diet_id) continue;
      const mealIds = mealsByDiet.get(a.diet_id) ?? [];
      if (mealIds.length === 0) continue;
      const done = progressByClient.get(a.client_id) ?? new Set<string>();
      if (mealIds.every((mid) => done.has(mid))) continue;
      pending.push(a.client_id);
    }

    if (pending.length === 0) return;

    this.logger.log(
      `[cron] remindMeal(${mealType}) → ${pending.length} clients`,
    );
    await this.notifications.sendInternalTemplate(
      sender,
      pending,
      'diet_reminder_meal',
      { mealLabel: label },
      {
        title: 'Hora de tu ' + label,
        body: 'Revisa tu plan y registra la comida cuando termines.',
        route: '/diets',
      },
      { type: 'diet_reminder' },
    );
  }

  @Cron('0 19 * * 0', { timeZone: TZ })
  async remindWeeklyRecap() {
    const sender = await this.resolveSender();
    if (!sender) return;

    const today = this.todayUtcDate();
    // Week starts Monday: subtract 6 days from Sunday to get Monday
    const weekStart = new Date(today);
    weekStart.setUTCDate(weekStart.getUTCDate() - 6);

    const clients = await this.prisma.user.findMany({
      where: { role: Role.CLIENT, is_active: true },
      select: { id: true },
    });

    if (clients.length === 0) return;

    const existing = await this.prisma.weeklyRecap.findMany({
      where: {
        week_start_date: weekStart,
        client_id: { in: clients.map((c) => c.id) },
        submitted_at: { not: null },
      },
      select: { client_id: true },
    });
    const done = new Set(existing.map((e) => e.client_id));
    const pending = clients.filter((c) => !done.has(c.id));

    if (pending.length === 0) return;

    this.logger.log(`[cron] remindWeeklyRecap → ${pending.length} clients`);
    await this.notifications.sendInternalTemplate(
      sender,
      pending.map((p) => p.id),
      'recap_reminder_weekly',
      {},
      {
        title: 'Completa tu recap semanal',
        body: 'Cuéntanos cómo fue tu semana antes del domingo.',
        route: '/recap',
      },
      { type: 'recap_reminder' },
    );
  }

  @Cron('0 20 * * *', { timeZone: TZ })
  async warnStreakAtRisk() {
    const sender = await this.resolveSender();
    if (!sender) return;

    const today = this.todayUtcDate();
    const streaks = await this.prisma.streak.findMany({
      where: {
        current_days: { gt: 0 },
        last_active_date: { lt: today },
        client: {
          is: {
            role: Role.CLIENT,
            is_active: true,
          },
        },
      },
      select: { client_id: true, current_days: true },
    });

    if (streaks.length === 0) return;

    const progress = await this.prisma.dayProgress.findMany({
      where: {
        date: today,
        client_id: { in: streaks.map((streak) => streak.client_id) },
      },
      select: {
        client_id: true,
        training_completed: true,
        meals_completed: true,
      },
    });
    const completedToday = new Set(
      progress
        .filter(
          (entry) =>
            entry.training_completed || entry.meals_completed.length > 0,
        )
        .map((entry) => entry.client_id),
    );
    const pending = streaks.filter(
      (streak) => !completedToday.has(streak.client_id),
    );

    if (pending.length === 0) return;

    this.logger.log(`[cron] warnStreakAtRisk → ${pending.length} clients`);
    await Promise.all(
      pending.map((streak) =>
        this.notifications.sendInternalTemplate(
          sender,
          [streak.client_id],
          'streak_at_risk',
          { days: streak.current_days },
          {
            title: `No pierdas tu racha de ${streak.current_days} días`,
            body: 'Registra tu progreso de hoy para mantenerla activa.',
            route: '/',
          },
          { type: 'streak_at_risk' },
        ),
      ),
    );
  }

  @Cron('0 9 * * 1', { timeZone: TZ })
  async weeklyClientSummaryToAdmin() {
    const sender = await this.resolveSender();
    if (!sender) return;

    const { start, end } = this.previousWeekRange(this.todayUtcDate());
    const assignments = await this.prisma.adminClientAssignment.findMany({
      where: {
        is_active: true,
        admin: {
          is: {
            role: Role.ADMIN,
            is_active: true,
          },
        },
        client: {
          is: {
            role: Role.CLIENT,
            is_active: true,
          },
        },
      },
      select: {
        admin_id: true,
        client_id: true,
        client: {
          select: {
            email: true,
            profile: {
              select: {
                first_name: true,
                last_name: true,
              },
            },
          },
        },
      },
    });

    if (assignments.length === 0) return;

    const clientIds = [...new Set(assignments.map((row) => row.client_id))];
    const [plans, progress] = await Promise.all([
      this.prisma.planAssignment.findMany({
        where: {
          client_id: { in: clientIds },
          date: { gte: start, lte: end },
          is_rest_day: false,
          OR: [{ training_id: { not: null } }, { diet_id: { not: null } }],
        },
        select: {
          client_id: true,
          date: true,
          training_id: true,
          diet: {
            select: {
              meals: {
                select: { id: true },
              },
            },
          },
        },
      }),
      this.prisma.dayProgress.findMany({
        where: {
          client_id: { in: clientIds },
          date: { gte: start, lte: end },
        },
        select: {
          client_id: true,
          date: true,
          training_completed: true,
          meals_completed: true,
        },
      }),
    ]);

    const summaryByClient = new Map<
      string,
      {
        trainingsAssigned: number;
        trainingsCompleted: number;
        mealsAssigned: number;
        mealsCompleted: number;
        trainingDates: Set<string>;
        mealIdsByDate: Map<string, Set<string>>;
      }
    >();
    const ensureSummary = (clientId: string) => {
      let summary = summaryByClient.get(clientId);
      if (!summary) {
        summary = {
          trainingsAssigned: 0,
          trainingsCompleted: 0,
          mealsAssigned: 0,
          mealsCompleted: 0,
          trainingDates: new Set(),
          mealIdsByDate: new Map(),
        };
        summaryByClient.set(clientId, summary);
      }
      return summary;
    };

    for (const plan of plans) {
      const summary = ensureSummary(plan.client_id);
      if (plan.training_id) {
        summary.trainingsAssigned += 1;
        summary.trainingDates.add(this.formatDate(plan.date));
      }

      const meals = plan.diet?.meals ?? [];
      if (meals.length > 0) {
        summary.mealsAssigned += meals.length;
        summary.mealIdsByDate.set(
          this.formatDate(plan.date),
          new Set(meals.map((meal) => meal.id)),
        );
      }
    }

    for (const entry of progress) {
      const summary = ensureSummary(entry.client_id);
      if (
        entry.training_completed &&
        summary.trainingDates.has(this.formatDate(entry.date))
      ) {
        summary.trainingsCompleted += 1;
      }

      const mealIds = summary.mealIdsByDate.get(this.formatDate(entry.date));
      if (!mealIds) {
        continue;
      }

      summary.mealsCompleted += entry.meals_completed.filter((mealId) =>
        mealIds.has(mealId),
      ).length;
    }

    this.logger.log(
      `[cron] weeklyClientSummaryToAdmin -> ${assignments.length} assignments`,
    );
    await Promise.all(
      assignments.map((assignment) => {
        const summary = ensureSummary(assignment.client_id);
        const clientName = this.buildClientName(assignment.client);

        return this.notifications.sendInternalTemplate(
          sender,
          [assignment.admin_id],
          'admin_weekly_summary',
          {
            clientName,
            clientId: assignment.client_id,
            trainingsCompleted: summary.trainingsCompleted,
            trainingsAssigned: summary.trainingsAssigned,
            mealsCompleted: summary.mealsCompleted,
            mealsAssigned: summary.mealsAssigned,
          },
          {
            title: 'Resumen semanal de cliente',
            body: `${clientName}: ${summary.trainingsCompleted}/${summary.trainingsAssigned} entrenos, ${summary.mealsCompleted}/${summary.mealsAssigned} comidas`,
            route: `/admin/clients/${assignment.client_id}`,
          },
          {
            type: 'weekly_summary',
            client_id: assignment.client_id,
            week_start: this.formatDate(start),
            week_end: this.formatDate(end),
          },
        );
      }),
    );
  }
}

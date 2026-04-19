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
    await this.notifications.sendInternalNotifications(
      sender,
      pending,
      '🏋️ Tu entreno de hoy te espera',
      'Abre la app y empieza cuando puedas.',
      { type: 'training_reminder', route: '/trainings' },
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
    await this.notifications.sendInternalNotifications(
      sender,
      pending,
      '🍽️ Hora de tu ' + label,
      'Revisa tu plan y registra la comida cuando termines.',
      { type: 'diet_reminder', route: '/diets' },
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
    await this.notifications.sendInternalNotifications(
      sender,
      pending.map((p) => p.id),
      '📋 Completa tu recap semanal',
      'Cuéntanos cómo fue tu semana antes del domingo.',
      { type: 'recap_reminder', route: '/recap' },
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
        this.notifications.sendInternalNotifications(
          sender,
          [streak.client_id],
          `No pierdas tu racha de ${streak.current_days} días`,
          'Registra tu progreso de hoy para mantenerla activa.',
          { type: 'streak_at_risk', route: '/' },
        ),
      ),
    );
  }
}

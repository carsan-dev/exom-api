import { MealType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsSchedulerService } from './notifications-scheduler.service';
import type { NotificationsService } from './notifications.service';

describe('NotificationsSchedulerService', () => {
  let service: NotificationsSchedulerService;
  let prisma: {
    user: { findMany: jest.Mock };
    planAssignment: { findMany: jest.Mock };
    dayProgress: { findMany: jest.Mock };
    meal: { findMany: jest.Mock };
    weeklyRecap: { findMany: jest.Mock };
    streak: { findMany: jest.Mock };
    adminClientAssignment: { findMany: jest.Mock };
  };
  let notifications: {
    findSystemSenderId: jest.Mock;
    sendInternalTemplate: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      planAssignment: { findMany: jest.fn().mockResolvedValue([]) },
      dayProgress: { findMany: jest.fn().mockResolvedValue([]) },
      meal: { findMany: jest.fn().mockResolvedValue([]) },
      weeklyRecap: { findMany: jest.fn().mockResolvedValue([]) },
      streak: { findMany: jest.fn().mockResolvedValue([]) },
      adminClientAssignment: { findMany: jest.fn().mockResolvedValue([]) },
    };

    notifications = {
      findSystemSenderId: jest.fn().mockResolvedValue('system-admin'),
      sendInternalTemplate: jest.fn().mockResolvedValue({
        success: true,
        sent: 1,
        failed: 0,
      }),
    };

    service = new NotificationsSchedulerService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    );
    (service as any).todayUtcDate = jest
      .fn()
      .mockReturnValue(new Date('2026-04-23T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends training reminders with date-aware routes', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'client-1' }]);
    prisma.planAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([]);

    await (service as any).remindDailyTraining();

    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'system-admin',
      ['client-1'],
      'training_reminder_daily',
      { date: '2026-04-23' },
      {
        title: 'Tu entreno de hoy te espera',
        body: 'Abre la app y empieza cuando puedas.',
        route: '/trainings?date=2026-04-23',
      },
      { type: 'training_reminder' },
    );
  });

  it('sends meal reminders with date-aware routes', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'client-1' }]);
    prisma.planAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1', diet_id: 'diet-1' },
    ]);
    prisma.meal.findMany.mockResolvedValue([
      { id: 'meal-1', diet_id: 'diet-1' },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([]);

    await (service as any).remindMeal(MealType.LUNCH, 'comida');

    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'system-admin',
      ['client-1'],
      'diet_reminder_meal',
      { mealLabel: 'comida', date: '2026-04-23' },
      {
        title: 'Hora de tu comida',
        body: 'Revisa tu plan y registra la comida cuando termines.',
        route: '/diets?date=2026-04-23',
      },
      { type: 'diet_reminder' },
    );
  });

  it('does not warn about a streak on a rest or unassigned day', async () => {
    prisma.streak.findMany.mockResolvedValue([
      { client_id: 'client-1', current_days: 4 },
    ]);
    prisma.planAssignment.findMany.mockResolvedValue([]);

    await (service as any).warnStreakAtRisk();

    expect(notifications.sendInternalTemplate).not.toHaveBeenCalled();
  });

  it('warns when an assigned active day has no activity', async () => {
    prisma.streak.findMany.mockResolvedValue([
      { client_id: 'client-1', current_days: 4 },
    ]);
    prisma.planAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([]);

    await (service as any).warnStreakAtRisk();

    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'system-admin',
      ['client-1'],
      'streak_at_risk',
      { days: 4 },
      expect.any(Object),
      { type: 'streak_at_risk' },
    );
  });
});

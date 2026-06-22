import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { StreakCalculatorService } from '../streaks/streak-calculator.service';
import { ProgressService } from './progress.service';

describe('ProgressService', () => {
  let service: ProgressService;
  let prisma: {
    $transaction: jest.Mock;
    planAssignment: {
      findUnique: jest.Mock;
    };
    dayProgress: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
    };
    streak: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };
  let challengesService: {
    recalculateAutomaticProgress: jest.Mock;
  };
  let achievementsService: {
    evaluateAutomaticAchievementsForUser: jest.Mock;
  };
  let notifications: {
    findSystemSenderId: jest.Mock;
    sendInternalTemplate: jest.Mock;
  };
  let streakCalculator: {
    recalculateClient: jest.Mock;
  };
  let updateStreakSpy: jest.SpyInstance;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
      planAssignment: {
        findUnique: jest.fn(),
      },
      dayProgress: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      streak: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    challengesService = {
      recalculateAutomaticProgress: jest.fn(),
    };
    achievementsService = {
      evaluateAutomaticAchievementsForUser: jest.fn(),
    };
    notifications = {
      findSystemSenderId: jest.fn().mockResolvedValue('system-admin'),
      sendInternalTemplate: jest.fn().mockResolvedValue({
        success: true,
        sent: 1,
        failed: 0,
      }),
    };
    streakCalculator = {
      recalculateClient: jest.fn().mockResolvedValue({
        currentDays: 1,
        longestDays: 1,
        previousCurrentDays: 0,
        changed: true,
      }),
    };

    service = new ProgressService(
      prisma as unknown as PrismaService,
      challengesService as unknown as ChallengesService,
      achievementsService as unknown as AchievementsService,
      notifications as unknown as NotificationsService,
      streakCalculator as unknown as StreakCalculatorService,
    );

    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );

    updateStreakSpy = jest
      .spyOn(service as any, 'updateStreak')
      .mockResolvedValue(undefined);
  });

  it('re-evaluates achievements after completing training', async () => {
    prisma.planAssignment.findUnique.mockResolvedValue({
      training: {
        exercises: [
          { exercise_id: 'exercise-1' },
          { exercise_id: 'exercise-2' },
        ],
      },
      diet: null,
    });
    prisma.dayProgress.findUnique.mockResolvedValue(null);
    prisma.dayProgress.upsert.mockResolvedValue({ id: 'progress-1' });

    await expect(
      service.completeTraining('client-1', { date: '2026-04-04' }),
    ).resolves.toEqual({ id: 'progress-1' });

    expect(challengesService.recalculateAutomaticProgress).toHaveBeenCalledWith(
      'client-1',
    );
    expect(
      achievementsService.evaluateAutomaticAchievementsForUser,
    ).toHaveBeenCalledWith('client-1');
  });

  it('stores per-set reps and weight when completing an exercise', async () => {
    prisma.planAssignment.findUnique.mockResolvedValue({
      training: {
        exercises: [{ id: 'training-exercise-1', exercise_id: 'exercise-1' }],
      },
      diet: null,
    });
    prisma.dayProgress.findUnique.mockResolvedValue(null);
    prisma.dayProgress.upsert.mockResolvedValue({ id: 'progress-1' });

    await service.markExerciseCompleted('client-1', {
      date: '2026-06-22',
      exercise_id: 'exercise-1',
      training_exercise_id: 'training-exercise-1',
      sets: [
        { set_number: 1, reps: 12, weight_kg: 20 },
        { set_number: 2, reps: 10, weight_kg: 20 },
      ],
    });

    expect(prisma.dayProgress.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          exercises_completed: expect.arrayContaining([
            expect.objectContaining({
              sets: [
                { set_number: 1, reps: 12, weight_kg: 20 },
                { set_number: 2, reps: 10, weight_kg: 20 },
              ],
            }),
          ]),
        }),
      }),
    );
  });

  it('rejects duplicate set numbers', async () => {
    await expect(
      service.markExerciseCompleted('client-1', {
        date: '2026-06-22',
        exercise_id: 'exercise-1',
        sets: [
          { set_number: 1, reps: 12 },
          { set_number: 1, reps: 10 },
        ],
      }),
    ).rejects.toThrow('No se puede repetir el número de serie');
  });

  it('notifies when completing training reaches a streak milestone', async () => {
    updateStreakSpy.mockRestore();
    prisma.planAssignment.findUnique.mockResolvedValue({
      training: {
        exercises: [{ exercise_id: 'exercise-1' }],
      },
      diet: null,
    });
    prisma.dayProgress.findUnique.mockResolvedValue(null);
    prisma.dayProgress.upsert.mockResolvedValue({ id: 'progress-1' });
    streakCalculator.recalculateClient.mockResolvedValue({
      currentDays: 7,
      longestDays: 7,
      previousCurrentDays: 6,
      changed: true,
    });

    await expect(
      service.completeTraining('client-1', { date: '2026-04-08' }),
    ).resolves.toEqual({ id: 'progress-1' });

    expect(streakCalculator.recalculateClient).toHaveBeenCalledWith(
      'client-1',
      expect.objectContaining({ db: prisma }),
    );
    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'system-admin',
      ['client-1'],
      'streak_milestone',
      { days: 7 },
      {
        title: '7 d\u00edas de racha!',
        body: 'Sigue as\u00ed. Tu constancia est\u00e1 creciendo.',
        route: '/',
      },
      { type: 'streak' },
    );
  });

  it('replaces a completed meal variant with the selected sibling', async () => {
    prisma.planAssignment.findUnique.mockResolvedValue({
      training: null,
      diet: {
        meals: [
          { id: 'meal-main', parent_meal_id: null },
          { id: 'variant-1', parent_meal_id: 'meal-main' },
          { id: 'variant-2', parent_meal_id: 'meal-main' },
        ],
      },
    });
    prisma.dayProgress.findUnique.mockResolvedValue({
      meals_completed: ['variant-1'],
      exercises_completed: [],
      notes: null,
      training_completed: false,
    });
    prisma.dayProgress.upsert.mockResolvedValue({
      id: 'progress-1',
      meals_completed: ['variant-2'],
    });

    await expect(
      service.markMealCompleted('client-1', {
        date: '2026-05-10',
        meal_id: 'variant-2',
      }),
    ).resolves.toEqual({
      id: 'progress-1',
      meals_completed: ['variant-2'],
    });

    expect(prisma.dayProgress.upsert).toHaveBeenCalledWith({
      where: {
        client_id_date: {
          client_id: 'client-1',
          date: new Date('2026-05-10T00:00:00.000Z'),
        },
      },
      create: expect.any(Object),
      update: {
        meals_completed: ['variant-2'],
      },
    });
  });
});

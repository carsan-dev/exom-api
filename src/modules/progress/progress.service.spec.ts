import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import type { NotificationsService } from '../notifications/notifications.service';
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
    sendInternalNotifications: jest.Mock;
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
      sendInternalNotifications: jest.fn().mockResolvedValue({
        success: true,
        sent: 1,
        failed: 0,
      }),
    };

    service = new ProgressService(
      prisma as unknown as PrismaService,
      challengesService as unknown as ChallengesService,
      achievementsService as unknown as AchievementsService,
      notifications as unknown as NotificationsService,
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
        exercises: [{ exercise_id: 'exercise-1' }, { exercise_id: 'exercise-2' }],
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
    prisma.streak.findUnique.mockResolvedValue({
      current_days: 6,
      longest_days: 6,
      last_active_date: new Date('2026-04-07T00:00:00.000Z'),
    });
    prisma.streak.update.mockResolvedValue({
      current_days: 7,
      longest_days: 7,
      last_active_date: new Date('2026-04-08T00:00:00.000Z'),
    });

    await expect(
      service.completeTraining('client-1', { date: '2026-04-08' }),
    ).resolves.toEqual({ id: 'progress-1' });

    expect(prisma.streak.update).toHaveBeenCalledWith({
      where: { client_id: 'client-1' },
      data: {
        current_days: 7,
        longest_days: 7,
        last_active_date: new Date('2026-04-08T00:00:00.000Z'),
      },
    });
    expect(notifications.sendInternalNotifications).toHaveBeenCalledWith(
      'system-admin',
      ['client-1'],
      '🔥 7 días de racha!',
      'Sigue así. Tu constancia está creciendo.',
      { type: 'streak', route: '/' },
    );
  });
});

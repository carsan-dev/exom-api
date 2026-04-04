import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { ProgressService } from './progress.service';

describe('ProgressService', () => {
  let service: ProgressService;
  let prisma: {
    planAssignment: {
      findUnique: jest.Mock;
    };
    dayProgress: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
    };
  };
  let challengesService: {
    recalculateAutomaticProgress: jest.Mock;
  };
  let achievementsService: {
    evaluateAutomaticAchievementsForUser: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      planAssignment: {
        findUnique: jest.fn(),
      },
      dayProgress: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };
    challengesService = {
      recalculateAutomaticProgress: jest.fn(),
    };
    achievementsService = {
      evaluateAutomaticAchievementsForUser: jest.fn(),
    };

    service = new ProgressService(
      prisma as unknown as PrismaService,
      challengesService as unknown as ChallengesService,
      achievementsService as unknown as AchievementsService,
    );

    jest
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
});

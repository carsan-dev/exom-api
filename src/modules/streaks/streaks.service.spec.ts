import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { StreaksService } from './streaks.service';

describe('StreaksService', () => {
  let service: StreaksService;
  let prisma: {
    streak: {
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
      streak: {
        upsert: jest.fn(),
      },
    };
    challengesService = {
      recalculateAutomaticProgress: jest.fn(),
    };
    achievementsService = {
      evaluateAutomaticAchievementsForUser: jest.fn(),
    };

    service = new StreaksService(
      prisma as unknown as PrismaService,
      challengesService as unknown as ChallengesService,
      achievementsService as unknown as AchievementsService,
    );
  });

  it('re-evaluates achievements after resetting a streak', async () => {
    prisma.streak.upsert.mockResolvedValue({ client_id: 'client-1', current_days: 0 });

    await expect(
      service.resetStreak('super-admin', 'SUPER_ADMIN', 'client-1'),
    ).resolves.toEqual({ client_id: 'client-1', current_days: 0 });

    expect(challengesService.recalculateAutomaticProgress).toHaveBeenCalledWith(
      'client-1',
    );
    expect(
      achievementsService.evaluateAutomaticAchievementsForUser,
    ).toHaveBeenCalledWith('client-1');
  });
});

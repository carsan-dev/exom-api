import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from './challenges.service';

describe('ChallengesService', () => {
  let service: ChallengesService;
  let prisma: {
    challengeClient: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };
  let achievementsService: {
    evaluateAutomaticAchievementsForUser: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      challengeClient: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    achievementsService = {
      evaluateAutomaticAchievementsForUser: jest.fn(),
    };

    service = new ChallengesService(
      prisma as unknown as PrismaService,
      achievementsService as unknown as AchievementsService,
    );
  });

  it('re-evaluates achievements after loading my challenges', async () => {
    prisma.challengeClient.findMany.mockResolvedValue([{ id: 'assignment-1' }]);
    jest
      .spyOn(service, 'recalculateAutomaticProgress')
      .mockResolvedValue(undefined);

    await expect(service.findMyChallenges('client-1')).resolves.toEqual([
      { id: 'assignment-1' },
    ]);

    expect(service.recalculateAutomaticProgress).toHaveBeenCalledWith('client-1');
    expect(
      achievementsService.evaluateAutomaticAchievementsForUser,
    ).toHaveBeenCalledWith('client-1', prisma as unknown as PrismaService);
  });

  it('re-evaluates achievements after updating manual challenge progress', async () => {
    prisma.challengeClient.findUnique.mockResolvedValue({
      completed_at: null,
      challenge: {
        is_manual: true,
        target_value: 5,
      },
    });
    prisma.challengeClient.update.mockResolvedValue({ id: 'assignment-2' });

    await expect(
      service.updateProgress('client-1', 'challenge-1', { current_value: 5 }),
    ).resolves.toEqual({ id: 'assignment-2' });

    expect(
      achievementsService.evaluateAutomaticAchievementsForUser,
    ).toHaveBeenCalledWith('client-1', prisma as unknown as PrismaService);
  });
});

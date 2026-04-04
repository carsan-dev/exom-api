import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from './achievements.service';

describe('AchievementsService', () => {
  let service: AchievementsService;
  let prisma: {
    achievement: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    userAchievement: {
      createMany: jest.Mock;
      findMany: jest.Mock;
      deleteMany: jest.Mock;
      upsert: jest.Mock;
      findUnique: jest.Mock;
      delete: jest.Mock;
    };
    dayProgress: {
      findMany: jest.Mock;
    };
    planAssignment: {
      findMany: jest.Mock;
    };
    challengeClient: {
      count: jest.Mock;
    };
    bodyMetric: {
      count: jest.Mock;
    };
    streak: {
      findUnique: jest.Mock;
    };
    adminClientAssignment: {
      findMany: jest.Mock;
    };
    user: {
      findMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      achievement: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      userAchievement: {
        createMany: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        upsert: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      dayProgress: {
        findMany: jest.fn(),
      },
      planAssignment: {
        findMany: jest.fn(),
      },
      challengeClient: {
        count: jest.fn(),
      },
      bodyMetric: {
        count: jest.fn(),
      },
      streak: {
        findUnique: jest.fn(),
      },
      adminClientAssignment: {
        findMany: jest.fn(),
      },
      user: {
        findMany: jest.fn(),
      },
    };

    service = new AchievementsService(prisma as unknown as PrismaService);
  });

  it('rejects unsupported rule_config combinations', async () => {
    await expect(
      service.create(
        {
          name: 'Racha semanal',
          description: 'Mantén la constancia durante la semana',
          criteria_type: 'STREAK_DAYS',
          criteria_value: 7,
          rule_config: { training_type: 'HIIT' },
        },
        { id: 'admin-1', role: 'ADMIN' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.achievement.create).not.toHaveBeenCalled();
  });

  it('recomputes automatic achievements globally when creating an automatic achievement', async () => {
    prisma.achievement.create.mockResolvedValue({
      id: 'ach-new',
      criteria_type: 'TRAINING_DAYS',
    });
    prisma.achievement.findMany.mockResolvedValue([
      {
        id: 'ach-new',
        criteria_type: 'TRAINING_DAYS',
        criteria_value: 3,
        rule_config: null,
      },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'client-1' },
      { id: 'client-2' },
    ]);

    const evaluateSpy = jest
      .spyOn(service, 'evaluateAutomaticAchievementsForUser')
      .mockResolvedValueOnce({
        user_id: 'client-1',
        evaluated: 1,
        granted: 1,
        revoked: 0,
      })
      .mockResolvedValueOnce({
        user_id: 'client-2',
        evaluated: 1,
        granted: 0,
        revoked: 0,
      });

    await expect(
      service.create(
        {
          name: 'Nuevo logro',
          description: 'Completa tres días de entrenamiento',
          criteria_type: 'TRAINING_DAYS',
          criteria_value: 3,
        },
        { id: 'admin-1', role: 'ADMIN' },
      ),
    ).resolves.toEqual({
      id: 'ach-new',
      criteria_type: 'TRAINING_DAYS',
    });

    expect(evaluateSpy).toHaveBeenNthCalledWith(
      1,
      'client-1',
      expect.any(Object),
      ['ach-new'],
    );
    expect(evaluateSpy).toHaveBeenNthCalledWith(
      2,
      'client-2',
      expect.any(Object),
      ['ach-new'],
    );
  });

  it('syncs automatic achievements with full diff, granting and revoking as needed', async () => {
    prisma.achievement.findMany.mockResolvedValue([
      {
        id: 'ach-training',
        criteria_type: 'TRAINING_DAYS',
        criteria_value: 2,
        rule_config: null,
      },
      {
        id: 'ach-streak',
        criteria_type: 'STREAK_DAYS',
        criteria_value: 5,
        rule_config: null,
      },
    ]);
    prisma.dayProgress.findMany.mockResolvedValue([
      { date: new Date('2026-04-01T00:00:00.000Z') },
      { date: new Date('2026-04-02T00:00:00.000Z') },
    ]);
    prisma.planAssignment.findMany.mockResolvedValue([]);
    prisma.challengeClient.count.mockResolvedValue(0);
    prisma.bodyMetric.count.mockResolvedValue(0);
    prisma.streak.findUnique.mockResolvedValue({ current_days: 4 });
    prisma.userAchievement.findMany.mockResolvedValue([
      { achievement_id: 'ach-streak' },
    ]);
    prisma.userAchievement.createMany.mockResolvedValue({ count: 1 });
    prisma.userAchievement.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      service.evaluateAutomaticAchievementsForUser('client-1'),
    ).resolves.toEqual({
      user_id: 'client-1',
      evaluated: 2,
      granted: 1,
      revoked: 1,
    });

    expect(prisma.userAchievement.createMany).toHaveBeenCalledWith({
      data: [{ user_id: 'client-1', achievement_id: 'ach-training' }],
      skipDuplicates: true,
    });
    expect(prisma.userAchievement.deleteMany).toHaveBeenCalledWith({
      where: {
        user_id: 'client-1',
        achievement_id: { in: ['ach-streak'] },
      },
    });
  });

  it('recomputes automatic achievements for all visible clients in batch', async () => {
    prisma.achievement.findMany.mockResolvedValue([
      {
        id: 'ach-1',
        criteria_type: 'TRAINING_DAYS',
        criteria_value: 1,
        rule_config: null,
      },
    ]);
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
      { client_id: 'client-2' },
    ]);

    const evaluateSpy = jest
      .spyOn(service, 'evaluateAutomaticAchievementsForUser')
      .mockResolvedValueOnce({
        user_id: 'client-1',
        evaluated: 1,
        granted: 1,
        revoked: 0,
      })
      .mockResolvedValueOnce({
        user_id: 'client-2',
        evaluated: 1,
        granted: 0,
        revoked: 1,
      });

    await expect(
      service.recomputeAchievements(
        {
          achievement_ids: ['ach-1'],
          apply_to_all_visible_clients: true,
        },
        { id: 'admin-1', role: 'ADMIN' },
      ),
    ).resolves.toEqual({
      achievements_evaluated: 1,
      users_evaluated: 2,
      granted: 1,
      revoked: 1,
    });

    expect(evaluateSpy).toHaveBeenNthCalledWith(
      1,
      'client-1',
      expect.any(Object),
      ['ach-1'],
    );
    expect(evaluateSpy).toHaveBeenNthCalledWith(
      2,
      'client-2',
      expect.any(Object),
      ['ach-1'],
    );
  });

  it('recomputes automatic achievements globally when updating an automatic rule', async () => {
    prisma.achievement.findUnique.mockResolvedValue({
      id: 'ach-1',
      name: 'Ach',
      description: 'Desc',
      icon_url: null,
      criteria_type: 'TRAINING_DAYS',
      criteria_value: 3,
      rule_config: null,
    });
    prisma.achievement.update.mockResolvedValue({
      id: 'ach-1',
      criteria_type: 'TRAINING_DAYS',
      criteria_value: 5,
    });
    prisma.achievement.findMany.mockResolvedValue([
      {
        id: 'ach-1',
        criteria_type: 'TRAINING_DAYS',
        criteria_value: 5,
        rule_config: null,
      },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'client-1' },
      { id: 'client-2' },
    ]);

    const evaluateSpy = jest
      .spyOn(service, 'evaluateAutomaticAchievementsForUser')
      .mockResolvedValueOnce({
        user_id: 'client-1',
        evaluated: 1,
        granted: 0,
        revoked: 0,
      })
      .mockResolvedValueOnce({
        user_id: 'client-2',
        evaluated: 1,
        granted: 1,
        revoked: 0,
      });

    await service.update(
      'ach-1',
      { criteria_value: 5 },
      { id: 'admin-1', role: 'ADMIN' },
    );

    expect(evaluateSpy).toHaveBeenNthCalledWith(
      1,
      'client-1',
      expect.any(Object),
      ['ach-1'],
    );
    expect(evaluateSpy).toHaveBeenNthCalledWith(
      2,
      'client-2',
      expect.any(Object),
      ['ach-1'],
    );
  });

  it('revokes unlocks globally when an automatic achievement becomes custom', async () => {
    prisma.achievement.findUnique.mockResolvedValue({
      id: 'ach-1',
      name: 'Ach',
      description: 'Desc',
      icon_url: null,
      criteria_type: 'TRAINING_DAYS',
      criteria_value: 3,
      rule_config: null,
    });
    prisma.achievement.update.mockResolvedValue({
      id: 'ach-1',
      criteria_type: 'CUSTOM',
    });
    prisma.userAchievement.deleteMany.mockResolvedValue({ count: 2 });

    await service.update(
      'ach-1',
      { criteria_type: 'CUSTOM' },
      { id: 'admin-1', role: 'ADMIN' },
    );

    expect(prisma.userAchievement.deleteMany).toHaveBeenCalledWith({
      where: {
        achievement_id: 'ach-1',
      },
    });
  });

  it('prevents granting an achievement to a client outside the admin visibility', async () => {
    prisma.achievement.findUnique.mockResolvedValue({ id: 'ach-1' });
    prisma.user.findMany.mockResolvedValue([{ id: 'client-1' }]);
    prisma.adminClientAssignment.findMany.mockResolvedValue([]);

    await expect(
      service.grantToUser(
        'ach-1',
        { user_id: 'client-1' },
        { id: 'admin-1', role: 'ADMIN' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.userAchievement.upsert).not.toHaveBeenCalled();
  });

  it('prevents revoking an achievement from a client outside the admin visibility', async () => {
    prisma.achievement.findUnique.mockResolvedValue({ id: 'ach-1' });
    prisma.user.findMany.mockResolvedValue([{ id: 'client-1' }]);
    prisma.adminClientAssignment.findMany.mockResolvedValue([]);

    await expect(
      service.revokeFromUser(
        'ach-1',
        { user_id: 'client-1' },
        { id: 'admin-1', role: 'ADMIN' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.userAchievement.findUnique).not.toHaveBeenCalled();
  });
});

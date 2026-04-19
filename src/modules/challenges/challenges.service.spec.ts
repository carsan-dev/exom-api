import { BadRequestException } from '@nestjs/common';
import { ChallengeType, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { ChallengesService } from './challenges.service';

describe('ChallengesService', () => {
  let service: ChallengesService;
  let prisma: {
    $transaction: jest.Mock;
    challenge: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    challengeClient: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      upsert: jest.Mock;
      count: jest.Mock;
    };
  };
  let achievementsService: {
    evaluateAutomaticAchievementsForUser: jest.Mock;
  };
  let notifications: {
    findSystemSenderId: jest.Mock;
    sendInternalTemplate: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn((callback) => callback(prisma)),
      challenge: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      challengeClient: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        count: jest.fn(),
      },
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
    jest.useFakeTimers().setSystemTime(new Date('2026-04-17T12:00:00.000Z'));

    service = new ChallengesService(
      prisma as unknown as PrismaService,
      achievementsService as unknown as AchievementsService,
      notifications as unknown as NotificationsService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
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
      is_completed: false,
      completed_at: null,
      challenge: {
        id: 'challenge-1',
        title: '5 comidas limpias',
        created_by: 'admin-1',
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
    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'admin-1',
      ['client-1'],
      'challenge_completed',
      { challengeName: '5 comidas limpias' },
      {
        title: 'Reto completado: 5 comidas limpias',
        body: 'Buen trabajo. Has completado el reto.',
        route: '/challenges',
      },
      {
        type: 'challenge',
        challenge_id: 'challenge-1',
      },
    );
  });

  it('allows challenges without a deadline', async () => {
    prisma.challenge.create.mockResolvedValue({
      id: 'challenge-1',
      title: 'Reto sin fecha',
      description: 'Reto indefinido',
      type: ChallengeType.MAIN_GOAL,
      target_value: 1,
      unit: 'puntos',
      is_manual: true,
      is_global: false,
      deadline: null,
      rule_key: null,
      rule_config: null,
      created_by: 'admin-1',
      created_at: new Date(),
      updated_at: new Date(),
    });
    prisma.challengeClient.findMany.mockResolvedValue([]);
    prisma.challengeClient.count.mockResolvedValue(0);

    await expect(
      service.create('admin-1', Role.ADMIN, {
        title: 'Reto sin fecha',
        description: 'Reto indefinido',
        type: ChallengeType.MAIN_GOAL,
        target_value: 1,
        unit: 'puntos',
        is_manual: true,
        is_global: false,
        deadline: null,
      }),
    ).resolves.toMatchObject({
      id: 'challenge-1',
      deadline: null,
      assigned_clients: 0,
      completed_clients: 0,
    });

    expect(prisma.challenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ deadline: undefined }),
      }),
    );
  });

  it('rejects challenge creation with an expired deadline', async () => {
    await expect(
      service.create('admin-1', Role.ADMIN, {
        title: 'Reto vencido',
        description: 'No debe crearse',
        type: ChallengeType.WEEKLY,
        target_value: 2,
        unit: 'sesiones',
        is_manual: true,
        is_global: false,
        deadline: '2026-03-28',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.challenge.create).not.toHaveBeenCalled();
  });

  it('rejects challenge assignment when its deadline is expired', async () => {
    prisma.challenge.findUnique.mockResolvedValue({
      id: 'challenge-1',
      title: '2 sesiones HIIT esta semana',
      description: 'Reto vencido',
      type: ChallengeType.WEEKLY,
      target_value: 2,
      unit: 'sesiones',
      is_manual: false,
      is_global: false,
      deadline: new Date('2026-03-28T00:00:00.000Z'),
      rule_key: 'TRAINING_DAYS',
      rule_config: null,
      created_by: 'admin-1',
      created_at: new Date(),
      updated_at: new Date(),
    });

    await expect(
      service.assignToClients('challenge-1', 'admin-1', Role.ADMIN, {
        client_ids: ['00000000-0000-4000-8000-000000000001'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.challengeClient.upsert).not.toHaveBeenCalled();
  });
});

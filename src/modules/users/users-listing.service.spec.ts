import { Prisma } from '@prisma/client';
import { Level, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ChallengesService } from '../challenges/challenges.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminClientsQueryDto } from './dto/admin-clients-query.dto';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { UsersService } from './users.service';
import type { CalendarService } from '../calendar/calendar.service';

describe('UsersService listing filters', () => {
  let service: UsersService;
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock<Promise<unknown>, [Prisma.Sql]>;
    user: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
    adminClientAssignment: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let challenges: {
    syncGlobalChallengesForCreatorClient: jest.Mock;
  };
  let notifications: {
    sendInternalTemplate: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
      $queryRaw: jest
        .fn<Promise<unknown>, [Prisma.Sql]>()
        .mockResolvedValue([]),
      user: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      adminClientAssignment: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };
    challenges = {
      syncGlobalChallengesForCreatorClient: jest.fn(),
    };
    notifications = {
      sendInternalTemplate: jest.fn(),
    };

    service = new UsersService(
      prisma as unknown as PrismaService,
      challenges as unknown as ChallengesService,
      notifications as unknown as NotificationsService,
      undefined as never,
      {} as CalendarService,
    );
  });

  it('applies role, status, and created_at filters to global user listings', async () => {
    prisma.$transaction.mockImplementation(
      (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(prisma as unknown as Prisma.TransactionClient),
    );
    prisma.$queryRaw.mockResolvedValueOnce([{ ids: ['admin-2'], total: 1n }]);
    const query = Object.assign(new AdminUsersQueryDto(), {
      page: 1,
      limit: 10,
      role: Role.ADMIN,
      status: ['INACTIVE'],
      created_from: '2026-01-01',
      created_to: '2026-01-31',
    });

    prisma.user.findMany.mockResolvedValue([
      {
        id: 'admin-2',
        email: 'lin@exom.dev',
        role: Role.ADMIN,
        is_active: false,
        is_locked: false,
        created_at: new Date('2026-01-10T10:00:00.000Z'),
        profile: { first_name: 'Lin', last_name: 'Coach', avatar_url: null },
      },
    ]);

    await expect(service.findAll(query)).resolves.toEqual({
      data: [
        {
          id: 'admin-2',
          email: 'lin@exom.dev',
          role: Role.ADMIN,
          is_active: false,
          is_locked: false,
          created_at: new Date('2026-01-10T10:00:00.000Z'),
          profile: { first_name: 'Lin', last_name: 'Coach', avatar_url: null },
        },
      ],
      total: 1,
      page: 1,
      limit: 10,
      totalPages: 1,
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['admin-2'] } } }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(prisma.$queryRaw.mock.calls[0][0]).toHaveProperty(
      'values',
      expect.any(Array),
    );
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('filters super admin client listings by level, status, assignment state, and search', async () => {
    prisma.$transaction.mockImplementation(
      (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(prisma as unknown as Prisma.TransactionClient),
    );
    prisma.$queryRaw.mockResolvedValueOnce([{ ids: ['client-1'], total: 1n }]);
    const query = Object.assign(new AdminClientsQueryDto(), {
      page: 1,
      limit: 10,
      level: [Level.INTERMEDIO],
      status: ['ACTIVE'],
      assignment_state: ['ASSIGNED'],
      search: 'ada',
    });

    prisma.user.findMany.mockResolvedValue([
      {
        id: 'client-1',
        email: 'ada@exom.dev',
        role: Role.CLIENT,
        is_active: true,
        is_locked: false,
        created_at: new Date('2026-01-10T10:00:00.000Z'),
        profile: {
          first_name: 'Ada',
          last_name: 'Rivera',
          avatar_url: null,
          level: Level.INTERMEDIO,
          main_goal: 'Fuerza',
        },
        _count: { clientOf: 1 },
      },
      {
        id: 'client-2',
        email: 'other@exom.dev',
        role: Role.CLIENT,
        is_active: true,
        is_locked: false,
        created_at: new Date('2026-01-11T10:00:00.000Z'),
        profile: {
          first_name: 'Luna',
          last_name: 'Coach',
          avatar_url: null,
          level: Level.INTERMEDIO,
          main_goal: 'Salud',
        },
        _count: { clientOf: 0 },
      },
    ]);

    await expect(
      service.getMyClients('super-admin-1', Role.SUPER_ADMIN, query),
    ).resolves.toEqual({
      data: [
        {
          id: 'client-1',
          email: 'ada@exom.dev',
          role: Role.CLIENT,
          is_active: true,
          is_locked: false,
          created_at: new Date('2026-01-10T10:00:00.000Z'),
          profile: {
            first_name: 'Ada',
            last_name: 'Rivera',
            avatar_url: null,
            level: Level.INTERMEDIO,
            main_goal: 'Fuerza',
          },
          active_admins_count: 1,
        },
      ],
      total: 1,
      page: 1,
      limit: 10,
      totalPages: 1,
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['client-1'] } } }),
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(prisma.$queryRaw.mock.calls[0][0]).toHaveProperty(
      'values',
      expect.any(Array),
    );
    expect(prisma.user.count).not.toHaveBeenCalled();
  });
});

import { Level, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ChallengesService } from '../challenges/challenges.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminClientsQueryDto } from './dto/admin-clients-query.dto';
import { AdminUsersQueryDto } from './dto/admin-users-query.dto';
import { UsersService } from './users.service';

describe('UsersService listing filters', () => {
  let service: UsersService;
  let prisma: {
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
    );
  });

  it('applies role, status, and created_at filters to global user listings', async () => {
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

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        role: Role.ADMIN,
        created_at: {
          gte: new Date('2026-01-01T00:00:00.000Z'),
          lte: new Date('2026-01-31T23:59:59.999Z'),
        },
      },
      select: {
        id: true,
        email: true,
        role: true,
        is_active: true,
        is_locked: true,
        created_at: true,
        profile: {
          select: {
            first_name: true,
            last_name: true,
            avatar_url: true,
          },
        },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    expect(prisma.user.count).not.toHaveBeenCalled();
  });

  it('filters super admin client listings by level, status, assignment state, and search', async () => {
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
        clientOf: [{ id: 'assignment-1' }],
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
        clientOf: [],
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

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        role: Role.CLIENT,
        profile: {
          is: {
            level: { in: [Level.INTERMEDIO] },
          },
        },
      },
      select: {
        id: true,
        email: true,
        role: true,
        is_active: true,
        is_locked: true,
        created_at: true,
        profile: true,
        clientOf: {
          where: {
            is_active: true,
            admin: {
              is: {
                role: Role.ADMIN,
                is_active: true,
              },
            },
          },
          select: { id: true },
        },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    expect(prisma.user.count).not.toHaveBeenCalled();
  });
});

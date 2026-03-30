import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { UsersService } from './users.service';
import { UpdateClientAssignmentsDto } from './dto/update-client-assignments.dto';

const createUserMock = jest.fn();

jest.mock('firebase-admin', () => ({
  auth: () => ({
    createUser: createUserMock,
  }),
}));

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    $transaction: jest.Mock;
    user: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    adminClientAssignment: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
      createMany: jest.Mock;
    };
  };

  beforeEach(() => {
    createUserMock.mockReset();
    prisma = {
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      adminClientAssignment: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        createMany: jest.fn(),
      },
    };

    service = new UsersService(prisma as unknown as PrismaService);
  });

  it('keeps creator auto-assignment when creating a client', async () => {
    const dto = {
      email: 'client-1@exom.dev',
      password: 'super-secret',
      first_name: 'Ada',
      last_name: 'Rivera',
      level: 'INTERMEDIO' as const,
      main_goal: 'Ganar fuerza',
    };
    const createdAt = new Date('2024-03-01T10:00:00.000Z');

    prisma.user.findUnique.mockResolvedValue(null);
    createUserMock.mockResolvedValue({ uid: 'firebase-client-1' });
    prisma.user.create.mockResolvedValue({
      id: 'client-1',
      email: dto.email,
      role: Role.CLIENT,
      is_active: true,
      is_locked: false,
      created_at: createdAt,
      profile: {
        first_name: dto.first_name,
        last_name: dto.last_name,
        level: dto.level,
        main_goal: dto.main_goal,
      },
    });
    prisma.adminClientAssignment.create.mockResolvedValue({
      id: 'assignment-1',
      admin_id: 'admin-1',
      client_id: 'client-1',
      is_active: true,
    });

    await expect(service.createClient('admin-1', dto)).resolves.toEqual({
      id: 'client-1',
      email: dto.email,
      role: Role.CLIENT,
      is_active: true,
      is_locked: false,
      created_at: createdAt,
      profile: {
        first_name: dto.first_name,
        last_name: dto.last_name,
        level: dto.level,
        main_goal: dto.main_goal,
      },
    });

    expect(createUserMock).toHaveBeenCalledWith({
      email: dto.email,
      password: dto.password,
      displayName: `${dto.first_name} ${dto.last_name}`,
    });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        email: dto.email,
        firebase_uid: 'firebase-client-1',
        role: Role.CLIENT,
        auth_provider: 'email',
        profile: {
          create: {
            first_name: dto.first_name,
            last_name: dto.last_name,
            level: dto.level,
            main_goal: dto.main_goal,
          },
        },
      },
      include: { profile: true },
    });
    expect(prisma.adminClientAssignment.create).toHaveBeenCalledWith({
      data: { admin_id: 'admin-1', client_id: 'client-1' },
    });
  });

  it('allows a super admin to view a client profile without assignment', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
      profile: null,
      bodyMetrics: [],
      streak: null,
    });

    await expect(
      service.getClientProfile('super-admin-1', Role.SUPER_ADMIN, 'client-1'),
    ).resolves.toEqual({
      id: 'client-1',
      role: Role.CLIENT,
      profile: null,
      bodyMetrics: [],
      streak: null,
    });

    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('rejects an admin when the client is not assigned', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'client-1',
      role: Role.CLIENT,
      profile: null,
      bodyMetrics: [],
      streak: null,
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue(null);

    await expect(
      service.getClientProfile('admin-1', Role.ADMIN, 'client-1'),
    ).rejects.toThrow(new ForbiddenException('Este cliente no está asignado a ti'));

    expect(prisma.adminClientAssignment.findFirst).toHaveBeenCalledWith({
      where: { admin_id: 'admin-1', client_id: 'client-1', is_active: true },
    });
  });

  it('returns not found before validating assignment when the client does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.getClientProfile('admin-1', Role.ADMIN, 'missing-client'),
    ).rejects.toThrow(new NotFoundException('Cliente no encontrado'));

    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('returns not found when the requested profile belongs to a non-client user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-2',
      role: Role.ADMIN,
      profile: null,
      bodyMetrics: [],
      streak: null,
    });

    await expect(
      service.getClientProfile('super-admin-1', Role.SUPER_ADMIN, 'admin-2'),
    ).rejects.toThrow(new NotFoundException('Cliente no encontrado'));

    expect(prisma.adminClientAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('returns not found when trying to unlock a non-client account', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-2',
      role: Role.ADMIN,
      is_locked: true,
    });

    await expect(service.unlockUser('admin-2')).rejects.toThrow(
      new NotFoundException('Cliente no encontrado'),
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('returns active client assignments for a super admin', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      {
        client_id: 'client-1',
        created_at: new Date('2024-01-01T10:00:00.000Z'),
        admin: {
          id: 'admin-1',
          email: 'admin-1@exom.dev',
          profile: {
            first_name: 'Ada',
            last_name: 'Trainer',
            avatar_url: 'https://cdn.exom.dev/a.png',
          },
        },
      },
    ]);

    await expect(
      service.getClientAssignments('super-admin-1', Role.SUPER_ADMIN, 'client-1'),
    ).resolves.toEqual({
      client_id: 'client-1',
      active_admins: [
        {
          id: 'admin-1',
          email: 'admin-1@exom.dev',
          profile: {
            first_name: 'Ada',
            last_name: 'Trainer',
            avatar_url: 'https://cdn.exom.dev/a.png',
          },
          assigned_at: new Date('2024-01-01T10:00:00.000Z'),
        },
      ],
    });

    expect(prisma.adminClientAssignment.findMany).toHaveBeenCalledWith({
      where: { client_id: 'client-1', is_active: true },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: {
        client_id: true,
        created_at: true,
        admin: {
          select: {
            id: true,
            email: true,
            profile: {
              select: {
                first_name: true,
                last_name: true,
                avatar_url: true,
              },
            },
          },
        },
      },
    });
  });

  it('rejects assignment management for non-super-admin users', async () => {
    await expect(
      service.getClientAssignments('admin-1', Role.ADMIN, 'client-1'),
    ).rejects.toThrow(
      new ForbiddenException('Solo un super admin puede gestionar asignaciones de clientes'),
    );

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.adminClientAssignment.findMany).not.toHaveBeenCalled();
  });

  it('updates client assignments atomically by deactivating, reactivating, and creating relations', async () => {
    const dto: UpdateClientAssignmentsDto = { admin_ids: ['admin-2', 'admin-3'] };
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.user.findMany.mockResolvedValue([{ id: 'admin-2' }, { id: 'admin-3' }]);
    prisma.adminClientAssignment.findMany
      .mockResolvedValueOnce([
        { id: 'assignment-1', admin_id: 'admin-1', is_active: true },
        { id: 'assignment-2', admin_id: 'admin-2', is_active: false },
      ])
      .mockResolvedValueOnce([
        {
          client_id: 'client-1',
          created_at: new Date('2024-02-01T10:00:00.000Z'),
          admin: {
            id: 'admin-2',
            email: 'admin-2@exom.dev',
            profile: { first_name: 'Lin', last_name: 'Coach', avatar_url: null },
          },
        },
        {
          client_id: 'client-1',
          created_at: new Date('2024-02-02T10:00:00.000Z'),
          admin: {
            id: 'admin-3',
            email: 'admin-3@exom.dev',
            profile: { first_name: 'Maya', last_name: 'Coach', avatar_url: null },
          },
        },
      ]);
    prisma.adminClientAssignment.updateMany.mockResolvedValue({ count: 1 });
    prisma.adminClientAssignment.createMany.mockResolvedValue({ count: 1 });

    await expect(
      service.updateClientAssignments('super-admin-1', Role.SUPER_ADMIN, 'client-1', dto),
    ).resolves.toEqual({
      client_id: 'client-1',
      active_admins: [
        {
          id: 'admin-2',
          email: 'admin-2@exom.dev',
          profile: { first_name: 'Lin', last_name: 'Coach', avatar_url: null },
          assigned_at: new Date('2024-02-01T10:00:00.000Z'),
        },
        {
          id: 'admin-3',
          email: 'admin-3@exom.dev',
          profile: { first_name: 'Maya', last_name: 'Coach', avatar_url: null },
          assigned_at: new Date('2024-02-02T10:00:00.000Z'),
        },
      ],
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['admin-2', 'admin-3'] },
        role: Role.ADMIN,
      },
      select: { id: true },
    });
    expect(prisma.adminClientAssignment.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: { in: ['assignment-1'] } },
      data: { is_active: false },
    });
    expect(prisma.adminClientAssignment.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['assignment-2'] } },
      data: { is_active: true },
    });
    expect(prisma.adminClientAssignment.createMany).toHaveBeenCalledWith({
      data: [{ admin_id: 'admin-3', client_id: 'client-1' }],
    });
  });

  it('rejects assignment updates when any admin is missing or has the wrong role', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });
    prisma.user.findMany.mockResolvedValue([{ id: 'admin-1' }]);

    await expect(
      service.updateClientAssignments('super-admin-1', Role.SUPER_ADMIN, 'client-1', {
        admin_ids: ['admin-1', 'admin-2'],
      }),
    ).rejects.toThrow(new NotFoundException('Uno o más administradores no existen'));

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects assignment updates when the final set is empty', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'client-1', role: Role.CLIENT });

    await expect(
      service.updateClientAssignments('super-admin-1', Role.SUPER_ADMIN, 'client-1', {
        admin_ids: [],
      }),
    ).rejects.toThrow(new BadRequestException('El cliente debe tener al menos un admin activo'));

    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requests assigned clients with deterministic pagination ordering', async () => {
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      {
        client: {
          id: 'client-1',
          email: 'client-1@exom.dev',
        },
      },
    ]);
    prisma.adminClientAssignment.count.mockResolvedValue(1);

    const pagination = new PaginationDto();
    pagination.page = 2;
    pagination.limit = 10;

    await expect(service.getMyClients('admin-1', Role.ADMIN, pagination)).resolves.toEqual({
      data: [
        {
          id: 'client-1',
          email: 'client-1@exom.dev',
        },
      ],
      total: 1,
      page: 2,
      limit: 10,
      totalPages: 1,
    });

    expect(prisma.adminClientAssignment.findMany).toHaveBeenCalledWith({
      where: {
        admin_id: 'admin-1',
        is_active: true,
        client: {
          is: {
            role: Role.CLIENT,
          },
        },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 10,
      include: {
        client: {
          select: {
            id: true,
            email: true,
            role: true,
            is_active: true,
            is_locked: true,
            created_at: true,
            profile: true,
          },
        },
      },
    });

    expect(prisma.adminClientAssignment.count).toHaveBeenCalledWith({
      where: {
        admin_id: 'admin-1',
        is_active: true,
        client: {
          is: {
            role: Role.CLIENT,
          },
        },
      },
    });
  });

  it('filters out non-client assignments from the paginated query', async () => {
    prisma.adminClientAssignment.findMany.mockResolvedValue([]);
    prisma.adminClientAssignment.count.mockResolvedValue(0);

    await service.getMyClients('admin-1', Role.ADMIN, new PaginationDto());

    const expectedWhere = {
      admin_id: 'admin-1',
      is_active: true,
      client: {
        is: {
          role: Role.CLIENT,
        },
      },
    };

    expect(prisma.adminClientAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    );
    expect(prisma.adminClientAssignment.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('returns all clients for super admin sessions', async () => {
    prisma.user.findMany.mockResolvedValue([
      {
        id: 'client-2',
        email: 'client-2@exom.dev',
        role: Role.CLIENT,
        is_active: true,
        is_locked: false,
        created_at: new Date('2024-03-02T10:00:00.000Z'),
        profile: null,
      },
    ]);
    prisma.user.count.mockResolvedValue(1);

    await expect(
      service.getMyClients('super-admin-1', Role.SUPER_ADMIN, new PaginationDto()),
    ).resolves.toEqual({
      data: [
        {
          id: 'client-2',
          email: 'client-2@exom.dev',
          role: Role.CLIENT,
          is_active: true,
          is_locked: false,
          created_at: new Date('2024-03-02T10:00:00.000Z'),
          profile: null,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: Role.CLIENT },
      skip: 0,
      take: 20,
      select: {
        id: true,
        email: true,
        role: true,
        is_active: true,
        is_locked: true,
        created_at: true,
        profile: true,
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { role: Role.CLIENT },
    });
    expect(prisma.adminClientAssignment.findMany).not.toHaveBeenCalled();
  });

  it('requests the global users list with deterministic ordering', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);

    await expect(service.findAll(undefined, new PaginationDto())).resolves.toEqual({
      data: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {},
      skip: 0,
      take: 20,
      select: {
        id: true,
        email: true,
        role: true,
        is_active: true,
        is_locked: true,
        created_at: true,
        profile: { select: { first_name: true, last_name: true, avatar_url: true } },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    });
  });
});

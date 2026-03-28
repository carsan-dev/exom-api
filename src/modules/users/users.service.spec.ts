import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { UsersService } from './users.service';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
    adminClientAssignment: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
      },
      adminClientAssignment: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    service = new UsersService(prisma as unknown as PrismaService);
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

    await expect(service.getMyClients('admin-1', pagination)).resolves.toEqual({
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

    await service.getMyClients('admin-1', new PaginationDto());

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

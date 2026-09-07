import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from './users.service';
import { AdminClientsQueryDto } from './dto/admin-clients-query.dto';

describe('Client archive visibility', () => {
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    user: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    adminClientAssignment: { findMany: jest.fn(), count: jest.fn() },
  };
  // Only persistence is substituted; unrelated constructor dependencies are unused.
  const service = new UsersService(
    prisma as unknown as PrismaService,
    undefined!,
    undefined!,
    undefined!,
    undefined!,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([{ id: 'assigned' }]);
    prisma.user.findUnique.mockResolvedValue({
      role: Role.SUPER_ADMIN,
      is_active: true,
      is_locked: false,
    });
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.count.mockResolvedValue(0);
    prisma.adminClientAssignment.findMany.mockResolvedValue([]);
    prisma.adminClientAssignment.count.mockResolvedValue(0);
  });
  it.each([true, false])(
    'writes only the requested archive state %s, including duplicate delivery',
    async (archived) => {
      await service.setClientArchived(
        'super',
        Role.SUPER_ADMIN,
        'client',
        archived,
      );
      await service.setClientArchived(
        'super',
        Role.SUPER_ADMIN,
        'client',
        archived,
      );
      expect(prisma.user.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.user.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'client', role: Role.CLIENT },
        data: { is_archived: archived },
      });
    },
  );
  it('checks admin assignment in the write and refuses an unassigned client', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: Role.ADMIN,
      is_active: true,
      is_locked: false,
    });
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.setClientArchived('admin', Role.ADMIN, 'other', true),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'other',
        role: Role.CLIENT,
        clientOf: { some: { admin_id: 'admin', is_active: true } },
      },
      data: { is_archived: true },
    });
  });
  it('refuses client role without writing', async () => {
    await expect(
      service.setClientArchived('client', Role.CLIENT, 'client', true),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
  it.each([Role.SUPER_ADMIN, Role.ADMIN])(
    'filters rows and totals for %s without changing account-state filters',
    async (role) => {
      for (const archive of ['visible', 'archived', 'all'] as const) {
        const query = Object.assign(new AdminClientsQueryDto(), { archive });
        await service.getMyClients('admin', role, query);
        const clientWhere = {
          role: Role.CLIENT,
          ...(archive === 'all' ? {} : { is_archived: archive === 'archived' }),
        };
        if (role === Role.ADMIN) {
          const where = {
            admin_id: 'admin',
            is_active: true,
            client: { is: clientWhere },
          };
          expect(
            prisma.adminClientAssignment.findMany,
          ).toHaveBeenLastCalledWith(expect.objectContaining({ where }));
          expect(prisma.adminClientAssignment.count).toHaveBeenLastCalledWith({
            where,
          });
        } else {
          expect(prisma.user.findMany).toHaveBeenLastCalledWith(
            expect.objectContaining({ where: clientWhere }),
          );
          expect(prisma.user.count).toHaveBeenLastCalledWith({
            where: clientWhere,
          });
        }
      }
    },
  );
  it('keeps the legacy all-clients contract when the visibility filter is omitted', async () => {
    await service.getMyClients('admin', Role.SUPER_ADMIN);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: Role.CLIENT } }),
    );
  });
});

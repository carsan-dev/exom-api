import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RecapStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecapsService } from './recaps.service';
import { ADMIN_RECAP_STATUSES, AdminRecapQueryDto } from './dto/admin-recap-query.dto';

describe('RecapsService', () => {
  let service: RecapsService;
  let prisma: {
    user: {
      findMany: jest.Mock;
    };
    adminClientAssignment: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
    };
    weeklyRecap: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };

  const createRecapDto = {
    week_start_date: '2026-03-30T00:00:00.000Z',
    week_end_date: '2026-04-05T00:00:00.000Z',
  };

  beforeEach(() => {
    prisma = {
      user: {
        findMany: jest.fn(),
      },
      adminClientAssignment: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      weeklyRecap: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    service = new RecapsService(prisma as unknown as PrismaService);
  });

  it('rejects overwriting a reviewed recap from create', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.REVIEWED,
      archived_at: null,
    });

    await expect(service.create('client-1', createRecapDto)).rejects.toThrow(
      new ForbiddenException('Only draft recaps can be overwritten'),
    );

    expect(prisma.weeklyRecap.create).not.toHaveBeenCalled();
    expect(prisma.weeklyRecap.update).not.toHaveBeenCalled();
  });

  it('rejects overwriting an archived recap from create', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.REVIEWED,
      archived_at: new Date('2026-04-01T10:00:00.000Z'),
    });

    await expect(service.create('client-1', createRecapDto)).rejects.toThrow(
      new ForbiddenException('Cannot overwrite an archived recap'),
    );

    expect(prisma.weeklyRecap.create).not.toHaveBeenCalled();
    expect(prisma.weeklyRecap.update).not.toHaveBeenCalled();
  });

  it('stores submitted_at when a client submits a recap', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.DRAFT,
    });
    prisma.weeklyRecap.update.mockResolvedValue({ id: 'recap-1', status: RecapStatus.SUBMITTED });

    await service.submit('client-1', 'recap-1');

    expect(prisma.weeklyRecap.update).toHaveBeenCalledWith({
      where: { id: 'recap-1' },
      data: expect.objectContaining({
        status: RecapStatus.SUBMITTED,
        submitted_at: expect.any(Date),
      }),
    });
  });

  it('stores admin comments without overwriting client notes', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.SUBMITTED,
      archived_at: null,
      client: {
        id: 'client-1',
        email: 'client-1@exom.dev',
        profile: null,
      },
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });
    prisma.weeklyRecap.update.mockResolvedValue({ id: 'recap-1', status: RecapStatus.REVIEWED });

    await service.review('admin-1', Role.ADMIN, 'recap-1', {
      admin_comments: 'Buen trabajo esta semana',
    });

    expect(prisma.weeklyRecap.update).toHaveBeenCalledWith({
      where: { id: 'recap-1' },
      data: expect.objectContaining({
        status: RecapStatus.REVIEWED,
        reviewed_at: expect.any(Date),
        admin_comments: 'Buen trabajo esta semana',
      }),
    });
    expect(prisma.weeklyRecap.update.mock.calls[0][0].data.general_notes).toBeUndefined();
  });

  it('rejects reviewing a draft recap', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.DRAFT,
      archived_at: null,
      client: {
        id: 'client-1',
        email: 'client-1@exom.dev',
        profile: null,
      },
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });

    await expect(
      service.review('admin-1', Role.ADMIN, 'recap-1', {
        admin_comments: 'No debería permitirse',
      }),
    ).rejects.toThrow(new ForbiddenException('Cannot review a draft recap'));

    expect(prisma.weeklyRecap.update).not.toHaveBeenCalled();
  });

  it('updates only admin comments when editing an already reviewed recap', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.REVIEWED,
      reviewed_at: new Date('2026-04-01T10:00:00.000Z'),
      archived_at: null,
      admin_comments: 'Comentario anterior',
      client: {
        id: 'client-1',
        email: 'client-1@exom.dev',
        profile: null,
      },
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });
    prisma.weeklyRecap.update.mockResolvedValue({ id: 'recap-1', status: RecapStatus.REVIEWED });

    await service.review('admin-1', Role.ADMIN, 'recap-1', {
      admin_comments: 'Comentario actualizado',
    });

    expect(prisma.weeklyRecap.update).toHaveBeenCalledWith({
      where: { id: 'recap-1' },
      data: {
        admin_comments: 'Comentario actualizado',
      },
    });
  });

  it('excludes archived recaps by default in admin listing', async () => {
    prisma.adminClientAssignment.findMany.mockResolvedValue([{ client_id: 'client-1' }]);
    prisma.weeklyRecap.findMany.mockResolvedValue([]);
    prisma.weeklyRecap.count.mockResolvedValue(0);

    await service.findForAdmin('admin-1', Role.ADMIN, new AdminRecapQueryDto());

    expect(prisma.weeklyRecap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          client_id: { in: ['client-1'] },
          archived_at: null,
        }),
      }),
    );
  });

  it('does not expose draft recaps when admin status validation is bypassed', async () => {
    prisma.adminClientAssignment.findMany.mockResolvedValue([{ client_id: 'client-1' }]);
    prisma.weeklyRecap.findMany.mockResolvedValue([]);
    prisma.weeklyRecap.count.mockResolvedValue(0);

    const query = Object.assign(new AdminRecapQueryDto(), {
      status: RecapStatus.DRAFT as unknown as AdminRecapQueryDto['status'],
    });

    await service.findForAdmin('admin-1', Role.ADMIN, query);

    expect(prisma.weeklyRecap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: [...ADMIN_RECAP_STATUSES] },
        }),
      }),
    );
  });

  it('can request archived recaps explicitly in admin listing', async () => {
    prisma.adminClientAssignment.findMany.mockResolvedValue([{ client_id: 'client-1' }]);
    prisma.weeklyRecap.findMany.mockResolvedValue([]);
    prisma.weeklyRecap.count.mockResolvedValue(0);

    const query = Object.assign(new AdminRecapQueryDto(), { archived: true });
    await service.findForAdmin('admin-1', Role.ADMIN, query);

    expect(prisma.weeklyRecap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          archived_at: { not: null },
        }),
      }),
    );
  });

  it('rejects archiving a recap that is not reviewed', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.SUBMITTED,
      archived_at: null,
      client: {
        id: 'client-1',
        email: 'client-1@exom.dev',
        profile: null,
      },
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({ id: 'assignment-1' });

    await expect(service.archive('admin-1', Role.ADMIN, 'recap-1')).rejects.toThrow(
      new ForbiddenException('Only reviewed recaps can be archived'),
    );
  });

  it('rejects an admin without assignment when requesting recap detail', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.SUBMITTED,
      archived_at: null,
      client: {
        id: 'client-1',
        email: 'client-1@exom.dev',
        profile: null,
      },
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue(null);

    await expect(service.getAdminRecapById('admin-1', Role.ADMIN, 'recap-1')).rejects.toThrow(
      new ForbiddenException('Access denied'),
    );
  });

  it('returns not found when the recap does not exist', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue(null);

    await expect(service.getAdminRecapById('admin-1', Role.ADMIN, 'missing')).rejects.toThrow(
      new NotFoundException('Recap not found'),
    );
  });
});

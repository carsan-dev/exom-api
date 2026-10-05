import type { NotificationsService } from '../notifications/notifications.service';
import { expect } from '@jest/globals';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, RecapStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RecapsService } from './recaps.service';
import {
  ADMIN_RECAP_STATUSES,
  AdminRecapQueryDto,
} from './dto/admin-recap-query.dto';

describe('RecapsService', () => {
  let service: RecapsService;
  let notificationsService: {
    sendToUser: jest.Mock;
  };
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
      update: jest.Mock<
        Promise<unknown>,
        [{ data: Record<string, unknown>; select?: Record<string, boolean> }]
      >;
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
        update: jest.fn<
          Promise<unknown>,
          [{ data: Record<string, unknown>; select?: Record<string, boolean> }]
        >(),
      },
    };

    notificationsService = {
      sendToUser: jest
        .fn()
        .mockResolvedValue({ success: true, message: 'queued' }),
    };

    service = new RecapsService(
      prisma as unknown as PrismaService,
      notificationsService as unknown as NotificationsService,
    );
  });

  it.each(['create', 'overwrite', 'update', 'submit'])(
    'keeps populated notes and review drafts private in %s while preserving every shareable legacy scalar',
    async (operation) => {
      const review = {
        draft_coach_summary: 'private draft summary',
        draft_changes: 'private draft changes',
        draft_next_week_goals: 'private draft goals',
        published_coach_summary: 'last published summary',
        published_changes: 'last published changes',
        published_next_week_goals: 'last published goals',
        review_version: 7,
      };
      const model = Prisma.dmmf.datamodel.models.find(
        (model) => model.name === 'WeeklyRecap',
      );
      if (!model) throw new Error('WeeklyRecap metadata missing');
      const keys = model.fields
        .filter(
          (field) =>
            field.kind !== 'object' &&
            field.name !== 'admin_comments' &&
            !(field.name in review),
        )
        .map((field) => field.name);
      const legacy: Record<string, unknown> = Object.fromEntries(
        keys.map((key) => [key, `legacy:${key}`]),
      );
      Object.assign(legacy, {
        id: 'recap-1',
        client_id: 'client-1',
        status: RecapStatus.DRAFT,
        archived_at: null,
      });
      expect(keys).toHaveLength(39);
      const stored = {
        ...legacy,
        ...review,
        admin_comments: '  Private coach note ñ\r\n  ',
      };
      const project = ({ select }: { select?: Record<string, boolean> }) =>
        Promise.resolve(
          select
            ? Object.fromEntries(
                Object.entries(stored).filter(([key]) => select[key]),
              )
            : stored,
        );
      prisma.weeklyRecap.findUnique.mockResolvedValue(
        operation === 'create' ? null : stored,
      );
      prisma.weeklyRecap.create.mockImplementation(project);
      prisma.weeklyRecap.update.mockImplementation(project);
      const result =
        operation === 'create' || operation === 'overwrite'
          ? await service.create('client-1', createRecapDto)
          : operation === 'update'
            ? await service.update('client-1', 'recap-1', {
                training_notes: 'updated',
              })
            : await service.submit('client-1', 'recap-1');
      expect(result).toEqual({
        ...legacy,
        published_coach_summary: review.published_coach_summary,
        published_changes: review.published_changes,
        published_next_week_goals: review.published_next_week_goals,
      });
      expect(stored.admin_comments).toBe('  Private coach note ñ\r\n  ');
      prisma.weeklyRecap.findUnique.mockResolvedValue(stored);
      const admin = await service.getAdminRecapById(
        'admin-1',
        Role.SUPER_ADMIN,
        'recap-1',
      );
      expect(admin.admin_comments).toBe(stored.admin_comments);
      expect(notificationsService.sendToUser).not.toHaveBeenCalled();
    },
  );

  it('rejects overwriting a reviewed recap from create', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.REVIEWED,
      archived_at: null,
    });

    await expect(service.create('client-1', createRecapDto)).rejects.toThrow(
      new ForbiddenException(
        'You already have a submitted recap for this week',
      ),
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

  it('stores average daily steps when creating a recap', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue(null);
    prisma.weeklyRecap.create.mockResolvedValue({
      id: 'recap-1',
      average_daily_steps: 8500,
    });

    await service.create('client-1', {
      ...createRecapDto,
      average_daily_steps: 8500,
    });

    expect(prisma.weeklyRecap.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        client_id: 'client-1',
        average_daily_steps: 8500,
      }),
      select: expect.objectContaining({ id: true, client_feedback_text: true }),
    });
  });

  it('includes average daily steps in client recap responses', async () => {
    prisma.weeklyRecap.findMany.mockResolvedValue([]);
    prisma.weeklyRecap.count.mockResolvedValue(0);

    await service.findMyRecaps('client-1', new AdminRecapQueryDto());

    expect(prisma.weeklyRecap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ average_daily_steps: true }),
      }),
    );
  });

  it('stores submitted_at when a client submits a recap', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.DRAFT,
    });
    prisma.weeklyRecap.update.mockResolvedValue({
      id: 'recap-1',
      status: RecapStatus.SUBMITTED,
    });

    await service.submit('client-1', 'recap-1');

    expect(prisma.weeklyRecap.update).toHaveBeenCalledWith({
      where: {
        id: 'recap-1',
        client_id: 'client-1',
        status: RecapStatus.DRAFT,
      },
      data: expect.objectContaining({
        status: RecapStatus.SUBMITTED,
        submitted_at: expect.any(Date),
      }),
      select: expect.objectContaining({ id: true, client_feedback_text: true }),
    });
  });

  it('rejects editing a submitted recap', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.SUBMITTED,
    });

    await expect(
      service.update('client-1', 'recap-1', {
        training_notes: 'No debería guardar cambios',
      }),
    ).rejects.toThrow(
      new ForbiddenException('Only draft recaps can be edited'),
    );

    expect(prisma.weeklyRecap.update).not.toHaveBeenCalled();
  });

  it('clears average daily steps when updating a draft with null', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.DRAFT,
    });
    prisma.weeklyRecap.update.mockResolvedValue({
      id: 'recap-1',
      average_daily_steps: null,
    });

    await service.update('client-1', 'recap-1', {
      average_daily_steps: null,
    });

    expect(prisma.weeklyRecap.update).toHaveBeenCalledWith({
      where: { id: 'recap-1' },
      data: { average_daily_steps: null },
      select: expect.objectContaining({ id: true, client_feedback_text: true }),
    });
  });

  it('rejects submitting a recap that is already submitted', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.SUBMITTED,
    });

    await expect(service.submit('client-1', 'recap-1')).rejects.toThrow(
      new ForbiddenException('Only draft recaps can be submitted'),
    );

    expect(prisma.weeklyRecap.update).not.toHaveBeenCalled();
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
    prisma.adminClientAssignment.findFirst.mockResolvedValue({
      id: 'assignment-1',
    });
    prisma.weeklyRecap.update.mockResolvedValue({
      id: 'recap-1',
      status: RecapStatus.REVIEWED,
    });

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
    expect(
      prisma.weeklyRecap.update.mock.calls[0][0].data.general_notes,
    ).toBeUndefined();
    expect(notificationsService.sendToUser).not.toHaveBeenCalled();
  });

  it('stores client feedback metadata and sends a push after a successful review update', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.SUBMITTED,
      archived_at: null,
      client_feedback_text: null,
      client: {
        id: 'client-1',
        email: 'client-1@exom.dev',
        profile: null,
      },
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({
      id: 'assignment-1',
    });
    prisma.weeklyRecap.update.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.REVIEWED,
    });

    await service.review('admin-1', Role.ADMIN, 'recap-1', {
      client_feedback_text: 'Revisa la movilidad de cadera esta semana',
    });

    expect(prisma.weeklyRecap.update).toHaveBeenCalledWith({
      where: { id: 'recap-1' },
      data: expect.objectContaining({
        status: RecapStatus.REVIEWED,
        reviewed_at: expect.any(Date),
        client_feedback_text: 'Revisa la movilidad de cadera esta semana',
        client_feedback_sent_at: expect.any(Date),
        client_feedback_read_at: null,
      }),
    });
    expect(notificationsService.sendToUser).toHaveBeenCalledWith(
      'admin-1',
      'client-1',
      'Tu entrenador te ha dejado un comentario',
      'Abre tu recap semanal para leer el feedback de tu entrenador.',
      {
        type: 'recap_feedback',
        route: '/recap/recap-1',
      },
    );
  });

  it('clears client feedback metadata when the visible comment is removed', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      status: RecapStatus.REVIEWED,
      archived_at: null,
      client_feedback_text: 'Comentario previo',
      client: {
        id: 'client-1',
        email: 'client-1@exom.dev',
        profile: null,
      },
    });
    prisma.adminClientAssignment.findFirst.mockResolvedValue({
      id: 'assignment-1',
    });
    prisma.weeklyRecap.update.mockResolvedValue({
      id: 'recap-1',
      status: RecapStatus.REVIEWED,
    });

    await service.review('admin-1', Role.ADMIN, 'recap-1', {
      client_feedback_text: '   ',
    });

    expect(prisma.weeklyRecap.update).toHaveBeenCalledWith({
      where: { id: 'recap-1' },
      data: {
        client_feedback_text: null,
        client_feedback_sent_at: null,
        client_feedback_read_at: null,
      },
    });
    expect(notificationsService.sendToUser).not.toHaveBeenCalled();
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
    prisma.adminClientAssignment.findFirst.mockResolvedValue({
      id: 'assignment-1',
    });

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
    prisma.adminClientAssignment.findFirst.mockResolvedValue({
      id: 'assignment-1',
    });
    prisma.weeklyRecap.update.mockResolvedValue({
      id: 'recap-1',
      status: RecapStatus.REVIEWED,
    });

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
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);
    prisma.weeklyRecap.findMany.mockResolvedValue([]);
    prisma.weeklyRecap.count.mockResolvedValue(0);

    await service.findForAdmin('admin-1', Role.ADMIN, new AdminRecapQueryDto());

    expect(prisma.weeklyRecap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          client: {
            is: {
              clientOf: { some: { admin_id: 'admin-1', is_active: true } },
            },
          },
          archived_at: null,
        }),
        select: expect.objectContaining({
          id: true,
          average_daily_steps: true,
          client: expect.any(Object),
        }),
      }),
    );
  });

  it('does not expose draft recaps when admin status validation is bypassed', async () => {
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);
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
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);
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
    prisma.adminClientAssignment.findFirst.mockResolvedValue({
      id: 'assignment-1',
    });

    await expect(
      service.archive('admin-1', Role.ADMIN, 'recap-1'),
    ).rejects.toThrow(
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

    await expect(
      service.getAdminRecapById('admin-1', Role.ADMIN, 'recap-1'),
    ).rejects.toThrow(new ForbiddenException('Access denied'));
  });

  it('returns not found when the recap does not exist', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue(null);

    await expect(
      service.getAdminRecapById('admin-1', Role.ADMIN, 'missing'),
    ).rejects.toThrow(new NotFoundException('Recap not found'));
  });

  it('marks visible client feedback as read', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      client_feedback_text: 'Comentario visible',
      client_feedback_read_at: null,
    });
    prisma.weeklyRecap.update.mockResolvedValue({ id: 'recap-1' });

    await expect(
      service.markClientFeedbackAsRead('client-1', 'recap-1'),
    ).resolves.toEqual({
      success: true,
    });

    expect(prisma.weeklyRecap.update).toHaveBeenCalledWith({
      where: { id: 'recap-1' },
      data: { client_feedback_read_at: expect.any(Date) },
    });
  });

  it('keeps mark-as-read as a no-op when there is no visible feedback', async () => {
    prisma.weeklyRecap.findUnique.mockResolvedValue({
      id: 'recap-1',
      client_id: 'client-1',
      client_feedback_text: null,
      client_feedback_read_at: null,
    });

    await expect(
      service.markClientFeedbackAsRead('client-1', 'recap-1'),
    ).resolves.toEqual({
      success: true,
    });

    expect(prisma.weeklyRecap.update).not.toHaveBeenCalled();
  });
});

import { FeedbackStatus, MediaType, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { FeedbackService } from './feedback.service';
import type { UploadsService } from '../uploads/uploads.service';

describe('FeedbackService', () => {
  let service: FeedbackService;
  let prisma: {
    $transaction: jest.Mock;
    feedbackMedia: {
      create: jest.Mock;
      findUnique: jest.Mock;
    };
    adminClientAssignment: {
      findMany: jest.Mock;
    };
  };
  let notifications: {
    sendInternalTemplate: jest.Mock;
  };
  let uploadsService: {
    prepareForConsumption: jest.Mock;
    consumePrepared: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(),
      feedbackMedia: {
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      adminClientAssignment: {
        findMany: jest.fn(),
      },
    };
    notifications = {
      sendInternalTemplate: jest.fn().mockResolvedValue({
        success: true,
        sent: 1,
        failed: 0,
      }),
    };
    uploadsService = {
      prepareForConsumption: jest.fn().mockResolvedValue({
        id: 'upload-1',
        file_url: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
      }),
      consumePrepared: jest.fn().mockResolvedValue(undefined),
    };
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );

    service = new FeedbackService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
      uploadsService as unknown as UploadsService,
    );
  });

  it('notifies assigned admins when a client uploads feedback', async () => {
    prisma.feedbackMedia.create.mockResolvedValue({
      id: 'feedback-1',
      client_id: 'client-1',
      media_type: MediaType.VIDEO,
      media_url: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
      notes: 'Revisar técnica',
      status: FeedbackStatus.PENDING,
    });
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      {
        admin_id: 'admin-1',
        client: {
          email: 'client-1@exom.dev',
          profile: {
            first_name: 'Ada',
            last_name: 'Rivera',
          },
        },
      },
      {
        admin_id: 'admin-2',
        client: {
          email: 'client-1@exom.dev',
          profile: {
            first_name: 'Ada',
            last_name: 'Rivera',
          },
        },
      },
    ]);

    await expect(
      service.create('client-1', {
        media_type: MediaType.VIDEO,
        media_url: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
        notes: 'Revisar técnica',
      }),
    ).resolves.toMatchObject({ id: 'feedback-1' });

    expect(prisma.feedbackMedia.create).toHaveBeenCalledWith({
      data: {
        client_id: 'client-1',
        media_type: MediaType.VIDEO,
        media_url: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
        notes: 'Revisar técnica',
        status: FeedbackStatus.PENDING,
      },
    });
    expect(uploadsService.prepareForConsumption).toHaveBeenCalledWith({
      ownerId: 'client-1',
      uploadId: undefined,
      legacyUrl: 'https://cdn.exom.dev/feedback_video/client-1/video.mp4',
      purposes: ['FEEDBACK_VIDEO'],
    });
    expect(uploadsService.consumePrepared).toHaveBeenCalledWith(
      prisma,
      'client-1',
      'upload-1',
      ['FEEDBACK_VIDEO'],
    );
    expect(prisma.adminClientAssignment.findMany).toHaveBeenCalledWith({
      where: {
        client_id: 'client-1',
        is_active: true,
        admin: {
          is: {
            role: Role.ADMIN,
            is_active: true,
          },
        },
      },
      select: {
        admin_id: true,
        client: {
          select: {
            email: true,
            profile: {
              select: {
                first_name: true,
                last_name: true,
              },
            },
          },
        },
      },
    });
    expect(notifications.sendInternalTemplate).toHaveBeenCalledWith(
      'client-1',
      ['admin-1', 'admin-2'],
      'admin_feedback_submitted',
      {
        clientName: 'Ada Rivera',
        clientId: 'client-1',
        feedbackId: 'feedback-1',
      },
      {
        title: 'Nuevo feedback de cliente',
        body: 'Ada Rivera subi\u00f3 feedback',
        route: '/admin/feedback/feedback-1',
      },
      {
        type: 'feedback_submitted',
        feedback_id: 'feedback-1',
        client_id: 'client-1',
      },
    );
  });

  it('returns existing feedback for a repeated client upload id', async () => {
    prisma.feedbackMedia.findUnique.mockResolvedValue({
      id: 'feedback-existing',
      client_id: 'client-1',
      client_upload_id: 'upload-1',
    });

    await expect(
      service.create('client-1', {
        client_upload_id: 'upload-1',
        media_type: MediaType.VIDEO,
        media_url: 'https://cdn.exom.dev/video.mp4',
      }),
    ).resolves.toMatchObject({ id: 'feedback-existing' });

    expect(prisma.feedbackMedia.create).not.toHaveBeenCalled();
    expect(notifications.sendInternalTemplate).not.toHaveBeenCalled();
  });

  it('returns the winner when concurrent client upload ids race', async () => {
    const existing = {
      id: 'feedback-existing',
      client_id: 'client-1',
      client_upload_id: 'upload-1',
    };
    prisma.feedbackMedia.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing);
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate feedback upload', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.create('client-1', {
        client_upload_id: 'upload-1',
        media_type: MediaType.VIDEO,
        media_url: 'https://cdn.exom.dev/video.mp4',
      }),
    ).resolves.toEqual(existing);

    expect(prisma.feedbackMedia.findUnique).toHaveBeenCalledTimes(2);
    expect(notifications.sendInternalTemplate).not.toHaveBeenCalled();
  });
});

import { FeedbackStatus, MediaType, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { FeedbackService } from './feedback.service';

describe('FeedbackService', () => {
  let service: FeedbackService;
  let prisma: {
    feedbackMedia: {
      create: jest.Mock;
    };
    adminClientAssignment: {
      findMany: jest.Mock;
    };
  };
  let notifications: {
    sendInternalNotifications: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      feedbackMedia: {
        create: jest.fn(),
      },
      adminClientAssignment: {
        findMany: jest.fn(),
      },
    };
    notifications = {
      sendInternalNotifications: jest.fn().mockResolvedValue({
        success: true,
        sent: 1,
        failed: 0,
      }),
    };

    service = new FeedbackService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    );
  });

  it('notifies assigned admins when a client uploads feedback', async () => {
    prisma.feedbackMedia.create.mockResolvedValue({
      id: 'feedback-1',
      client_id: 'client-1',
      media_type: MediaType.VIDEO,
      media_url: 'https://cdn.exom.dev/video.mp4',
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
        media_url: 'https://cdn.exom.dev/video.mp4',
        notes: 'Revisar técnica',
      }),
    ).resolves.toMatchObject({ id: 'feedback-1' });

    expect(prisma.feedbackMedia.create).toHaveBeenCalledWith({
      data: {
        client_id: 'client-1',
        exercise_id: undefined,
        media_type: MediaType.VIDEO,
        media_url: 'https://cdn.exom.dev/video.mp4',
        notes: 'Revisar técnica',
        status: FeedbackStatus.PENDING,
      },
    });
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
    expect(notifications.sendInternalNotifications).toHaveBeenCalledWith(
      'client-1',
      ['admin-1', 'admin-2'],
      'Nuevo feedback de cliente',
      'Ada Rivera subió feedback',
      {
        type: 'feedback_submitted',
        route: '/admin/feedback/feedback-1',
        feedback_id: 'feedback-1',
        client_id: 'client-1',
      },
    );
  });
});

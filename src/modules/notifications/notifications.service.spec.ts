import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NotificationStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const sendMock = jest.fn();

jest.mock('firebase-admin', () => ({
  messaging: () => ({
    send: sendMock,
  }),
}));

function createNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notification-1',
    sender_id: 'admin-1',
    recipient_id: 'client-1',
    title: 'Weekly recap',
    body: 'Completa tu recap',
    data: { type: 'recap_reminder', route: '/recap' },
    status: NotificationStatus.SENT,
    error: null,
    read_at: null,
    created_at: new Date('2026-04-04T10:00:00.000Z'),
    recipient: {
      email: 'cliente@exom.dev',
      profile: {
        first_name: 'Ada',
        last_name: 'Client',
        avatar_url: null,
      },
    },
    ...overrides,
  };
}

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
    };
    adminClientAssignment: {
      findMany: jest.Mock;
    };
    notification: {
      create: jest.Mock;
    };
  };

  const adminUser = {
    id: 'admin-1',
    role: Role.ADMIN,
  };

  const clientUser = {
    id: 'client-1',
    email: 'cliente@exom.dev',
    role: Role.CLIENT,
    fcm_token: 'token-123',
  };

  beforeEach(() => {
    sendMock.mockReset();
    prisma = {
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      adminClientAssignment: {
        findMany: jest.fn(),
      },
      notification: {
        create: jest.fn(),
      },
    };

    service = new NotificationsService(prisma as unknown as PrismaService);
  });

  it('throws when the sender does not exist', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.sendToUser('missing-sender', 'client-1', 'Titulo', 'Cuerpo'),
    ).rejects.toThrow(new NotFoundException('Sender not found'));

    expect(prisma.adminClientAssignment.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('throws when the sender does not have admin permissions', async () => {
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'client-sender', role: Role.CLIENT });

    await expect(
      service.sendToUser('client-sender', 'client-1', 'Titulo', 'Cuerpo'),
    ).rejects.toThrow(new ForbiddenException('No tienes permisos para enviar notificaciones'));

    expect(prisma.adminClientAssignment.findMany).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('persists a failed notification when the recipient has no FCM token', async () => {
    const failedNotification = createNotification({
      title: 'Titulo',
      body: 'Cuerpo',
      data: null,
      status: NotificationStatus.FAILED,
      error: 'No FCM token registered for this user',
    });

    prisma.user.findUnique
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce({ ...clientUser, fcm_token: null });
    prisma.adminClientAssignment.findMany.mockResolvedValue([{ client_id: 'client-1' }]);
    prisma.notification.create.mockResolvedValue(failedNotification);

    await expect(
      service.sendToUser('admin-1', 'client-1', 'Titulo', 'Cuerpo'),
    ).resolves.toEqual(failedNotification);

    expect(sendMock).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sender_id: 'admin-1',
          recipient_id: 'client-1',
          title: 'Titulo',
          body: 'Cuerpo',
          status: NotificationStatus.FAILED,
          error: 'No FCM token registered for this user',
        }),
      }),
    );
  });

  it('sends and persists a notification successfully', async () => {
    const sentNotification = createNotification();

    prisma.user.findUnique.mockResolvedValueOnce(adminUser).mockResolvedValueOnce(clientUser);
    prisma.adminClientAssignment.findMany.mockResolvedValue([{ client_id: 'client-1' }]);
    prisma.notification.create.mockResolvedValue(sentNotification);
    sendMock.mockResolvedValue('message-id-123');

    await expect(
      service.sendToUser('admin-1', 'client-1', 'Weekly recap', 'Completa tu recap', {
        type: 'recap_reminder',
      }),
    ).resolves.toEqual(sentNotification);

    expect(sendMock).toHaveBeenCalledWith({
      token: 'token-123',
      notification: {
        title: 'Weekly recap',
        body: 'Completa tu recap',
      },
      data: {
        type: 'recap_reminder',
        route: '/recap',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'exom_high_importance',
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
        payload: {
          aps: {
            sound: 'default',
          },
        },
      },
    });
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sender_id: 'admin-1',
          recipient_id: 'client-1',
          title: 'Weekly recap',
          body: 'Completa tu recap',
          data: {
            type: 'recap_reminder',
            route: '/recap',
          },
          status: NotificationStatus.SENT,
        }),
      }),
    );
  });

  it('preserves an explicit deep link route from the payload', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(adminUser).mockResolvedValueOnce(clientUser);
    prisma.adminClientAssignment.findMany.mockResolvedValue([{ client_id: 'client-1' }]);
    prisma.notification.create.mockResolvedValue(
      createNotification({
        title: 'Nuevo feedback',
        body: 'Abre tu recap',
        data: {
          type: 'recap_feedback',
          route: '/recap/recap-1',
        },
      }),
    );
    sendMock.mockResolvedValue('message-id-456');

    await service.sendToUser('admin-1', 'client-1', 'Nuevo feedback', 'Abre tu recap', {
      type: 'recap_feedback',
      route: '/recap/recap-1',
    });

    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          type: 'recap_feedback',
          route: '/recap/recap-1',
        },
      }),
    );
  });

  it('falls back to the recap route when recap feedback has no direct deep link', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(adminUser).mockResolvedValueOnce(clientUser);
    prisma.adminClientAssignment.findMany.mockResolvedValue([{ client_id: 'client-1' }]);
    prisma.notification.create.mockResolvedValue(
      createNotification({
        title: 'Nuevo feedback',
        body: 'Abre tu recap',
        data: {
          type: 'recap_feedback',
          route: '/recap',
        },
      }),
    );
    sendMock.mockResolvedValue('message-id-789');

    await service.sendToUser('admin-1', 'client-1', 'Nuevo feedback', 'Abre tu recap', {
      type: 'recap_feedback',
    });

    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          type: 'recap_feedback',
          route: '/recap',
        },
      }),
    );
  });
});

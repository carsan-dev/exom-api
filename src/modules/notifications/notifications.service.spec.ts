import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const sendMock = jest.fn();

jest.mock('firebase-admin', () => ({
  messaging: () => ({
    send: sendMock,
  }),
}));

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: {
    user: {
      findUnique: jest.Mock;
    };
  };

  beforeEach(() => {
    sendMock.mockReset();
    prisma = {
      user: {
        findUnique: jest.fn(),
      },
    };

    service = new NotificationsService(prisma as unknown as PrismaService);
  });

  it('returns a not found response when the user does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.sendToUser('missing-user', 'Titulo', 'Cuerpo'),
    ).resolves.toEqual({
      success: false,
      message: 'User not found',
    });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns a validation response when the user has no FCM token', async () => {
    prisma.user.findUnique.mockResolvedValue({
      email: 'cliente@exom.dev',
      firebase_uid: 'firebase-uid',
      fcm_token: null,
    });

    await expect(
      service.sendToUser('user-1', 'Titulo', 'Cuerpo'),
    ).resolves.toEqual({
      success: false,
      message: 'No FCM token registered for this user',
    });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends a push notification through Firebase Admin', async () => {
    prisma.user.findUnique.mockResolvedValue({
      email: 'cliente@exom.dev',
      firebase_uid: 'firebase-uid',
      fcm_token: 'token-123',
    });
    sendMock.mockResolvedValue('message-id-123');

    await expect(
      service.sendToUser('user-1', 'Weekly recap', 'Completa tu recap', {
        type: 'recap_reminder',
      }),
    ).resolves.toEqual({
      success: true,
      message: 'message-id-123',
    });

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
  });

  it('preserves an explicit deep link route from the payload', async () => {
    prisma.user.findUnique.mockResolvedValue({
      email: 'cliente@exom.dev',
      firebase_uid: 'firebase-uid',
      fcm_token: 'token-123',
    });
    sendMock.mockResolvedValue('message-id-456');

    await service.sendToUser('user-1', 'Nuevo feedback', 'Abre tu recap', {
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
    prisma.user.findUnique.mockResolvedValue({
      email: 'cliente@exom.dev',
      firebase_uid: 'firebase-uid',
      fcm_token: 'token-123',
    });
    sendMock.mockResolvedValue('message-id-789');

    await service.sendToUser('user-1', 'Nuevo feedback', 'Abre tu recap', {
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

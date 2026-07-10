import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
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
      deleteMany: jest.Mock;
    };
    notificationTemplate: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      upsert: jest.Mock;
      deleteMany: jest.Mock;
    };
    notificationTemplateSchedule: {
      findUnique: jest.Mock;
      findMany: jest.Mock;
      upsert: jest.Mock;
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
    is_active: true,
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
        deleteMany: jest.fn(),
      },
      notificationTemplate: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
      },
      notificationTemplateSchedule: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
      },
    };
    prisma.notificationTemplate.findMany.mockResolvedValue([]);
    prisma.notificationTemplateSchedule.findMany.mockResolvedValue([]);

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
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'client-sender',
      role: Role.CLIENT,
    });

    await expect(
      service.sendToUser('client-sender', 'client-1', 'Titulo', 'Cuerpo'),
    ).rejects.toThrow(
      new ForbiddenException('No tienes permisos para enviar notificaciones'),
    );

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
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);
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

    prisma.user.findUnique
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce(clientUser);
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);
    prisma.notification.create.mockResolvedValue(sentNotification);
    sendMock.mockResolvedValue('message-id-123');

    await expect(
      service.sendToUser(
        'admin-1',
        'client-1',
        'Weekly recap',
        'Completa tu recap',
        {
          type: 'recap_reminder',
        },
      ),
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
        notification_id: 'notification-1',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'exom_high_importance',
          sound: 'default',
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

  it('skips FCM and records FAILED when the recipient is inactive', async () => {
    const failed = createNotification({
      status: NotificationStatus.FAILED,
      error: 'Recipient inactive',
    });

    prisma.user.findUnique
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce({ ...clientUser, is_active: false });
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);
    prisma.notification.create.mockResolvedValue(failed);

    await expect(
      service.sendToUser('admin-1', 'client-1', 'Titulo', 'Cuerpo'),
    ).resolves.toEqual(failed);

    expect(sendMock).not.toHaveBeenCalled();
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: NotificationStatus.FAILED,
          error: 'Recipient inactive',
        }),
      }),
    );
  });

  it('preserves an explicit deep link route from the payload', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce(clientUser);
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);
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

    await service.sendToUser(
      'admin-1',
      'client-1',
      'Nuevo feedback',
      'Abre tu recap',
      {
        type: 'recap_feedback',
        route: '/recap/recap-1',
      },
    );

    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          type: 'recap_feedback',
          route: '/recap/recap-1',
          notification_id: 'notification-1',
        },
      }),
    );
  });

  it('falls back to the recap route when recap feedback has no direct deep link', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce(adminUser)
      .mockResolvedValueOnce(clientUser);
    prisma.adminClientAssignment.findMany.mockResolvedValue([
      { client_id: 'client-1' },
    ]);
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

    await service.sendToUser(
      'admin-1',
      'client-1',
      'Nuevo feedback',
      'Abre tu recap',
      {
        type: 'recap_feedback',
      },
    );

    expect(sendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: {
          type: 'recap_feedback',
          route: '/recap',
          notification_id: 'notification-1',
        },
      }),
    );
  });

  it('lists default templates merged with stored customizations', async () => {
    const updatedAt = new Date('2026-04-19T10:00:00.000Z');
    prisma.notificationTemplate.findMany.mockResolvedValue([
      {
        key: 'diet_reminder_meal',
        title: 'Entreno pendiente',
        body: 'Abre tu plan de hoy',
        route: null,
        enabled: false,
        updated_at: updatedAt,
      },
    ]);

    const templates = await service.listTemplates();

    expect(templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'diet_reminder_meal',
          title: 'Entreno pendiente',
          body: 'Abre tu plan de hoy',
          route: null,
          enabled: false,
          customized: true,
          is_system: true,
          delivery_info: expect.objectContaining({
            type: 'schedule',
            label: 'Todos los días a las 08:00, 13:00, 17:00 y 20:30',
            timezone: 'Europe/Madrid',
          }),
          variable_help: expect.objectContaining({
            mealLabel: 'Nombre de la comida: desayuno, comida, snack o cena.',
          }),
          updated_at: updatedAt,
        }),
      ]),
    );
  });

  it('lists scheduled templates with stored schedule overrides', async () => {
    prisma.notificationTemplateSchedule.findMany.mockResolvedValue([
      {
        template_key: 'training_reminder_daily',
        enabled: true,
        timezone: 'Europe/Madrid',
        times: ['10:30'],
        weekday: null,
      },
    ]);

    const templates = await service.listTemplates();

    expect(templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'training_reminder_daily',
          delivery_info: expect.objectContaining({
            type: 'schedule',
            label: 'Todos los días a las 10:30',
            timezone: 'Europe/Madrid',
            times: ['10:30'],
            schedule_enabled: true,
            schedule_kind: 'daily',
          }),
        }),
      ]),
    );
  });

  it('renders date-aware routes when sending internal templates', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValueOnce(clientUser);
    prisma.notification.create.mockResolvedValue(
      createNotification({
        title: 'Tu entreno de hoy te espera',
        body: 'Abre la app y empieza cuando puedas.',
        data: {
          type: 'training_reminder',
          route: '/trainings?date=2026-04-23',
        },
      }),
    );
    sendMock.mockResolvedValue('message-id-date-route');

    await expect(
      service.sendInternalTemplate(
        'system-admin',
        ['client-1'],
        'training_reminder_daily',
        { date: '2026-04-23' },
        {
          title: 'Tu entreno de hoy te espera',
          body: 'Abre la app y empieza cuando puedas.',
          route: '/trainings?date=2026-04-23',
        },
        { type: 'training_reminder' },
      ),
    ).resolves.toEqual({ success: true, sent: 1, failed: 0 });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          type: 'training_reminder',
          route: '/trainings?date=2026-04-23',
          notification_id: 'notification-1',
        },
      }),
    );
  });

  it('updates a scheduled template schedule', async () => {
    prisma.notificationTemplateSchedule.findUnique.mockResolvedValue(null);
    prisma.notificationTemplateSchedule.upsert.mockResolvedValue({
      template_key: 'recap_reminder_weekly',
      enabled: true,
      timezone: 'Europe/Madrid',
      times: ['18:15'],
      weekday: 0,
    });
    prisma.notificationTemplate.findUnique.mockResolvedValue(null);

    await expect(
      service.updateTemplateSchedule('recap_reminder_weekly', {
        enabled: true,
        timezone: 'Europe/Madrid',
        times: ['18:15'],
        weekday: 0,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        key: 'recap_reminder_weekly',
        delivery_info: expect.objectContaining({
          label: 'domingos a las 18:15',
          times: ['18:15'],
          weekday: 0,
          schedule_enabled: true,
        }),
      }),
    );

    expect(prisma.notificationTemplateSchedule.upsert).toHaveBeenCalledWith({
      where: { template_key: 'recap_reminder_weekly' },
      create: {
        template_key: 'recap_reminder_weekly',
        enabled: true,
        timezone: 'Europe/Madrid',
        times: ['18:15'],
        weekday: 0,
      },
      update: {
        enabled: true,
        timezone: 'Europe/Madrid',
        times: ['18:15'],
        weekday: 0,
      },
    });
  });

  it('rejects schedule updates for templates without programmable schedule', async () => {
    await expect(
      service.updateTemplateSchedule('achievement_unlocked', {
        times: ['09:00'],
      }),
    ).rejects.toThrow('Esta plantilla no tiene horario programable');
  });

  it('preserves meal reminder time order for meal labels', async () => {
    const times = ['08:00', '13:00', '17:00', '20:30'];
    prisma.notificationTemplateSchedule.findUnique.mockResolvedValue(null);
    prisma.notificationTemplateSchedule.upsert.mockResolvedValue({
      template_key: 'diet_reminder_meal',
      enabled: true,
      timezone: 'Europe/Madrid',
      times,
      weekday: null,
    });
    prisma.notificationTemplate.findUnique.mockResolvedValue(null);

    await service.updateTemplateSchedule('diet_reminder_meal', {
      times,
    });

    expect(prisma.notificationTemplateSchedule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ times }),
        update: expect.objectContaining({ times }),
      }),
    );
  });

  it('lists manual templates after the system templates', async () => {
    const updatedAt = new Date('2026-04-19T11:00:00.000Z');
    prisma.notificationTemplate.findMany.mockResolvedValue([
      {
        key: 'manual_revision_mensual',
        name: 'Revisión mensual',
        description: 'Plantilla para envío manual',
        category: 'Manual',
        title: 'Revisión mensual',
        body: 'Agenda tu revisión',
        route: '/recap',
        enabled: true,
        variables: [],
        updated_at: updatedAt,
      },
    ]);

    const templates = await service.listTemplates();

    expect(templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'manual_revision_mensual',
          name: 'Revisión mensual',
          description: 'Plantilla para envío manual',
          category: 'Manual',
          title: 'Revisión mensual',
          body: 'Agenda tu revisión',
          route: '/recap',
          enabled: true,
          customized: true,
          is_system: false,
          delivery_info: expect.objectContaining({
            type: 'manual',
            label: 'Manual, al enviar desde el panel',
          }),
          variables: [],
          variable_help: {},
          updated_at: updatedAt,
        }),
      ]),
    );
  });

  it('creates a manual template with a generated unique key', async () => {
    const createdAt = new Date('2026-04-19T12:00:00.000Z');
    prisma.notificationTemplate.findUnique.mockResolvedValue(null);
    prisma.notificationTemplate.create.mockResolvedValue({
      key: 'manual_revision_mensual',
      name: 'Revisión mensual',
      description: 'Aviso manual',
      category: 'Manual',
      title: 'Tu revisión mensual',
      body: 'Reserva un hueco esta semana',
      route: '/recap',
      enabled: true,
      variables: [],
      updated_at: createdAt,
    });

    await expect(
      service.createTemplate({
        name: 'Revisión mensual',
        description: 'Aviso manual',
        title: 'Tu revisión mensual',
        body: 'Reserva un hueco esta semana',
        route: '/recap',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        key: 'manual_revision_mensual',
        is_system: false,
        variable_help: {},
      }),
    );

    expect(prisma.notificationTemplate.create).toHaveBeenCalledWith({
      data: {
        key: 'manual_revision_mensual',
        name: 'Revisión mensual',
        description: 'Aviso manual',
        category: 'Manual',
        title: 'Tu revisión mensual',
        body: 'Reserva un hueco esta semana',
        route: '/recap',
        enabled: true,
        variables: [],
      },
    });
  });

  it('deletes a manual template through resetTemplate', async () => {
    prisma.notificationTemplate.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      service.resetTemplate('manual_revision_mensual'),
    ).resolves.toEqual({
      key: 'manual_revision_mensual',
      deleted: true,
    });
  });

  it('deletes read notifications for the current client', async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 3 });

    await expect(service.deleteRead('client-1')).resolves.toEqual({
      deleted: 3,
    });

    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: {
        recipient_id: 'client-1',
        read_at: {
          not: null,
        },
      },
    });
  });

  it('does not send an internal template when it is disabled', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      key: 'streak_at_risk',
      title: 'Racha en riesgo',
      body: 'Registra tu progreso',
      route: '/',
      enabled: false,
    });

    await expect(
      service.sendInternalTemplate(
        'system-admin',
        ['client-1'],
        'streak_at_risk',
        { days: 6 },
        {
          title: 'Racha en riesgo',
          body: 'Registra tu progreso',
          route: '/',
        },
        { type: 'streak_at_risk' },
      ),
    ).resolves.toEqual({ success: true, sent: 0, failed: 0 });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('keeps a customized empty route instead of falling back to the default route', async () => {
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      key: 'training_reminder_daily',
      title: 'Hola {name}',
      body: 'Entrena hoy',
      route: null,
      enabled: true,
    });
    prisma.user.findUnique.mockResolvedValueOnce(clientUser);
    prisma.notification.create.mockResolvedValue(
      createNotification({
        title: 'Hola Ada',
        body: 'Entrena hoy',
        data: { source: 'template-test' },
      }),
    );
    sendMock.mockResolvedValue('message-id-template');

    await expect(
      service.sendInternalTemplate(
        'system-admin',
        ['client-1'],
        'training_reminder_daily',
        { name: 'Ada' },
        {
          title: 'Entreno',
          body: 'Abre tu plan',
          route: '/trainings',
        },
        { source: 'template-test' },
      ),
    ).resolves.toEqual({ success: true, sent: 1, failed: 0 });

    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          source: 'template-test',
          notification_id: 'notification-1',
        },
        notification: {
          title: 'Hola Ada',
          body: 'Entrena hoy',
        },
      }),
    );
  });
});

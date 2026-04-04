import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NotificationStatus, Prisma, Role } from '@prisma/client';
import * as admin from 'firebase-admin';
import { paginate } from '../../common/dto/pagination.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationQueryDto } from './dto/notification-query.dto';

const notificationHistoryInclude = {
  recipient: {
    select: {
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
} as const;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private static readonly defaultChannelId = 'exom_high_importance';

  constructor(private readonly prisma: PrismaService) {}

  private resolveRoute(data?: Record<string, string>): string | undefined {
    const directRoute = data?.route;
    if (directRoute?.startsWith('/')) {
      return directRoute;
    }

    switch (data?.type?.toLowerCase()) {
      case 'recap_reminder':
      case 'recap':
      case 'recap_feedback':
        return '/recap';
      case 'training':
      case 'training_reminder':
        return '/trainings';
      case 'meal':
      case 'diet':
      case 'diet_reminder':
        return '/diets';
      case 'challenge':
      case 'challenge_update':
        return '/challenges';
      case 'profile':
        return '/profile';
      case 'calendar':
        return '/calendar';
      case 'home':
        return '/';
      default:
        return undefined;
    }
  }

  private buildPayloadData(data?: Record<string, string>) {
    const route = this.resolveRoute(data);

    if (!data && !route) {
      return undefined;
    }

    return {
      ...(data ?? {}),
      ...(route ? { route } : {}),
    };
  }

  private async resolveAccessibleClientIds(senderId: string) {
    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { id: true, role: true },
    });

    if (!sender) {
      throw new NotFoundException('Sender not found');
    }

    if (sender.role === Role.SUPER_ADMIN) {
      const clients = await this.prisma.user.findMany({
        where: { role: Role.CLIENT },
        select: { id: true },
      });

      return clients.map((client) => client.id);
    }

    if (sender.role !== Role.ADMIN) {
      throw new ForbiddenException('No tienes permisos para enviar notificaciones');
    }

    const assignments = await this.prisma.adminClientAssignment.findMany({
      where: {
        admin_id: senderId,
        is_active: true,
        client: {
          is: {
            role: Role.CLIENT,
          },
        },
      },
      select: { client_id: true },
    });

    return assignments.map((assignment) => assignment.client_id);
  }

  private async assertAccessibleRecipientIds(senderId: string, userIds: string[]) {
    const uniqueUserIds = [...new Set(userIds)];

    if (uniqueUserIds.length === 0) {
      throw new BadRequestException('Debes seleccionar al menos un destinatario');
    }

    const accessibleClientIds = await this.resolveAccessibleClientIds(senderId);
    const inaccessibleUserIds = uniqueUserIds.filter(
      (userId) => !accessibleClientIds.includes(userId),
    );

    if (inaccessibleUserIds.length > 0) {
      throw new ForbiddenException('No tienes permisos para notificar a uno o mas usuarios');
    }

    return uniqueUserIds;
  }

  private async createNotificationRecord(
    senderId: string,
    recipientId: string,
    title: string,
    body: string,
    data: Record<string, string> | undefined,
    status: NotificationStatus,
    error?: string,
  ) {
    return this.prisma.notification.create({
      data: {
        sender_id: senderId,
        recipient_id: recipientId,
        title,
        body,
        ...(data ? { data: data as Prisma.InputJsonObject } : {}),
        status,
        ...(error ? { error } : {}),
      },
      include: notificationHistoryInclude,
    });
  }

  private async deliverToRecipient(
    senderId: string,
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, fcm_token: true, role: true },
    });

    if (!user || user.role !== Role.CLIENT) {
      throw new NotFoundException('User not found');
    }

    const payloadData = this.buildPayloadData(data);

    if (!user.fcm_token) {
      this.logger.warn(`No FCM token registered for user ${user.email}`);

      return this.createNotificationRecord(
        senderId,
        user.id,
        title,
        body,
        payloadData,
        NotificationStatus.FAILED,
        'No FCM token registered for this user',
      );
    }

    try {
      const messageId = await admin.messaging().send({
        token: user.fcm_token,
        notification: { title, body },
        data: payloadData,
        android: {
          priority: 'high',
          notification: {
            channelId: NotificationsService.defaultChannelId,
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

      this.logger.log(`FCM sent to ${user.email}: ${messageId}`);

      return this.createNotificationRecord(
        senderId,
        user.id,
        title,
        body,
        payloadData,
        NotificationStatus.SENT,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unexpected FCM error';
      this.logger.error(`FCM error for ${user.email}: ${message}`);

      return this.createNotificationRecord(
        senderId,
        user.id,
        title,
        body,
        payloadData,
        NotificationStatus.FAILED,
        message,
      );
    }
  }

  private async sendToRecipients(
    senderId: string,
    userIds: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const notifications = await Promise.all(
      userIds.map((userId) => this.deliverToRecipient(senderId, userId, title, body, data)),
    );

    const sent = notifications.filter(
      (notification) => notification.status === NotificationStatus.SENT,
    ).length;
    const failed = notifications.length - sent;

    return {
      success: failed === 0,
      sent,
      failed,
    };
  }

  async sendToUser(
    senderId: string,
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const [recipientId] = await this.assertAccessibleRecipientIds(senderId, [userId]);

    return this.deliverToRecipient(senderId, recipientId, title, body, data);
  }

  async sendToMultiple(
    senderId: string,
    userIds: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const recipientIds = await this.assertAccessibleRecipientIds(senderId, userIds);

    return this.sendToRecipients(senderId, recipientIds, title, body, data);
  }

  async sendToAllClients(
    senderId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const recipientIds = await this.resolveAccessibleClientIds(senderId);

    if (recipientIds.length === 0) {
      throw new BadRequestException('No hay clientes asignados para notificar');
    }

    return this.sendToRecipients(senderId, recipientIds, title, body, data);
  }

  async getHistory(senderId: string, query: NotificationQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.NotificationWhereInput = {
      sender_id: senderId,
      ...(query.recipient_id ? { recipient_id: query.recipient_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { body: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        include: notificationHistoryInclude,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async getStats(senderId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const where = { sender_id: senderId };

    const [total, sentToday, failed] = await Promise.all([
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({
        where: {
          ...where,
          created_at: { gte: today },
        },
      }),
      this.prisma.notification.count({
        where: {
          ...where,
          status: NotificationStatus.FAILED,
        },
      }),
    ]);

    return {
      total,
      today: sentToday,
      failed,
    };
  }

  async markAsRead(recipientId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id: notificationId,
        recipient_id: recipientId,
      },
      include: notificationHistoryInclude,
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    if (notification.read_at) {
      return notification;
    }

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { read_at: new Date() },
      include: notificationHistoryInclude,
    });
  }

  async sendRecapReminder(
    senderId: string,
    clientId: string,
  ) {
    return this.sendToUser(
      senderId,
      clientId,
      'Weekly Recap Reminder',
      "Don't forget to complete your weekly recap!",
      { type: 'recap_reminder' },
    );
  }
}

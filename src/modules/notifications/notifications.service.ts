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
import { MyNotificationsQueryDto } from './dto/my-notifications-query.dto';
import {
  CreateNotificationTemplateDto,
  UpdateNotificationTemplateDto,
} from './dto/notification-template.dto';
import {
  DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY,
  DEFAULT_NOTIFICATION_TEMPLATES,
  NOTIFICATION_TEMPLATE_DELIVERY_INFO,
  NOTIFICATION_TEMPLATE_VARIABLE_HELP,
  type NotificationTemplateDefinition,
  type NotificationTemplateKey,
} from './notification-templates.constants';

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

type TemplateVariables = Record<string, string | number | boolean | null | undefined>;

type TemplateFallback = {
  title: string;
  body: string;
  route?: string | null;
};

type StoredNotificationTemplate = {
  key: string;
  name: string;
  description: string | null;
  category: string;
  title: string;
  body: string;
  route: string | null;
  enabled: boolean;
  variables: string[];
  updated_at?: Date;
};

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
      case 'achievement':
        return '/achievements';
      case 'streak':
      case 'streak_at_risk':
        return '/';
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

  private stringifyTemplateVariables(variables: TemplateVariables) {
    return Object.fromEntries(
      Object.entries(variables).map(([key, value]) => [
        key,
        value == null ? '' : String(value),
      ]),
    );
  }

  private renderTemplateText(
    text: string | null | undefined,
    variables: Record<string, string>,
  ) {
    if (!text) return text;

    return text.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) =>
      variables[key] ?? '',
    );
  }

  private getVariableHelp(variables: string[]) {
    return Object.fromEntries(
      variables.map((variable) => [
        variable,
        NOTIFICATION_TEMPLATE_VARIABLE_HELP[variable] ??
          'Dato dinámico que el sistema reemplaza al enviar.',
      ]),
    );
  }

  private serializeTemplate(
    definition: NotificationTemplateDefinition,
    storedTemplate?: StoredNotificationTemplate,
  ) {
    return {
      ...definition,
      title: storedTemplate?.title ?? definition.title,
      body: storedTemplate?.body ?? definition.body,
      route: storedTemplate ? storedTemplate.route : definition.route,
      enabled: storedTemplate?.enabled ?? true,
      customized: Boolean(storedTemplate),
      is_system: true,
      variable_help: this.getVariableHelp(definition.variables),
      delivery_info: NOTIFICATION_TEMPLATE_DELIVERY_INFO[definition.key],
      updated_at: storedTemplate?.updated_at ?? null,
    };
  }

  private serializeStoredTemplate(template: StoredNotificationTemplate) {
    return {
      key: template.key,
      name: template.name,
      description: template.description ?? '',
      category: template.category,
      title: template.title,
      body: template.body,
      route: template.route,
      enabled: template.enabled,
      variables: template.variables,
      customized: true,
      is_system: false,
      variable_help: this.getVariableHelp(template.variables),
      delivery_info: {
        type: 'manual',
        label: 'Manual, al enviar desde el panel',
        description:
          'No se ejecuta automáticamente. Se usa como texto reutilizable al enviar una notificación puntual.',
      },
      updated_at: template.updated_at ?? null,
    };
  }

  private normalizeTemplateRoute(route: string | null | undefined) {
    if (route === undefined) {
      return undefined;
    }

    const trimmed = route?.trim() ?? '';
    if (!trimmed) {
      return null;
    }

    if (!trimmed.startsWith('/')) {
      throw new BadRequestException('La ruta debe empezar por /');
    }

    return trimmed;
  }

  private buildManualTemplateKey(name: string, suffix?: number) {
    const slug =
      name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48) || 'plantilla';

    return `manual_${slug}${suffix ? `_${suffix}` : ''}`;
  }

  private async buildUniqueManualTemplateKey(name: string) {
    for (let suffix = 0; suffix < 100; suffix += 1) {
      const key = this.buildManualTemplateKey(name, suffix || undefined);
      const isDefaultKey = DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY.has(
        key as NotificationTemplateKey,
      );

      if (isDefaultKey) {
        continue;
      }

      const existing = await this.prisma.notificationTemplate.findUnique({
        where: { key },
        select: { key: true },
      });

      if (!existing) {
        return key;
      }
    }

    throw new BadRequestException('No se pudo generar una clave única');
  }

  private async resolveTemplate(
    key: NotificationTemplateKey,
    variables: TemplateVariables,
    fallback?: TemplateFallback,
  ) {
    const definition = DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY.get(key);
    const storedTemplate = await this.prisma.notificationTemplate.findUnique({
      where: { key },
    });
    const enabled = storedTemplate?.enabled ?? true;

    if (!enabled) {
      return null;
    }

    const stringVariables = this.stringifyTemplateVariables(variables);
    const title =
      storedTemplate?.title ?? definition?.title ?? fallback?.title ?? '';
    const body = storedTemplate?.body ?? definition?.body ?? fallback?.body ?? '';
    const route = storedTemplate
      ? storedTemplate.route
      : definition?.route ?? fallback?.route ?? null;

    return {
      title: this.renderTemplateText(title, stringVariables) ?? '',
      body: this.renderTemplateText(body, stringVariables) ?? '',
      route: this.renderTemplateText(route, stringVariables) ?? undefined,
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
      throw new ForbiddenException(
        'No tienes permisos para enviar notificaciones',
      );
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

  private async assertAccessibleRecipientIds(
    senderId: string,
    userIds: string[],
  ) {
    const uniqueUserIds = [...new Set(userIds)];

    if (uniqueUserIds.length === 0) {
      throw new BadRequestException(
        'Debes seleccionar al menos un destinatario',
      );
    }

    const accessibleClientIds = await this.resolveAccessibleClientIds(senderId);
    const inaccessibleUserIds = uniqueUserIds.filter(
      (userId) => !accessibleClientIds.includes(userId),
    );

    if (inaccessibleUserIds.length > 0) {
      throw new ForbiddenException(
        'No tienes permisos para notificar a uno o mas usuarios',
      );
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

  private async deliverToUser(
    senderId: string,
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    options?: { requireClientRole?: boolean },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fcm_token: true,
        role: true,
        is_active: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if ((options?.requireClientRole ?? true) && user.role !== Role.CLIENT) {
      throw new NotFoundException('User not found');
    }

    const payloadData = this.buildPayloadData(data);

    if (!user.is_active) {
      this.logger.warn(`Skipping notification to inactive user ${user.email}`);

      return this.createNotificationRecord(
        senderId,
        user.id,
        title,
        body,
        payloadData,
        NotificationStatus.FAILED,
        'Recipient inactive',
      );
    }

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
      const message =
        error instanceof Error ? error.message : 'Unexpected FCM error';
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
    options?: { requireClientRole?: boolean },
  ) {
    const notifications = await Promise.all(
      userIds.map((userId) =>
        this.deliverToUser(senderId, userId, title, body, data, options),
      ),
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
    const [recipientId] = await this.assertAccessibleRecipientIds(senderId, [
      userId,
    ]);

    return this.deliverToUser(senderId, recipientId, title, body, data, {
      requireClientRole: true,
    });
  }

  async sendToMultiple(
    senderId: string,
    userIds: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const recipientIds = await this.assertAccessibleRecipientIds(
      senderId,
      userIds,
    );

    return this.sendToRecipients(senderId, recipientIds, title, body, data, {
      requireClientRole: true,
    });
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

    return this.sendToRecipients(senderId, recipientIds, title, body, data, {
      requireClientRole: true,
    });
  }

  async sendInternalNotifications(
    senderId: string,
    userIds: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const uniqueUserIds = [...new Set(userIds.filter(Boolean))];

    if (uniqueUserIds.length === 0) {
      return { success: true, sent: 0, failed: 0 };
    }

    return this.sendToRecipients(senderId, uniqueUserIds, title, body, data, {
      requireClientRole: false,
    });
  }

  async sendInternalTemplate(
    senderId: string,
    userIds: string[],
    templateKey: NotificationTemplateKey,
    variables: TemplateVariables,
    fallback: TemplateFallback,
    data?: Record<string, string>,
  ) {
    const rendered = await this.resolveTemplate(templateKey, variables, fallback);

    if (!rendered) {
      return { success: true, sent: 0, failed: 0 };
    }

    return this.sendInternalNotifications(
      senderId,
      userIds,
      rendered.title,
      rendered.body,
      {
        ...(data ?? {}),
        ...(rendered.route ? { route: rendered.route } : {}),
      },
    );
  }

  async listTemplates() {
    const storedTemplates = await this.prisma.notificationTemplate.findMany();
    const storedByKey = new Map(
      storedTemplates.map((template) => [template.key, template]),
    );
    const customTemplates = storedTemplates.filter(
      (template) =>
        !DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY.has(
          template.key as NotificationTemplateKey,
        ),
    );

    return [
      ...DEFAULT_NOTIFICATION_TEMPLATES.map((definition) =>
        this.serializeTemplate(definition, storedByKey.get(definition.key)),
      ),
      ...customTemplates
        .sort((left, right) => left.name.localeCompare(right.name, 'es'))
        .map((template) => this.serializeStoredTemplate(template)),
    ];
  }

  async createTemplate(dto: CreateNotificationTemplateDto) {
    const name = dto.name.trim();
    const title = dto.title.trim();
    const body = dto.body.trim();

    if (!name || !title || !body) {
      throw new BadRequestException('Nombre, título y cuerpo son obligatorios');
    }

    const key = await this.buildUniqueManualTemplateKey(name);
    const template = await this.prisma.notificationTemplate.create({
      data: {
        key,
        name,
        description: dto.description?.trim() || null,
        category: dto.category?.trim() || 'Manual',
        title,
        body,
        route: this.normalizeTemplateRoute(dto.route) ?? null,
        enabled: dto.enabled ?? true,
        variables: [],
      },
    });

    return this.serializeStoredTemplate(template);
  }

  async updateTemplate(
    key: string,
    dto: UpdateNotificationTemplateDto,
  ) {
    const definition = DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY.get(
      key as NotificationTemplateKey,
    );
    const route = this.normalizeTemplateRoute(dto.route);
    const name = dto.name?.trim();
    const title = dto.title?.trim();
    const body = dto.body?.trim();

    if (dto.name !== undefined && !name) {
      throw new BadRequestException('El nombre es obligatorio');
    }

    if (dto.title !== undefined && !title) {
      throw new BadRequestException('El título es obligatorio');
    }

    if (dto.body !== undefined && !body) {
      throw new BadRequestException('El cuerpo es obligatorio');
    }

    const data = {
      ...(!definition && name !== undefined ? { name } : {}),
      ...(!definition && dto.description !== undefined
        ? { description: dto.description.trim() || null }
        : {}),
      ...(!definition && dto.category !== undefined
        ? { category: dto.category.trim() || 'Manual' }
        : {}),
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(route !== undefined ? { route } : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
    };

    if (!definition) {
      const existingTemplate = await this.prisma.notificationTemplate.findUnique({
        where: { key },
      });

      if (!existingTemplate) {
        throw new NotFoundException('Notification template not found');
      }

      const storedTemplate = await this.prisma.notificationTemplate.update({
        where: { key },
        data,
      });

      return this.serializeStoredTemplate(storedTemplate);
    }

    const storedTemplate = await this.prisma.notificationTemplate.upsert({
      where: { key },
      create: {
        key,
        name: definition.name,
        description: definition.description,
        category: definition.category,
        title: data.title ?? definition.title,
        body: data.body ?? definition.body,
        route: data.route === undefined ? definition.route : data.route,
        enabled: data.enabled ?? true,
        variables: definition.variables,
      },
      update: data,
    });

    return this.serializeTemplate(definition, storedTemplate);
  }

  async resetTemplate(key: string) {
    const definition = DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY.get(
      key as NotificationTemplateKey,
    );

    if (definition) {
      await this.prisma.notificationTemplate.deleteMany({ where: { key } });

      return this.serializeTemplate(definition);
    }

    const result = await this.prisma.notificationTemplate.deleteMany({
      where: { key },
    });

    if (result.count === 0) {
      throw new NotFoundException('Notification template not found');
    }

    return { key, deleted: true };
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
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

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

  async getMyNotifications(
    recipientId: string,
    query: MyNotificationsQueryDto,
  ) {
    const where: Prisma.NotificationWhereInput = {
      recipient_id: recipientId,
      ...(query.unread_only ? { read_at: null } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async getMyUnreadCount(recipientId: string) {
    const count = await this.prisma.notification.count({
      where: {
        recipient_id: recipientId,
        read_at: null,
      },
    });

    return { count };
  }

  async markAllAsRead(recipientId: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        recipient_id: recipientId,
        read_at: null,
      },
      data: { read_at: new Date() },
    });

    return { updated: result.count };
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

  async sendRecapReminder(senderId: string, clientId: string) {
    return this.sendToUser(
      senderId,
      clientId,
      'Weekly Recap Reminder',
      "Don't forget to complete your weekly recap!",
      { type: 'recap_reminder' },
    );
  }

  async findSystemSenderId(fallbackUserId?: string): Promise<string | null> {
    const superAdmin = await this.prisma.user.findFirst({
      where: { role: Role.SUPER_ADMIN, is_active: true },
      orderBy: { created_at: 'asc' },
      select: { id: true },
    });

    return superAdmin?.id ?? fallbackUserId ?? null;
  }
}

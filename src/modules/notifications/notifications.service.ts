import { createHash } from 'node:crypto';
import {
  JobsService,
  PermanentWorkError,
  workContext,
} from '../jobs/jobs.service';
import { boundedMap } from '../jobs/bounded-map';
import {
  BadRequestException,
  OnModuleInit,
  ServiceUnavailableException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NotificationStatus, Prisma, Role } from '@prisma/client';
import * as admin from 'firebase-admin';
import { paginate } from '../../common/dto/pagination.dto';
import { withLiveUsers } from '../../common/user-external-effect';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationQueryDto } from './dto/notification-query.dto';
import { MyNotificationsQueryDto } from './dto/my-notifications-query.dto';
import {
  CreateNotificationTemplateDto,
  UpdateNotificationTemplateScheduleDto,
  UpdateNotificationTemplateDto,
} from './dto/notification-template.dto';
import {
  DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY,
  DEFAULT_NOTIFICATION_TEMPLATES,
  NOTIFICATION_TEMPLATE_DELIVERY_INFO,
  NOTIFICATION_TEMPLATE_DEFAULT_TIMEZONE,
  NOTIFICATION_TEMPLATE_SCHEDULE_BY_KEY,
  NOTIFICATION_TEMPLATE_VARIABLE_HELP,
  type NotificationTemplateDefinition,
  type NotificationTemplateDeliveryInfo,
  type NotificationTemplateKey,
  type NotificationTemplateScheduleDefinition,
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

type TemplateVariables = Record<
  string,
  string | number | boolean | null | undefined
>;

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

type StoredNotificationTemplateSchedule = {
  template_key: string;
  enabled: boolean;
  timezone: string;
  times: string[];
  weekday: number | null;
  updated_at?: Date;
};

const weekdayLabels = [
  'domingos',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábados',
];

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private static readonly defaultChannelId = 'exom_high_importance';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService = new JobsService(prisma),
  ) {}

  onModuleInit() {
    this.jobs.register('FCM', (work) => this.dispatchNotification(work.key));
  }

  async queueTemplate(
    tx: Pick<Prisma.TransactionClient, 'notificationTemplate' | 'notification'>,
    senderId: string,
    recipients: string[],
    templateKey: NotificationTemplateKey,
    variables: TemplateVariables,
    fallback: TemplateFallback,
    data?: Record<string, string>,
  ) {
    const rendered = await this.resolveTemplate(
      templateKey,
      variables,
      fallback,
      tx,
    );
    if (!rendered) return;
    for (const recipientId of [...new Set(recipients)]) {
      await tx.notification.create({
        data: {
          sender_id: senderId,
          recipient_id: recipientId,
          title: rendered.title,
          body: rendered.body,
          data: this.buildPayloadData({
            ...data,
            ...(rendered.route ? { route: rendered.route } : {}),
          }),
          status: NotificationStatus.PENDING,
        },
      });
    }
  }

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

    return text.replace(
      /\{([a-zA-Z0-9_]+)\}/g,
      (_match, key: string) => variables[key] ?? '',
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

  private normalizeScheduleTimes(
    schedule: NotificationTemplateScheduleDefinition,
    times?: string[],
  ) {
    const nextTimes = times ?? schedule.defaultTimes;
    const uniqueTimes = [
      ...new Set(nextTimes.map((time) => time.trim()).filter(Boolean)),
    ];
    const normalizedTimes =
      schedule.kind === 'meal_daily' ? uniqueTimes : uniqueTimes.sort();

    if (normalizedTimes.some((time) => !timePattern.test(time))) {
      throw new BadRequestException('Las horas deben usar formato HH:mm');
    }

    if (schedule.kind === 'meal_daily' && normalizedTimes.length !== 4) {
      throw new BadRequestException(
        'El recordatorio de comidas necesita 4 horas: desayuno, comida, snack y cena',
      );
    }

    if (schedule.kind !== 'meal_daily' && normalizedTimes.length !== 1) {
      throw new BadRequestException(
        'Esta plantilla necesita exactamente una hora',
      );
    }

    return normalizedTimes;
  }

  private normalizeScheduleTimezone(timezone?: string) {
    const value = timezone?.trim() || NOTIFICATION_TEMPLATE_DEFAULT_TIMEZONE;

    try {
      new Intl.DateTimeFormat('es-ES', { timeZone: value });
    } catch {
      throw new BadRequestException('La zona horaria no es válida');
    }

    return value;
  }

  private normalizeScheduleWeekday(
    schedule: NotificationTemplateScheduleDefinition,
    weekday?: number | null,
  ) {
    if (schedule.kind !== 'weekly') {
      return null;
    }

    const nextWeekday = weekday ?? schedule.defaultWeekday ?? 0;
    if (nextWeekday < 0 || nextWeekday > 6) {
      throw new BadRequestException(
        'El día de la semana debe estar entre 0 y 6',
      );
    }

    return nextWeekday;
  }

  private buildScheduleCron(
    schedule: NotificationTemplateScheduleDefinition,
    times: string[],
    weekday: number | null,
  ) {
    return times
      .map((time) => {
        const [hour, minute] = time.split(':');
        return `${Number(minute)} ${Number(hour)} * * ${
          schedule.kind === 'weekly'
            ? (weekday ?? schedule.defaultWeekday ?? 0)
            : '*'
        }`;
      })
      .join(', ');
  }

  private buildScheduleLabel(
    schedule: NotificationTemplateScheduleDefinition,
    times: string[],
    weekday: number | null,
  ) {
    if (schedule.kind === 'weekly') {
      return `${weekdayLabels[weekday ?? schedule.defaultWeekday ?? 0]} a las ${times[0]}`;
    }

    if (schedule.kind === 'meal_daily') {
      return `Todos los días a las ${times.slice(0, -1).join(', ')} y ${
        times[times.length - 1]
      }`;
    }

    return `Todos los días a las ${times[0]}`;
  }

  private buildDeliveryInfo(
    key: NotificationTemplateKey,
    storedSchedule?: StoredNotificationTemplateSchedule,
  ): NotificationTemplateDeliveryInfo {
    const base = NOTIFICATION_TEMPLATE_DELIVERY_INFO[key];
    const schedule = NOTIFICATION_TEMPLATE_SCHEDULE_BY_KEY.get(key);

    if (!schedule) {
      return base;
    }

    const times =
      storedSchedule?.times && storedSchedule.times.length > 0
        ? storedSchedule.times
        : schedule.defaultTimes;
    const timezone = storedSchedule?.timezone ?? schedule.defaultTimezone;
    const weekday = storedSchedule?.weekday ?? schedule.defaultWeekday ?? null;

    return {
      ...base,
      label: this.buildScheduleLabel(schedule, times, weekday),
      timezone,
      times,
      weekday,
      cron: this.buildScheduleCron(schedule, times, weekday),
      schedule_enabled: storedSchedule?.enabled ?? true,
      schedule_kind: schedule.kind,
    };
  }

  private serializeTemplate(
    definition: NotificationTemplateDefinition,
    storedTemplate?: StoredNotificationTemplate,
    storedSchedule?: StoredNotificationTemplateSchedule,
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
      delivery_info: this.buildDeliveryInfo(definition.key, storedSchedule),
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
    db: Pick<Prisma.TransactionClient, 'notificationTemplate'> = this.prisma,
  ) {
    const definition = DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY.get(key);
    const storedTemplate = await db.notificationTemplate.findUnique({
      where: { key },
    });
    const enabled = storedTemplate?.enabled ?? true;

    if (!enabled) {
      return null;
    }

    const stringVariables = this.stringifyTemplateVariables(variables);
    const title =
      storedTemplate?.title ?? definition?.title ?? fallback?.title ?? '';
    const body =
      storedTemplate?.body ?? definition?.body ?? fallback?.body ?? '';
    const route = storedTemplate
      ? storedTemplate.route
      : (definition?.route ?? fallback?.route ?? null);

    return {
      title: this.renderTemplateText(title, stringVariables) ?? '',
      body: this.renderTemplateText(body, stringVariables) ?? '',
      route: this.renderTemplateText(route, stringVariables) ?? undefined,
    };
  }

  private async resolveAccessibleClientIds(
    senderId: string,
    clientIds?: string[],
  ) {
    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { id: true, role: true },
    });

    if (!sender) {
      throw new NotFoundException('Sender not found');
    }

    if (sender.role === Role.SUPER_ADMIN) {
      const clients = await this.prisma.user.findMany({
        where: {
          role: Role.CLIENT,
          ...(clientIds ? { id: { in: clientIds } } : {}),
        },
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
        ...(clientIds ? { client_id: { in: clientIds } } : {}),
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

    const accessibleClientIds = await this.resolveAccessibleClientIds(
      senderId,
      uniqueUserIds,
    );
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
    db: Pick<Prisma.TransactionClient, 'notification'> = this.prisma,
    requireClientRole = false,
  ) {
    const context = workContext.getStore();
    const id = context
      ? createHash('sha256')
          .update(
            JSON.stringify([
              context.key,
              recipientId,
              data?.type,
              data?.client_id,
              data?.clientId,
            ]),
          )
          .digest('hex')
      : undefined;
    const input = {
      data: {
        ...(id ? { id } : {}),
        sender_id: senderId,
        recipient_id: recipientId,
        title,
        body,
        ...(data ? { data: data as Prisma.InputJsonObject } : {}),
        status,
        requires_client_role: requireClientRole,
        ...(error ? { error } : {}),
      },
      include: notificationHistoryInclude,
    };
    if (id) {
      await db.notification.createMany({
        data: [input.data],
        skipDuplicates: true,
      });
      return db.notification.findUniqueOrThrow({
        where: { id },
        include: notificationHistoryInclude,
      });
    }
    return db.notification.create(input);
  }

  private async deliverToUser(
    senderId: string,
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
    options?: { requireClientRole?: boolean; defer?: boolean },
    db: Pick<Prisma.TransactionClient, 'user' | 'notification'> = this.prisma,
  ) {
    const user = await db.user.findUnique({
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
      this.logger.warn('Skipping notification to inactive recipient');

      return this.createNotificationRecord(
        senderId,
        user.id,
        title,
        body,
        payloadData,
        NotificationStatus.FAILED,
        'Recipient inactive',
        db,
      );
    }

    if (!user.fcm_token) {
      this.logger.warn('No FCM token registered for recipient');

      return this.createNotificationRecord(
        senderId,
        user.id,
        title,
        body,
        payloadData,
        NotificationStatus.FAILED,
        'No FCM token registered for this user',
        db,
      );
    }

    const record = await this.createNotificationRecord(
      senderId,
      user.id,
      title,
      body,
      payloadData,
      NotificationStatus.PENDING,
      undefined,
      db,
      options?.requireClientRole ?? true,
    );
    if (options?.defer || options?.requireClientRole === false) return record;
    // Preserve the legacy manual API: a successful response requires provider acceptance.
    await this.jobs.runKey(record.id);
    const current = await this.prisma.notification.findUniqueOrThrow({
      where: { id: record.id },
      include: notificationHistoryInclude,
    });
    if (current.status === NotificationStatus.PENDING) {
      throw new ServiceUnavailableException(
        'Notificación pendiente de envío. Revisa el historial más tarde; no repitas la solicitud.',
      );
    }
    return current;
  }

  async dispatchNotification(id: string): Promise<void> {
    const record = await this.prisma.notification.findUnique({ where: { id } });
    if (!record || record.status === NotificationStatus.SENT) return;
    const data = Object.fromEntries(
      Object.entries(record.data ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
    const references = [
      record.sender_id,
      record.recipient_id,
      ...[data.client_id, data.clientId].filter(Boolean),
    ];
    await withLiveUsers(this.prisma, references, async () => {
      // Durable internal messages may outlive the assignment/role that selected
      // their audience. Recheck it immediately before requesting provider delivery.
      const clientId = data.client_id ?? data.clientId;
      if (clientId && clientId !== record.recipient_id) {
        try {
          await this.assertAccessibleRecipientIds(record.recipient_id, [
            clientId,
          ]);
        } catch (error) {
          if (
            error instanceof ForbiddenException ||
            error instanceof NotFoundException
          )
            throw new PermanentWorkError('RECIPIENT_AUTHORIZATION_REVOKED');
          throw error;
        }
      }
      if (data.type === 'approval_pending') {
        const reviewer = await this.prisma.user.findUnique({
          where: { id: record.recipient_id },
          select: { role: true },
        });
        if (reviewer?.role !== Role.SUPER_ADMIN)
          throw new PermanentWorkError('RECIPIENT_AUTHORIZATION_REVOKED');
      }
      if (record.requires_client_role) {
        try {
          await this.assertAccessibleRecipientIds(record.sender_id, [
            record.recipient_id,
          ]);
        } catch (error) {
          if (
            error instanceof ForbiddenException ||
            error instanceof NotFoundException
          )
            throw new PermanentWorkError('AUTHORIZATION_REVOKED');
          throw error;
        }
      }
      const user = await this.prisma.user.findUnique({
        where: { id: record.recipient_id },
        select: { fcm_token: true, is_active: true },
      });
      if (!user?.is_active)
        throw new PermanentWorkError('RECIPIENT_UNAVAILABLE');
      if (!user.fcm_token) throw new PermanentWorkError('NO_FCM_TOKEN');
      const messageId = await admin.messaging().send({
        token: user.fcm_token,
        notification: { title: record.title, body: record.body },
        data: { ...data, notification_id: record.id },
        android: {
          priority: 'high',
          notification: {
            channelId: NotificationsService.defaultChannelId,
            sound: 'default',
          },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default' } },
        },
      });
      if (!messageId) throw new Error('PROVIDER_ACCEPTANCE_MISSING');
      // The business/outbox transaction has already committed. This update is
      // evidence of provider acceptance, never of device delivery or reading.
      await this.prisma.notification.update({
        where: { id },
        data: {
          status: NotificationStatus.SENT,
          provider_message_id: messageId,
          sent_at: new Date(),
          error: null,
        },
      });
    });
  }

  private async sendToRecipients(
    senderId: string,
    userIds: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
    options?: { requireClientRole?: boolean; defer?: boolean },
  ) {
    // Persist the complete audience before any provider call. A partial response
    // or process crash cannot lose recipients that had not started sending yet.
    const queuedRecords = await this.prisma.$transaction(
      (tx) =>
        boundedMap(userIds, (userId) =>
          this.deliverToUser(
            senderId,
            userId,
            title,
            body,
            data,
            { ...options, defer: true },
            tx,
          ),
        ),
      { timeout: 30000 },
    );
    const notifications =
      options?.defer || options?.requireClientRole === false
        ? queuedRecords
        : await boundedMap(queuedRecords, async (record) => {
            if (record.status !== NotificationStatus.PENDING) return record;
            await this.jobs.runKey(record.id);
            return this.prisma.notification.findUniqueOrThrow({
              where: { id: record.id },
              include: notificationHistoryInclude,
            });
          });

    const sent = notifications.filter(
      (notification) => notification.status === NotificationStatus.SENT,
    ).length;
    const failed = notifications.filter(
      (n) => n.status === NotificationStatus.FAILED,
    ).length;
    const queued = notifications.length - sent - failed;
    if (queued && !options?.defer && options?.requireClientRole !== false)
      throw new ServiceUnavailableException(
        `Envíos aceptados: ${sent}; fallidos: ${failed}; pendientes: ${queued}. No repitas la solicitud; revisa el historial más tarde.`,
      );

    return {
      success: failed === 0 && queued === 0,
      sent,
      failed,
      ...(queued ? { queued } : {}),
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

  async queueAuthorizedNotifications(
    senderId: string,
    userIds: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ) {
    const recipients = await this.assertAccessibleRecipientIds(
      senderId,
      userIds,
    );
    return this.sendToRecipients(senderId, recipients, title, body, data, {
      requireClientRole: true,
      defer: true,
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
    const rendered = await this.resolveTemplate(
      templateKey,
      variables,
      fallback,
    );

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
    const [storedTemplates, storedSchedules] = await Promise.all([
      this.prisma.notificationTemplate.findMany(),
      this.prisma.notificationTemplateSchedule.findMany(),
    ]);
    const storedByKey = new Map(
      storedTemplates.map((template) => [template.key, template]),
    );
    const scheduleByKey = new Map(
      storedSchedules.map((schedule) => [schedule.template_key, schedule]),
    );
    const customTemplates = storedTemplates.filter(
      (template) =>
        !DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY.has(
          template.key as NotificationTemplateKey,
        ),
    );

    return [
      ...DEFAULT_NOTIFICATION_TEMPLATES.map((definition) =>
        this.serializeTemplate(
          definition,
          storedByKey.get(definition.key),
          scheduleByKey.get(definition.key),
        ),
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

  async updateTemplate(key: string, dto: UpdateNotificationTemplateDto) {
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
      const existingTemplate =
        await this.prisma.notificationTemplate.findUnique({
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

    const [storedTemplate, storedSchedule] = await Promise.all([
      this.prisma.notificationTemplate.upsert({
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
      }),
      this.prisma.notificationTemplateSchedule.findUnique({
        where: { template_key: key },
      }),
    ]);

    return this.serializeTemplate(
      definition,
      storedTemplate,
      storedSchedule ?? undefined,
    );
  }

  async resetTemplate(key: string) {
    const definition = DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY.get(
      key as NotificationTemplateKey,
    );

    if (definition) {
      const [, storedSchedule] = await Promise.all([
        this.prisma.notificationTemplate.deleteMany({ where: { key } }),
        this.prisma.notificationTemplateSchedule.findUnique({
          where: { template_key: key },
        }),
      ]);

      return this.serializeTemplate(
        definition,
        undefined,
        storedSchedule ?? undefined,
      );
    }

    const result = await this.prisma.notificationTemplate.deleteMany({
      where: { key },
    });

    if (result.count === 0) {
      throw new NotFoundException('Notification template not found');
    }

    return { key, deleted: true };
  }

  async updateTemplateSchedule(
    key: string,
    dto: UpdateNotificationTemplateScheduleDto,
  ) {
    const templateKey = key as NotificationTemplateKey;
    const definition = DEFAULT_NOTIFICATION_TEMPLATE_BY_KEY.get(templateKey);
    const schedule = NOTIFICATION_TEMPLATE_SCHEDULE_BY_KEY.get(templateKey);

    if (!definition || !schedule) {
      throw new BadRequestException(
        'Esta plantilla no tiene horario programable',
      );
    }

    const existingSchedule =
      await this.prisma.notificationTemplateSchedule.findUnique({
        where: { template_key: key },
      });
    const times = this.normalizeScheduleTimes(
      schedule,
      dto.times ?? existingSchedule?.times ?? schedule.defaultTimes,
    );
    const timezone = this.normalizeScheduleTimezone(
      dto.timezone ?? existingSchedule?.timezone ?? schedule.defaultTimezone,
    );
    const weekday = this.normalizeScheduleWeekday(
      schedule,
      dto.weekday ??
        existingSchedule?.weekday ??
        schedule.defaultWeekday ??
        null,
    );
    const enabled = dto.enabled ?? existingSchedule?.enabled ?? true;

    const [storedSchedule, storedTemplate] = await Promise.all([
      this.prisma.notificationTemplateSchedule.upsert({
        where: { template_key: key },
        create: {
          template_key: key,
          enabled,
          timezone,
          times,
          weekday,
        },
        update: {
          enabled,
          timezone,
          times,
          weekday,
        },
      }),
      this.prisma.notificationTemplate.findUnique({ where: { key } }),
    ]);

    return this.serializeTemplate(
      definition,
      storedTemplate ?? undefined,
      storedSchedule,
    );
  }

  async getHistory(senderId: string, query: NotificationQueryDto) {
    const search = query.search?.trim();
    const where: Prisma.NotificationWhereInput = {
      sender_id: senderId,
      ...(query.recipient_id ? { recipient_id: query.recipient_id } : {}),
      status: query.status ?? {
        in: [NotificationStatus.SENT, NotificationStatus.FAILED],
      },
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
          status: NotificationStatus.SENT,
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

  async getDeliveryWork() {
    const where = { status: { in: ['PENDING', 'RUNNING', 'FAILED'] } };
    const [counts, oldest] = await Promise.all([
      this.prisma.durableWork.groupBy({
        by: ['kind', 'status'],
        where,
        _count: true,
      }),
      this.prisma.durableWork.findMany({
        where,
        orderBy: [{ status: 'asc' }, { next_attempt_at: 'asc' }],
        take: 100,
        select: {
          key: true,
          kind: true,
          status: true,
          attempts: true,
          created_at: true,
          next_attempt_at: true,
          lease_until: true,
          last_error: true,
        },
      }),
    ]);
    return { counts, oldest };
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

  async deleteRead(recipientId: string) {
    const result = await this.prisma.notification.deleteMany({
      where: {
        recipient_id: recipientId,
        status: { not: NotificationStatus.PENDING },
        read_at: {
          not: null,
        },
      },
    });

    return { deleted: result.count };
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

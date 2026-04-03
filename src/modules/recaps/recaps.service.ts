import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateRecapDto, UpdateRecapDto, ReviewRecapDto } from './dto/create-recap.dto';
import { ADMIN_RECAP_STATUSES, AdminRecapQueryDto } from './dto/admin-recap-query.dto';
import { RecapStatus, Role } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

type ClientFeedbackUpdate = {
  data: Record<string, unknown>;
  shouldNotifyClientFeedback: boolean;
};

const CLIENT_RECAP_SELECT = {
  id: true,
  client_id: true,
  week_start_date: true,
  week_end_date: true,
  submitted_at: true,
  training_effort: true,
  training_sessions: true,
  training_progress: true,
  training_notes: true,
  nutrition_quality: true,
  hydration_enabled: true,
  hydration_level: true,
  food_quality: true,
  nutrition_notes: true,
  sleep_hours_range: true,
  fatigue_level: true,
  muscle_pain_zones: true,
  recovery_notes: true,
  mood: true,
  stress_enabled: true,
  stress_level: true,
  general_notes: true,
  improvement_app_rating: true,
  improvement_service_rating: true,
  improvement_areas: true,
  improvement_feedback_text: true,
  client_feedback_text: true,
  client_feedback_sent_at: true,
  client_feedback_read_at: true,
  status: true,
  reviewed_at: true,
  archived_at: true,
  created_at: true,
  updated_at: true,
  // admin_comments intentionally excluded — internal note
} as const;

@Injectable()
export class RecapsService {
  private readonly logger = new Logger(RecapsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private async resolveAccessibleClientIds(currentUserId: string, currentUserRole: string) {
    if (currentUserRole === Role.SUPER_ADMIN) {
      const clients = await this.prisma.user.findMany({
        where: { role: Role.CLIENT },
        select: { id: true },
      });

      return clients.map((client) => client.id);
    }

    if (currentUserRole !== Role.ADMIN) {
      return [];
    }

    const assignments = await this.prisma.adminClientAssignment.findMany({
      where: { admin_id: currentUserId, is_active: true },
      select: { client_id: true },
    });

    return assignments.map((assignment) => assignment.client_id);
  }

  private async assertAdminRecapAccess(id: string, adminId: string, adminRole: string) {
    const recap = await this.prisma.weeklyRecap.findUnique({
      where: { id },
      include: {
        client: {
          select: {
            id: true,
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
      },
    });

    if (!recap) {
      throw new NotFoundException('Recap not found');
    }

    if (adminRole === Role.SUPER_ADMIN) {
      return recap;
    }

    if (adminRole !== Role.ADMIN) {
      throw new ForbiddenException('Access denied');
    }

    const assignment = await this.prisma.adminClientAssignment.findFirst({
      where: {
        admin_id: adminId,
        client_id: recap.client_id,
        is_active: true,
      },
    });

    if (!assignment) {
      throw new ForbiddenException('Access denied');
    }

    return recap;
  }

  private shouldNotifyClientFeedback(
    previous: string | null | undefined,
    next: string | null | undefined,
  ): boolean {
    const prev = previous?.trim() ?? '';
    const cur = next?.trim() ?? '';
    return cur.length > 0 && cur !== prev;
  }

  private normalizeOptionalText(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? '';
    return normalized.length > 0 ? normalized : null;
  }

  private buildClientFeedbackUpdate(
    recap: { client_feedback_text: string | null },
    dto: ReviewRecapDto,
  ): ClientFeedbackUpdate {
    const updates: Record<string, unknown> = {};
    let shouldNotifyClientFeedback = false;

    if (dto.client_feedback_text !== undefined) {
      const nextFeedback = this.normalizeOptionalText(dto.client_feedback_text);
      updates.client_feedback_text = nextFeedback;

      if (!nextFeedback) {
        updates.client_feedback_sent_at = null;
        updates.client_feedback_read_at = null;
      } else if (this.shouldNotifyClientFeedback(recap.client_feedback_text, nextFeedback)) {
        updates.client_feedback_sent_at = new Date();
        updates.client_feedback_read_at = null;
        shouldNotifyClientFeedback = true;
      }
    }

    return {
      data: updates,
      shouldNotifyClientFeedback,
    };
  }

  private notifyClientFeedback(clientId: string, recapId: string) {
    this.notificationsService
      .sendToUser(
        clientId,
        'Tu entrenador te ha dejado un comentario',
        'Abre tu recap semanal para leer el feedback de tu entrenador.',
        {
          type: 'recap_feedback',
          route: `/recap/${recapId}`,
        },
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to send recap feedback push to client ${clientId}: ${message}`,
        );
      });
  }

  async create(clientId: string, dto: CreateRecapDto) {
    const weekStart = new Date(dto.week_start_date);
    const weekEnd = new Date(dto.week_end_date);
    const recapLookup = {
      client_id_week_start_date: {
        client_id: clientId,
        week_start_date: weekStart,
      },
    };

    const existingRecap = await this.prisma.weeklyRecap.findUnique({
      where: recapLookup,
    });

    if (existingRecap?.archived_at) {
      throw new ForbiddenException('Cannot overwrite an archived recap');
    }

    if (existingRecap && existingRecap.status !== RecapStatus.DRAFT) {
      throw new ForbiddenException('Only draft recaps can be overwritten');
    }

    const data = {
      week_end_date: weekEnd,
      training_effort: dto.training_effort,
      training_sessions: dto.training_sessions,
      training_progress: dto.training_progress,
      training_notes: dto.training_notes,
      nutrition_quality: dto.nutrition_quality,
      hydration_enabled: dto.hydration_enabled,
      hydration_level: dto.hydration_level,
      food_quality: dto.food_quality,
      nutrition_notes: dto.nutrition_notes,
      sleep_hours_range: dto.sleep_hours_range,
      fatigue_level: dto.fatigue_level,
      muscle_pain_zones: dto.muscle_pain_zones ?? [],
      recovery_notes: dto.recovery_notes,
      mood: dto.mood,
      stress_enabled: dto.stress_enabled,
      stress_level: dto.stress_level,
      general_notes: dto.general_notes,
      improvement_app_rating: dto.improvement_app_rating,
      improvement_service_rating: dto.improvement_service_rating,
      improvement_areas: dto.improvement_areas ?? [],
      improvement_feedback_text: dto.improvement_feedback_text,
    };

    if (existingRecap) {
      return this.prisma.weeklyRecap.update({
        where: { id: existingRecap.id },
        data,
      });
    }

    return this.prisma.weeklyRecap.create({
      data: {
        client_id: clientId,
        week_start_date: weekStart,
        ...data,
        status: RecapStatus.DRAFT,
      },
    });
  }

  async update(clientId: string, id: string, dto: UpdateRecapDto) {
    const recap = await this.prisma.weeklyRecap.findUnique({ where: { id } });

    if (!recap) {
      throw new NotFoundException('Recap not found');
    }

    if (recap.client_id !== clientId) {
      throw new ForbiddenException('Access denied');
    }

    if (recap.status === RecapStatus.REVIEWED) {
      throw new ForbiddenException('Cannot edit a reviewed recap');
    }

    const updateData: Record<string, unknown> = { ...dto };
    if (dto.week_start_date) {
      updateData.week_start_date = new Date(dto.week_start_date);
    }
    if (dto.week_end_date) {
      updateData.week_end_date = new Date(dto.week_end_date);
    }

    return this.prisma.weeklyRecap.update({
      where: { id },
      data: updateData,
    });
  }

  async submit(clientId: string, id: string) {
    const recap = await this.prisma.weeklyRecap.findUnique({ where: { id } });

    if (!recap) {
      throw new NotFoundException('Recap not found');
    }

    if (recap.client_id !== clientId) {
      throw new ForbiddenException('Access denied');
    }

    if (recap.status === RecapStatus.REVIEWED) {
      throw new ForbiddenException('Cannot submit a reviewed recap');
    }

    return this.prisma.weeklyRecap.update({
      where: { id },
      data: {
        status: RecapStatus.SUBMITTED,
        submitted_at: new Date(),
      },
    });
  }

  async findMyRecaps(clientId: string, pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.weeklyRecap.findMany({
        where: { client_id: clientId },
        orderBy: { week_start_date: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        select: CLIENT_RECAP_SELECT,
      }),
      this.prisma.weeklyRecap.count({ where: { client_id: clientId } }),
    ]);

    return paginate(data, total, pagination);
  }

  async getMyRecapById(clientId: string, id: string) {
    const recap = await this.prisma.weeklyRecap.findUnique({
      where: { id },
      select: CLIENT_RECAP_SELECT,
    });

    if (!recap) {
      throw new NotFoundException('Recap not found');
    }

    if (recap.client_id !== clientId) {
      throw new ForbiddenException('Access denied');
    }

    return recap;
  }

  async markClientFeedbackAsRead(clientId: string, id: string) {
    const recap = await this.prisma.weeklyRecap.findUnique({
      where: { id },
      select: { id: true, client_id: true, client_feedback_text: true, client_feedback_read_at: true },
    });

    if (!recap) {
      throw new NotFoundException('Recap not found');
    }

    if (recap.client_id !== clientId) {
      throw new ForbiddenException('Access denied');
    }

    if (!recap.client_feedback_text || recap.client_feedback_read_at) {
      return { success: true };
    }

    await this.prisma.weeklyRecap.update({
      where: { id },
      data: { client_feedback_read_at: new Date() },
    });

    return { success: true };
  }

  async getStats(adminId: string, adminRole: string) {
    const accessibleClientIds = await this.resolveAccessibleClientIds(adminId, adminRole);

    if (accessibleClientIds.length === 0) {
      return { total: 0, submitted: 0, reviewed: 0, archived: 0 };
    }

    const where = {
      client_id: { in: accessibleClientIds },
      status: { in: [RecapStatus.SUBMITTED, RecapStatus.REVIEWED] },
    };

    const [total, submitted, reviewed, archived] = await Promise.all([
      this.prisma.weeklyRecap.count({ where }),
      this.prisma.weeklyRecap.count({
        where: {
          ...where,
          status: RecapStatus.SUBMITTED,
        },
      }),
      this.prisma.weeklyRecap.count({
        where: {
          ...where,
          status: RecapStatus.REVIEWED,
        },
      }),
      this.prisma.weeklyRecap.count({
        where: {
          ...where,
          archived_at: { not: null },
        },
      }),
    ]);

    return { total, submitted, reviewed, archived };
  }

  async findForAdmin(adminId: string, adminRole: string, query: AdminRecapQueryDto) {
    const accessibleClientIds = await this.resolveAccessibleClientIds(adminId, adminRole);

    if (accessibleClientIds.length === 0) {
      return paginate([], 0, query);
    }

    if (query.client_id && !accessibleClientIds.includes(query.client_id)) {
      return paginate([], 0, query);
    }

    const clientIds = query.client_id ? [query.client_id] : accessibleClientIds;
    const statusFilter =
      query.status === RecapStatus.SUBMITTED || query.status === RecapStatus.REVIEWED
        ? query.status
        : { in: [...ADMIN_RECAP_STATUSES] };
    const where = {
      client_id: { in: clientIds },
      status: statusFilter,
      archived_at: query.archived ? { not: null } : null,
    };

    const [data, total] = await Promise.all([
      this.prisma.weeklyRecap.findMany({
        where,
        orderBy: { week_start_date: 'desc' },
        skip: query.skip,
        take: query.limit,
        include: {
          client: {
            select: {
              id: true,
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
        },
      }),
      this.prisma.weeklyRecap.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async getAdminRecapById(adminId: string, adminRole: string, id: string) {
    return this.assertAdminRecapAccess(id, adminId, adminRole);
  }

  async review(adminId: string, adminRole: string, id: string, dto: ReviewRecapDto) {
    const recap = await this.assertAdminRecapAccess(id, adminId, adminRole);

    if (recap.archived_at) {
      throw new ForbiddenException('Cannot review an archived recap');
    }

    if (recap.status === RecapStatus.DRAFT) {
      throw new ForbiddenException('Cannot review a draft recap');
    }

    const { data: feedbackUpdates, shouldNotifyClientFeedback } = this.buildClientFeedbackUpdate(
      recap,
      dto,
    );

    if (recap.status === RecapStatus.REVIEWED) {
      if (dto.admin_comments === undefined && Object.keys(feedbackUpdates).length === 0) {
        return recap;
      }

      const updatedRecap = await this.prisma.weeklyRecap.update({
        where: { id },
        data: {
          ...(dto.admin_comments !== undefined
            ? { admin_comments: dto.admin_comments || null }
            : {}),
          ...feedbackUpdates,
        },
      });

      if (shouldNotifyClientFeedback) {
        this.notifyClientFeedback(recap.client_id, recap.id);
      }

      return updatedRecap;
    }

    const updatedRecap = await this.prisma.weeklyRecap.update({
      where: { id },
      data: {
        status: RecapStatus.REVIEWED,
        reviewed_at: new Date(),
        ...(dto.admin_comments !== undefined
          ? { admin_comments: dto.admin_comments || null }
          : {}),
        ...feedbackUpdates,
      },
    });

    if (shouldNotifyClientFeedback) {
      this.notifyClientFeedback(recap.client_id, recap.id);
    }

    return updatedRecap;
  }

  async archive(adminId: string, adminRole: string, id: string) {
    const recap = await this.assertAdminRecapAccess(id, adminId, adminRole);

    if (recap.archived_at) {
      return recap;
    }

    if (recap.status !== RecapStatus.REVIEWED) {
      throw new ForbiddenException('Only reviewed recaps can be archived');
    }

    return this.prisma.weeklyRecap.update({
      where: { id },
      data: { archived_at: new Date() },
    });
  }
}

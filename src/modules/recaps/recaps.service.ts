import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import {
  CreateRecapDto,
  UpdateRecapDto,
  ReviewRecapDto,
} from './dto/create-recap.dto';
import {
  ADMIN_RECAP_STATUSES,
  AdminRecapQueryDto,
} from './dto/admin-recap-query.dto';
import { Prisma, RecapStatus, Role } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';
import type { WeeklyRecap } from '@prisma/client';
import { ReviewDraftDto, ReviewPublishDto } from './dto/review-publication.dto';
import {
  DAY_PROGRESS_TRANSACTION_OPTIONS,
  lockClientDayProgress,
} from '../../common/progress/day-progress-lock';

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
  average_daily_steps: true,
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
  pain_intensity: true,
  recovery_notes: true,
  mood: true,
  stress_enabled: true,
  stress_level: true,
  hunger_level: true,
  energy_level: true,
  digestion_level: true,
  general_notes: true,
  improvement_app_rating: true,
  improvement_service_rating: true,
  improvement_areas: true,
  improvement_feedback_text: true,
  client_feedback_text: true,
  client_feedback_sent_at: true,
  client_feedback_read_at: true,
  published_coach_summary: true,
  published_changes: true,
  published_next_week_goals: true,
  status: true,
  reviewed_at: true,
  archived_at: true,
  created_at: true,
  updated_at: true,
  // admin_comments intentionally excluded — internal note
} as const;

const REVIEW_SELECT = {
  id: true,
  status: true,
  reviewed_at: true,
  review_version: true,
  draft_coach_summary: true,
  draft_changes: true,
  draft_next_week_goals: true,
  published_coach_summary: true,
  published_changes: true,
  published_next_week_goals: true,
} as const;
const DRAFT_REVIEW_FIELDS = {
  coach_summary: 'draft_coach_summary',
  changes: 'draft_changes',
  next_week_goals: 'draft_next_week_goals',
} as const;

const ADMIN_RECAP_LIST_SELECT = {
  id: true,
  client_id: true,
  week_start_date: true,
  week_end_date: true,
  submitted_at: true,
  average_daily_steps: true,
  admin_comments: true,
  status: true,
  archived_at: true,
  created_at: true,
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
} as const;

@Injectable()
export class RecapsService {
  private readonly logger = new Logger(RecapsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private accessibleRecapWhere(
    adminId: string,
    role: string,
  ): Prisma.WeeklyRecapWhereInput {
    if (role === Role.SUPER_ADMIN)
      return { client: { is: { role: Role.CLIENT } } };
    if (role === Role.ADMIN)
      return {
        client: {
          is: { clientOf: { some: { admin_id: adminId, is_active: true } } },
        },
      };
    return { id: { in: [] } };
  }

  private async assertAdminRecapAccess(
    id: string,
    adminId: string,
    adminRole: string,
  ) {
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

  private normalizeOptionalText(
    value: string | null | undefined,
  ): string | null {
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
      } else if (
        this.shouldNotifyClientFeedback(
          recap.client_feedback_text,
          nextFeedback,
        )
      ) {
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

  private notifyClientFeedback(
    adminId: string,
    clientId: string,
    recapId: string,
  ) {
    this.notificationsService
      .sendToUser(
        adminId,
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
      throw new ForbiddenException(
        'You already have a submitted recap for this week',
      );
    }

    const data = {
      week_end_date: weekEnd,
      training_effort: dto.training_effort,
      training_sessions: dto.training_sessions,
      average_daily_steps: dto.average_daily_steps,
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
      pain_intensity: dto.pain_intensity,
      recovery_notes: dto.recovery_notes,
      mood: dto.mood,
      stress_enabled: dto.stress_enabled,
      stress_level: dto.stress_level,
      hunger_level: dto.hunger_level,
      energy_level: dto.energy_level,
      digestion_level: dto.digestion_level,
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
        select: CLIENT_RECAP_SELECT,
      });
    }

    return this.prisma.weeklyRecap.create({
      data: {
        client_id: clientId,
        week_start_date: weekStart,
        week_end_date: weekEnd,
        training_effort: dto.training_effort,
        training_sessions: dto.training_sessions,
        average_daily_steps: dto.average_daily_steps,
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
        pain_intensity: dto.pain_intensity,
        recovery_notes: dto.recovery_notes,
        mood: dto.mood,
        stress_enabled: dto.stress_enabled,
        stress_level: dto.stress_level,
        hunger_level: dto.hunger_level,
        energy_level: dto.energy_level,
        digestion_level: dto.digestion_level,
        general_notes: dto.general_notes,
        improvement_app_rating: dto.improvement_app_rating,
        improvement_service_rating: dto.improvement_service_rating,
        improvement_areas: dto.improvement_areas ?? [],
        improvement_feedback_text: dto.improvement_feedback_text,
        status: RecapStatus.DRAFT,
      },
      select: CLIENT_RECAP_SELECT,
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

    if (recap.status !== RecapStatus.DRAFT) {
      throw new ForbiddenException('Only draft recaps can be edited');
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
      select: CLIENT_RECAP_SELECT,
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

    if (recap.status !== RecapStatus.DRAFT) {
      throw new ForbiddenException('Only draft recaps can be submitted');
    }

    try {
      // A stale pre-submit lookup cannot downgrade a later confirmed review.
      return await this.prisma.weeklyRecap.update({
        where: { id, client_id: clientId, status: RecapStatus.DRAFT },
        data: {
          status: RecapStatus.SUBMITTED,
          submitted_at: new Date(),
        },
        select: CLIENT_RECAP_SELECT,
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      )
        throw new ForbiddenException('Only draft recaps can be submitted');
      throw error;
    }
  }

  async findMyRecaps(clientId: string, pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.weeklyRecap.findMany({
        where: { client_id: clientId },
        orderBy: [{ week_start_date: 'desc' }, { id: 'desc' }],
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
      select: {
        id: true,
        client_id: true,
        client_feedback_text: true,
        client_feedback_read_at: true,
      },
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
    const where: Prisma.WeeklyRecapWhereInput = {
      ...this.accessibleRecapWhere(adminId, adminRole),
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

  async findForAdmin(
    adminId: string,
    adminRole: string,
    query: AdminRecapQueryDto,
  ) {
    const statusFilter =
      query.status === RecapStatus.SUBMITTED ||
      query.status === RecapStatus.REVIEWED
        ? query.status
        : { in: [...ADMIN_RECAP_STATUSES] };
    const where: Prisma.WeeklyRecapWhereInput = {
      ...this.accessibleRecapWhere(adminId, adminRole),
      ...(query.client_id ? { client_id: query.client_id } : {}),
      status: statusFilter,
      archived_at: query.archived ? { not: null } : null,
    };

    const [data, total] = await Promise.all([
      this.prisma.weeklyRecap.findMany({
        where,
        orderBy: [{ week_start_date: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
        select: ADMIN_RECAP_LIST_SELECT,
      }),
      this.prisma.weeklyRecap.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async getAdminRecapById(adminId: string, adminRole: string, id: string) {
    return this.assertAdminRecapAccess(id, adminId, adminRole);
  }

  private async reviewTransaction<T>(
    adminId: string,
    adminRole: string,
    id: string,
    work: (tx: Prisma.TransactionClient, recap: WeeklyRecap) => Promise<T>,
  ): Promise<T> {
    if (adminRole !== Role.ADMIN && adminRole !== Role.SUPER_ADMIN)
      throw new ForbiddenException('Staff access required');
    const lookup = await this.prisma.weeklyRecap.findUnique({
      where: { id },
      select: { client_id: true },
    });
    if (!lookup) throw new NotFoundException('Recap not found');
    return this.prisma.$transaction(
      async (tx) => {
        // Match follow-up task/deletion order: client barrier, sorted users,
        // active assignment, recap. SHARE protects eligibility through commit.
        await lockClientDayProgress(tx, lookup.client_id);
        const ids = [...new Set([adminId, lookup.client_id])].sort();
        await tx.$queryRaw(Prisma.sql`
          SELECT id FROM users WHERE id IN (${Prisma.join(ids)})
          ORDER BY id FOR SHARE`);
        const users = await tx.user.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            role: true,
            is_active: true,
            is_locked: true,
            is_archived: true,
            identity_pending: true,
          },
        });
        const actor = users.find((user) => user.id === adminId);
        const client = users.find((user) => user.id === lookup.client_id);
        const eligible = (user: (typeof users)[number]) =>
          user.is_active &&
          !user.is_locked &&
          !user.is_archived &&
          !user.identity_pending;
        if (!actor || actor.role !== adminRole || !eligible(actor))
          throw new ForbiddenException('Staff access changed');
        if (!client || client.role !== Role.CLIENT)
          throw new NotFoundException('Client not found');
        if (
          !eligible(client) ||
          (await tx.clientDeletion.findUnique({
            where: { client_id: client.id },
            select: { id: true },
          }))
        )
          throw new ForbiddenException('Client is not writable');
        if (actor.role === Role.ADMIN) {
          const assignments = await tx.$queryRaw<{ admin_id: string }[]>(
            Prisma.sql`SELECT admin_id FROM admin_client_assignments
              WHERE client_id = ${client.id} AND admin_id = ${actor.id}
                AND is_active = true ORDER BY admin_id FOR UPDATE`,
          );
          if (!assignments.length)
            throw new ForbiddenException('Client not assigned to staff');
        }
        await tx.$queryRaw(Prisma.sql`
          SELECT id FROM weekly_recaps WHERE id = ${id}
            AND client_id = ${client.id} FOR UPDATE`);
        const recap = await tx.weeklyRecap.findUnique({ where: { id } });
        if (!recap || recap.client_id !== client.id)
          throw new NotFoundException('Recap not found');
        if (
          recap.status === RecapStatus.DRAFT ||
          !recap.submitted_at ||
          recap.archived_at
        )
          throw new ForbiddenException(
            'Only submitted, unarchived recaps can be reviewed',
          );
        return work(tx, recap);
      },
      {
        ...DAY_PROGRESS_TRANSACTION_OPTIONS,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      },
    );
  }

  private assertReviewVersion(version: number) {
    if (!Number.isInteger(version) || version < 0 || version > 2147483646)
      throw new BadRequestException('Invalid expected_version');
  }

  private async writeReview(
    tx: Prisma.TransactionClient,
    recap: WeeklyRecap,
    version: number,
    data: Prisma.WeeklyRecapUpdateManyMutationInput,
  ) {
    if (recap.review_version !== version)
      throw new ConflictException('Review version changed');
    const updated = await tx.weeklyRecap.updateMany({
      where: { id: recap.id, review_version: version },
      data: { ...data, review_version: { increment: 1 } },
    });
    if (updated.count !== 1)
      throw new ConflictException('Review version changed');
    return tx.weeklyRecap.findUniqueOrThrow({
      where: { id: recap.id },
      select: REVIEW_SELECT,
    });
  }

  async saveReviewDraft(
    adminId: string,
    adminRole: string,
    id: string,
    dto: ReviewDraftDto,
  ) {
    this.assertReviewVersion(dto.expected_version);
    const data: Prisma.WeeklyRecapUpdateManyMutationInput = {};
    for (const key of Object.keys(
      DRAFT_REVIEW_FIELDS,
    ) as (keyof typeof DRAFT_REVIEW_FIELDS)[]) {
      if (dto[key] !== undefined)
        data[DRAFT_REVIEW_FIELDS[key]] = this.normalizeOptionalText(dto[key]);
    }
    if (!Object.keys(data).length)
      throw new BadRequestException('At least one draft field is required');
    return this.reviewTransaction(adminId, adminRole, id, (tx, recap) =>
      this.writeReview(tx, recap, dto.expected_version, data),
    );
  }

  async publishReview(
    adminId: string,
    adminRole: string,
    id: string,
    dto: ReviewPublishDto,
  ) {
    this.assertReviewVersion(dto.expected_version);
    if (dto.confirm !== true)
      throw new BadRequestException('Explicit confirmation required');
    return this.reviewTransaction(adminId, adminRole, id, (tx, recap) =>
      this.writeReview(tx, recap, dto.expected_version, {
        published_coach_summary: recap.draft_coach_summary,
        published_changes: recap.draft_changes,
        published_next_week_goals: recap.draft_next_week_goals,
        ...(recap.status === RecapStatus.SUBMITTED
          ? { status: RecapStatus.REVIEWED, reviewed_at: new Date() }
          : {}),
      }),
    );
  }

  async review(
    adminId: string,
    adminRole: string,
    id: string,
    dto: ReviewRecapDto,
  ) {
    const recap = await this.assertAdminRecapAccess(id, adminId, adminRole);

    if (recap.archived_at) {
      throw new ForbiddenException('Cannot review an archived recap');
    }

    if (recap.status === RecapStatus.DRAFT) {
      throw new ForbiddenException('Cannot review a draft recap');
    }

    const { data: feedbackUpdates, shouldNotifyClientFeedback } =
      this.buildClientFeedbackUpdate(recap, dto);

    if (recap.status === RecapStatus.REVIEWED) {
      if (
        dto.admin_comments === undefined &&
        Object.keys(feedbackUpdates).length === 0
      ) {
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
        this.notifyClientFeedback(adminId, recap.client_id, recap.id);
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
      this.notifyClientFeedback(adminId, recap.client_id, recap.id);
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

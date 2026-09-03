import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateFeedbackDto, RespondFeedbackDto } from './dto/create-feedback.dto';
import {
  FeedbackKind,
  FeedbackStatus,
  ManagedUploadPurpose,
  MediaType,
  Prisma,
  Role,
} from '@prisma/client';
import { AdminFeedbackQueryDto } from './dto/admin-feedback-query.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { UploadsService } from '../uploads/uploads.service';
import { parseDateOnly } from '../../common/date-only';

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly uploadsService: UploadsService,
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

    const clientAssignments = await this.prisma.adminClientAssignment.findMany({
      where: { admin_id: currentUserId, is_active: true },
      select: { client_id: true },
    });

    return clientAssignments.map((assignment) => assignment.client_id);
  }

  async create(clientId: string, dto: CreateFeedbackDto) {
    if (dto.client_upload_id) {
      const existing = await this.prisma.feedbackMedia.findUnique({
        where: {
          client_id_client_upload_id: {
            client_id: clientId,
            client_upload_id: dto.client_upload_id,
          },
        },
      });
      if (existing) return existing;
    }
    const feedbackKind = dto.feedback_kind ?? FeedbackKind.GENERAL;
    let assignmentDate: Date | undefined;
    if (feedbackKind === FeedbackKind.LAST_SET) {
      if (
        dto.media_type !== MediaType.VIDEO ||
        !dto.exercise_id ||
        !dto.training_id ||
        !dto.training_exercise_id ||
        !dto.assignment_date ||
        !dto.client_upload_id
      ) {
        throw new BadRequestException(
          'El feedback de última serie requiere vídeo, fecha, entrenamiento, ejercicio e identificador de subida',
        );
      }
      assignmentDate = parseDateOnly(dto.assignment_date, 'assignment_date');
      const assignment = await this.prisma.planAssignment.findUnique({
        where: { client_id_date: { client_id: clientId, date: assignmentDate } },
        select: {
          trainings: {
            where: { training_id: dto.training_id },
            select: { requires_last_set_video: true },
          },
        },
      });
      const trainingExercise = await this.prisma.trainingExercise.findFirst({
        where: {
          id: dto.training_exercise_id,
          training_id: dto.training_id,
          exercise_id: dto.exercise_id,
        },
        select: { id: true },
      });
      if (!assignment?.trainings.length || !trainingExercise) {
        throw new ForbiddenException(
          'El ejercicio no pertenece al entrenamiento asignado para esa fecha',
        );
      }
    }
    const expectedPurpose = dto.media_type === MediaType.VIDEO
      ? ManagedUploadPurpose.FEEDBACK_VIDEO
      : ManagedUploadPurpose.FEEDBACK_IMAGE;
    const upload = await this.uploadsService.prepareForConsumption({
      ownerId: clientId,
      uploadId: dto.upload_id,
      legacyUrl: dto.media_url,
      purposes: [expectedPurpose],
    });
    let feedback;
    try {
      feedback = await this.prisma.$transaction(async (tx) => {
        await this.uploadsService.consumePrepared(
          tx,
          clientId,
          upload.id,
          [expectedPurpose],
        );
        return tx.feedbackMedia.create({
          data: {
            client_id: clientId,
            ...(dto.client_upload_id && { client_upload_id: dto.client_upload_id }),
            ...(dto.exercise_id && { exercise_id: dto.exercise_id }),
            ...(dto.training_id && { training_id: dto.training_id }),
            ...(dto.training_exercise_id && {
              training_exercise_id: dto.training_exercise_id,
            }),
            ...(assignmentDate && { assignment_date: assignmentDate }),
            ...(feedbackKind !== FeedbackKind.GENERAL && {
              feedback_kind: feedbackKind,
            }),
            media_type: dto.media_type,
            media_url: upload.file_url,
            notes: dto.notes,
            status: FeedbackStatus.PENDING,
          },
        });
      });
    } catch (error) {
      if (
        dto.client_upload_id &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.feedbackMedia.findUnique({
          where: {
            client_id_client_upload_id: {
              client_id: clientId,
              client_upload_id: dto.client_upload_id,
            },
          },
        });
        if (existing) return existing;
      }
      throw error;
    }

    await this.notifyFeedbackSubmitted(clientId, feedback.id);

    return feedback;
  }

  async findAll(currentUserId: string, currentUserRole: string, query: AdminFeedbackQueryDto) {
    const accessibleClientIds = await this.resolveAccessibleClientIds(currentUserId, currentUserRole);

    if (accessibleClientIds.length === 0) {
      return paginate([], 0, query);
    }

    if (query.client_id && !accessibleClientIds.includes(query.client_id)) {
      return paginate([], 0, query);
    }

    const filteredClientIds = query.client_id ? [query.client_id] : accessibleClientIds;

    const where = {
      client_id: { in: filteredClientIds },
      ...(query.status ? { status: query.status } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.feedbackMedia.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: query.skip,
        take: query.limit,
        include: {
          client: { select: { id: true, email: true, profile: { select: { first_name: true, last_name: true } } } },
          exercise: { select: { id: true, name: true } },
          training: { select: { id: true, name: true } },
        },
      }),
      this.prisma.feedbackMedia.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async getStats(currentUserId: string, currentUserRole: string) {
    const accessibleClientIds = await this.resolveAccessibleClientIds(currentUserId, currentUserRole);

    if (accessibleClientIds.length === 0) {
      return { total: 0, pending: 0, reviewed: 0 };
    }

    const [total, pending, reviewed] = await Promise.all([
      this.prisma.feedbackMedia.count({ where: { client_id: { in: accessibleClientIds } } }),
      this.prisma.feedbackMedia.count({ where: { client_id: { in: accessibleClientIds }, status: FeedbackStatus.PENDING } }),
      this.prisma.feedbackMedia.count({ where: { client_id: { in: accessibleClientIds }, status: FeedbackStatus.REVIEWED } }),
    ]);

    return { total, pending, reviewed };
  }

  async findMy(clientId: string, pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.feedbackMedia.findMany({
        where: { client_id: clientId },
        orderBy: { created_at: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          exercise: { select: { id: true, name: true } },
          training: { select: { id: true, name: true } },
        },
      }),
      this.prisma.feedbackMedia.count({ where: { client_id: clientId } }),
    ]);

    return paginate(data, total, pagination);
  }

  async respond(id: string, currentUserId: string, currentUserRole: string, dto: RespondFeedbackDto) {
    const feedback = await this.prisma.feedbackMedia.findUnique({
      where: { id },
      select: { id: true, client_id: true },
    });

    if (!feedback) {
      throw new NotFoundException('Feedback not found');
    }

    const accessibleClientIds = await this.resolveAccessibleClientIds(currentUserId, currentUserRole);

    if (!accessibleClientIds.includes(feedback.client_id)) {
      throw new ForbiddenException('No tienes permisos para responder este feedback');
    }

    const adminResponse = dto.admin_response.trim();

    if (!adminResponse) {
      throw new BadRequestException('admin_response no puede estar vacío');
    }

    return this.prisma.feedbackMedia.update({
      where: { id },
      data: {
        admin_response: adminResponse,
        status: FeedbackStatus.REVIEWED,
        reviewed_by: currentUserId,
        reviewed_at: new Date(),
      },
    });
  }

  private buildClientNotificationName(client: {
    email?: string | null;
    profile?: {
      first_name?: string | null;
      last_name?: string | null;
    } | null;
  } | null) {
    const fullName = [
      client?.profile?.first_name,
      client?.profile?.last_name,
    ]
      .filter(Boolean)
      .join(' ')
      .trim();

    return fullName || client?.email || 'Cliente';
  }

  private async notifyFeedbackSubmitted(clientId: string, feedbackId: string) {
    try {
      const assignments = await this.prisma.adminClientAssignment.findMany({
        where: {
          client_id: clientId,
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

      const adminIds = [...new Set(assignments.map((row) => row.admin_id))];
      if (adminIds.length === 0) {
        return;
      }

      const clientName = this.buildClientNotificationName(
        assignments[0]?.client ?? null,
      );

      await this.notifications.sendInternalTemplate(
        clientId,
        adminIds,
        'admin_feedback_submitted',
        { clientName, clientId, feedbackId },
        {
          title: 'Nuevo feedback de cliente',
          body: `${clientName} subió feedback`,
          route: `/admin/feedback/${feedbackId}`,
        },
        {
          type: 'feedback_submitted',
          feedback_id: feedbackId,
          client_id: clientId,
        },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send feedback notification for ${feedbackId}: ${(err as Error).message}`,
      );
    }
  }
}

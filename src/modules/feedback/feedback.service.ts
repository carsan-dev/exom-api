import type { FeedbackMedia } from '@prisma/client';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import {
  CreateFeedbackDto,
  RespondFeedbackDto,
} from './dto/create-feedback.dto';
import {
  Prisma,
  FeedbackKind,
  FeedbackStatus,
  ManagedUploadPurpose,
  MediaType,
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

  private accessibleFeedbackWhere(
    currentUserId: string,
    currentUserRole: string,
  ): Prisma.FeedbackMediaWhereInput {
    if (currentUserRole === Role.SUPER_ADMIN)
      return { client: { is: { role: Role.CLIENT } } };
    if (currentUserRole === Role.ADMIN)
      return {
        client: {
          is: {
            clientOf: { some: { admin_id: currentUserId, is_active: true } },
          },
        },
      };
    return { id: { in: [] } };
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
        where: {
          client_id_date: { client_id: clientId, date: assignmentDate },
        },
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
    const expectedPurpose =
      dto.media_type === MediaType.VIDEO
        ? ManagedUploadPurpose.FEEDBACK_VIDEO
        : ManagedUploadPurpose.FEEDBACK_IMAGE;
    let feedback: FeedbackMedia;
    try {
      const upload = await this.uploadsService.prepareForConsumption({
        ownerId: clientId,
        uploadId: dto.upload_id,
        legacyUrl: dto.media_url,
        purposes: [expectedPurpose],
      });
      feedback = await this.prisma.$transaction(async (tx) => {
        await this.uploadsService.consumePrepared(tx, clientId, upload.id, [
          expectedPurpose,
        ]);
        const created = await tx.feedbackMedia.create({
          data: {
            client_id: clientId,
            ...(dto.client_upload_id && {
              client_upload_id: dto.client_upload_id,
            }),
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
        await this.notifyFeedbackSubmitted(tx, clientId, created.id);
        return created;
      });
    } catch (error) {
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
      throw error;
    }

    return feedback;
  }

  async findAll(
    currentUserId: string,
    currentUserRole: string,
    query: AdminFeedbackQueryDto,
  ) {
    const where: Prisma.FeedbackMediaWhereInput = {
      ...this.accessibleFeedbackWhere(currentUserId, currentUserRole),
      ...(query.client_id ? { client_id: query.client_id } : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.feedbackMedia.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip: query.skip,
        take: query.limit,
        include: {
          client: {
            select: {
              id: true,
              email: true,
              profile: { select: { first_name: true, last_name: true } },
            },
          },
          exercise: { select: { id: true, name: true } },
          training: { select: { id: true, name: true } },
        },
      }),
      this.prisma.feedbackMedia.count({ where }),
    ]);

    return paginate(data, total, query);
  }

  async getStats(currentUserId: string, currentUserRole: string) {
    const accessible = this.accessibleFeedbackWhere(
      currentUserId,
      currentUserRole,
    );

    const [total, pending, reviewed] = await Promise.all([
      this.prisma.feedbackMedia.count({
        where: accessible,
      }),
      this.prisma.feedbackMedia.count({
        where: {
          ...accessible,
          status: FeedbackStatus.PENDING,
        },
      }),
      this.prisma.feedbackMedia.count({
        where: {
          ...accessible,
          status: FeedbackStatus.REVIEWED,
        },
      }),
    ]);

    return { total, pending, reviewed };
  }

  async findMy(clientId: string, pagination: PaginationDto) {
    const [data, total] = await Promise.all([
      this.prisma.feedbackMedia.findMany({
        where: { client_id: clientId },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
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

  async respond(
    id: string,
    currentUserId: string,
    currentUserRole: string,
    dto: RespondFeedbackDto,
  ) {
    const feedback = await this.prisma.feedbackMedia.findUnique({
      where: { id },
      select: { id: true, client_id: true },
    });

    if (!feedback) {
      throw new NotFoundException('Feedback not found');
    }

    const accessible = await this.prisma.feedbackMedia.count({
      where: {
        id: feedback.id,
        ...this.accessibleFeedbackWhere(currentUserId, currentUserRole),
      },
    });
    if (!accessible) {
      throw new ForbiddenException(
        'No tienes permisos para responder este feedback',
      );
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

  private buildClientNotificationName(
    client: {
      email?: string | null;
      profile?: {
        first_name?: string | null;
        last_name?: string | null;
      } | null;
    } | null,
  ) {
    const fullName = [client?.profile?.first_name, client?.profile?.last_name]
      .filter(Boolean)
      .join(' ')
      .trim();

    return fullName || client?.email || 'Cliente';
  }

  private async notifyFeedbackSubmitted(
    tx: Prisma.TransactionClient,
    clientId: string,
    feedbackId: string,
  ) {
    const assignments = await tx.adminClientAssignment.findMany({
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

    await this.notifications.queueTemplate(
      tx,
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
  }
}

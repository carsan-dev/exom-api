import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateFeedbackDto, RespondFeedbackDto } from './dto/create-feedback.dto';
import { FeedbackStatus, Role } from '@prisma/client';
import { AdminFeedbackQueryDto } from './dto/admin-feedback-query.dto';

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

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
    return this.prisma.feedbackMedia.create({
      data: {
        client_id: clientId,
        exercise_id: dto.exercise_id,
        media_type: dto.media_type,
        media_url: dto.media_url,
        notes: dto.notes,
        status: FeedbackStatus.PENDING,
      },
    });
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
}

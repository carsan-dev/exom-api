import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateFeedbackDto, RespondFeedbackDto } from './dto/create-feedback.dto';
import { FeedbackStatus } from '@prisma/client';

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

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

  async findAll(adminId: string, pagination: PaginationDto) {
    const clientAssignments = await this.prisma.adminClientAssignment.findMany({
      where: { admin_id: adminId, is_active: true },
      select: { client_id: true },
    });

    const clientIds = clientAssignments.map((a) => a.client_id);

    const [data, total] = await Promise.all([
      this.prisma.feedbackMedia.findMany({
        where: { client_id: { in: clientIds } },
        orderBy: { created_at: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          client: { select: { id: true, email: true, profile: { select: { first_name: true, last_name: true } } } },
          exercise: { select: { id: true, name: true } },
        },
      }),
      this.prisma.feedbackMedia.count({
        where: { client_id: { in: clientIds } },
      }),
    ]);

    return paginate(data, total, pagination);
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

  async respond(id: string, adminId: string, dto: RespondFeedbackDto) {
    const feedback = await this.prisma.feedbackMedia.findUnique({ where: { id } });

    if (!feedback) {
      throw new NotFoundException('Feedback not found');
    }

    return this.prisma.feedbackMedia.update({
      where: { id },
      data: {
        admin_response: dto.admin_response,
        status: FeedbackStatus.REVIEWED,
        reviewed_by: adminId,
        reviewed_at: new Date(),
      },
    });
  }
}

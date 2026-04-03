import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateRecapDto, UpdateRecapDto, ReviewRecapDto } from './dto/create-recap.dto';
import { ADMIN_RECAP_STATUSES, AdminRecapQueryDto } from './dto/admin-recap-query.dto';
import { RecapStatus, Role } from '@prisma/client';

@Injectable()
export class RecapsService {
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
      }),
      this.prisma.weeklyRecap.count({ where: { client_id: clientId } }),
    ]);

    return paginate(data, total, pagination);
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

    if (recap.status === RecapStatus.REVIEWED) {
      if (dto.admin_comments === undefined) {
        return recap;
      }

      return this.prisma.weeklyRecap.update({
        where: { id },
        data: {
          admin_comments: dto.admin_comments || null,
        },
      });
    }

    return this.prisma.weeklyRecap.update({
      where: { id },
      data: {
        status: RecapStatus.REVIEWED,
        reviewed_at: new Date(),
        ...(dto.admin_comments !== undefined
          ? { admin_comments: dto.admin_comments || null }
          : {}),
      },
    });
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

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, paginate } from '../../common/dto/pagination.dto';
import { CreateRecapDto, UpdateRecapDto, ReviewRecapDto } from './dto/create-recap.dto';
import { RecapStatus } from '@prisma/client';

@Injectable()
export class RecapsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(clientId: string, dto: CreateRecapDto) {
    return this.prisma.weeklyRecap.create({
      data: {
        client_id: clientId,
        week_start_date: new Date(dto.week_start_date),
        week_end_date: new Date(dto.week_end_date),
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

    return this.prisma.weeklyRecap.update({
      where: { id },
      data: { status: RecapStatus.SUBMITTED },
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

  async findForAdmin(adminId: string, pagination: PaginationDto) {
    const clientAssignments = await this.prisma.adminClientAssignment.findMany({
      where: { admin_id: adminId, is_active: true },
      select: { client_id: true },
    });

    const clientIds = clientAssignments.map((a) => a.client_id);

    const [data, total] = await Promise.all([
      this.prisma.weeklyRecap.findMany({
        where: {
          client_id: { in: clientIds },
          status: { in: [RecapStatus.SUBMITTED, RecapStatus.REVIEWED] },
        },
        orderBy: { week_start_date: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
        include: {
          client: {
            select: {
              id: true,
              email: true,
              profile: { select: { first_name: true, last_name: true } },
            },
          },
        },
      }),
      this.prisma.weeklyRecap.count({
        where: {
          client_id: { in: clientIds },
          status: { in: [RecapStatus.SUBMITTED, RecapStatus.REVIEWED] },
        },
      }),
    ]);

    return paginate(data, total, pagination);
  }

  async findOne(id: string) {
    const recap = await this.prisma.weeklyRecap.findUnique({ where: { id } });

    if (!recap) {
      throw new NotFoundException('Recap not found');
    }

    return recap;
  }

  async review(adminId: string, id: string, dto: ReviewRecapDto) {
    const recap = await this.prisma.weeklyRecap.findUnique({ where: { id } });

    if (!recap) {
      throw new NotFoundException('Recap not found');
    }

    return this.prisma.weeklyRecap.update({
      where: { id },
      data: {
        status: RecapStatus.REVIEWED,
        ...(dto.notes ? { general_notes: dto.notes } : {}),
      },
    });
  }
}

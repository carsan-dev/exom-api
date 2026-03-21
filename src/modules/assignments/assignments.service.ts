import {
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BulkAssignmentDto, CopyWeekDto } from './dto/bulk-assign.dto';

@Injectable()
export class AssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private parseDate(dateStr: string): Date {
    const d = new Date(dateStr);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }

  async bulkAssign(adminId: string, dto: BulkAssignmentDto) {
    // Verify client belongs to this admin
    const assignment = await this.prisma.adminClientAssignment.findFirst({
      where: {
        admin_id: adminId,
        client_id: dto.client_id,
        is_active: true,
      },
    });

    if (!assignment) {
      throw new ForbiddenException('Este cliente no está asignado a ti');
    }

    const results = await this.prisma.$transaction(
      dto.dates.map((dateStr) => {
        const date = this.parseDate(dateStr);
        return this.prisma.planAssignment.upsert({
          where: {
            client_id_date: {
              client_id: dto.client_id,
              date,
            },
          },
          create: {
            client_id: dto.client_id,
            admin_id: adminId,
            date,
            training_id: dto.training_id ?? null,
            diet_id: dto.diet_id ?? null,
            is_rest_day: dto.is_rest_day ?? false,
          },
          update: {
            admin_id: adminId,
            training_id: dto.training_id ?? null,
            diet_id: dto.diet_id ?? null,
            is_rest_day: dto.is_rest_day ?? false,
          },
        });
      }),
    );

    return results;
  }

  async copyWeek(adminId: string, dto: CopyWeekDto) {
    // Verify client belongs to this admin
    const assignment = await this.prisma.adminClientAssignment.findFirst({
      where: {
        admin_id: adminId,
        client_id: dto.client_id,
        is_active: true,
      },
    });

    if (!assignment) {
      throw new ForbiddenException('Este cliente no está asignado a ti');
    }

    const sourceStart = this.parseDate(dto.source_week_start);
    const targetStart = this.parseDate(dto.target_week_start);

    // Fetch 7 days from source week
    const sourceDates = Array.from({ length: 7 }, (_, i) =>
      this.addDays(sourceStart, i),
    );

    const sourceAssignments = await this.prisma.planAssignment.findMany({
      where: {
        client_id: dto.client_id,
        date: {
          gte: sourceDates[0],
          lte: sourceDates[6],
        },
      },
    });

    const sourceMap = new Map(
      sourceAssignments.map((a) => [
        a.date.toISOString().split('T')[0],
        a,
      ]),
    );

    const results = await this.prisma.$transaction(
      sourceDates.map((sourceDate, i) => {
        const targetDate = this.addDays(targetStart, i);
        const sourceDateKey = sourceDate.toISOString().split('T')[0];
        const source = sourceMap.get(sourceDateKey);

        return this.prisma.planAssignment.upsert({
          where: {
            client_id_date: {
              client_id: dto.client_id,
              date: targetDate,
            },
          },
          create: {
            client_id: dto.client_id,
            admin_id: adminId,
            date: targetDate,
            training_id: source?.training_id ?? null,
            diet_id: source?.diet_id ?? null,
            is_rest_day: source?.is_rest_day ?? false,
          },
          update: {
            admin_id: adminId,
            training_id: source?.training_id ?? null,
            diet_id: source?.diet_id ?? null,
            is_rest_day: source?.is_rest_day ?? false,
          },
        });
      }),
    );

    return results;
  }

  async getWeek(clientId: string, weekStart: string) {
    const start = this.parseDate(weekStart);
    const end = this.addDays(start, 6);

    const assignments = await this.prisma.planAssignment.findMany({
      where: {
        client_id: clientId,
        date: {
          gte: start,
          lte: end,
        },
      },
      include: {
        training: {
          select: {
            id: true,
            name: true,
            type: true,
            level: true,
            estimated_duration_min: true,
          },
        },
        diet: {
          select: {
            id: true,
            name: true,
            total_calories: true,
          },
        },
      },
      orderBy: { date: 'asc' },
    });

    return assignments;
  }
}

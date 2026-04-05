import {
  BadRequestException,
  ConflictException,
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BatchAssignDaysDto } from './dto/batch-assign-days.dto';
import { BulkAssignmentDto, CopyWeekDto } from './dto/bulk-assign.dto';
import { GetMonthAssignmentsQueryDto } from './dto/get-month-assignments-query.dto';
import { GetWeekAssignmentsQueryDto } from './dto/get-week-assignments-query.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

const assignmentInclude = {
  training: {
    select: {
      id: true,
      name: true,
      type: true,
      level: true,
      estimated_duration_min: true,
      estimated_calories: true,
    },
  },
  diet: {
    select: {
      id: true,
      name: true,
      total_calories: true,
      total_protein_g: true,
      total_carbs_g: true,
      total_fat_g: true,
    },
  },
};

export interface AssignmentTrainingSummary {
  id: string;
  name: string;
  type: string;
  level: string;
  estimated_duration_min: number | null;
  estimated_calories: number | null;
}

export interface AssignmentDietSummary {
  id: string;
  name: string;
  total_calories: number | null;
  total_protein_g: number | null;
  total_carbs_g: number | null;
  total_fat_g: number | null;
}

export interface AssignmentRecord {
  id: string;
  client_id: string;
  date: Date;
  is_rest_day: boolean;
  training_id?: string | null;
  diet_id?: string | null;
  training: AssignmentTrainingSummary | null;
  diet: AssignmentDietSummary | null;
}

interface AssignmentRange {
  start: Date;
  end: Date;
  dates: Date[];
}

interface AssignmentMonthRange extends AssignmentRange {
  year: number;
  month: number;
}

@Injectable()
export class AssignmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private parseDate(dateStr: string): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);

    if (!match) {
      throw new BadRequestException('Fecha inválida');
    }

    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));

    if (this.formatDate(date) !== dateStr) {
      throw new BadRequestException('Fecha inválida');
    }

    return date;
  }

  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  private addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + days);
    return result;
  }

  private buildDateRange(start: Date, totalDays: number): AssignmentRange {
    return {
      start,
      end: this.addDays(start, totalDays - 1),
      dates: Array.from({ length: totalDays }, (_, index) => this.addDays(start, index)),
    };
  }

  private buildWeekRange(weekStart: string) {
    const start = this.parseDate(weekStart);

    if (start.getUTCDay() !== 1) {
      throw new BadRequestException('La semana debe comenzar en lunes');
    }

    return this.buildDateRange(start, 7);
  }

  private buildMonthRange(year: number, month: number): AssignmentMonthRange {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate();

    return {
      ...this.buildDateRange(start, totalDays),
      year,
      month,
    };
  }

  private normalizeAssignmentInput(input: {
    training_id?: string | null;
    diet_id?: string | null;
    is_rest_day?: boolean;
  }) {
    const is_rest_day = input.is_rest_day ?? false;
    const training_id = is_rest_day ? null : (input.training_id ?? null);
    const diet_id = is_rest_day ? null : (input.diet_id ?? null);

    if (!is_rest_day && !training_id && !diet_id) {
      throw new BadRequestException(
        'Debes asignar un entrenamiento, una dieta o marcar descanso',
      );
    }

    return {
      training_id,
      diet_id,
      is_rest_day,
    };
  }

  private async assertClientExists(clientId: string) {
    const client = await this.prisma.user.findUnique({
      where: { id: clientId },
      select: { id: true, role: true },
    });

    if (!client || client.role !== Role.CLIENT) {
      throw new NotFoundException('Cliente no encontrado');
    }

    return client;
  }

  private async assertClientAccess(user: AuthenticatedUser, clientId: string) {
    await this.assertClientExists(clientId);

    if (user.role === Role.SUPER_ADMIN) {
      return;
    }

    if (user.role === Role.CLIENT) {
      if (user.id !== clientId) {
        throw new ForbiddenException('No tienes permisos para acceder a este cliente');
      }

      return;
    }

    if (user.role !== Role.ADMIN) {
      throw new ForbiddenException('No tienes permisos para acceder a este cliente');
    }

    const assignment = await this.prisma.adminClientAssignment.findFirst({
      where: {
        admin_id: user.id,
        client_id: clientId,
        is_active: true,
      },
    });

    if (!assignment) {
      throw new ForbiddenException('Este cliente no está asignado a ti');
    }
  }

  private async validatePlanReferences(
    trainingId: string | null,
    dietId: string | null,
  ) {
    const [training, diet] = await Promise.all([
      trainingId
        ? this.prisma.training.findFirst({
            where: { id: trainingId, is_active: true },
            select: { id: true },
          })
        : Promise.resolve(null),
      dietId
        ? this.prisma.diet.findFirst({
            where: { id: dietId, is_active: true },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (trainingId && !training) {
      throw new NotFoundException('Entrenamiento no encontrado');
    }

    if (dietId && !diet) {
      throw new NotFoundException('Dieta no encontrada');
    }
  }

  private serializeAssignment(assignment: AssignmentRecord) {
    return {
      id: assignment.id,
      client_id: assignment.client_id,
      date: this.formatDate(assignment.date),
      is_rest_day: assignment.is_rest_day,
      training: assignment.training,
      diet: assignment.diet,
    };
  }

  private serializeRangeAssignments(
    clientId: string,
    range: AssignmentRange,
    assignments: AssignmentRecord[],
  ) {
    const assignmentMap = new Map(
      assignments.map((assignment) => [this.formatDate(assignment.date), assignment]),
    );

    return range.dates.map((date) => {
      const dateKey = this.formatDate(date);
      const assignment = assignmentMap.get(dateKey);

      if (!assignment) {
        return {
          id: null,
          client_id: clientId,
          date: dateKey,
          is_rest_day: false,
          training: null,
          diet: null,
        };
      }

      return this.serializeAssignment(assignment);
    });
  }

  private serializeWeekAssignments(
    clientId: string,
    weekRange: ReturnType<AssignmentsService['buildWeekRange']>,
    assignments: AssignmentRecord[],
  ) {
    return {
      client_id: clientId,
      week_start: this.formatDate(weekRange.start),
      week_end: this.formatDate(weekRange.end),
      days: this.serializeRangeAssignments(clientId, weekRange, assignments),
    };
  }

  private serializeMonthAssignments(
    clientId: string,
    monthRange: AssignmentMonthRange,
    assignments: AssignmentRecord[],
  ) {
    return {
      client_id: clientId,
      year: monthRange.year,
      month: monthRange.month,
      month_start: this.formatDate(monthRange.start),
      month_end: this.formatDate(monthRange.end),
      days: this.serializeRangeAssignments(clientId, monthRange, assignments),
    };
  }

  private getAssignmentsForRange(clientId: string, range: AssignmentRange) {
    return this.prisma.planAssignment.findMany({
      where: {
        client_id: clientId,
        date: {
          gte: range.start,
          lte: range.end,
        },
      },
      include: assignmentInclude,
      orderBy: { date: 'asc' },
    });
  }

  async bulkAssign(user: AuthenticatedUser, dto: BulkAssignmentDto) {
    await this.assertClientAccess(user, dto.client_id);

    const normalizedInput = this.normalizeAssignmentInput(dto);
    await this.validatePlanReferences(
      normalizedInput.training_id,
      normalizedInput.diet_id,
    );

    const uniqueDates = Array.from(
      new Set(dto.dates.map((dateStr) => this.formatDate(this.parseDate(dateStr)))),
    );

    const results = await this.prisma.$transaction(
      uniqueDates.map((dateStr) => {
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
            admin_id: user.id,
            date,
            ...normalizedInput,
          },
          update: {
            admin_id: user.id,
            ...normalizedInput,
          },
          include: assignmentInclude,
        });
      }),
    );

    return results.map((assignment) => this.serializeAssignment(assignment));
  }

  async batchAssign(user: AuthenticatedUser, dto: BatchAssignDaysDto) {
    await this.assertClientAccess(user, dto.client_id);

    const uniqueDays = Array.from(
      dto.days.reduce(
        (daysMap, day) => {
          const date = this.parseDate(day.date);
          const normalizedInput = this.normalizeAssignmentInput(day);

          daysMap.set(this.formatDate(date), {
            date,
            ...normalizedInput,
          });

          return daysMap;
        },
        new Map<
          string,
          {
            date: Date;
            training_id: string | null;
            diet_id: string | null;
            is_rest_day: boolean;
          }
        >(),
      ).values(),
    ).sort((left, right) => left.date.getTime() - right.date.getTime());

    await Promise.all(
      uniqueDays.map((day) =>
        this.validatePlanReferences(day.training_id, day.diet_id),
      ),
    );

    const results = await this.prisma.$transaction(
      uniqueDays.map((day) =>
        this.prisma.planAssignment.upsert({
          where: {
            client_id_date: {
              client_id: dto.client_id,
              date: day.date,
            },
          },
          create: {
            client_id: dto.client_id,
            admin_id: user.id,
            date: day.date,
            training_id: day.training_id,
            diet_id: day.diet_id,
            is_rest_day: day.is_rest_day,
          },
          update: {
            admin_id: user.id,
            training_id: day.training_id,
            diet_id: day.diet_id,
            is_rest_day: day.is_rest_day,
          },
          include: assignmentInclude,
        }),
      ),
    );

    return results.map((assignment) => this.serializeAssignment(assignment));
  }

  async copyWeek(user: AuthenticatedUser, dto: CopyWeekDto) {
    await this.assertClientAccess(user, dto.client_id);

    const sourceWeek = this.buildWeekRange(dto.source_week_start);
    const targetWeek = this.buildWeekRange(dto.target_week_start);

    if (sourceWeek.start.getTime() === targetWeek.start.getTime()) {
      throw new BadRequestException('La semana de origen y destino no puede ser la misma');
    }

    const sourceAssignments = await this.prisma.planAssignment.findMany({
      where: {
        client_id: dto.client_id,
        date: {
          gte: sourceWeek.start,
          lte: sourceWeek.end,
        },
      },
      include: assignmentInclude,
    });

    const sourceMap = new Map(
      sourceAssignments.map((a) => [
        a.date.toISOString().split('T')[0],
        a,
      ]),
    );

    const results = await this.prisma.$transaction(
      sourceWeek.dates.map((sourceDate, index) => {
        const sourceDateKey = sourceDate.toISOString().split('T')[0];
        const source = sourceMap.get(sourceDateKey);
        const targetDate = targetWeek.dates[index];

        if (!source) {
          // Skip days without source assignment — preserve existing target assignments
          return this.prisma.$queryRaw`SELECT 1`;
        }

        return this.prisma.planAssignment.upsert({
          where: {
            client_id_date: {
              client_id: dto.client_id,
              date: targetDate,
            },
          },
          create: {
            client_id: dto.client_id,
            admin_id: user.id,
            date: targetDate,
            training_id: source.training_id,
            diet_id: source.diet_id,
            is_rest_day: source.is_rest_day,
          },
          update: {
            admin_id: user.id,
            training_id: source.training_id,
            diet_id: source.diet_id,
            is_rest_day: source.is_rest_day,
          },
          include: assignmentInclude,
        });
      }),
    );

    void results;

    return this.getWeek(user, {
      client_id: dto.client_id,
      week_start: this.formatDate(targetWeek.start),
    });
  }

  async getWeek(user: AuthenticatedUser, query: GetWeekAssignmentsQueryDto) {
    await this.assertClientAccess(user, query.client_id);

    const weekRange = this.buildWeekRange(query.week_start);
    const assignments = await this.getAssignmentsForRange(query.client_id, weekRange);

    return this.serializeWeekAssignments(query.client_id, weekRange, assignments);
  }

  async getMonth(user: AuthenticatedUser, query: GetMonthAssignmentsQueryDto) {
    await this.assertClientAccess(user, query.client_id);

    const monthRange = this.buildMonthRange(query.year, query.month);
    const assignments = await this.getAssignmentsForRange(query.client_id, monthRange);

    return this.serializeMonthAssignments(query.client_id, monthRange, assignments);
  }

  async updateAssignment(
    user: AuthenticatedUser,
    assignmentId: string,
    dto: UpdateAssignmentDto,
  ) {
    const assignment = await this.prisma.planAssignment.findUnique({
      where: { id: assignmentId },
      include: assignmentInclude,
    });

    if (!assignment) {
      throw new NotFoundException('Asignación no encontrada');
    }

    await this.assertClientAccess(user, assignment.client_id);

    const nextDate = dto.date ? this.parseDate(dto.date) : assignment.date;

    if (this.formatDate(nextDate) !== this.formatDate(assignment.date)) {
      const existingAssignment = await this.prisma.planAssignment.findUnique({
        where: {
          client_id_date: {
            client_id: assignment.client_id,
            date: nextDate,
          },
        },
        select: { id: true },
      });

      if (existingAssignment && existingAssignment.id !== assignmentId) {
        throw new ConflictException(
          'Ya existe una asignación para ese cliente en la fecha indicada',
        );
      }
    }

    const normalizedInput = this.normalizeAssignmentInput({
      training_id:
        dto.training_id !== undefined ? dto.training_id : assignment.training_id,
      diet_id: dto.diet_id !== undefined ? dto.diet_id : assignment.diet_id,
      is_rest_day: dto.is_rest_day ?? assignment.is_rest_day,
    });

    await this.validatePlanReferences(
      normalizedInput.training_id,
      normalizedInput.diet_id,
    );

    const updatedAssignment = await this.prisma.planAssignment.update({
      where: { id: assignmentId },
      data: {
        admin_id: user.id,
        date: nextDate,
        ...normalizedInput,
      },
      include: assignmentInclude,
    });

    return this.serializeAssignment(updatedAssignment);
  }

  async deleteAssignment(user: AuthenticatedUser, assignmentId: string) {
    const assignment = await this.prisma.planAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        client_id: true,
      },
    });

    if (!assignment) {
      throw new NotFoundException('Asignación no encontrada');
    }

    await this.assertClientAccess(user, assignment.client_id);

    await this.prisma.planAssignment.delete({
      where: { id: assignmentId },
    });

    return {
      message: 'Asignación eliminada exitosamente',
    };
  }
}

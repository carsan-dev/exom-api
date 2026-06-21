import {
  BadRequestException,
  ConflictException,
  Injectable,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateAutoAssignmentRuleDto,
  GetActiveAutoAssignmentRuleQueryDto,
} from './dto/auto-assignment-rule.dto';
import { BatchAssignDaysDto } from './dto/batch-assign-days.dto';
import { BulkAssignmentDto, CopyWeekDto } from './dto/bulk-assign.dto';
import { GetMonthAssignmentsQueryDto } from './dto/get-month-assignments-query.dto';
import { GetWeekAssignmentsQueryDto } from './dto/get-week-assignments-query.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { NotificationsService } from '../notifications/notifications.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

type PlanNotifKind = 'training' | 'diet' | 'plan' | 'rest';

const assignmentInclude = {
  training: {
    select: {
      id: true,
      name: true,
      type: true,
      types: true,
      accentColor: true,
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

const autoAssignmentRuleInclude = {
  days: {
    orderBy: { weekday: 'asc' as const },
    include: {
      training: {
        select: {
          id: true,
          name: true,
          type: true,
          types: true,
          accentColor: true,
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
    },
  },
};

export interface AssignmentTrainingSummary {
  id: string;
  name: string;
  type: string;
  types: string[];
  accentColor: string | null;
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

interface AutoAssignmentRuleDayRecord {
  id: string;
  weekday: number;
  training_id: string | null;
  diet_id: string | null;
  is_rest_day: boolean;
  training: AssignmentTrainingSummary | null;
  diet: AssignmentDietSummary | null;
}

interface AutoAssignmentRuleRecord {
  id: string;
  client_id: string;
  admin_id: string | null;
  source_week_start: Date;
  starts_on: Date;
  ends_on: Date | null;
  is_active: boolean;
  deactivated_at: Date | null;
  days: AutoAssignmentRuleDayRecord[];
}

@Injectable()
export class AssignmentsService {
  private readonly logger = new Logger(AssignmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async getClientOptions(user: AuthenticatedUser) {
    const clients = await this.prisma.user.findMany({
      where: {
        role: Role.CLIENT,
        ...(user.role === Role.ADMIN
          ? {
              clientOf: {
                some: {
                  admin_id: user.id,
                  is_active: true,
                },
              },
            }
          : {}),
      },
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
      orderBy: [{ profile: { first_name: 'asc' } }, { email: 'asc' }],
    });

    return clients;
  }

  async getCatalogOptions() {
    const [trainings, diets] = await Promise.all([
      this.prisma.training.findMany({
        where: { is_active: true },
        select: {
          id: true,
          name: true,
          type: true,
          types: true,
          accentColor: true,
          level: true,
          estimated_duration_min: true,
          estimated_calories: true,
          _count: { select: { exercises: true } },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.diet.findMany({
        where: { is_active: true },
        select: {
          id: true,
          name: true,
          tags: true,
          total_calories: true,
          total_protein_g: true,
          total_carbs_g: true,
          total_fat_g: true,
          _count: { select: { meals: true } },
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
    ]);

    return {
      trainings: trainings.map(({ _count, ...training }) => ({
        ...this.serializeAssignmentTraining(training),
        exercises_count: _count.exercises,
      })),
      diets: diets.map(({ _count, ...diet }) => ({
        ...diet,
        meals_count: _count.meals,
      })),
    };
  }

  private normalizeCatalogValue(value: string) {
    return value.trim().replace(/\s+/g, ' ');
  }

  private getCatalogKey(value: string) {
    return this.normalizeCatalogValue(value)
      .toLocaleLowerCase('es-ES')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .normalize('NFC');
  }

  private serializeAssignmentTraining(
    training: AssignmentTrainingSummary | null,
  ) {
    if (!training) {
      return null;
    }

    const uniqueTypes = new Map<string, string>();

    for (const value of [...(training.types ?? []), training.type]) {
      const normalizedValue = this.normalizeCatalogValue(value);

      if (!normalizedValue) {
        continue;
      }

      const key = this.getCatalogKey(normalizedValue);

      if (!uniqueTypes.has(key)) {
        uniqueTypes.set(key, normalizedValue);
      }
    }

    const types = Array.from(uniqueTypes.values());

    return {
      ...training,
      type: types[0] ?? this.normalizeCatalogValue(training.type),
      types,
      accentColor: training.accentColor ?? null,
    };
  }

  private inferPlanKind(
    days: Array<{
      training_id?: string | null;
      diet_id?: string | null;
      is_rest_day?: boolean;
    }>,
  ): PlanNotifKind {
    const active = days.filter((d) => !d.is_rest_day);
    if (active.length === 0) return 'rest';
    const hasTraining = active.some((d) => !!d.training_id);
    const hasDiet = active.some((d) => !!d.diet_id);
    if (hasTraining && hasDiet) return 'plan';
    if (hasTraining) return 'training';
    if (hasDiet) return 'diet';
    return 'plan';
  }

  private routeForKind(kind: PlanNotifKind, firstDate?: Date): string {
    const base =
      kind === 'training'
        ? '/trainings'
        : kind === 'diet'
          ? '/diets'
          : '/calendar';
    if (!firstDate) return base;
    return `${base}?date=${this.formatDate(firstDate)}`;
  }

  private async notifyPlanAssigned(params: {
    actorId: string;
    clientId: string;
    kind: PlanNotifKind;
    dayCount: number;
    firstDate?: Date;
  }) {
    const { actorId, clientId, kind, dayCount, firstDate } = params;
    try {
      const planSummary =
        kind === 'training'
          ? dayCount === 1
            ? 'un entrenamiento'
            : `${dayCount} días de entrenamiento`
          : kind === 'diet'
            ? dayCount === 1
              ? 'una dieta'
              : `${dayCount} días de dieta`
            : `${dayCount} días`;
      const templateKey =
        kind === 'training'
          ? 'plan_training_assigned'
          : kind === 'diet'
            ? 'plan_diet_assigned'
            : 'plan_updated';
      const title =
        kind === 'training'
          ? 'Nuevo entrenamiento asignado'
          : kind === 'diet'
            ? 'Nueva dieta asignada'
            : 'Tu plan se ha actualizado';
      const body =
        kind === 'plan'
          ? `Tu entrenador actualizó tu plan (${dayCount} días)`
          : `Tu entrenador asignó ${planSummary}`;

      const dateVar = firstDate ? this.formatDate(firstDate) : '';
      await this.notifications.sendInternalTemplate(
        actorId,
        [clientId],
        templateKey,
        { dayCount, planSummary, date: dateVar },
        { title, body, route: this.routeForKind(kind, firstDate) },
        {
          type:
            kind === 'training'
              ? 'training'
              : kind === 'diet'
                ? 'diet'
                : 'calendar',
        },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send plan notification to ${clientId}: ${(err as Error).message}`,
      );
    }
  }

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
      training: this.serializeAssignmentTraining(assignment.training),
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

  private isoWeekday(date: Date) {
    const weekday = date.getUTCDay();
    return weekday === 0 ? 7 : weekday;
  }

  private serializeAutoRule(rule: AutoAssignmentRuleRecord | null) {
    if (!rule) {
      return null;
    }

    return {
      id: rule.id,
      client_id: rule.client_id,
      admin_id: rule.admin_id,
      source_week_start: this.formatDate(rule.source_week_start),
      starts_on: this.formatDate(rule.starts_on),
      ends_on: rule.ends_on ? this.formatDate(rule.ends_on) : null,
      is_active: rule.is_active,
      deactivated_at: rule.deactivated_at?.toISOString() ?? null,
      days: rule.days.map((day) => ({
        id: day.id,
        weekday: day.weekday,
        training_id: day.training_id,
        diet_id: day.diet_id,
        is_rest_day: day.is_rest_day,
        training: this.serializeAssignmentTraining(day.training),
        diet: day.diet,
      })),
    };
  }

  private async materializeAutoAssignmentsForRange(
    clientId: string,
    range: AssignmentRange,
  ) {
    const activeRules = await this.prisma.autoAssignmentRule.findMany({
      where: {
        client_id: clientId,
        is_active: true,
        starts_on: { lte: range.end },
        OR: [{ ends_on: null }, { ends_on: { gte: range.start } }],
      },
      include: { days: true },
      orderBy: { created_at: 'asc' },
    });

    if (activeRules.length === 0) {
      return;
    }

    const existingAssignments = await this.prisma.planAssignment.findMany({
      where: {
        client_id: clientId,
        date: {
          gte: range.start,
          lte: range.end,
        },
      },
      select: { date: true },
    });
    const occupiedDates = new Set(
      existingAssignments.map((assignment) => this.formatDate(assignment.date)),
    );
    const assignmentsToCreate: Array<{
      client_id: string;
      admin_id: string | null;
      date: Date;
      training_id: string | null;
      diet_id: string | null;
      is_rest_day: boolean;
      auto_assignment_rule_id: string;
    }> = [];

    for (const rule of activeRules) {
      const ruleDays = new Map(rule.days.map((day) => [day.weekday, day]));

      for (const date of range.dates) {
        const dateKey = this.formatDate(date);

        if (occupiedDates.has(dateKey)) {
          continue;
        }

        if (date < rule.starts_on || (rule.ends_on && date > rule.ends_on)) {
          continue;
        }

        const day = ruleDays.get(this.isoWeekday(date));

        if (!day) {
          continue;
        }

        assignmentsToCreate.push({
          client_id: clientId,
          admin_id: rule.admin_id,
          date,
          training_id: day.is_rest_day ? null : day.training_id,
          diet_id: day.is_rest_day ? null : day.diet_id,
          is_rest_day: day.is_rest_day,
          auto_assignment_rule_id: rule.id,
        });
        occupiedDates.add(dateKey);
      }
    }

    if (assignmentsToCreate.length > 0) {
      await this.prisma.planAssignment.createMany({
        data: assignmentsToCreate,
        skipDuplicates: true,
      });
    }
  }

  async createAutoRule(
    user: AuthenticatedUser,
    dto: CreateAutoAssignmentRuleDto,
  ) {
    await this.assertClientAccess(user, dto.client_id);

    const sourceWeek = this.buildWeekRange(dto.source_week_start);
    const startsOn = this.parseDate(dto.starts_on);
    const endsOn = dto.ends_on ? this.parseDate(dto.ends_on) : null;

    if (endsOn && endsOn < startsOn) {
      throw new BadRequestException(
        'La fecha fin debe ser posterior o igual a la fecha de inicio',
      );
    }

    const uniqueWeekdays = new Set<number>();
    const normalizedDays = dto.days
      .map((day) => ({
        weekday: day.weekday,
        ...this.normalizeAssignmentInput(day),
      }))
      .sort((left, right) => left.weekday - right.weekday);

    for (const day of normalizedDays) {
      if (uniqueWeekdays.has(day.weekday)) {
        throw new BadRequestException(
          'No puedes configurar dos autoasignaciones para el mismo día de la semana',
        );
      }

      uniqueWeekdays.add(day.weekday);
    }

    await Promise.all(
      normalizedDays.map((day) =>
        this.validatePlanReferences(day.training_id, day.diet_id),
      ),
    );

    const [, rule] = await this.prisma.$transaction([
      this.prisma.autoAssignmentRule.updateMany({
        where: {
          client_id: dto.client_id,
          is_active: true,
        },
        data: {
          is_active: false,
          deactivated_at: new Date(),
        },
      }),
      this.prisma.autoAssignmentRule.create({
        data: {
          client_id: dto.client_id,
          admin_id: user.id,
          source_week_start: sourceWeek.start,
          starts_on: startsOn,
          ends_on: endsOn,
          days: {
            create: normalizedDays.map((day) => ({
              weekday: day.weekday,
              training_id: day.training_id,
              diet_id: day.diet_id,
              is_rest_day: day.is_rest_day,
            })),
          },
        },
        include: autoAssignmentRuleInclude,
      }),
    ]);

    return this.serializeAutoRule(rule);
  }

  async getActiveAutoRule(
    user: AuthenticatedUser,
    query: GetActiveAutoAssignmentRuleQueryDto,
  ) {
    await this.assertClientAccess(user, query.client_id);

    const rule = await this.prisma.autoAssignmentRule.findFirst({
      where: {
        client_id: query.client_id,
        is_active: true,
      },
      include: autoAssignmentRuleInclude,
      orderBy: { created_at: 'desc' },
    });

    return this.serializeAutoRule(rule);
  }

  async deactivateAutoRule(user: AuthenticatedUser, ruleId: string) {
    const rule = await this.prisma.autoAssignmentRule.findUnique({
      where: { id: ruleId },
      select: {
        id: true,
        client_id: true,
        is_active: true,
      },
    });

    if (!rule) {
      throw new NotFoundException('Autoasignación no encontrada');
    }

    await this.assertClientAccess(user, rule.client_id);

    const updatedRule = await this.prisma.autoAssignmentRule.update({
      where: { id: ruleId },
      data: {
        is_active: false,
        deactivated_at: new Date(),
      },
      include: autoAssignmentRuleInclude,
    });

    return this.serializeAutoRule(updatedRule);
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

    if (uniqueDates.length > 0) {
      const kind = this.inferPlanKind([normalizedInput]);
      if (kind !== 'rest') {
        const sortedDates = [...uniqueDates].sort();
        await this.notifyPlanAssigned({
          actorId: user.id,
          clientId: dto.client_id,
          kind,
          dayCount: uniqueDates.length,
          firstDate: this.parseDate(sortedDates[0]),
        });
      }
    }

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

    if (uniqueDays.length > 0) {
      const kind = this.inferPlanKind(uniqueDays);
      if (kind !== 'rest') {
        const firstActive = uniqueDays.find((day) => !day.is_rest_day);
        await this.notifyPlanAssigned({
          actorId: user.id,
          clientId: dto.client_id,
          kind,
          dayCount: uniqueDays.length,
          firstDate: (firstActive ?? uniqueDays[0]).date,
        });
      }
    }

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

    const copiedDays = sourceWeek.dates
      .map((sourceDate) => {
        const sourceDateKey = sourceDate.toISOString().split('T')[0];
        const source = sourceMap.get(sourceDateKey);
        if (!source) return null;
        const offsetDays = Math.round(
          (sourceDate.getTime() - sourceWeek.start.getTime()) /
            (1000 * 60 * 60 * 24),
        );
        return {
          date: this.addDays(targetWeek.start, offsetDays),
          training_id: source.training_id,
          diet_id: source.diet_id,
          is_rest_day: source.is_rest_day,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    if (copiedDays.length > 0) {
      const kind = this.inferPlanKind(copiedDays);
      if (kind !== 'rest') {
        const firstActive = copiedDays.find((day) => !day.is_rest_day);
        await this.notifyPlanAssigned({
          actorId: user.id,
          clientId: dto.client_id,
          kind,
          dayCount: copiedDays.length,
          firstDate: (firstActive ?? copiedDays[0]).date,
        });
      }
    }

    return this.getWeek(user, {
      client_id: dto.client_id,
      week_start: this.formatDate(targetWeek.start),
    });
  }

  async getWeek(user: AuthenticatedUser, query: GetWeekAssignmentsQueryDto) {
    await this.assertClientAccess(user, query.client_id);

    const weekRange = this.buildWeekRange(query.week_start);
    await this.materializeAutoAssignmentsForRange(query.client_id, weekRange);
    const assignments = await this.getAssignmentsForRange(query.client_id, weekRange);

    return this.serializeWeekAssignments(query.client_id, weekRange, assignments);
  }

  async getMonth(user: AuthenticatedUser, query: GetMonthAssignmentsQueryDto) {
    await this.assertClientAccess(user, query.client_id);

    const monthRange = this.buildMonthRange(query.year, query.month);
    await this.materializeAutoAssignmentsForRange(query.client_id, monthRange);
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

    const kind = this.inferPlanKind([normalizedInput]);
    if (kind !== 'rest') {
      await this.notifyPlanAssigned({
        actorId: user.id,
        clientId: assignment.client_id,
        kind,
        dayCount: 1,
        firstDate: nextDate,
      });
    }

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

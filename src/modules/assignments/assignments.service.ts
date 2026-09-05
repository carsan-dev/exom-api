import {
  BadRequestException,
  ConflictException,
  Injectable,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LastSetVideoPolicy, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateAutoAssignmentRuleDto,
  GetActiveAutoAssignmentRuleQueryDto,
} from './dto/auto-assignment-rule.dto';
import { BatchAssignDaysDto } from './dto/batch-assign-days.dto';
import { BulkAssignmentDto, CopySelectionDto, CopyWeekDto } from './dto/bulk-assign.dto';
import { GetMonthAssignmentsQueryDto } from './dto/get-month-assignments-query.dto';
import { GetWeekAssignmentsQueryDto } from './dto/get-week-assignments-query.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { NotificationsService } from '../notifications/notifications.service';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';
import { formatDateOnly, parseDateOnly } from '../../common/date-only';
import {
  LastSetVideoPolicyService,
  type AssignmentTransaction,
} from './last-set-video-policy.service';
import {
  ASSIGNMENT_TRANSACTION_OPTIONS,
  lockAssignmentPlanning,
} from './assignment-planning-lock';
import { lockClientDayProgress } from '../../common/progress/day-progress-lock';

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
      is_active: true,
    },
  },
  trainings: {
    orderBy: { position: 'asc' as const },
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
          is_active: true,
        },
      },
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
          is_active: true,
        },
      },
      trainings: {
        orderBy: { position: 'asc' as const },
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
              is_active: true,
            },
          },
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
  is_active: boolean;
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
  trainings?: Array<{
    position: number;
    last_set_video_policy: LastSetVideoPolicy;
    requires_last_set_video: boolean;
    training: AssignmentTrainingSummary;
  }>;
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
  trainings?: Array<{
    position: number;
    last_set_video_policy: LastSetVideoPolicy;
    requires_last_set_video: boolean;
    training: AssignmentTrainingSummary;
  }>;
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
    private readonly autoAssignmentMaterializer: AutoAssignmentMaterializerService,
    private readonly lastSetVideoPolicy: LastSetVideoPolicyService,
  ) {}

  private planningTransaction<T>(
    operation: (tx: AssignmentTransaction) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(operation, ASSIGNMENT_TRANSACTION_OPTIONS);
  }

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
          is_active: true,
          _count: { select: { exercises: true } },
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
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
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
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
      training_ids?: string[];
      diet_id?: string | null;
      is_rest_day?: boolean;
    }>,
  ): PlanNotifKind {
    const active = days.filter((d) => !d.is_rest_day);
    if (active.length === 0) return 'rest';
    const hasTraining = active.some((d) => Boolean(d.training_ids?.length || d.training_id));
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
    return parseDateOnly(dateStr);
  }

  private formatDate(date: Date): string {
    return formatDateOnly(date);
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
    training_ids?: string[];
    trainings?: Array<{
      training_id: string;
      last_set_video_policy?: LastSetVideoPolicy;
      requires_last_set_video?: boolean;
    }>;
    diet_id?: string | null;
    is_rest_day?: boolean;
  }) {
    const is_rest_day = input.is_rest_day ?? false;
    const requestedTrainings = input.trainings !== undefined
      ? input.trainings.map((item) => ({
          training_id: item.training_id,
          last_set_video_policy:
            item.last_set_video_policy ??
            (item.requires_last_set_video === true
              ? LastSetVideoPolicy.ALWAYS
              : item.requires_last_set_video === false
                ? LastSetVideoPolicy.NEVER
                : LastSetVideoPolicy.AUTO),
        }))
      : null;
    const requestedIds = requestedTrainings
      ? requestedTrainings.map((item) => item.training_id)
      : input.training_ids !== undefined
      ? input.training_ids
      : input.training_id
        ? [input.training_id]
        : [];
    const training_ids = is_rest_day ? [] : requestedIds;
    if (training_ids.length > 5) {
      throw new BadRequestException('No puedes asignar más de 5 entrenamientos por día');
    }
    if (new Set(training_ids).size !== training_ids.length) {
      throw new BadRequestException('No puedes repetir un entrenamiento en el mismo día');
    }
    const training_id = training_ids[0] ?? null;
    const diet_id = is_rest_day ? null : (input.diet_id ?? null);

    if (!is_rest_day && training_ids.length === 0 && !diet_id) {
      throw new BadRequestException(
        'Debes asignar un entrenamiento, una dieta o marcar descanso',
      );
    }

    return {
      training_id,
      training_ids,
      trainings: training_ids.map((id) => requestedTrainings?.find((item) => item.training_id === id) ?? ({
        training_id: id,
        last_set_video_policy: LastSetVideoPolicy.AUTO,
      })),
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
    trainingIds: string[],
    dietId: string | null,
    db: AssignmentTransaction = this.prisma,
  ) {
    const [trainings, diet] = await Promise.all([
      Promise.all(trainingIds.map((trainingId) =>
        db.training.findFirst({
          where: { id: trainingId, is_active: true },
          select: { id: true },
        }),
      )),
      dietId
        ? db.diet.findFirst({
            where: { id: dietId, is_active: true },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    if (trainings.some((training) => !training)) {
      throw new NotFoundException('Entrenamiento no encontrado');
    }

    if (dietId && !diet) {
      throw new NotFoundException('Dieta no encontrada');
    }
  }

  private async reconcileProgressForDate(clientId: string, date: Date) {
    if (
      !(this.prisma as unknown as { dayProgress?: { findUnique?: unknown } })
        .dayProgress?.findUnique
    ) {
      return;
    }
    return this.prisma.$transaction(async (tx) => {
      await lockClientDayProgress(tx, clientId);
      const assignment = await tx.planAssignment.findUnique({
        where: { client_id_date: { client_id: clientId, date } },
        include: {
          trainings: {
            orderBy: { position: 'asc' },
            include: {
              training: {
                select: {
                  id: true,
                  exercises: { select: { id: true, exercise_id: true } },
                },
              },
            },
          },
          training: {
            select: {
              id: true,
              exercises: { select: { id: true, exercise_id: true } },
            },
          },
        },
      });
      const progress = await tx.dayProgress.findUnique({
        where: { client_id_date: { client_id: clientId, date } },
      });
      if (!progress) return;

      // Assignments may change after a client has trained. Completed progress is
      // historical evidence: never rewrite it to match the latest assignment.
      if (progress.training_completed) return;

      const trainings = assignment?.trainings.length
        ? assignment.trainings.map((link) => link.training)
        : assignment?.training
          ? [assignment.training]
          : [];
      const validTrainingExerciseIds = new Set(
        trainings.flatMap((training) =>
          training.exercises.map((exercise) => exercise.id),
        ),
      );
      const validExerciseIds = new Set(
        trainings.flatMap((training) =>
          training.exercises.map((exercise) => exercise.exercise_id),
        ),
      );
      const entries = Array.isArray(progress.exercises_completed)
        ? (progress.exercises_completed as Array<{
            training_exercise_id?: string;
            exercise_id?: string;
          }>)
        : [];
      const matchingEntries = entries.filter((entry) =>
        entry.training_exercise_id
          ? validTrainingExerciseIds.has(entry.training_exercise_id)
          : Boolean(
              entry.exercise_id && validExerciseIds.has(entry.exercise_id),
            ),
      );
      const completedTrainingExerciseIds = new Set(
        matchingEntries
          .map((entry) => entry.training_exercise_id)
          .filter((id): id is string => Boolean(id)),
      );
      const completedExerciseIds = new Set(
        matchingEntries
          .map((entry) => entry.exercise_id)
          .filter((id): id is string => Boolean(id)),
      );
      const newlyCompletedTrainingIds = trainings
        .filter(
          (training) =>
            training.exercises.length > 0 &&
            training.exercises.every(
              (exercise) =>
                completedTrainingExerciseIds.has(exercise.id) ||
                completedExerciseIds.has(exercise.exercise_id),
            ),
        )
        .map((training) => training.id);
      const trainingsCompleted = [
        ...new Set([
          ...progress.trainings_completed,
          ...newlyCompletedTrainingIds,
        ]),
      ];

      await tx.dayProgress.update({
        where: { id: progress.id },
        data: {
          trainings_completed: trainingsCompleted,
          training_completed:
            trainings.length > 0 &&
            trainings.every((training) =>
              trainingsCompleted.includes(training.id),
            ),
        },
      });
    }, ASSIGNMENT_TRANSACTION_OPTIONS);
  }

  private serializeAssignment(assignment: AssignmentRecord) {
    const trainings = this.resolveAssignmentTrainingLinks(assignment)
      .map((link) => ({
          ...this.serializeAssignmentTraining(link.training)!,
          last_set_video_policy: link.last_set_video_policy,
          requires_last_set_video: link.requires_last_set_video,
        }));
    return {
      id: assignment.id,
      client_id: assignment.client_id,
      date: this.formatDate(assignment.date),
      is_rest_day: assignment.is_rest_day,
      training_ids: trainings.map((training) => training.id),
      trainings,
      training: trainings[0] ?? null,
      diet: assignment.diet,
    };
  }

  private resolveAssignmentTrainingLinks(
    assignment: AssignmentRecord,
  ): NonNullable<AssignmentRecord['trainings']> {
    if (assignment.trainings?.length) {
      return assignment.trainings;
    }
    return assignment.training
      ? [{
          position: 0,
          last_set_video_policy: LastSetVideoPolicy.AUTO,
          requires_last_set_video: false,
          training: assignment.training,
        }]
      : [];
  }

  private clearAssignmentDate(
    db: AssignmentTransaction,
    clientId: string,
    adminId: string,
    date: Date,
  ) {
    return db.planAssignment.upsert({
      where: { client_id_date: { client_id: clientId, date } },
      create: {
        client_id: clientId,
        admin_id: adminId,
        auto_assignment_rule_id: null,
        date,
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
      },
      update: {
        admin_id: adminId,
        auto_assignment_rule_id: null,
        training_id: null,
        diet_id: null,
        is_rest_day: false,
        notes: null,
        trainings: { deleteMany: {} },
      },
    });
  }

  private isClearedAssignment(assignment: AssignmentRecord): boolean {
    return (
      !assignment.is_rest_day &&
      !assignment.diet_id &&
      this.resolveAssignmentTrainingLinks(assignment).length === 0
    );
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

      if (!assignment || this.isClearedAssignment(assignment)) {
        return {
          id: null,
          client_id: clientId,
          date: dateKey,
          is_rest_day: false,
          training: null,
          trainings: [],
          training_ids: [],
          default_last_set_video_policy: LastSetVideoPolicy.AUTO,
          diet: null,
        };
      }

      return {
        ...this.serializeAssignment(assignment),
        default_last_set_video_policy: LastSetVideoPolicy.AUTO,
      };
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
      days: rule.days.map((day) => {
        const trainings = (day.trainings ?? []).length
          ? day.trainings!.map((link) => ({
              ...this.serializeAssignmentTraining(link.training)!,
              last_set_video_policy: link.last_set_video_policy,
              requires_last_set_video: link.requires_last_set_video,
            }))
          : day.training ? [this.serializeAssignmentTraining(day.training)!] : [];
        return {
          training_ids: trainings.map((training) => training.id),
          id: day.id,
          weekday: day.weekday,
          training_id: trainings[0]?.id ?? null,
          diet_id: day.diet_id,
          is_rest_day: day.is_rest_day,
          trainings,
          training: trainings[0] ?? null,
          diet: day.diet,
        };
      }),
    };
  }

  private async reconcileAutoAssignmentsForRange(
    clientId: string,
    range: AssignmentRange,
  ) {
    // Auto rules are indefinite, so planning reads reconcile only their requested window.
    return this.autoAssignmentMaterializer.reconcile(clientId, range);
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
        this.validatePlanReferences(day.training_ids, day.diet_id),
      ),
    );

    const rule = await this.planningTransaction(async (tx) => {
      await lockAssignmentPlanning(tx, dto.client_id);
      await tx.autoAssignmentRule.updateMany({
        where: {
          client_id: dto.client_id,
          is_active: true,
        },
        data: {
          is_active: false,
          deactivated_at: new Date(),
        },
      });
      const createdRule = await tx.autoAssignmentRule.create({
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
              trainings: {
                create: day.trainings.map((training, position) => ({
                  training_id: training.training_id,
                  position,
                  last_set_video_policy: training.last_set_video_policy,
                  requires_last_set_video:
                    training.last_set_video_policy === LastSetVideoPolicy.ALWAYS,
                })),
              },
            })),
          },
        },
        include: autoAssignmentRuleInclude,
      });
      await this.autoAssignmentMaterializer.reconcileMaterialized(
        dto.client_id,
        tx,
      );
      return createdRule;
    });

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

  async updateAutoRule(
    user: AuthenticatedUser,
    ruleId: string,
    dto: CreateAutoAssignmentRuleDto,
  ) {
    const existing = await this.prisma.autoAssignmentRule.findUnique({
      where: { id: ruleId },
      select: { id: true, client_id: true, is_active: true },
    });
    if (!existing || !existing.is_active) {
      throw new NotFoundException('Autoasignación activa no encontrada');
    }
    if (existing.client_id !== dto.client_id) {
      throw new BadRequestException('La regla no pertenece al cliente indicado');
    }
    await this.assertClientAccess(user, existing.client_id);

    const sourceWeek = this.buildWeekRange(dto.source_week_start);
    const startsOn = this.parseDate(dto.starts_on);
    const endsOn = dto.ends_on ? this.parseDate(dto.ends_on) : null;
    if (endsOn && endsOn < startsOn) {
      throw new BadRequestException('La fecha fin debe ser posterior o igual a la fecha de inicio');
    }
    const weekdays = new Set<number>();
    const days = dto.days.map((day) => ({
      weekday: day.weekday,
      ...this.normalizeAssignmentInput(day),
    }));
    for (const day of days) {
      if (weekdays.has(day.weekday)) {
        throw new BadRequestException('No puedes configurar dos autoasignaciones para el mismo día de la semana');
      }
      weekdays.add(day.weekday);
    }
    await Promise.all(days.map((day) => this.validatePlanReferences(day.training_ids, day.diet_id)));

    const rule = await this.planningTransaction(async (tx) => {
      await lockAssignmentPlanning(tx, existing.client_id);
      const lockedRule = await tx.autoAssignmentRule.findUnique({
        where: { id: ruleId },
        select: { client_id: true, is_active: true },
      });
      if (!lockedRule?.is_active) {
        throw new NotFoundException('Autoasignación activa no encontrada');
      }
      if (lockedRule.client_id !== existing.client_id) {
        throw new BadRequestException('La regla no pertenece al cliente indicado');
      }
      const updatedRule = await tx.autoAssignmentRule.update({
        where: { id: ruleId },
        data: {
          admin_id: user.id,
          source_week_start: sourceWeek.start,
          starts_on: startsOn,
          ends_on: endsOn,
          days: {
            deleteMany: {},
            create: days.map((day) => ({
              weekday: day.weekday,
              training_id: day.training_id,
              diet_id: day.diet_id,
              is_rest_day: day.is_rest_day,
              trainings: {
                create: day.trainings.map((training, position) => ({
                  training_id: training.training_id,
                  position,
                  last_set_video_policy: training.last_set_video_policy,
                  requires_last_set_video:
                    training.last_set_video_policy === LastSetVideoPolicy.ALWAYS,
                })),
              },
            })),
          },
        },
        include: autoAssignmentRuleInclude,
      });
      await this.autoAssignmentMaterializer.reconcileMaterialized(
        existing.client_id,
        tx,
      );
      return updatedRule;
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

    const updatedRule = await this.planningTransaction(async (tx) => {
      await lockAssignmentPlanning(tx, rule.client_id);
      const deactivatedRule = await tx.autoAssignmentRule.update({
        where: { id: ruleId },
        data: {
          is_active: false,
          deactivated_at: new Date(),
        },
        include: autoAssignmentRuleInclude,
      });
      await this.autoAssignmentMaterializer.reconcileMaterialized(
        rule.client_id,
        tx,
      );
      return deactivatedRule;
    });

    return this.serializeAutoRule(updatedRule);
  }

  async bulkAssign(user: AuthenticatedUser, dto: BulkAssignmentDto) {
    await this.assertClientAccess(user, dto.client_id);

    const normalizedInput = this.normalizeAssignmentInput(dto);
    await this.validatePlanReferences(
      normalizedInput.training_ids,
      normalizedInput.diet_id,
    );

    const uniqueDates = Array.from(
      new Set(dto.dates.map((dateStr) => this.formatDate(this.parseDate(dateStr)))),
    );
    const parsedDates = uniqueDates.map((date) => this.parseDate(date));
    const affectedMonths = this.lastSetVideoPolicy.monthsForDates(parsedDates);

    const results = await this.planningTransaction(async (tx) => {
      await lockAssignmentPlanning(tx, dto.client_id);
      for (const date of parsedDates) {
        await tx.planAssignment.upsert({
          where: {
            client_id_date: {
              client_id: dto.client_id,
              date,
            },
          },
          create: {
            client_id: dto.client_id,
            admin_id: user.id,
            auto_assignment_rule_id: null,
            date,
            training_id: normalizedInput.training_id,
            diet_id: normalizedInput.diet_id,
            is_rest_day: normalizedInput.is_rest_day,
            trainings: {
              create: normalizedInput.trainings.map((item, position) => ({
                training_id: item.training_id,
                position,
                last_set_video_policy: item.last_set_video_policy,
                requires_last_set_video:
                  item.last_set_video_policy === LastSetVideoPolicy.ALWAYS,
              })),
            },
          },
          update: {
            admin_id: user.id,
            auto_assignment_rule_id: null,
            training_id: normalizedInput.training_id,
            diet_id: normalizedInput.diet_id,
            is_rest_day: normalizedInput.is_rest_day,
            trainings: {
              deleteMany: {},
              create: normalizedInput.trainings.map((item, position) => ({
                training_id: item.training_id,
                position,
                last_set_video_policy: item.last_set_video_policy,
                requires_last_set_video:
                  item.last_set_video_policy === LastSetVideoPolicy.ALWAYS,
              })),
            },
          },
        });
      }
      await this.lastSetVideoPolicy.reconcile(dto.client_id, affectedMonths, tx);
      return tx.planAssignment.findMany({
        where: { client_id: dto.client_id, date: { in: parsedDates } },
        include: assignmentInclude,
        orderBy: { date: 'asc' },
      });
    });

    await Promise.all(uniqueDates.map((dateStr) =>
      this.reconcileProgressForDate(dto.client_id, this.parseDate(dateStr)),
    ));

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
            training_ids: string[];
            trainings: Array<{
              training_id: string;
              last_set_video_policy: LastSetVideoPolicy;
            }>;
            diet_id: string | null;
            is_rest_day: boolean;
          }
        >(),
      ).values(),
    ).sort((left, right) => left.date.getTime() - right.date.getTime());

    await Promise.all(
      uniqueDays.map((day) =>
        this.validatePlanReferences(day.training_ids, day.diet_id),
      ),
    );
    const affectedMonths = this.lastSetVideoPolicy.monthsForDates(
      uniqueDays.map((day) => day.date),
    );

    const results = await this.planningTransaction(async (tx) => {
      await lockAssignmentPlanning(tx, dto.client_id);
      for (const day of uniqueDays) {
        await tx.planAssignment.upsert({
          where: {
            client_id_date: {
              client_id: dto.client_id,
              date: day.date,
            },
          },
          create: {
            client_id: dto.client_id,
            admin_id: user.id,
            auto_assignment_rule_id: null,
            date: day.date,
            training_id: day.training_id,
            diet_id: day.diet_id,
            is_rest_day: day.is_rest_day,
            trainings: {
              create: day.trainings.map((item, position) => ({
                training_id: item.training_id,
                position,
                last_set_video_policy: item.last_set_video_policy,
                requires_last_set_video:
                  item.last_set_video_policy === LastSetVideoPolicy.ALWAYS,
              })),
            },
          },
          update: {
            admin_id: user.id,
            auto_assignment_rule_id: null,
            training_id: day.training_id,
            diet_id: day.diet_id,
            is_rest_day: day.is_rest_day,
            trainings: {
              deleteMany: {},
              create: day.trainings.map((item, position) => ({
                training_id: item.training_id,
                position,
                last_set_video_policy: item.last_set_video_policy,
                requires_last_set_video:
                  item.last_set_video_policy === LastSetVideoPolicy.ALWAYS,
              })),
            },
          },
        });
      }
      await this.lastSetVideoPolicy.reconcile(dto.client_id, affectedMonths, tx);
      return tx.planAssignment.findMany({
        where: { client_id: dto.client_id, date: { in: uniqueDays.map((day) => day.date) } },
        include: assignmentInclude,
        orderBy: { date: 'asc' },
      });
    });

    await Promise.all(uniqueDays.map((day) =>
      this.reconcileProgressForDate(dto.client_id, day.date),
    ));

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

    const affectedMonths = this.lastSetVideoPolicy.monthsForDates(targetWeek.dates);

    const copiedDays = await this.planningTransaction(async (tx) => {
      await lockAssignmentPlanning(tx, dto.client_id);
      const sourceAssignments = await tx.planAssignment.findMany({
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
        sourceAssignments.map((assignment) => [
          this.formatDate(assignment.date),
          assignment,
        ]),
      );

      for (const [index, sourceDate] of sourceWeek.dates.entries()) {
        const sourceDateKey = this.formatDate(sourceDate);
        const source = sourceMap.get(sourceDateKey);
        const targetDate = targetWeek.dates[index];

        if (!source || this.isClearedAssignment(source)) {
          await this.clearAssignmentDate(
            tx,
            dto.client_id,
            user.id,
            targetDate,
          );
          continue;
        }
        const sourceTrainings = this.resolveAssignmentTrainingLinks(source);
        const sourceTrainingId = sourceTrainings[0]?.training.id ?? null;

        await tx.planAssignment.upsert({
          where: {
            client_id_date: {
              client_id: dto.client_id,
              date: targetDate,
            },
          },
          create: {
            client_id: dto.client_id,
            admin_id: user.id,
            auto_assignment_rule_id: null,
            date: targetDate,
            training_id: sourceTrainingId,
            diet_id: source.diet_id,
            is_rest_day: source.is_rest_day,
            trainings: {
              create: sourceTrainings.map((link) => ({
                training_id: link.training.id,
                position: link.position,
                last_set_video_policy: 'last_set_video_policy' in link
                  ? link.last_set_video_policy
                  : LastSetVideoPolicy.AUTO,
                requires_last_set_video: 'last_set_video_policy' in link
                  ? link.last_set_video_policy === LastSetVideoPolicy.ALWAYS
                  : false,
              })),
            },
          },
          update: {
            admin_id: user.id,
            auto_assignment_rule_id: null,
            training_id: sourceTrainingId,
            diet_id: source.diet_id,
            is_rest_day: source.is_rest_day,
            trainings: {
              deleteMany: {},
              create: sourceTrainings.map((link) => ({
                training_id: link.training.id,
                position: link.position,
                last_set_video_policy: 'last_set_video_policy' in link
                  ? link.last_set_video_policy
                  : LastSetVideoPolicy.AUTO,
                requires_last_set_video: 'last_set_video_policy' in link
                  ? link.last_set_video_policy === LastSetVideoPolicy.ALWAYS
                  : false,
              })),
            },
          },
        });
      }
      await this.lastSetVideoPolicy.reconcile(dto.client_id, affectedMonths, tx);
      return sourceWeek.dates
        .map((sourceDate) => {
          const source = sourceMap.get(this.formatDate(sourceDate));
          if (!source || this.isClearedAssignment(source)) return null;
          const sourceTrainings = this.resolveAssignmentTrainingLinks(source);
          const offsetDays = Math.round(
            (sourceDate.getTime() - sourceWeek.start.getTime()) /
              (1000 * 60 * 60 * 24),
          );
          return {
            date: this.addDays(targetWeek.start, offsetDays),
            training_id: sourceTrainings[0]?.training.id ?? null,
            training_ids: sourceTrainings.map((link) => link.training.id),
            diet_id: source.diet_id,
            is_rest_day: source.is_rest_day,
          };
        })
        .filter((day): day is NonNullable<typeof day> => day !== null);
    });

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

  async copySelection(user: AuthenticatedUser, dto: CopySelectionDto) {
    await this.assertClientAccess(user, dto.client_id);

    const sourceDates = Array.from(new Set(dto.source_dates)).sort();
    const sourceStart = this.parseDate(sourceDates[0]);
    const targetStart = this.parseDate(dto.target_start_date);

    if (this.formatDate(sourceStart) === this.formatDate(targetStart)) {
      throw new BadRequestException('La fecha inicial de origen y destino no puede ser la misma');
    }

    const parsedSourceDates = sourceDates.map((date) => this.parseDate(date));
    const targets = parsedSourceDates.map((sourceDate) => ({
      sourceDate,
      targetDate: this.addDays(
        targetStart,
        Math.round(
          (sourceDate.getTime() - sourceStart.getTime()) /
            (1000 * 60 * 60 * 24),
        ),
      ),
    }));
    const affectedMonths = this.lastSetVideoPolicy.monthsForDates(
      targets.map(({ targetDate }) => targetDate),
    );

    const { copiedDays, copiedCount } = await this.planningTransaction(
      async (tx) => {
        await lockAssignmentPlanning(tx, dto.client_id);
        const sourceAssignments = await tx.planAssignment.findMany({
          where: { client_id: dto.client_id, date: { in: parsedSourceDates } },
          include: assignmentInclude,
        });
        const sourceMap = new Map(
          sourceAssignments.map((assignment) => [
            this.formatDate(assignment.date),
            assignment,
          ]),
        );

        for (const { sourceDate, targetDate } of targets) {
          const source = sourceMap.get(this.formatDate(sourceDate));
          if (!source || this.isClearedAssignment(source)) {
            await this.clearAssignmentDate(
              tx,
              dto.client_id,
              user.id,
              targetDate,
            );
            continue;
          }
          const sourceTrainings = this.resolveAssignmentTrainingLinks(source);
          const sourceTrainingId = sourceTrainings[0]?.training.id ?? null;
          await tx.planAssignment.upsert({
          where: { client_id_date: { client_id: dto.client_id, date: targetDate } },
          create: {
            client_id: dto.client_id,
            admin_id: user.id,
            auto_assignment_rule_id: null,
            date: targetDate,
            training_id: sourceTrainingId,
            diet_id: source.diet_id,
            is_rest_day: source.is_rest_day,
            trainings: {
              create: sourceTrainings.map((link) => ({
                training_id: link.training.id,
                position: link.position,
                last_set_video_policy: 'last_set_video_policy' in link
                  ? link.last_set_video_policy
                  : LastSetVideoPolicy.AUTO,
                requires_last_set_video: 'last_set_video_policy' in link
                  ? link.last_set_video_policy === LastSetVideoPolicy.ALWAYS
                  : false,
              })),
            },
          },
          update: {
            admin_id: user.id,
            auto_assignment_rule_id: null,
            training_id: sourceTrainingId,
            diet_id: source.diet_id,
            is_rest_day: source.is_rest_day,
            trainings: {
              deleteMany: {},
              create: sourceTrainings.map((link) => ({
                training_id: link.training.id,
                position: link.position,
                last_set_video_policy: 'last_set_video_policy' in link
                  ? link.last_set_video_policy
                  : LastSetVideoPolicy.AUTO,
                requires_last_set_video: 'last_set_video_policy' in link
                  ? link.last_set_video_policy === LastSetVideoPolicy.ALWAYS
                  : false,
              })),
            },
          },
          });
        }
        await this.lastSetVideoPolicy.reconcile(
          dto.client_id,
          affectedMonths,
          tx,
        );
        const copiedDays = targets.flatMap(({ sourceDate, targetDate }) => {
          const source = sourceMap.get(this.formatDate(sourceDate));
          if (!source || this.isClearedAssignment(source)) return [];
          const sourceTrainings = this.resolveAssignmentTrainingLinks(source);
          return [
            {
              date: targetDate,
              training_id: sourceTrainings[0]?.training.id ?? null,
              training_ids: sourceTrainings.map((link) => link.training.id),
              diet_id: source.diet_id,
              is_rest_day: source.is_rest_day,
            },
          ];
        });
        return { copiedCount: copiedDays.length, copiedDays };
      },
    );
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

    return {
      copied_count: copiedCount,
      cleared_count: sourceDates.length - copiedCount,
      target_dates: targets.map(({ targetDate }) =>
        this.formatDate(targetDate),
      ),
    };
  }

  async getWeek(user: AuthenticatedUser, query: GetWeekAssignmentsQueryDto) {
    await this.assertClientAccess(user, query.client_id);

    const weekRange = this.buildWeekRange(query.week_start);
    await this.reconcileAutoAssignmentsForRange(query.client_id, weekRange);
    const lookupStart = new Date(Date.UTC(
      weekRange.start.getUTCFullYear(),
      weekRange.start.getUTCMonth(),
      1,
    ));
    const lookupEnd = new Date(Date.UTC(
      weekRange.end.getUTCFullYear(),
      weekRange.end.getUTCMonth() + 1,
      0,
    ));
    const assignments = await this.getAssignmentsForRange(query.client_id, {
      start: lookupStart,
      end: lookupEnd,
      dates: weekRange.dates,
    });

    return this.serializeWeekAssignments(query.client_id, weekRange, assignments);
  }

  async getMonth(user: AuthenticatedUser, query: GetMonthAssignmentsQueryDto) {
    await this.assertClientAccess(user, query.client_id);

    const monthRange = this.buildMonthRange(query.year, query.month);
    await this.reconcileAutoAssignmentsForRange(query.client_id, monthRange);
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

    const { updatedAssignment, nextDate, normalizedInput } =
      await this.planningTransaction(async (tx) => {
      await lockAssignmentPlanning(tx, assignment.client_id);
      const lockedAssignment = await tx.planAssignment.findUnique({
        where: { id: assignmentId },
        include: assignmentInclude,
      });
      if (!lockedAssignment) {
        throw new NotFoundException('Asignación no encontrada');
      }

      const nextDate = dto.date ? this.parseDate(dto.date) : lockedAssignment.date;
      const existingTrainings = this.resolveAssignmentTrainingLinks(lockedAssignment)
        .map((link) => ({
          training_id: link.training.id,
          last_set_video_policy: link.last_set_video_policy,
        }));
      const normalizedInput = this.normalizeAssignmentInput({
        ...(dto.trainings !== undefined
          ? { trainings: dto.trainings }
          : dto.training_ids !== undefined
            ? { training_ids: dto.training_ids }
            : dto.training_id !== undefined
              ? { training_id: dto.training_id }
              : { trainings: existingTrainings }),
        diet_id: dto.diet_id !== undefined ? dto.diet_id : lockedAssignment.diet_id,
        is_rest_day: dto.is_rest_day ?? lockedAssignment.is_rest_day,
      });

      if (this.formatDate(nextDate) !== this.formatDate(lockedAssignment.date)) {
        const existingTarget = await tx.planAssignment.findUnique({
          where: {
            client_id_date: {
              client_id: lockedAssignment.client_id,
              date: nextDate,
            },
          },
          select: { id: true },
        });
        if (existingTarget && existingTarget.id !== assignmentId) {
          throw new ConflictException(
            'Ya existe una asignación para ese cliente en la fecha indicada',
          );
        }
      }
      await this.validatePlanReferences(
        normalizedInput.training_ids,
        normalizedInput.diet_id,
        tx,
      );
      const affectedMonths = this.lastSetVideoPolicy.monthsForDates([
        lockedAssignment.date,
        nextDate,
      ]);
      await tx.planAssignment.update({
        where: { id: assignmentId },
        data: {
          admin_id: user.id,
          auto_assignment_rule_id: null,
          date: nextDate,
          training_id: normalizedInput.training_id,
          diet_id: normalizedInput.diet_id,
          is_rest_day: normalizedInput.is_rest_day,
          trainings: {
            deleteMany: {},
            create: normalizedInput.trainings.map((item, position) => ({
              training_id: item.training_id,
              position,
              last_set_video_policy: item.last_set_video_policy,
              requires_last_set_video:
                item.last_set_video_policy === LastSetVideoPolicy.ALWAYS,
            })),
          },
        },
      });
      await this.lastSetVideoPolicy.reconcile(
        lockedAssignment.client_id,
        affectedMonths,
        tx,
      );
      const updatedAssignment = await tx.planAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
        include: assignmentInclude,
      });
      return { updatedAssignment, nextDate, normalizedInput };
    });

    await this.reconcileProgressForDate(assignment.client_id, nextDate);

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
        date: true,
      },
    });

    if (!assignment) {
      throw new NotFoundException('Asignación no encontrada');
    }

    await this.assertClientAccess(user, assignment.client_id);

    await this.planningTransaction(async (tx) => {
      await lockAssignmentPlanning(tx, assignment.client_id);
      const lockedAssignment = await tx.planAssignment.findUnique({
        where: { id: assignmentId },
        select: { id: true, client_id: true, date: true },
      });
      if (!lockedAssignment) {
        throw new NotFoundException('Asignación no encontrada');
      }
      await this.clearAssignmentDate(
        tx,
        lockedAssignment.client_id,
        user.id,
        lockedAssignment.date,
      );
      await this.lastSetVideoPolicy.reconcile(
        lockedAssignment.client_id,
        this.lastSetVideoPolicy.monthsForDates([lockedAssignment.date]),
        tx,
      );
    });

    return {
      message: 'Asignación eliminada exitosamente',
    };
  }

  async deleteAssignments(user: AuthenticatedUser, assignmentIds: string[]) {
    if (assignmentIds.length > 93) {
      throw new BadRequestException('No puedes eliminar más de 93 fechas por petición');
    }
    const assignments = await this.prisma.planAssignment.findMany({
      where: { id: { in: assignmentIds } },
      select: { id: true, client_id: true, date: true },
    });

    if (assignments.length !== assignmentIds.length) {
      throw new NotFoundException('Una o varias asignaciones no existen');
    }

    const clientIds = [...new Set(assignments.map((assignment) => assignment.client_id))];
    await Promise.all(clientIds.map((clientId) => this.assertClientAccess(user, clientId)));

    const result = await this.planningTransaction(async (tx) => {
      for (const clientId of [...clientIds].sort()) {
        await lockAssignmentPlanning(tx, clientId);
      }
      const lockedAssignments = await tx.planAssignment.findMany({
        where: { id: { in: assignmentIds } },
        select: { id: true, client_id: true, date: true },
      });
      if (lockedAssignments.length !== assignmentIds.length) {
        throw new NotFoundException('Una o varias asignaciones no existen');
      }
      for (const lockedAssignment of lockedAssignments) {
        await this.clearAssignmentDate(
          tx,
          lockedAssignment.client_id,
          user.id,
          lockedAssignment.date,
        );
      }
      for (const clientId of clientIds) {
        const months = this.lastSetVideoPolicy.monthsForDates(
          lockedAssignments
            .filter((assignment) => assignment.client_id === clientId)
            .map((assignment) => assignment.date),
        );
        await this.lastSetVideoPolicy.reconcile(clientId, months, tx);
      }
      return { count: lockedAssignments.length };
    });

    return { deleted_count: result.count };
  }
}

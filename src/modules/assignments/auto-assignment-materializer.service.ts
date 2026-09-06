import { Injectable } from '@nestjs/common';
import { LastSetVideoPolicy } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { formatDateOnly } from '../../common/date-only';
import {
  LastSetVideoPolicyService,
  type AssignmentTransaction,
} from './last-set-video-policy.service';
import {
  ASSIGNMENT_TRANSACTION_OPTIONS,
  lockAssignmentPlanning,
} from './assignment-planning-lock';

export interface AutoAssignmentRange {
  start: Date;
  end: Date;
  dates: Date[];
}

interface DesiredAutoAssignment {
  admin_id: string | null;
  training_id: string | null;
  diet_id: string | null;
  is_rest_day: boolean;
  auto_assignment_rule_id: string;
  trainings: Array<{
    training_id: string;
    last_set_video_policy: LastSetVideoPolicy;
  }>;
}

@Injectable()
export class AutoAssignmentMaterializerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lastSetVideoPolicy: LastSetVideoPolicyService,
  ) {}

  async reconcile(clientId: string, range: AutoAssignmentRange): Promise<void> {
    const today = this.today();
    if (!range.dates.some((date) => date >= today)) return;

    await this.prisma.$transaction(async (tx) => {
      await lockAssignmentPlanning(tx, clientId);
      await this.reconcileRange(tx, clientId, range);
    }, ASSIGNMENT_TRANSACTION_OPTIONS);
  }

  async reconcileMaterialized(
    clientId: string,
    db: AssignmentTransaction,
  ): Promise<void> {
    await lockAssignmentPlanning(db, clientId);
    const today = this.today();
    const assignments = await db.planAssignment.findMany({
      where: {
        client_id: clientId,
        date: { gte: today },
        auto_assignment_rule_id: { not: null },
      },
      select: { date: true },
      orderBy: { date: 'asc' },
    });
    const weekStarts = new Map<string, Date>();

    for (const assignment of assignments) {
      const start = this.weekStart(assignment.date);
      weekStarts.set(formatDateOnly(start), start);
    }

    for (const start of weekStarts.values()) {
      await this.reconcileRange(db, clientId, this.weekRange(start));
    }
  }

  private async reconcileRange(
    db: AssignmentTransaction,
    clientId: string,
    range: AutoAssignmentRange,
  ): Promise<void> {
    const today = this.today();
    const mutableDates = Array.from(
      new Map(
        range.dates
          .filter((date) => date >= today)
          .map((date) => [formatDateOnly(date), date]),
      ).values(),
    ).sort((left, right) => left.getTime() - right.getTime());

    if (mutableDates.length === 0) return;

    const mutableStart = mutableDates[0];
    const mutableEnd = mutableDates[mutableDates.length - 1];
    const [activeRules, existingAssignments, todayProgress] = await Promise.all(
      [
        db.autoAssignmentRule.findMany({
          where: {
            client_id: clientId,
            is_active: true,
            starts_on: { lte: mutableEnd },
            OR: [{ ends_on: null }, { ends_on: { gte: mutableStart } }],
          },
          include: {
            days: {
              include: {
                training: { select: { is_active: true } },
                diet: { select: { is_active: true } },
                trainings: {
                  orderBy: { position: 'asc' },
                  include: { training: { select: { is_active: true } } },
                },
              },
            },
          },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        }),
        db.planAssignment.findMany({
          where: {
            client_id: clientId,
            date: { in: mutableDates },
          },
          select: {
            id: true,
            admin_id: true,
            date: true,
            training_id: true,
            diet_id: true,
            is_rest_day: true,
            auto_assignment_rule_id: true,
            trainings: {
              orderBy: { position: 'asc' },
              select: {
                training_id: true,
                last_set_video_policy: true,
              },
            },
          },
        }),
        mutableDates.some((date) => date.getTime() === today.getTime())
          ? db.dayProgress.findUnique({
              where: { client_id_date: { client_id: clientId, date: today } },
              select: {
                training_completed: true,
                trainings_completed: true,
                exercises_completed: true,
                meals_completed: true,
                notes: true,
              },
            })
          : Promise.resolve(null),
      ],
    );
    const existingByDate = new Map(
      existingAssignments.map((assignment) => [
        formatDateOnly(assignment.date),
        assignment,
      ]),
    );
    const changedDates: Date[] = [];

    for (const date of mutableDates) {
      if (
        date.getTime() === today.getTime() &&
        this.hasRecordedProgress(todayProgress)
      ) {
        continue;
      }

      const existing = existingByDate.get(formatDateOnly(date));
      if (existing && !existing.auto_assignment_rule_id) {
        continue;
      }

      const desired = this.desiredAssignment(activeRules, date);
      if (!desired) {
        if (existing?.auto_assignment_rule_id) {
          await db.planAssignment.delete({ where: { id: existing.id } });
          changedDates.push(date);
        }
        continue;
      }

      if (!existing) {
        await db.planAssignment.create({
          data: {
            client_id: clientId,
            date,
            ...desired,
            trainings: {
              create: desired.trainings.map((training, position) => ({
                training_id: training.training_id,
                position,
                last_set_video_policy: training.last_set_video_policy,
                requires_last_set_video:
                  training.last_set_video_policy === LastSetVideoPolicy.ALWAYS,
              })),
            },
          },
        });
        changedDates.push(date);
        continue;
      }

      const trainingsChanged =
        existing.trainings.length !== desired.trainings.length ||
        existing.trainings.some((training, index) => {
          const expected = desired.trainings[index];
          return (
            !expected ||
            training.training_id !== expected.training_id ||
            training.last_set_video_policy !== expected.last_set_video_policy
          );
        });
      const assignmentChanged =
        existing.admin_id !== desired.admin_id ||
        existing.training_id !== desired.training_id ||
        existing.diet_id !== desired.diet_id ||
        existing.is_rest_day !== desired.is_rest_day ||
        existing.auto_assignment_rule_id !== desired.auto_assignment_rule_id ||
        trainingsChanged;

      if (!assignmentChanged) continue;

      await db.planAssignment.update({
        where: { id: existing.id },
        data: {
          admin_id: desired.admin_id,
          training_id: desired.training_id,
          diet_id: desired.diet_id,
          is_rest_day: desired.is_rest_day,
          auto_assignment_rule_id: desired.auto_assignment_rule_id,
          ...(trainingsChanged && {
            trainings: {
              deleteMany: {},
              create: desired.trainings.map((training, position) => ({
                training_id: training.training_id,
                position,
                last_set_video_policy: training.last_set_video_policy,
                requires_last_set_video:
                  training.last_set_video_policy === LastSetVideoPolicy.ALWAYS,
              })),
            },
          }),
        },
      });
      changedDates.push(date);
    }

    if (changedDates.length > 0) {
      await this.lastSetVideoPolicy.reconcile(
        clientId,
        this.lastSetVideoPolicy.monthsForDates(changedDates),
        db,
      );
    }
  }

  private desiredAssignment<
    TRule extends {
      id: string;
      admin_id: string | null;
      starts_on: Date;
      ends_on: Date | null;
      days: Array<{
        weekday: number;
        training_id: string | null;
        diet_id: string | null;
        is_rest_day: boolean;
        training?: { is_active: boolean } | null;
        diet?: { is_active: boolean } | null;
        trainings?: Array<{
          training_id: string;
          last_set_video_policy: LastSetVideoPolicy;
          training?: { is_active: boolean };
        }>;
      }>;
    },
  >(rules: TRule[], date: Date): DesiredAutoAssignment | null {
    for (const rule of rules) {
      if (date < rule.starts_on || (rule.ends_on && date > rule.ends_on)) {
        continue;
      }
      const day = rule.days.find(
        (candidate) => candidate.weekday === this.isoWeekday(date),
      );
      if (!day) continue;

      const trainings = day.is_rest_day
        ? []
        : (day.trainings?.length ?? 0) > 0
          ? day
              .trainings!.filter(
                (training) => training.training?.is_active !== false,
              )
              .map((training) => ({
                training_id: training.training_id,
                last_set_video_policy: training.last_set_video_policy,
              }))
          : day.training_id && day.training?.is_active !== false
            ? [
                {
                  training_id: day.training_id,
                  last_set_video_policy: LastSetVideoPolicy.AUTO,
                },
              ]
            : [];

      const dietId =
        day.is_rest_day || day.diet?.is_active === false ? null : day.diet_id;
      if (!day.is_rest_day && trainings.length === 0 && !dietId) return null;
      return {
        admin_id: rule.admin_id,
        training_id: trainings[0]?.training_id ?? null,
        diet_id: dietId,
        is_rest_day: day.is_rest_day,
        auto_assignment_rule_id: rule.id,
        trainings,
      };
    }

    return null;
  }

  private today(): Date {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }

  private hasRecordedProgress(
    progress: {
      training_completed: boolean;
      trainings_completed?: string[];
      exercises_completed?: unknown;
      meals_completed?: string[];
      notes?: string | null;
    } | null,
  ): boolean {
    if (!progress) return false;
    return (
      progress.training_completed ||
      (progress.trainings_completed?.length ?? 0) > 0 ||
      (Array.isArray(progress.exercises_completed) &&
        progress.exercises_completed.length > 0) ||
      (progress.meals_completed?.length ?? 0) > 0 ||
      Boolean(progress.notes?.trim())
    );
  }

  private isoWeekday(date: Date): number {
    return date.getUTCDay() || 7;
  }

  private weekStart(date: Date): Date {
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + 1 - this.isoWeekday(result));
    return result;
  }

  private weekRange(start: Date): AutoAssignmentRange {
    const dates = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(start);
      date.setUTCDate(date.getUTCDate() + index);
      return date;
    });
    return { start: dates[0], end: dates[6], dates };
  }
}

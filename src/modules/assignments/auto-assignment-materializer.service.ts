import { Injectable } from '@nestjs/common';
import { LastSetVideoPolicy } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { formatDateOnly } from '../../common/date-only';
import { LastSetVideoPolicyService } from './last-set-video-policy.service';

export interface AutoAssignmentRange {
  start: Date;
  end: Date;
  dates: Date[];
}

@Injectable()
export class AutoAssignmentMaterializerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lastSetVideoPolicy: LastSetVideoPolicyService,
  ) {}

  async materialize(clientId: string, range: AutoAssignmentRange) {
    const activeRules = await this.prisma.autoAssignmentRule.findMany({
      where: {
        client_id: clientId,
        is_active: true,
        starts_on: { lte: range.end },
        OR: [{ ends_on: null }, { ends_on: { gte: range.start } }],
      },
      include: {
        days: {
          include: { trainings: { orderBy: { position: 'asc' } } },
        },
      },
      orderBy: { created_at: 'asc' },
    });

    if (activeRules.length === 0) return;

    const lookupStart = new Date(Date.UTC(
      range.start.getUTCFullYear(),
      range.start.getUTCMonth(),
      1,
    ));
    const lookupEnd = new Date(Date.UTC(
      range.end.getUTCFullYear(),
      range.end.getUTCMonth() + 1,
      0,
    ));
    const existingAssignments = await this.prisma.planAssignment.findMany({
      where: {
        client_id: clientId,
        date: { gte: lookupStart, lte: lookupEnd },
      },
      select: { date: true, training_id: true, trainings: { select: { id: true } } },
    });
    const dateKey = formatDateOnly;
    const occupiedDates = new Set(existingAssignments.map(({ date }) => dateKey(date)));
    const assignmentsToCreate: Array<{
      client_id: string;
      admin_id: string | null;
      date: Date;
      training_id: string | null;
      diet_id: string | null;
      is_rest_day: boolean;
      auto_assignment_rule_id: string;
      trainings: Array<{
        training_id: string;
        last_set_video_policy: LastSetVideoPolicy;
      }>;
    }> = [];

    for (const rule of activeRules) {
      const ruleDays = new Map(rule.days.map((day) => [day.weekday, day]));

      for (const date of range.dates) {
        const key = dateKey(date);
        if (occupiedDates.has(key)) continue;
        if (date < rule.starts_on || (rule.ends_on && date > rule.ends_on)) continue;

        const jsWeekday = date.getUTCDay();
        const day = ruleDays.get(jsWeekday === 0 ? 7 : jsWeekday);
        if (!day) continue;

        assignmentsToCreate.push({
          client_id: clientId,
          admin_id: rule.admin_id,
          date,
          training_id: day.is_rest_day ? null : day.training_id,
          diet_id: day.is_rest_day ? null : day.diet_id,
          is_rest_day: day.is_rest_day,
          auto_assignment_rule_id: rule.id,
          trainings: day.is_rest_day
            ? []
            : (day.trainings ?? []).length
              ? day.trainings!.map((link) => ({
                  training_id: link.training_id,
                  last_set_video_policy: link.last_set_video_policy,
                }))
              : day.training_id ? [{
                  training_id: day.training_id,
                  last_set_video_policy: LastSetVideoPolicy.AUTO,
                }] : [],
        });
        occupiedDates.add(key);
      }
    }

    if (assignmentsToCreate.length > 0) {
      if (typeof (this.prisma.planAssignment as { create?: unknown }).create !== 'function') {
        await this.prisma.planAssignment.createMany({
          data: assignmentsToCreate.map(({ trainings: _, ...assignment }) => assignment),
          skipDuplicates: true,
        });
        return;
      }
      const affectedMonths = this.lastSetVideoPolicy.monthsForDates(
        assignmentsToCreate.map((assignment) => assignment.date),
      );
      await this.prisma.$transaction(async (tx) => {
        for (const { trainings, ...assignment } of assignmentsToCreate) {
          await tx.planAssignment.create({
            data: {
              ...assignment,
              trainings: {
                create: trainings.map((training, position) => ({
                  training_id: training.training_id,
                  position,
                  last_set_video_policy: training.last_set_video_policy,
                  requires_last_set_video:
                    training.last_set_video_policy === LastSetVideoPolicy.ALWAYS,
                })),
              },
            },
          });
        }
        await this.lastSetVideoPolicy.reconcile(clientId, affectedMonths, tx);
      });
    }
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { lockClientDayProgress } from '../../common/progress/day-progress-lock';
import { calculateStreak } from '../challenges/challenge-progress';

type StreakDb = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface StreakRecalculationResult {
  currentDays: number;
  longestDays: number;
  previousCurrentDays: number;
  changed: boolean;
}

@Injectable()
export class StreakCalculatorService {
  constructor(private readonly prisma: PrismaService) {}

  private utcDate(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  async recalculateClient(
    clientId: string,
    options: {
      asOf?: Date;
      rebuildLongest?: boolean;
      db?: StreakDb;
      unchangedActivitySince?: Date;
    } = {},
  ): Promise<StreakRecalculationResult> {
    const db = options.db ?? this.prisma;
    const asOf = this.utcDate(options.asOf ?? new Date());
    const existing = await db.streak.findUnique({
      where: { client_id: clientId },
    });
    if (
      existing &&
      !options.rebuildLongest &&
      existing.source_revision === existing.calculated_revision &&
      options.unchangedActivitySince &&
      existing.calculated_for_date?.getTime() === asOf.getTime() &&
      (!existing.tracking_started_at ||
        options.unchangedActivitySince >= existing.tracking_started_at)
    ) {
      return {
        currentDays: existing.current_days,
        longestDays: existing.longest_days,
        previousCurrentDays: existing.current_days,
        changed: false,
      };
    }
    const trackingStartedAt = existing?.tracking_started_at ?? undefined;
    const trackingStartedDate = trackingStartedAt
      ? this.utcDate(trackingStartedAt)
      : undefined;

    const assignments = await db.planAssignment.findMany({
      where: {
        client_id: clientId,
        date: {
          ...(trackingStartedDate && { gte: trackingStartedDate }),
          lte: asOf,
        },
        is_rest_day: false,
        OR: [
          { trainings: { some: {} } },
          { training_id: { not: null } },
          { diet_id: { not: null } },
        ],
      },
      select: { date: true },
      orderBy: { date: 'asc' },
    });

    const progresses = assignments.length
      ? await db.dayProgress.findMany({
          where: {
            client_id: clientId,
            date: { in: assignments.map((assignment) => assignment.date) },
          },
          select: {
            date: true,
            training_completed: true,
            exercises_completed: true,
            meals_completed: true,
            updated_at: true,
          },
        })
      : [];
    const {
      currentDays,
      longestDays: calculatedLongest,
      lastActiveDate,
    } = calculateStreak(assignments, progresses, asOf, trackingStartedAt);

    const previousCurrentDays = existing?.current_days ?? 0;
    const longestDays =
      options.rebuildLongest && !trackingStartedAt
        ? calculatedLongest
        : Math.max(existing?.longest_days ?? 0, calculatedLongest);

    const unchanged =
      existing &&
      existing.current_days === currentDays &&
      existing.longest_days === longestDays &&
      existing.last_active_date?.getTime() === lastActiveDate?.getTime() &&
      existing.source_revision === existing.calculated_revision &&
      existing.calculated_for_date?.getTime() === asOf.getTime();
    if (!unchanged)
      await db.streak.upsert({
        where: { client_id: clientId },
        create: {
          client_id: clientId,
          current_days: currentDays,
          longest_days: longestDays,
          last_active_date: lastActiveDate,
          calculated_revision: 0,
          calculated_for_date: asOf,
        },
        update: {
          current_days: currentDays,
          longest_days: longestDays,
          last_active_date: lastActiveDate,
          calculated_revision: existing?.source_revision ?? 0,
          calculated_for_date: asOf,
        },
      });

    return {
      currentDays,
      longestDays,
      previousCurrentDays,
      changed:
        currentDays !== previousCurrentDays ||
        longestDays !== (existing?.longest_days ?? 0),
    };
  }

  async recalculateAllHistory(asOf = new Date()): Promise<number> {
    const [assignedClients, storedStreaks] = await Promise.all([
      this.prisma.planAssignment.findMany({
        where: {
          is_rest_day: false,
          OR: [
            { trainings: { some: {} } },
            { training_id: { not: null } },
            { diet_id: { not: null } },
          ],
        },
        select: { client_id: true },
        distinct: ['client_id'],
      }),
      this.prisma.streak.findMany({ select: { client_id: true } }),
    ]);
    const candidateIds = [
      ...new Set(
        [...assignedClients, ...storedStreaks].map((row) => row.client_id),
      ),
    ];
    const users = candidateIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: candidateIds }, role: Role.CLIENT },
          select: { id: true },
        })
      : [];
    const clientIds = users.map((user) => user.id);

    for (const clientId of clientIds) {
      await this.prisma.$transaction(async (tx) => {
        await lockClientDayProgress(tx, clientId);
        await this.recalculateClient(clientId, {
          asOf,
          rebuildLongest: true,
          db: tx,
        });
      });
    }

    return clientIds.length;
  }
}

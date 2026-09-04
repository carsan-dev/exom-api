import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

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

  private hasActivity(progress: {
    training_completed: boolean;
    exercises_completed: Prisma.JsonValue;
    meals_completed: string[];
  }): boolean {
    return (
      progress.training_completed ||
      (Array.isArray(progress.exercises_completed) &&
        progress.exercises_completed.length > 0) ||
      progress.meals_completed.length > 0
    );
  }

  async recalculateClient(
    clientId: string,
    options: {
      asOf?: Date;
      rebuildLongest?: boolean;
      db?: StreakDb;
    } = {},
  ): Promise<StreakRecalculationResult> {
    const db = options.db ?? this.prisma;
    const asOf = this.utcDate(options.asOf ?? new Date());
    const existing = await db.streak.findUnique({
      where: { client_id: clientId },
    });
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
    const activityByDate = new Map(
      progresses.map((progress) => [
        this.utcDate(progress.date).getTime(),
        (!trackingStartedAt || progress.updated_at >= trackingStartedAt) &&
          this.hasActivity(progress),
      ]),
    );

    let currentDays = 0;
    let calculatedLongest = 0;
    let lastActiveDate: Date | null = null;

    for (const assignment of assignments) {
      const date = this.utcDate(assignment.date);
      const active = activityByDate.get(date.getTime()) ?? false;

      // Current calendar day remains open until tomorrow.
      if (!active && date.getTime() === asOf.getTime()) continue;

      if (active) {
        currentDays += 1;
        calculatedLongest = Math.max(calculatedLongest, currentDays);
        lastActiveDate = date;
      } else {
        currentDays = 0;
      }
    }

    const previousCurrentDays = existing?.current_days ?? 0;
    const longestDays =
      options.rebuildLongest && !trackingStartedAt
        ? calculatedLongest
        : Math.max(existing?.longest_days ?? 0, calculatedLongest);

    await db.streak.upsert({
      where: { client_id: clientId },
      create: {
        client_id: clientId,
        current_days: currentDays,
        longest_days: longestDays,
        last_active_date: lastActiveDate,
      },
      update: {
        current_days: currentDays,
        longest_days: longestDays,
        last_active_date: lastActiveDate,
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
      await this.recalculateClient(clientId, {
        asOf,
        rebuildLongest: true,
      });
    }

    return clientIds.length;
  }
}

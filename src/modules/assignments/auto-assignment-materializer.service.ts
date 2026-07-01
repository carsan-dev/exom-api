import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface AutoAssignmentRange {
  start: Date;
  end: Date;
  dates: Date[];
}

@Injectable()
export class AutoAssignmentMaterializerService {
  constructor(private readonly prisma: PrismaService) {}

  async materialize(clientId: string, range: AutoAssignmentRange) {
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

    if (activeRules.length === 0) return;

    const existingAssignments = await this.prisma.planAssignment.findMany({
      where: {
        client_id: clientId,
        date: { gte: range.start, lte: range.end },
      },
      select: { date: true },
    });
    const dateKey = (date: Date) => date.toISOString().split('T')[0];
    const occupiedDates = new Set(existingAssignments.map(({ date }) => dateKey(date)));
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
        });
        occupiedDates.add(key);
      }
    }

    if (assignmentsToCreate.length > 0) {
      await this.prisma.planAssignment.createMany({
        data: assignmentsToCreate,
        skipDuplicates: true,
      });
    }
  }
}

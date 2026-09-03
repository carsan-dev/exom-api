import { BadRequestException, Injectable } from '@nestjs/common';
import { LastSetVideoPolicy, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type AssignmentTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class LastSetVideoPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  monthKey(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  monthsForDates(dates: Date[]): string[] {
    const months = [...new Set(dates.map((date) => this.monthKey(date)))];
    if (months.length > 6) {
      throw new BadRequestException({
        code: 'ASSIGNMENT_RANGE_TOO_LARGE',
        message: 'Una petición no puede afectar a más de 6 meses',
      });
    }
    return months;
  }

  effective(policy: LastSetVideoPolicy, autoRequired: boolean): boolean {
    if (policy === LastSetVideoPolicy.ALWAYS) return true;
    if (policy === LastSetVideoPolicy.NEVER) return false;
    return autoRequired;
  }

  async reconcile(
    clientId: string,
    monthKeys: string[],
    db: AssignmentTransaction = this.prisma,
  ): Promise<void> {
    const uniqueMonths = [...new Set(monthKeys)];
    if (uniqueMonths.length > 6) {
      throw new BadRequestException({
        code: 'ASSIGNMENT_RANGE_TOO_LARGE',
        message: 'Una petición no puede afectar a más de 6 meses',
      });
    }

    for (const key of uniqueMonths) {
      const [year, month] = key.split('-').map(Number);
      if (!year || month < 1 || month > 12) {
        throw new BadRequestException('Mes de reconciliación inválido');
      }
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 1));
      const assignments = await db.planAssignment.findMany({
        where: {
          client_id: clientId,
          date: { gte: start, lt: end },
          trainings: { some: {} },
        },
        orderBy: { date: 'asc' },
        select: {
          date: true,
          trainings: {
            select: {
              id: true,
              last_set_video_policy: true,
              requires_last_set_video: true,
            },
          },
        },
      });

      if (!assignments.length) continue;
      const firstWeekStart = this.weekStart(assignments[0].date).getTime();
      const updates: Prisma.PrismaPromise<unknown>[] = [];

      for (const assignment of assignments) {
        const autoRequired = this.weekStart(assignment.date).getTime() === firstWeekStart;
        for (const link of assignment.trainings) {
          const required = this.effective(link.last_set_video_policy, autoRequired);
          if (required !== link.requires_last_set_video) {
            updates.push(
              db.planAssignmentTraining.update({
                where: { id: link.id },
                data: { requires_last_set_video: required },
              }) as Prisma.PrismaPromise<unknown>,
            );
          }
        }
      }

      await Promise.all(updates);
    }
  }

  private weekStart(date: Date): Date {
    const weekday = date.getUTCDay() || 7;
    const result = new Date(date);
    result.setUTCDate(result.getUTCDate() + 1 - weekday);
    return result;
  }
}

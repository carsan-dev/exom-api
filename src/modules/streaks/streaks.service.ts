import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Role } from '@prisma/client';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { STREAK_PUBLIC_SELECT } from './streak-public';
import { lockClientDayProgress } from '../../common/progress/day-progress-lock';

@Injectable()
export class StreaksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly challengesService: ChallengesService,
    private readonly achievementsService: AchievementsService,
  ) {}

  async getStreak(clientId: string) {
    const existing = await this.prisma.streak.findUnique({
      where: { client_id: clientId },
      select: STREAK_PUBLIC_SELECT,
    });

    if (existing) {
      return existing;
    }

    return {
      id: '',
      client_id: clientId,
      current_days: 0,
      longest_days: 0,
      last_active_date: null,
      tracking_started_at: null,
      updated_at: new Date(0),
    };
  }

  async resetStreak(adminId: string, adminRole: string, clientId: string) {
    const streak = await this.prisma.$transaction(async (tx) => {
      await lockClientDayProgress(tx, clientId);
      if (adminRole !== Role.SUPER_ADMIN) {
        const assignment = await tx.adminClientAssignment.findFirst({
          where: { admin_id: adminId, client_id: clientId, is_active: true },
        });

        if (!assignment) {
          throw new ForbiddenException('Este cliente no está asignado a ti');
        }
      }

      return tx.streak.upsert({
        where: { client_id: clientId },
        select: STREAK_PUBLIC_SELECT,
        update: {
          current_days: 0,
          last_active_date: null,
          tracking_started_at: new Date(),
        },
        create: {
          client_id: clientId,
          current_days: 0,
          longest_days: 0,
          last_active_date: null,
          tracking_started_at: new Date(),
        },
      });
    });

    await this.challengesService.recalculateAutomaticProgress(
      clientId,
      undefined,
      undefined,
      ['STREAK_DAYS'],
    );
    await this.achievementsService.evaluateAutomaticAchievementsForUser(
      clientId,
      undefined,
      undefined,
      ['STREAK_DAYS', 'CHALLENGES_COMPLETED'],
    );

    return streak;
  }
}

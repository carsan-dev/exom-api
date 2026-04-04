import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Role } from '@prisma/client';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';

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
    });

    if (existing) {
      return existing;
    }

    return this.prisma.streak.create({
      data: {
        client_id: clientId,
        current_days: 0,
        longest_days: 0,
      },
    });
  }

  async resetStreak(adminId: string, adminRole: string, clientId: string) {
    if (adminRole !== Role.SUPER_ADMIN) {
      const assignment = await this.prisma.adminClientAssignment.findFirst({
        where: { admin_id: adminId, client_id: clientId, is_active: true },
      });

      if (!assignment) {
        throw new ForbiddenException('Este cliente no está asignado a ti');
      }
    }

    const streak = await this.prisma.streak.upsert({
      where: { client_id: clientId },
      update: {
        current_days: 0,
        last_active_date: null,
      },
      create: {
        client_id: clientId,
        current_days: 0,
        longest_days: 0,
        last_active_date: null,
      },
    });

    await this.challengesService.recalculateAutomaticProgress(clientId);
    await this.achievementsService.evaluateAutomaticAchievementsForUser(clientId);

    return streak;
  }
}

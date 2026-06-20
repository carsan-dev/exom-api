import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { StreakCalculatorService } from './streak-calculator.service';

@Injectable()
export class StreakReconciliationService {
  private readonly logger = new Logger(StreakReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: StreakCalculatorService,
    private readonly challenges: ChallengesService,
    private readonly achievements: AchievementsService,
  ) {}

  @Cron('5 0 * * *', { timeZone: 'UTC' })
  async reconcileActiveStreaks() {
    const streaks = await this.prisma.streak.findMany({
      where: { current_days: { gt: 0 } },
      select: { client_id: true },
    });
    let changed = 0;

    for (const { client_id } of streaks) {
      const result = await this.calculator.recalculateClient(client_id);
      if (!result.changed) continue;

      changed += 1;
      await this.challenges.recalculateAutomaticProgress(client_id);
      await this.achievements.evaluateAutomaticAchievementsForUser(client_id);
    }

    if (changed > 0) {
      this.logger.log(`[cron] reconciled ${changed} changed streaks`);
    }
  }
}

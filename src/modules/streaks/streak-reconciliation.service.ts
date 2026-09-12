import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AchievementsService } from '../achievements/achievements.service';
import { ChallengesService } from '../challenges/challenges.service';
import { StreakCalculatorService } from './streak-calculator.service';
import { lockClientDayProgress } from '../../common/progress/day-progress-lock';

@Injectable()
export class StreakReconciliationService {
  private readonly logger = new Logger(StreakReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly calculator: StreakCalculatorService,
    private readonly challenges: ChallengesService,
    private readonly achievements: AchievementsService,
  ) {}

  async reconcileActiveStreaks() {
    const streaks = await this.prisma.streak.findMany({
      where: { current_days: { gt: 0 } },
      select: { client_id: true },
    });
    let changed = 0;

    for (const { client_id } of streaks) {
      const result = await this.prisma.$transaction(async (tx) => {
        await lockClientDayProgress(tx, client_id);
        return this.calculator.recalculateClient(client_id, { db: tx });
      });
      if (!result.changed) continue;

      changed += 1;
      await this.challenges.recalculateAutomaticProgress(
        client_id,
        undefined,
        undefined,
        ['STREAK_DAYS'],
      );
      await this.achievements.evaluateAutomaticAchievementsForUser(
        client_id,
        undefined,
        undefined,
        ['STREAK_DAYS', 'CHALLENGES_COMPLETED'],
      );
    }

    if (changed > 0) {
      this.logger.log(`[cron] reconciled ${changed} changed streaks`);
    }
  }
}

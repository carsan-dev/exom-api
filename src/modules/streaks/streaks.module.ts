import { Module } from '@nestjs/common';
import { AchievementsModule } from '../achievements/achievements.module';
import { ChallengesModule } from '../challenges/challenges.module';
import { StreaksController } from './streaks.controller';
import { StreakCalculatorService } from './streak-calculator.service';
import { StreakReconciliationService } from './streak-reconciliation.service';
import { StreaksService } from './streaks.service';

@Module({
  imports: [ChallengesModule, AchievementsModule],
  controllers: [StreaksController],
  providers: [
    StreaksService,
    StreakCalculatorService,
    StreakReconciliationService,
  ],
  exports: [StreakCalculatorService],
})
export class StreaksModule {}

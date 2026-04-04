import { Module } from '@nestjs/common';
import { AchievementsModule } from '../achievements/achievements.module';
import { ChallengesModule } from '../challenges/challenges.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [ChallengesModule, AchievementsModule],
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class MetricsModule {}

import { Module } from '@nestjs/common';
import { AchievementsModule } from '../achievements/achievements.module';
import { ChallengesModule } from '../challenges/challenges.module';
import { StreaksController } from './streaks.controller';
import { StreaksService } from './streaks.service';

@Module({
  imports: [ChallengesModule, AchievementsModule],
  controllers: [StreaksController],
  providers: [StreaksService],
})
export class StreaksModule {}

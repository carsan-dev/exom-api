import { Module } from '@nestjs/common';
import { AchievementsModule } from '../achievements/achievements.module';
import { ChallengesModule } from '../challenges/challenges.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';

@Module({
  imports: [ChallengesModule, AchievementsModule, NotificationsModule],
  controllers: [ProgressController],
  providers: [ProgressService],
})
export class ProgressModule {}

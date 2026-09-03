import { Module } from '@nestjs/common';
import { AchievementsModule } from '../achievements/achievements.module';
import { ChallengesModule } from '../challenges/challenges.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StreaksModule } from '../streaks/streaks.module';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [
    ChallengesModule,
    AchievementsModule,
    NotificationsModule,
    StreaksModule,
    UploadsModule,
  ],
  controllers: [ProgressController],
  providers: [ProgressService],
})
export class ProgressModule {}

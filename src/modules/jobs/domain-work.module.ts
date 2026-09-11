import { Module } from '@nestjs/common';
import { AchievementsModule } from '../achievements/achievements.module';
import { ChallengesModule } from '../challenges/challenges.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DomainWorkService } from './domain-work.service';
import { MaintenanceWorkService } from './maintenance-work.service';
import { FeedbackModule } from '../feedback/feedback.module';
import { UploadsModule } from '../uploads/uploads.module';
import { StreaksModule } from '../streaks/streaks.module';

@Module({
  imports: [
    AchievementsModule,
    ChallengesModule,
    NotificationsModule,
    FeedbackModule,
    UploadsModule,
    StreaksModule,
  ],
  providers: [DomainWorkService, MaintenanceWorkService],
})
export class DomainWorkModule {}

import { Module } from '@nestjs/common';
import { AchievementsModule } from '../achievements/achievements.module';
import { ChallengesModule } from '../challenges/challenges.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StreaksModule } from '../streaks/streaks.module';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';
import { TrainingProgressReadService } from './training-progress-read.service';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsModule } from '../uploads/uploads.module';
import { AssignmentReconciliationModule } from '../assignments/assignment-reconciliation.module';

@Module({
  imports: [
    ChallengesModule,
    AchievementsModule,
    NotificationsModule,
    StreaksModule,
    UploadsModule,
    AssignmentReconciliationModule,
  ],
  controllers: [ProgressController],
  providers: [
    ProgressService,
    {
      provide: TrainingProgressReadService,
      useFactory: (prisma: PrismaService) =>
        new TrainingProgressReadService(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [TrainingProgressReadService],
})
export class ProgressModule {}

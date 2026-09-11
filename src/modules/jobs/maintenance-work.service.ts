import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { FeedbackRetentionService } from '../feedback/feedback-retention.service';
import { UploadsService } from '../uploads/uploads.service';
import { StreakReconciliationService } from '../streaks/streak-reconciliation.service';
import { enqueueWork, JobsService } from './jobs.service';

@Injectable()
export class MaintenanceWorkService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly feedback: FeedbackRetentionService,
    private readonly uploads: UploadsService,
    private readonly streaks: StreakReconciliationService,
  ) {}
  onModuleInit() {
    this.jobs.register('FEEDBACK_RETENTION', async () => {
      await this.feedback.cleanupExpiredFeedbackMedia();
    });
    this.jobs.register('UPLOAD_RETENTION', async () => {
      await this.uploads.purgeExpiredSessions();
    });
    this.jobs.register('STREAK_RECONCILIATION', async () => {
      await this.streaks.reconcileActiveStreaks();
    });
  }
  @Cron('5 0 * * *', { timeZone: 'UTC' })
  async streakSchedule() {
    await enqueueWork(
      this.prisma,
      `daily:streak:${new Date().toISOString().slice(0, 10)}`,
      'STREAK_RECONCILIATION',
      {},
    );
  }
  @Cron('0 0 3 * * *')
  async feedbackSchedule() {
    await enqueueWork(
      this.prisma,
      `daily:feedback:${new Date().toISOString().slice(0, 10)}`,
      'FEEDBACK_RETENTION',
      {},
    );
  }
  @Cron('0 */30 * * * *')
  async uploadSchedule() {
    await enqueueWork(
      this.prisma,
      `half-hour:uploads:${Math.floor(Date.now() / 1800000)}`,
      'UPLOAD_RETENTION',
      {},
    );
  }
}

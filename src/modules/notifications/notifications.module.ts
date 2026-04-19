import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsSchedulerService } from './notifications-scheduler.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsSchedulerService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

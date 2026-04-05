import { Module } from '@nestjs/common';
import { ApprovalInterceptor } from '../../common/interceptors/approval.interceptor';
import { NotificationsModule } from '../notifications/notifications.module';
import { ApprovalRequestsController } from './approval-requests.controller';
import { ApprovalRequestsService } from './approval-requests.service';

@Module({
  imports: [NotificationsModule],
  controllers: [ApprovalRequestsController],
  providers: [ApprovalRequestsService, ApprovalInterceptor],
  exports: [ApprovalRequestsService, ApprovalInterceptor],
})
export class ApprovalRequestsModule {}

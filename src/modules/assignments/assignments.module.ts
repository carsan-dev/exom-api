import { Module } from '@nestjs/common';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';
import { LastSetVideoPolicyService } from './last-set-video-policy.service';

@Module({
  imports: [NotificationsModule],
  controllers: [AssignmentsController],
  providers: [AssignmentsService, AutoAssignmentMaterializerService, LastSetVideoPolicyService],
  exports: [AutoAssignmentMaterializerService, LastSetVideoPolicyService],
})
export class AssignmentsModule {}

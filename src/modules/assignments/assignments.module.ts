import { Module } from '@nestjs/common';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';

@Module({
  imports: [NotificationsModule],
  controllers: [AssignmentsController],
  providers: [AssignmentsService, AutoAssignmentMaterializerService],
  exports: [AutoAssignmentMaterializerService],
})
export class AssignmentsModule {}

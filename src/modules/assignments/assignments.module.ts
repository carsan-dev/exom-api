import { Module } from '@nestjs/common';
import { RirCycleService } from './rir-cycle.service';
import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssignmentReconciliationModule } from './assignment-reconciliation.module';

@Module({
  imports: [NotificationsModule, AssignmentReconciliationModule],
  controllers: [AssignmentsController],
  providers: [AssignmentsService, RirCycleService],
})
export class AssignmentsModule {}

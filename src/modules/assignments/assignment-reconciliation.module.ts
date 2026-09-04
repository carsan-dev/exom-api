import { Module } from '@nestjs/common';
import { AutoAssignmentMaterializerService } from './auto-assignment-materializer.service';
import { LastSetVideoPolicyService } from './last-set-video-policy.service';

@Module({
  providers: [AutoAssignmentMaterializerService, LastSetVideoPolicyService],
  exports: [AutoAssignmentMaterializerService, LastSetVideoPolicyService],
})
export class AssignmentReconciliationModule {}

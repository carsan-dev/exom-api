import { Module } from '@nestjs/common';
import { DietsController } from './diets.controller';
import { DietsService } from './diets.service';
import { DietGroupsController } from './diet-groups.controller';
import { DietGroupsService } from './diet-groups.service';
import { UploadsModule } from '../uploads/uploads.module';
import { AssignmentReconciliationModule } from '../assignments/assignment-reconciliation.module';

@Module({
  imports: [UploadsModule, AssignmentReconciliationModule],
  controllers: [DietsController, DietGroupsController],
  providers: [DietsService, DietGroupsService],
})
export class DietsModule {}

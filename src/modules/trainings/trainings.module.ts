import { Module } from '@nestjs/common';
import { TrainingsController } from './trainings.controller';
import { TrainingsService } from './trainings.service';
import { TrainingGroupsController } from './training-groups.controller';
import { TrainingGroupsService } from './training-groups.service';
import { AssignmentReconciliationModule } from '../assignments/assignment-reconciliation.module';

@Module({
  imports: [AssignmentReconciliationModule],
  controllers: [TrainingsController, TrainingGroupsController],
  providers: [TrainingsService, TrainingGroupsService],
})
export class TrainingsModule {}

import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { AssignmentReconciliationModule } from '../assignments/assignment-reconciliation.module';

@Module({
  imports: [AssignmentReconciliationModule],
  controllers: [CalendarController],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}

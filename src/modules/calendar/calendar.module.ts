import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { AssignmentsModule } from '../assignments/assignments.module';

@Module({
  imports: [AssignmentsModule],
  controllers: [CalendarController],
  providers: [CalendarService]
})
export class CalendarModule {}

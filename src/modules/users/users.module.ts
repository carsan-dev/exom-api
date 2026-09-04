import { Module } from '@nestjs/common';
import { ChallengesModule } from '../challenges/challenges.module';
import { EmailModule } from '../email/email.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MetricsModule } from '../metrics/metrics.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { CalendarModule } from '../calendar/calendar.module';

@Module({
  imports: [
    ChallengesModule,
    EmailModule,
    NotificationsModule,
    MetricsModule,
    CalendarModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

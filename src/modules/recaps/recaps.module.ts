import { Module } from '@nestjs/common';
import { RecapsController } from './recaps.controller';
import { RecapsService } from './recaps.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [RecapsController],
  providers: [RecapsService],
})
export class RecapsModule {}

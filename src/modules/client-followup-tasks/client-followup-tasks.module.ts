import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ClientFollowUpTasksController } from './client-followup-tasks.controller';
import { ClientFollowUpTasksService } from './client-followup-tasks.service';

@Module({
  imports: [PrismaModule],
  controllers: [ClientFollowUpTasksController],
  providers: [ClientFollowUpTasksService],
})
export class ClientFollowUpTasksModule {}

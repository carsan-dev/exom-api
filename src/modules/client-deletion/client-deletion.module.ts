import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import { ClientDeletionController } from './client-deletion.controller';
import {
  ClientDeletionService,
  DeletionIdentityService,
} from './client-deletion.service';

@Module({
  imports: [UploadsModule],
  controllers: [ClientDeletionController],
  providers: [ClientDeletionService, DeletionIdentityService],
  exports: [ClientDeletionService],
})
export class ClientDeletionModule {}

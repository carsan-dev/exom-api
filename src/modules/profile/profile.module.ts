import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { UploadsModule } from '../uploads/uploads.module';
import { ClientDeletionModule } from '../client-deletion/client-deletion.module';

@Module({
  imports: [UploadsModule, ClientDeletionModule],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}

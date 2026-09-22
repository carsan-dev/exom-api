import { Module } from '@nestjs/common';
import { UploadsModule } from '../uploads/uploads.module';
import {
  AdminProgressPhotosController,
  ProgressPhotosController,
} from './progress-photos.controller';
import { ProgressPhotosService } from './progress-photos.service';

@Module({
  imports: [UploadsModule],
  controllers: [ProgressPhotosController, AdminProgressPhotosController],
  providers: [ProgressPhotosService],
})
export class ProgressPhotosModule {}

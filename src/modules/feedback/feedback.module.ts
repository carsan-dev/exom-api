import { Module } from '@nestjs/common';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';
import { UploadsModule } from '../uploads/uploads.module';
import { FeedbackRetentionService } from './feedback-retention.service';

@Module({
  imports: [UploadsModule],
  controllers: [FeedbackController],
  providers: [FeedbackService, FeedbackRetentionService],
})
export class FeedbackModule {}

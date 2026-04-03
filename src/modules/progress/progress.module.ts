import { Module } from '@nestjs/common';
import { ChallengesModule } from '../challenges/challenges.module';
import { ProgressController } from './progress.controller';
import { ProgressService } from './progress.service';

@Module({
  imports: [ChallengesModule],
  controllers: [ProgressController],
  providers: [ProgressService],
})
export class ProgressModule {}

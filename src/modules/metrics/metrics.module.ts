import { Module } from '@nestjs/common';
import { ChallengesModule } from '../challenges/challenges.module';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [ChallengesModule],
  controllers: [MetricsController],
  providers: [MetricsService],
})
export class MetricsModule {}

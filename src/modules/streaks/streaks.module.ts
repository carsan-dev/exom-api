import { Module } from '@nestjs/common';
import { ChallengesModule } from '../challenges/challenges.module';
import { StreaksController } from './streaks.controller';
import { StreaksService } from './streaks.service';

@Module({
  imports: [ChallengesModule],
  controllers: [StreaksController],
  providers: [StreaksService],
})
export class StreaksModule {}

import { Module } from '@nestjs/common';
import { StreaksController } from './streaks.controller';
import { StreaksService } from './streaks.service';

@Module({
  controllers: [StreaksController],
  providers: [StreaksService]
})
export class StreaksModule {}

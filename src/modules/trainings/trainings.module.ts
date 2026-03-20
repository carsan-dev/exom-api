import { Module } from '@nestjs/common';
import { TrainingsController } from './trainings.controller';
import { TrainingsService } from './trainings.service';

@Module({
  controllers: [TrainingsController],
  providers: [TrainingsService]
})
export class TrainingsModule {}

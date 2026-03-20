import { Module } from '@nestjs/common';
import { RecapsController } from './recaps.controller';
import { RecapsService } from './recaps.service';

@Module({
  controllers: [RecapsController],
  providers: [RecapsService]
})
export class RecapsModule {}

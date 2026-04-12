import { Module } from '@nestjs/common';
import { PublicConfigController } from './public-config.controller';
import { PublicConfigService } from './public-config.service';

@Module({
  controllers: [PublicConfigController],
  providers: [PublicConfigService],
})
export class PublicConfigModule {}

import { Module } from '@nestjs/common';
import { AdherenceConfigController } from './adherence-config.controller';
import { AdherenceConfigService } from './adherence-config.service';

@Module({
  controllers: [AdherenceConfigController],
  providers: [AdherenceConfigService],
  exports: [AdherenceConfigService],
})
export class AdherenceConfigModule {}

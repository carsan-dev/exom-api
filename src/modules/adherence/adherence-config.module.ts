import { Module } from '@nestjs/common';
import { AdherenceConfigController } from './adherence-config.controller';
import { AdherenceConfigService } from './adherence-config.service';
import {
  AdherenceEvaluationController,
  ClientAdherenceEvaluationController,
} from './adherence-evaluation.controller';
import { AdherenceEvaluationService } from './adherence-evaluation.service';

@Module({
  controllers: [
    AdherenceConfigController,
    AdherenceEvaluationController,
    ClientAdherenceEvaluationController,
  ],
  providers: [AdherenceConfigService, AdherenceEvaluationService],
  exports: [AdherenceConfigService],
})
export class AdherenceConfigModule {}

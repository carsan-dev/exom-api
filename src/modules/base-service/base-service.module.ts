import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { BaseDeliveriesService } from './base-deliveries.service';
import { BaseDeliveryWorker } from './base-delivery.worker';
import { BasePdfSourceProvider } from './base-pdf-source.provider';
import { BasePdfStamper } from './base-pdf-stamper';
import { BaseServiceController } from './base-service.controller';
import { BaseSubscribersService } from './base-subscribers.service';

@Module({
  imports: [PrismaModule, EmailModule],
  controllers: [BaseServiceController],
  providers: [
    BasePdfSourceProvider,
    BasePdfStamper,
    BaseSubscribersService,
    BaseDeliveriesService,
    BaseDeliveryWorker,
  ],
})
export class BaseServiceModule {}

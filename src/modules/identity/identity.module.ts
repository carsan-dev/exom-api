import { Module } from '@nestjs/common';
import { IdentityProvider } from './identity-provider';
import { IdentityService } from './identity.service';

@Module({
  providers: [IdentityProvider, IdentityService],
  exports: [IdentityService],
})
export class IdentityModule {}

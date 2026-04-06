import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { ClientTier } from '@prisma/client';

export class UpdateClientTierDto {
  @ApiProperty({ enum: ClientTier })
  @IsEnum(ClientTier)
  tier: ClientTier;
}

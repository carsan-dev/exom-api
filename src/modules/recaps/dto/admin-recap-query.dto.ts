import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { RecapStatus } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export const ADMIN_RECAP_STATUSES = [RecapStatus.SUBMITTED, RecapStatus.REVIEWED] as const;
export type AdminRecapStatus = (typeof ADMIN_RECAP_STATUSES)[number];

function toBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return value;
}

export class AdminRecapQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by client ID' })
  @IsOptional()
  @IsUUID()
  client_id?: string;

  @ApiPropertyOptional({
    enum: ADMIN_RECAP_STATUSES,
    description: 'Filter by admin-visible statuses only',
  })
  @IsOptional()
  @IsIn(ADMIN_RECAP_STATUSES)
  status?: AdminRecapStatus;

  @ApiPropertyOptional({ description: 'Include archived recaps only' })
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  archived?: boolean;
}

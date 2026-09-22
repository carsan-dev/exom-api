import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProgressPhotoView } from '@prisma/client';
import { IsDateOnly } from '../../../common/date-only';

const OPERATION_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

export class CreateProgressPhotoSessionDto {
  @ApiProperty({
    example: '2026-09-16',
    description: 'Civil date (YYYY-MM-DD)',
  })
  @IsDateOnly()
  session_date: string;

  @ApiProperty({
    example: 'progress-photo-session:device-1:001',
    maxLength: 128,
    description: 'Stable client-generated operation identity',
  })
  @IsString()
  @Matches(OPERATION_ID_PATTERN)
  operation_id: string;
}

export class AssociateProgressPhotoDto {
  @ApiProperty({ format: 'uuid', description: 'Verified managed upload ID' })
  @IsUUID()
  upload_id: string;

  @ApiProperty({ enum: ProgressPhotoView })
  @IsEnum(ProgressPhotoView)
  view: ProgressPhotoView;

  @ApiProperty({
    example: 'progress-photo-association:device-1:001',
    maxLength: 128,
    description: 'Stable client-generated operation identity',
  })
  @IsString()
  @Matches(OPERATION_ID_PATTERN)
  operation_id: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Required only when replacing an active photo; must equal the current active photo ID for this session and view',
  })
  @IsOptional()
  @IsUUID()
  replaces_photo_id?: string;
}

export class ProgressPhotoHistoryQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  get skip(): number {
    return ((this.page ?? 1) - 1) * (this.limit ?? 20);
  }
}

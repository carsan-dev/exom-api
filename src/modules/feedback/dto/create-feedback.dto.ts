import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { FeedbackKind, MediaType } from '@prisma/client';
import { IsDateOnly } from '../../../common/date-only';

export class CreateFeedbackDto {
  @ApiPropertyOptional({ description: 'Stable client-side upload ID for idempotency' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  client_upload_id?: string;

  @ApiPropertyOptional({ description: 'Exercise ID (optional)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  exercise_id?: string;

  @ApiPropertyOptional({ enum: FeedbackKind, default: FeedbackKind.GENERAL })
  @IsOptional()
  @IsEnum(FeedbackKind)
  feedback_kind?: FeedbackKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  training_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  training_exercise_id?: string;

  @ApiPropertyOptional({ description: 'Assigned date in YYYY-MM-DD format' })
  @IsOptional()
  @IsDateOnly()
  assignment_date?: string;

  @ApiPropertyOptional({ description: 'Managed upload session identifier' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  upload_id?: string;

  @ApiProperty({ enum: MediaType })
  @IsEnum(MediaType)
  media_type: MediaType;

  @ApiPropertyOptional({ deprecated: true })
  @IsOptional()
  @IsString()
  media_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class RespondFeedbackDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  admin_response: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { MediaType } from '@prisma/client';

export class CreateFeedbackDto {
  @ApiPropertyOptional({ description: 'Exercise ID (optional)' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  exercise_id?: string;

  @ApiProperty({ enum: MediaType })
  @IsEnum(MediaType)
  media_type: MediaType;

  @ApiProperty()
  @IsString()
  media_url: string;

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

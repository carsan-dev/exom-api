import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @IsString()
  admin_response: string;
}

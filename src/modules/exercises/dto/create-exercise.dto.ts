import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsString,
  IsArray,
  IsEnum,
  IsOptional,
} from 'class-validator';
import { Level } from '@prisma/client';

export class CreateExerciseDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  muscle_groups: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  equipment: string[];

  @ApiProperty({ enum: Level })
  @IsEnum(Level)
  level: Level;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  video_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  video_stream_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  thumbnail_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  technique_text?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  common_errors_text?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  explanation_text?: string;
}

export class UpdateExerciseDto extends PartialType(CreateExerciseDto) {}

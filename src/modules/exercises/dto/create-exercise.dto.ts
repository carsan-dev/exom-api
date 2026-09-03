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

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  video_url?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  video_upload_id?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  video_stream_id?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  thumbnail_url?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  thumbnail_upload_id?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  technique_text?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  common_errors_text?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  explanation_text?: string | null;
}

export class UpdateExerciseDto extends PartialType(CreateExerciseDto) {}

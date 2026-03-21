import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsArray,
  IsUUID,
  ValidateNested,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Level, TrainingType } from '@prisma/client';

export class TrainingExerciseDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  exercise_id: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  order: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  sets: number;

  @ApiProperty()
  @IsString()
  reps_or_duration: string;

  @ApiPropertyOptional({ default: 60 })
  @IsOptional()
  @IsInt()
  @Min(0)
  rest_seconds?: number = 60;
}

export class CreateTrainingDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ enum: TrainingType })
  @IsEnum(TrainingType)
  type: TrainingType;

  @ApiProperty({ enum: Level })
  @IsEnum(Level)
  level: Level;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  estimated_duration_min?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  estimated_calories?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warmup_description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  warmup_duration_min?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cooldown_description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiProperty({ type: [TrainingExerciseDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TrainingExerciseDto)
  exercises: TrainingExerciseDto[];
}

export class UpdateTrainingDto extends PartialType(CreateTrainingDto) {}

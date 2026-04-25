import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  IsNotEmpty,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { Level } from '@prisma/client';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

export class TrainingExerciseDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
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

  @ApiPropertyOptional({
    default: 60,
    description: 'Descanso entre series del ejercicio, en segundos.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  rest_seconds?: number = 60;
}

export class CreateTrainingDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ example: 'FUERZA' })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  type: string;

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

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  warmup_description?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  warmup_duration_min?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  cooldown_description?: string | null;

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

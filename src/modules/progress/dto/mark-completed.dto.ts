import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsNumber,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedSetDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  set_number: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  reps?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight_kg?: number;
}

export class MarkExerciseDto {
  @ApiProperty()
  @IsString()
  date: string;

  @ApiProperty()
  @IsString()
  exercise_id: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  training_exercise_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  weight_used?: number;

  @ApiPropertyOptional({ type: [CompletedSetDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompletedSetDto)
  sets?: CompletedSetDto[];
}

export class MarkMealDto {
  @ApiProperty()
  @IsString()
  date: string;

  @ApiProperty()
  @IsString()
  meal_id: string;
}

export class CompleteTrainingDto {
  @ApiProperty()
  @IsString()
  date: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

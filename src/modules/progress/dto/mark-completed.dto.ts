import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayUnique,
  IsInt,
  IsOptional,
  IsNumber,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from '../../../common/date-only';

const getCompletedSetNumber = (value: unknown): unknown =>
  typeof value === 'object' && value !== null
    ? Reflect.get(value, 'set_number')
    : value;

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
  @IsInt()
  @Min(1)
  seconds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight_kg?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 10, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  rir?: number | null;
}

export class MarkExerciseDto {
  @ApiProperty()
  @IsDateOnly()
  date: string;

  @ApiProperty()
  @IsString()
  exercise_id: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  training_exercise_id?: string;

  @ApiPropertyOptional({
    description: 'Client upload ID for the required final-set video',
  })
  @IsOptional()
  @IsString()
  last_set_feedback_client_upload_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  weight_used?: number;

  @ApiPropertyOptional({ type: [CompletedSetDto] })
  @IsOptional()
  @IsArray()
  @ArrayUnique(getCompletedSetNumber)
  @ValidateNested({ each: true })
  @Type(() => CompletedSetDto)
  sets?: CompletedSetDto[];
}

export class MarkMealDto {
  @ApiProperty()
  @IsDateOnly()
  date: string;

  @ApiProperty()
  @IsString()
  meal_id: string;
}

export class CompleteTrainingDto {
  @ApiProperty()
  @IsDateOnly()
  date: string;

  @ApiPropertyOptional({
    description: 'Assigned training to complete; defaults to the first one',
  })
  @IsOptional()
  @IsString()
  training_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

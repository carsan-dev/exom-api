import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayUnique,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from '../../../common/date-only';

// Full date-time with an explicit zone: a zoneless value would be read in the
// server time zone. Out-of-range instants are clamped by the service, not here.
const CLIENT_COMPLETED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const ClientCompletedAt = (description: string) =>
  applyDecorators(
    ApiPropertyOptional({ type: String, format: 'date-time', description }),
    ValidateIf((_, value: unknown) => value !== undefined),
    IsString(),
    Matches(CLIENT_COMPLETED_AT_PATTERN, {
      message: 'completed_at must be an ISO 8601 date-time with a time zone',
    }),
    IsISO8601({ strict: true, strictSeparator: true }),
  );

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
  @ApiPropertyOptional({
    description: 'Stable training occurrence ID, not an operation ID',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @IsNotEmpty()
  training_session_id?: string;

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

  @ClientCompletedAt(
    'Real completion time on the client (last logged set). The server keeps it only when it falls between the start of `date` minus 14 h and its own time plus 2 min; otherwise, or when absent, it stores its own time. An existing completion keeps its first time.',
  )
  completed_at?: string;
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
  @ApiPropertyOptional({
    description: 'Stable training occurrence ID, not an operation ID',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @IsNotEmpty()
  training_session_id?: string;

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

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 10,
    description: 'Confirmed effort for this training occurrence',
  })
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(10)
  rpe?: number;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Note for this training occurrence; legacy notes remain daily',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  session_note?: string;

  @ClientCompletedAt(
    'Real completion time on the client, applied only to exercise entries created by this completion. Same range and fallback as exercise completion.',
  )
  completed_at?: string;
}

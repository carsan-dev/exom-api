import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  IsNotEmpty,
  Matches,
  IsIn,
  IsBoolean,
  Max,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { Level, TrainingMeasureType } from '@prisma/client';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

const trimStringArray = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? value
        .map((entry) =>
          typeof entry === 'string' ? entry.trim().replace(/\s+/g, ' ') : entry,
        )
        .filter((entry) => typeof entry === 'string' && entry.length > 0)
    : value;

const trimOptionalString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const TRAINING_ACCENT_COLOR_REGEX = /^#?(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

export class TrainingExerciseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  id?: string;

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

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  request_set_tracking?: boolean = false;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reps_or_duration: string;

  @ApiPropertyOptional({ enum: TrainingMeasureType })
  @IsOptional()
  @IsEnum(TrainingMeasureType)
  measure_type?: TrainingMeasureType;

  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  target_value?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  target_value_min?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  target_value_max?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 10, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  target_rir?: number | null;

  @ApiPropertyOptional({
    default: 60,
    description: 'Descanso entre series del ejercicio, en segundos.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  rest_seconds?: number = 60;
}

export class TrainingItemExerciseDto extends TrainingExerciseDto {
  @ApiProperty({ enum: ['EXERCISE'] })
  @IsIn(['EXERCISE'])
  kind: 'EXERCISE';
}

export class TrainingCircuitExerciseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  id?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  exercise_id: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  reps_or_duration: string;

  @ApiPropertyOptional({ enum: TrainingMeasureType })
  @IsOptional()
  @IsEnum(TrainingMeasureType)
  measure_type?: TrainingMeasureType;

  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  target_value?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  target_value_min?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  target_value_max?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 10, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  target_rir?: number | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  request_set_tracking?: boolean = false;

  @ApiPropertyOptional({
    default: 15,
    description: 'Descanso tras el ejercicio dentro del circuito, en segundos.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  rest_seconds?: number = 15;
}

export class TrainingCircuitItemDto {
  @ApiProperty({ enum: ['CIRCUIT'] })
  @IsIn(['CIRCUIT'])
  kind: 'CIRCUIT';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  id?: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  order: number;

  @ApiPropertyOptional({ default: 'Circuito' })
  @IsOptional()
  @IsString()
  name?: string | null;

  @ApiProperty({ default: 3 })
  @IsInt()
  @Min(1)
  rounds: number;

  @ApiPropertyOptional({ default: 60 })
  @IsOptional()
  @IsInt()
  @Min(0)
  rest_between_rounds_seconds?: number = 60;

  @ApiProperty({ type: [TrainingCircuitExerciseDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TrainingCircuitExerciseDto)
  exercises: TrainingCircuitExerciseDto[];
}

export class CreateTrainingDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['FUERZA', 'CARDIO'],
  })
  @IsOptional()
  @Transform(trimStringArray)
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  types?: string[];

  @ApiPropertyOptional({ example: 'FUERZA' })
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  type?: string;

  @ApiPropertyOptional({
    example: '#C5E384',
    nullable: true,
    description: 'Color visual del entrenamiento en formato hex.',
  })
  @Transform(trimOptionalString)
  @IsOptional()
  @IsString()
  @Matches(TRAINING_ACCENT_COLOR_REGEX, {
    message: 'accentColor debe ser un color hex valido',
  })
  accentColor?: string | null;

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

  @ApiPropertyOptional({ type: [TrainingExerciseDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TrainingExerciseDto)
  exercises?: TrainingExerciseDto[];

  @ApiPropertyOptional({
    description: 'Lista mixta de ejercicios sueltos y circuitos.',
    type: [Object],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => Object, {
    discriminator: {
      property: 'kind',
      subTypes: [
        { name: 'EXERCISE', value: TrainingItemExerciseDto },
        { name: 'CIRCUIT', value: TrainingCircuitItemDto },
      ],
    },
    keepDiscriminatorProperty: true,
  })
  items?: Array<TrainingItemExerciseDto | TrainingCircuitItemDto>;
}

export class UpdateTrainingDto extends PartialType(CreateTrainingDto) {}

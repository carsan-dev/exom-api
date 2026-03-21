import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateRecapDto {
  @ApiProperty()
  @IsString()
  week_start_date: string;

  @ApiProperty()
  @IsString()
  week_end_date: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  training_effort?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  training_sessions?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  training_progress?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  training_notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nutrition_quality?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hydration_enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  hydration_level?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  food_quality?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nutrition_notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sleep_hours_range?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fatigue_level?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  muscle_pain_zones?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  recovery_notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mood?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  stress_enabled?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  stress_level?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  general_notes?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  improvement_app_rating?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  improvement_service_rating?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  improvement_areas?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  improvement_feedback_text?: string;
}

export class UpdateRecapDto extends PartialType(CreateRecapDto) {}

export class ReviewRecapDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

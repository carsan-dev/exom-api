import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsBoolean,
  IsNotEmpty,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AssignmentTrainingInputDto } from './assignment-training-input.dto';
import { IsDateOnly } from '../../../common/date-only';

export class BulkAssignmentDto {
  @ApiProperty({ description: 'Client identifier' })
  @IsString()
  @IsNotEmpty()
  client_id: string;

  @ApiProperty({ type: [String], description: 'ISO date strings YYYY-MM-DD' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(93)
  @IsDateOnly({ each: true })
  dates: string[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  training_id?: string | null;

  @ApiPropertyOptional({ type: [String], maxItems: 5 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  training_ids?: string[];

  @ApiPropertyOptional({ type: [AssignmentTrainingInputDto], maxItems: 5 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => AssignmentTrainingInputDto)
  trainings?: AssignmentTrainingInputDto[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  diet_id?: string | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_rest_day?: boolean = false;
}

export class CopyWeekDto {
  @ApiProperty({ description: 'Client identifier' })
  @IsString()
  @IsNotEmpty()
  client_id: string;

  @ApiProperty({ description: 'ISO date string YYYY-MM-DD (Monday)' })
  @IsDateOnly()
  source_week_start: string;

  @ApiProperty({ description: 'ISO date string YYYY-MM-DD (Monday)' })
  @IsDateOnly()
  target_week_start: string;
}

export class CopySelectionDto {
  @ApiProperty({ description: 'Client identifier' })
  @IsString()
  @IsNotEmpty()
  client_id: string;

  @ApiProperty({ type: [String], description: 'Selected source dates (YYYY-MM-DD)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(93)
  @IsDateOnly({ each: true })
  source_dates: string[];

  @ApiProperty({ description: 'Target date for the earliest selected day' })
  @IsDateOnly()
  target_start_date: string;
}

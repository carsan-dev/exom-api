import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsDateString,
  IsUUID,
  IsArray,
  IsOptional,
  IsBoolean,
  IsNotEmpty,
  IsString,
} from 'class-validator';

export class BulkAssignmentDto {
  @ApiProperty({ description: 'Client identifier' })
  @IsString()
  @IsNotEmpty()
  client_id: string;

  @ApiProperty({ type: [String], description: 'ISO date strings YYYY-MM-DD' })
  @IsArray()
  @ArrayMinSize(1)
  @IsDateString({}, { each: true })
  dates: string[];

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  training_id?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
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
  @IsDateString()
  source_week_start: string;

  @ApiProperty({ description: 'ISO date string YYYY-MM-DD (Monday)' })
  @IsDateString()
  target_week_start: string;
}

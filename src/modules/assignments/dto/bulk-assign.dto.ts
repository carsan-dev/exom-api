import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsUUID,
  IsArray,
  IsString,
  IsOptional,
  IsBoolean,
} from 'class-validator';

export class BulkAssignmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  client_id: string;

  @ApiProperty({ type: [String], description: 'ISO date strings YYYY-MM-DD' })
  @IsArray()
  @IsString({ each: true })
  dates: string[];

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  training_id?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  diet_id?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_rest_day?: boolean = false;
}

export class CopyWeekDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  client_id: string;

  @ApiProperty({ description: 'ISO date string YYYY-MM-DD (Monday)' })
  @IsString()
  source_week_start: string;

  @ApiProperty({ description: 'ISO date string YYYY-MM-DD (Monday)' })
  @IsString()
  target_week_start: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateNotificationTemplateDto {
  @ApiProperty({ type: 'string', minLength: 1, maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 240 })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @ApiProperty({ type: 'string', minLength: 1, maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @ApiProperty({ type: 'string', minLength: 1, maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body: string;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  route?: string | null;

  @ApiPropertyOptional({ type: 'boolean', nullable: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateNotificationTemplateDto {
  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    minLength: 1,
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 240 })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    minLength: 1,
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    minLength: 1,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body?: string;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  route?: string | null;

  @ApiPropertyOptional({ type: 'boolean', nullable: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateNotificationTemplateScheduleDto {
  @ApiPropertyOptional({ type: 'boolean', nullable: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ type: 'string', nullable: true, maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  timezone?: string;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string' },
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  times?: string[];

  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    minimum: 0,
    maximum: 6,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  weekday?: number | null;
}

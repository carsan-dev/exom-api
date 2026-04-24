import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { Level } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

function normalizeCatalogValue(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function toArray(value: unknown): string[] | undefined {
  if (value == null || value === '') return undefined;
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        if (typeof entry === 'string') return entry;
        if (typeof entry === 'number' || typeof entry === 'boolean') {
          return String(entry);
        }
        return [];
      })
      .map(normalizeCatalogValue)
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map(normalizeCatalogValue).filter(Boolean);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [normalizeCatalogValue(String(value))];
  }
  return undefined;
}

export class TrainingsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search trainings by name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by training type (in)',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  type?: string[];

  @ApiPropertyOptional({
    description: 'Filter by level (in)',
    enum: Level,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(Level, { each: true })
  level?: Level[];

  @ApiPropertyOptional({
    description: 'Filter by tags (hasSome)',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Filter by minimum duration in minutes' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  duration_min?: number;

  @ApiPropertyOptional({ description: 'Filter by maximum duration in minutes' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  duration_max?: number;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

const ICON_STATE_VALUES = ['WITH_ICON', 'WITHOUT_ICON'] as const;

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
      .filter(Boolean);
  }
  if (typeof value === 'string') return value.split(',').filter(Boolean);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  return undefined;
}

export class IngredientsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search ingredients by name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by icon presence',
    enum: ICON_STATE_VALUES,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsIn(ICON_STATE_VALUES, { each: true })
  has_icon?: (typeof ICON_STATE_VALUES)[number][];

  @ApiPropertyOptional({ description: 'Filter by minimum kcal per 100g' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  calories_per_100g_min?: number;

  @ApiPropertyOptional({ description: 'Filter by maximum kcal per 100g' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  calories_per_100g_max?: number;

  @ApiPropertyOptional({ description: 'Filter by minimum protein per 100g' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  protein_per_100g_min?: number;

  @ApiPropertyOptional({ description: 'Filter by maximum protein per 100g' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  protein_per_100g_max?: number;

  @ApiPropertyOptional({ description: 'Filter by minimum carbs per 100g' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  carbs_per_100g_min?: number;

  @ApiPropertyOptional({ description: 'Filter by maximum carbs per 100g' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  carbs_per_100g_max?: number;

  @ApiPropertyOptional({ description: 'Filter by minimum fat per 100g' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fat_per_100g_min?: number;

  @ApiPropertyOptional({ description: 'Filter by maximum fat per 100g' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  fat_per_100g_max?: number;

  @ApiPropertyOptional({ description: 'Filter ingredients updated from this ISO date' })
  @IsOptional()
  @IsDateString()
  updated_from?: string;

  @ApiPropertyOptional({ description: 'Filter ingredients updated to this ISO date' })
  @IsOptional()
  @IsDateString()
  updated_to?: string;
}

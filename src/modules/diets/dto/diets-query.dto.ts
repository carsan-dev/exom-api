import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { MealType } from '@prisma/client';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

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
      .map((entry) => entry.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  return undefined;
}

export class DietsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search diets by name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by nutritional badges on meals (hasSome)',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  nutritional_badges?: string[];

  @ApiPropertyOptional({
    description: 'Filter by internal diet tags (hasSome)',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({
    description: 'Filter by meal types on meals (in)',
    enum: MealType,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(MealType, { each: true })
  meal_types?: MealType[];

  @ApiPropertyOptional({
    description: 'Filter diets updated from this ISO date',
  })
  @IsOptional()
  @IsDateString()
  updated_from?: string;

  @ApiPropertyOptional({ description: 'Filter diets updated to this ISO date' })
  @IsOptional()
  @IsDateString()
  updated_to?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Level } from '@prisma/client';
import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
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
      .filter(Boolean);
  }
  if (typeof value === 'string') return value.split(',').filter(Boolean);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  return undefined;
}

export class ExercisesQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search exercises by name' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by muscle groups (hasSome)',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  muscle_groups?: string[];

  @ApiPropertyOptional({
    description: 'Filter by equipment (hasSome)',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  equipment?: string[];

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
}

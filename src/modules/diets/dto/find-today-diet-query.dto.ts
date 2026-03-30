import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsOptional } from 'class-validator';

export class FindTodayDietQueryDto {
  @ApiPropertyOptional({
    description: 'Date to fetch the assigned diet for. Defaults to today.',
    example: '2026-03-30',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  })
  @IsDateString()
  date?: string;
}

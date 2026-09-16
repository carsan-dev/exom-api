import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class MetricsOverviewQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-16' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  to?: string;

  @ApiPropertyOptional({
    default: 1,
    description: '90 civil days per chart page, newest first',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  page: number = 1;
}

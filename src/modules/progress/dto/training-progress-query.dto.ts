import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsDateOnly } from '../../../common/date-only';

export class TrainingProgressRangeQueryDto {
  @ApiProperty({
    example: '2026-09-01',
    description:
      'Inclusive start civil date. from/to include both dates; maximum 366 dates per query (larger windows return 400). Access older history with consecutive windows.',
  })
  @IsDateOnly()
  from: string;

  @ApiProperty({ example: '2026-09-30', description: 'Inclusive civil date' })
  @IsDateOnly()
  to: string;
}

export class TrainingOverviewQueryDto extends TrainingProgressRangeQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    description:
      'Opt in to pagination with a limit from 1 to 100; cursor requires an explicit limit. Without limit, returns the full legacy response within the response-size guard or HTTP 413.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}

export class TrainingProgressPageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}

export class TrainingProgressLoadQueryDto extends TrainingProgressRangeQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque pagination cursor' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  @Matches(/^[A-Za-z0-9_-]+$/)
  cursor?: string;
}

export class TrainingProgressSessionParamsDto {
  @IsDateOnly()
  date: string;

  @IsString()
  @IsNotEmpty()
  sessionId: string;
}

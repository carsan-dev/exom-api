import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDefined,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsDateOnly } from '../../../common/date-only';

export class AdherenceConfigDateQueryDto {
  @ApiPropertyOptional({ description: 'UTC date, YYYY-MM-DD' })
  @IsOptional()
  @IsDateOnly()
  date?: string;
}

export class UpdateAdherenceConfigDto {
  @ApiProperty({
    description:
      'Future UTC date at submission (may be today when committed), YYYY-MM-DD',
  })
  @IsDateOnly()
  effective_date: string;

  @ApiProperty({
    description: 'Version received from GET; 0 before any revision',
  })
  @IsInt()
  @Min(0)
  expected_version: number;

  @ApiProperty({
    nullable: true,
    description: 'Null disables the steps comparison',
  })
  @IsDefined()
  @ValidateIf(
    (_object: UpdateAdherenceConfigDto, value: unknown) => value !== null,
  )
  @IsInt()
  @Min(1)
  steps_goal: number | null;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(100)
  calorie_lower_percent: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(100)
  calorie_upper_percent: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(200)
  protein_min_percent: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(200)
  steps_min_percent: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(100)
  low_global_percent: number;
}

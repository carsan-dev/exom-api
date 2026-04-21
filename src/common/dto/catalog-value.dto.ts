import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

function normalizeCatalogValue(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;
}

export class RenameCatalogValueDto {
  @ApiProperty({ example: 'Pectoral' })
  @Transform(({ value }) => normalizeCatalogValue(value))
  @IsString()
  @MinLength(1)
  from: string;

  @ApiProperty({ example: 'Pecho' })
  @Transform(({ value }) => normalizeCatalogValue(value))
  @IsString()
  @MinLength(1)
  to: string;
}

export class CatalogMutationResponseDto {
  @ApiProperty({ example: 'Pecho' })
  value: string;

  @ApiProperty({ example: 12 })
  affected_count: number;
}

import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsHexColor } from 'class-validator';

function normalizeHexColor(value: unknown) {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

export class CatalogValueWithColorDto {
  @ApiProperty({ example: 'Fuerza' })
  value: string;

  @ApiProperty({ example: '#3B82F6' })
  color: string;
}

export class UpdateCatalogColorDto {
  @ApiProperty({ example: '#3B82F6' })
  @Transform(({ value }) => normalizeHexColor(value))
  @IsHexColor()
  color: string;
}

export class CatalogColorMutationResponseDto {
  @ApiProperty({ example: 'Fuerza' })
  value: string;

  @ApiProperty({ example: '#3B82F6' })
  color: string;
}

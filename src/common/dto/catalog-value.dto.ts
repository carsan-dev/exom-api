import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsString, MinLength } from 'class-validator';

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

export class DeleteCatalogValuesDto {
  @ApiProperty({ type: [String], example: ['Pecho', 'Espalda'] })
  @Transform(({ value }) => {
    if (!Array.isArray(value)) return value;
    const unique = new Map<string, string>();
    for (const item of value) {
      const normalized = normalizeCatalogValue(item);
      if (typeof normalized === 'string' && normalized) {
        const key = normalized.toLocaleLowerCase('es');
        if (!unique.has(key)) unique.set(key, normalized);
      } else {
        return value;
      }
    }
    return Array.from(unique.values());
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  values: string[];
}

export class CatalogBatchMutationResponseDto {
  @ApiProperty({ type: [String], example: ['Pecho', 'Espalda'] })
  values: string[];

  @ApiProperty({ example: 12 })
  affected_count: number;
}

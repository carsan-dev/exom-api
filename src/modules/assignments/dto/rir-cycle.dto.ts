import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { rirConfigSchema } from '../../../contracts/prescription-schemas';
import {
  IsDateString,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateRirCycleDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  operation_id: string;

  @ApiProperty({ type: 'integer', minimum: 0 })
  @IsInt()
  @Min(0)
  expected_revision: number;

  @ApiProperty({ type: String, format: 'date' })
  @IsDateString({ strict: true })
  effective_from: string;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @IsDateString({ strict: true })
  starts_on?: string;

  // null is explicit cancellation; omitted config is never cancellation.
  @ApiProperty({
    anyOf: [rirConfigSchema, { type: 'object', nullable: true, enum: [null] }],
    nullable: true,
  })
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsObject()
  config: Record<string, unknown> | null;
}

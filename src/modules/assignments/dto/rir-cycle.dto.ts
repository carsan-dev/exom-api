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
  @IsUUID()
  operation_id: string;

  @IsInt()
  @Min(0)
  expected_revision: number;

  @IsDateString({ strict: true })
  effective_from: string;

  @IsOptional()
  @IsDateString({ strict: true })
  starts_on?: string;

  // null is explicit cancellation; omitted config is never cancellation.
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsObject()
  config: Record<string, unknown> | null;
}

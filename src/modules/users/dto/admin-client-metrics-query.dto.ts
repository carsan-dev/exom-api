import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const BODY_FIELDS = [
  'weight_kg',
  'muscle_mass_kg',
  'sleep_hours',
  'neck_cm',
  'shoulders_cm',
  'chest_cm',
  'arm_cm',
  'forearm_cm',
  'waist_cm',
  'hips_cm',
  'thigh_cm',
  'calf_cm',
] as const;

export type BodyField = (typeof BODY_FIELDS)[number];

export class AdminClientBodyHistoryQueryDto {
  @ApiProperty({ enum: BODY_FIELDS })
  @IsEnum(BODY_FIELDS)
  field: BodyField;
}

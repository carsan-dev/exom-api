import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TrainingType } from '@prisma/client';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  ACHIEVEMENT_CRITERIA_TYPES,
  type AchievementCriteriaType,
  type AchievementRuleConfig,
} from '../achievements.constants';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const emptyStringToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export class CreateAchievementDto {
  @ApiProperty({ minLength: 2, maxLength: 100 })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiProperty({ minLength: 5, maxLength: 500 })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(500)
  description: string;

  @ApiPropertyOptional()
  @Transform(emptyStringToUndefined)
  @IsOptional()
  @IsUrl()
  icon_url?: string;

  @ApiProperty({ enum: ACHIEVEMENT_CRITERIA_TYPES })
  @IsIn(ACHIEVEMENT_CRITERIA_TYPES)
  criteria_type: AchievementCriteriaType;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  criteria_value: number;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: 'Configuración adicional opcional para variantes de la regla',
    example: { training_type: TrainingType.HIIT },
  })
  @IsOptional()
  @IsObject()
  rule_config?: AchievementRuleConfig | null;
}

export class GrantAchievementDto {
  @ApiProperty({ format: 'uuid' })
  @IsNotEmpty()
  @IsUUID('4')
  user_id: string;
}

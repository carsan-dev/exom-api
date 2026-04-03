import { PartialType, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsDateString,
  IsArray,
  IsBoolean,
  IsIn,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ChallengeType } from '@prisma/client';
import { CHALLENGE_RULE_KEYS, type ChallengeRuleKey } from '../challenges.constants';

@ValidatorConstraint({ name: 'challengeAssignmentTarget', async: false })
class ChallengeAssignmentTargetValidator implements ValidatorConstraintInterface {
  validate(_: boolean | undefined, args: ValidationArguments) {
    const dto = args.object as AssignChallengeDto;
    return Boolean(dto.apply_to_all_visible_clients || (dto.client_ids?.length ?? 0) > 0);
  }

  defaultMessage() {
    return 'Debes seleccionar clientes o aplicar la asignación a todos los clientes visibles';
  }
}

export class CreateChallengeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ enum: ChallengeType })
  @IsEnum(ChallengeType)
  type: ChallengeType;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  target_value: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  unit: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  is_manual?: boolean = true;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  is_global?: boolean = false;

  @ApiPropertyOptional({ description: 'Deadline date YYYY-MM-DD', nullable: true })
  @IsOptional()
  @IsDateString()
  deadline?: string | null;

  @ApiPropertyOptional({
    enum: CHALLENGE_RULE_KEYS,
    description: 'Regla automática para retos no manuales',
    nullable: true,
  })
  @ValidateIf((dto: CreateChallengeDto) => dto.is_manual === false || dto.rule_key != null)
  @IsString()
  @IsNotEmpty()
  @IsIn(CHALLENGE_RULE_KEYS)
  rule_key?: ChallengeRuleKey | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Configuración adicional opcional para reglas automáticas',
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  rule_config?: Record<string, unknown> | null;
}

export class UpdateChallengeDto extends PartialType(CreateChallengeDto) {}

export class AssignChallengeDto {
  @ApiPropertyOptional({ type: [String], nullable: true })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  client_ids?: string[];

  @ApiPropertyOptional({ default: false, description: 'Aplica el reto a todos los clientes visibles del admin actual' })
  @IsOptional()
  @IsBoolean()
  @Validate(ChallengeAssignmentTargetValidator)
  apply_to_all_visible_clients?: boolean = false;
}

export class UpdateProgressDto {
  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  current_value: number;
}

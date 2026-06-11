import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  Validate,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'autoAssignmentDaySelection', async: false })
class AutoAssignmentDaySelectionValidator
  implements ValidatorConstraintInterface
{
  validate(_: boolean | undefined, args: ValidationArguments) {
    const day = args.object as AutoAssignmentRuleDayDto;
    return Boolean(day.is_rest_day || day.training_id || day.diet_id);
  }

  defaultMessage() {
    return 'Debes asignar un entrenamiento, una dieta o marcar descanso';
  }
}

export class AutoAssignmentRuleDayDto {
  @ApiProperty({ minimum: 1, maximum: 7, description: 'ISO weekday, Monday=1' })
  @IsInt()
  @Min(1)
  @Max(7)
  weekday: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  training_id?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  diet_id?: string | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  @Validate(AutoAssignmentDaySelectionValidator)
  is_rest_day?: boolean = false;
}

export class CreateAutoAssignmentRuleDto {
  @ApiProperty({ description: 'Client identifier' })
  @IsString()
  @IsNotEmpty()
  client_id: string;

  @ApiProperty({ description: 'ISO date string YYYY-MM-DD (Monday)' })
  @IsDateString()
  source_week_start: string;

  @ApiProperty({ description: 'ISO date string YYYY-MM-DD' })
  @IsDateString()
  starts_on: string;

  @ApiPropertyOptional({ nullable: true, description: 'ISO date string YYYY-MM-DD' })
  @IsOptional()
  @IsDateString()
  ends_on?: string | null;

  @ApiProperty({ type: [AutoAssignmentRuleDayDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AutoAssignmentRuleDayDto)
  days: AutoAssignmentRuleDayDto[];
}

export class GetActiveAutoAssignmentRuleQueryDto {
  @ApiProperty({ description: 'Client identifier' })
  @IsString()
  @IsNotEmpty()
  client_id: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidationArguments,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'assignmentDaySelection', async: false })
class AssignmentDaySelectionValidator implements ValidatorConstraintInterface {
  validate(_: boolean | undefined, args: ValidationArguments) {
    const day = args.object as BatchAssignmentDayDto;
    return Boolean(day.is_rest_day || day.training_id || day.diet_id);
  }

  defaultMessage() {
    return 'Debes asignar un entrenamiento, una dieta o marcar descanso';
  }
}

export class BatchAssignmentDayDto {
  @ApiProperty({ description: 'ISO date string YYYY-MM-DD' })
  @IsDateString()
  date: string;

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
  @Validate(AssignmentDaySelectionValidator)
  is_rest_day?: boolean = false;
}

export class BatchAssignDaysDto {
  @ApiProperty({ description: 'Client identifier' })
  @IsString()
  @IsNotEmpty()
  client_id: string;

  @ApiProperty({ type: [BatchAssignmentDayDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BatchAssignmentDayDto)
  days: BatchAssignmentDayDto[];
}

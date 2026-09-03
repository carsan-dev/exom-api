import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidationArguments,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { AssignmentTrainingInputDto } from './assignment-training-input.dto';
import { IsDateOnly } from '../../../common/date-only';

@ValidatorConstraint({ name: 'assignmentDaySelection', async: false })
class AssignmentDaySelectionValidator implements ValidatorConstraintInterface {
  validate(_: boolean | undefined, args: ValidationArguments) {
    const day = args.object as BatchAssignmentDayDto;
    return Boolean(day.is_rest_day || day.trainings?.length || day.training_ids?.length || day.training_id || day.diet_id);
  }

  defaultMessage() {
    return 'Debes asignar un entrenamiento, una dieta o marcar descanso';
  }
}

export class BatchAssignmentDayDto {
  @ApiProperty({ description: 'ISO date string YYYY-MM-DD' })
  @IsDateOnly()
  date: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  training_id?: string | null;

  @ApiPropertyOptional({ type: [String], maxItems: 5 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  training_ids?: string[];

  @ApiPropertyOptional({ type: [AssignmentTrainingInputDto], maxItems: 5 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => AssignmentTrainingInputDto)
  trainings?: AssignmentTrainingInputDto[];

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
  @ArrayMaxSize(93)
  @ValidateNested({ each: true })
  @Type(() => BatchAssignmentDayDto)
  days: BatchAssignmentDayDto[];
}

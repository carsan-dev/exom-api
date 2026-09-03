import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AssignmentTrainingInputDto } from './assignment-training-input.dto';
import { IsDateOnly } from '../../../common/date-only';

export class UpdateAssignmentDto {
  @ApiPropertyOptional({ description: 'ISO date string YYYY-MM-DD', nullable: true })
  @IsOptional()
  @IsDateOnly()
  date?: string | null;

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
  is_rest_day?: boolean;
}

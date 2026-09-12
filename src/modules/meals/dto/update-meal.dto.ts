import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateMealBodyDto } from './create-meal.dto';

export class UpdateMealDto extends PartialType(
  OmitType(CreateMealBodyDto, ['diet_id'] as const),
) {}

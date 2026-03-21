import { ApiProperty, ApiPropertyOptional, PartialType, OmitType } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsArray,
  IsUUID,
  ValidateNested,
  IsInt,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MealType, MeasureUnit } from '@prisma/client';

export class MealIngredientDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  ingredient_id: string;

  @ApiProperty()
  @IsNumber()
  quantity: number;

  @ApiProperty({ enum: MeasureUnit })
  @IsEnum(MeasureUnit)
  unit: MeasureUnit;
}

export class CreateMealDto {
  @ApiProperty({ enum: MealType })
  @IsEnum(MealType)
  type: MealType;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  image_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  calories?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  protein_g?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  carbs_g?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  fat_g?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  nutritional_badges?: string[];

  @ApiProperty({ type: [MealIngredientDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MealIngredientDto)
  ingredients: MealIngredientDto[];

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number = 0;
}

export class CreateDietDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  total_calories?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  total_protein_g?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  total_carbs_g?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  total_fat_g?: number;

  @ApiProperty({ type: [CreateMealDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateMealDto)
  meals: CreateMealDto[];
}

export class UpdateDietDto extends PartialType(
  OmitType(CreateDietDto, ['meals'] as const),
) {}

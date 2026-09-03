import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsArray,
  ValidateNested,
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsUrl,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { MealType, MeasureUnit } from '@prisma/client';

export class MealIngredientDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  ingredient_id: string;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  quantity: number;

  @ApiProperty({ enum: MeasureUnit })
  @IsEnum(MeasureUnit)
  unit: MeasureUnit;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @IsPositive()
  grams_equivalent?: number;
}

class MealBaseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  id?: string;

  @ApiProperty({ enum: MealType })
  @IsEnum(MealType)
  type: MealType;

  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  image_url?: string;

  @ApiPropertyOptional({ description: 'Verified managed upload session' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  image_upload_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  calories?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  protein_g?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  carbs_g?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  fat_g?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  nutritional_badges?: string[];

  @ApiProperty({ type: [MealIngredientDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MealIngredientDto)
  ingredients: MealIngredientDto[];

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number = 0;
}

export class CreateMealVariantDto extends MealBaseDto {}

export class CreateMealDto extends MealBaseDto {
  @ApiPropertyOptional({ type: [CreateMealVariantDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateMealVariantDto)
  variants?: CreateMealVariantDto[];
}

export class CreateDietDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  total_calories?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  total_protein_g?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  total_carbs_g?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  total_fat_g?: number;

  @ApiProperty({ type: [CreateMealDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateMealDto)
  meals: CreateMealDto[];
}

export class UpdateDietDto extends PartialType(CreateDietDto) {}

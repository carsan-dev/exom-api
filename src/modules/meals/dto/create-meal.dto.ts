import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  IsNotEmpty,
  IsUrl,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MealType, MeasureUnit } from '@prisma/client';
import { MealIngredientDto } from '../../diets/dto/create-diet.dto';

export class CreateMealBodyDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  diet_id: string;

  @ApiProperty({ enum: MealType })
  @IsEnum(MealType)
  type: MealType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  image_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
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

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;

  @ApiProperty({ type: [MealIngredientDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MealIngredientDto)
  ingredients: MealIngredientDto[];
}

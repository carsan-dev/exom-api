import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber } from 'class-validator';

export class CreateIngredientDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiProperty()
  @IsNumber()
  calories_per_100g: number;

  @ApiProperty()
  @IsNumber()
  protein_per_100g: number;

  @ApiProperty()
  @IsNumber()
  carbs_per_100g: number;

  @ApiProperty()
  @IsNumber()
  fat_per_100g: number;
}

export class UpdateIngredientDto extends PartialType(CreateIngredientDto) {}

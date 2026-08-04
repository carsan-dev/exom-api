import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { Level } from '@prisma/client';
import {
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxDate,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateClientProfileDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  first_name?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  last_name?: string;

  @ApiPropertyOptional({ enum: Level })
  @IsOptional()
  @IsEnum(Level)
  level?: Level;

  @ApiPropertyOptional({ nullable: true, maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  main_goal?: string | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 500 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500)
  muscle_mass_goal?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 20000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(20000)
  target_calories?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 500 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(500)
  current_weight?: number | null;

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 300 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(300)
  height?: number | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  @MaxDate(new Date())
  birth_date?: Date | null;
}

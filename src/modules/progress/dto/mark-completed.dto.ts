import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsOptional, IsNumber, IsString } from 'class-validator';

export class MarkExerciseDto {
  @ApiProperty()
  @IsString()
  date: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  exercise_id: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  weight_used?: number;
}

export class MarkMealDto {
  @ApiProperty()
  @IsString()
  date: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  meal_id: string;
}

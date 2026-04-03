import { IsDateString, IsInt, Max, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class AdminClientCalendarMonthQueryDto {
  @ApiProperty({ example: 2024 })
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year: number;

  @ApiProperty({ example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;
}

export class AdminClientCalendarWeekQueryDto {
  @ApiProperty({ example: '2024-03-11', description: 'Inicio de semana en formato YYYY-MM-DD' })
  @IsDateString()
  week_start: string;
}

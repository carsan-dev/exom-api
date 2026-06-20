import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsNotEmpty } from 'class-validator';

export class FindWeekDietQueryDto {
  @ApiProperty({
    description: 'Any date inside the week to fetch (YYYY-MM-DD).',
    example: '2026-06-15',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty()
  @IsDateString()
  week_start!: string;
}

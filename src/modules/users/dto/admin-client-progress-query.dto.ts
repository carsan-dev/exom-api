import { IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AdminClientProgressQueryDto {
  @ApiProperty({ example: '2024-03-15', description: 'Fecha en formato YYYY-MM-DD' })
  @IsDateString()
  date: string;
}

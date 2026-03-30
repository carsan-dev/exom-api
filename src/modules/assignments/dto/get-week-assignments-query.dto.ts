import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsUUID } from 'class-validator';

export class GetWeekAssignmentsQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  client_id: string;

  @ApiProperty({ description: 'ISO date string YYYY-MM-DD (Monday)' })
  @IsDateString()
  week_start: string;
}

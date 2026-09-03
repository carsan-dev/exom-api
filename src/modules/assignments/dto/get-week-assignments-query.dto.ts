import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { IsDateOnly } from '../../../common/date-only';

export class GetWeekAssignmentsQueryDto {
  @ApiProperty({ description: 'Client identifier' })
  @IsString()
  @IsNotEmpty()
  client_id: string;

  @ApiProperty({ description: 'ISO date string YYYY-MM-DD (Monday)' })
  @IsDateOnly()
  week_start: string;
}

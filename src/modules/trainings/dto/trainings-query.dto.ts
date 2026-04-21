import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class TrainingsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search trainings by name' })
  @IsOptional()
  @IsString()
  search?: string;
}

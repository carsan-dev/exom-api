import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class ExercisesQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search exercises by name' })
  @IsOptional()
  @IsString()
  search?: string;
}

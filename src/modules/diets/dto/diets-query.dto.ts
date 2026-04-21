import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class DietsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search diets by name' })
  @IsOptional()
  @IsString()
  search?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class IngredientsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search ingredients by name' })
  @IsOptional()
  @IsString()
  search?: string;
}

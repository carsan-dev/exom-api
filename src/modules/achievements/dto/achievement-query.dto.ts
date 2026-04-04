import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class AchievementFiltersDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Búsqueda en nombre y descripción' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filtra por tipo de criterio' })
  @IsOptional()
  @IsString()
  criteria_type?: string;
}

export class AchievementUsersQueryDto extends PaginationDto {}

export class RevokeAchievementDto {
  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  user_id: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class NotificationQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by recipient ID' })
  @IsOptional()
  @IsUUID()
  recipient_id?: string;

  @ApiPropertyOptional({ enum: NotificationStatus, description: 'Filter by notification status' })
  @IsOptional()
  @IsEnum(NotificationStatus)
  status?: NotificationStatus;

  @ApiPropertyOptional({ description: 'Search in title or body' })
  @IsOptional()
  @IsString()
  search?: string;
}

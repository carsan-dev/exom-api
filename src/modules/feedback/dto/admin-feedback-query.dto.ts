import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { FeedbackStatus } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export class AdminFeedbackQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by client ID' })
  @IsOptional()
  @IsString()
  client_id?: string;

  @ApiPropertyOptional({ enum: FeedbackStatus, description: 'Filter by status' })
  @IsOptional()
  @IsEnum(FeedbackStatus)
  status?: FeedbackStatus;
}

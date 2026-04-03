import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ChallengeType } from '@prisma/client';
import { PaginationDto } from '../../../common/dto/pagination.dto';

export const CHALLENGE_COMPLETION_STATUSES = [
  'NOT_ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
] as const;

export type ChallengeCompletionStatus =
  (typeof CHALLENGE_COMPLETION_STATUSES)[number];

function toBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }

  return value;
}

export class ChallengesQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Texto libre para título o descripción' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ChallengeType })
  @IsOptional()
  @IsEnum(ChallengeType)
  type?: ChallengeType;

  @ApiPropertyOptional({ description: 'Filtra por retos manuales o automáticos' })
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  is_manual?: boolean;

  @ApiPropertyOptional({ description: 'Filtra por alcance global' })
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  is_global?: boolean;

  @ApiPropertyOptional({ enum: CHALLENGE_COMPLETION_STATUSES })
  @IsOptional()
  @IsIn(CHALLENGE_COMPLETION_STATUSES)
  completion_status?: ChallengeCompletionStatus;
}

export class ChallengeAssignmentsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filtra por cliente asignado' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  client_id?: string;

  @ApiPropertyOptional({ description: 'Filtra por estado de completado' })
  @IsOptional()
  @Transform(({ value }) => toBoolean(value))
  @IsBoolean()
  is_completed?: boolean;
}

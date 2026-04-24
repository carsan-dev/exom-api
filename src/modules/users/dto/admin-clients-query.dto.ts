import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Level } from '@prisma/client';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import { PaginationDto } from '../../../common/dto/pagination.dto';

const USER_STATUS_VALUES = ['ACTIVE', 'INACTIVE', 'LOCKED'] as const;
const CLIENT_ASSIGNMENT_STATE_VALUES = ['ASSIGNED', 'UNASSIGNED'] as const;

export type UserStatusFilter = (typeof USER_STATUS_VALUES)[number];
export type ClientAssignmentStateFilter =
  (typeof CLIENT_ASSIGNMENT_STATE_VALUES)[number];

function toArray(value: unknown): string[] | undefined {
  if (value == null || value === '') return undefined;
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => {
        if (typeof entry === 'string') return entry;
        if (typeof entry === 'number' || typeof entry === 'boolean') {
          return String(entry);
        }
        return [];
      })
      .filter(Boolean);
  }
  if (typeof value === 'string') return value.split(',').filter(Boolean);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [String(value)];
  }
  return undefined;
}

export class AdminClientsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search clients by name or email' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter clients by level',
    enum: Level,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(Level, { each: true })
  level?: Level[];

  @ApiPropertyOptional({
    description: 'Filter clients by derived status',
    isArray: true,
    enum: USER_STATUS_VALUES,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsIn(USER_STATUS_VALUES, { each: true })
  status?: UserStatusFilter[];

  @ApiPropertyOptional({
    description: 'Filter clients by active admin assignment state',
    isArray: true,
    enum: CLIENT_ASSIGNMENT_STATE_VALUES,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsIn(CLIENT_ASSIGNMENT_STATE_VALUES, { each: true })
  assignment_state?: ClientAssignmentStateFilter[];

  @ApiPropertyOptional({
    description: 'Filter clients created from this ISO date',
  })
  @IsOptional()
  @IsDateString()
  created_from?: string;

  @ApiPropertyOptional({
    description: 'Filter clients created to this ISO date',
  })
  @IsOptional()
  @IsDateString()
  created_to?: string;
}

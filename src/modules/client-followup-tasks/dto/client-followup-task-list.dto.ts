import { ApiPropertyOptional } from '@nestjs/swagger';
import { ClientFollowUpTaskStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

export const TASK_VIEW = {
  ACTIVE: 'active',
  HISTORY: 'history',
  ALL: 'all',
} as const;
export type TaskView = (typeof TASK_VIEW)[keyof typeof TASK_VIEW];

// Deliberately does not inherit generic sorting: this list has canonical ordering.
export class FollowUpPageDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 1000000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class ClientFollowUpTaskListDto extends FollowUpPageDto {
  @ApiPropertyOptional({
    enum: Object.values(TASK_VIEW),
    description:
      'Defaults to active unless status alone is supplied; explicit view and status intersect.',
  })
  @IsOptional()
  @IsIn(Object.values(TASK_VIEW))
  view?: TaskView;

  @ApiPropertyOptional({ enum: ClientFollowUpTaskStatus })
  @IsOptional()
  @IsEnum(ClientFollowUpTaskStatus)
  status?: ClientFollowUpTaskStatus;

  @ApiPropertyOptional({
    description:
      'UUID of current/historical assignee, or unassigned for removed/null assignee. Omit for all assignees.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.toLowerCase() === 'unassigned'
      ? 'unassigned'
      : value,
  )
  @IsOptional()
  @Matches(
    /^(?:unassigned|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  )
  assigned_to_id?: string;
}

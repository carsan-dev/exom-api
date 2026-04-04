import { ApiProperty } from '@nestjs/swagger';

const DASHBOARD_ACTIVITY_TYPES = [
  'recap_submitted',
  'feedback_sent',
  'progress_completed',
  'client_created',
] as const;

class AdminDashboardStatsDto {
  @ApiProperty()
  activeClients: number;

  @ApiProperty()
  totalClients: number;

  @ApiProperty()
  pendingRecaps: number;

  @ApiProperty()
  pendingFeedback: number;

  @ApiProperty()
  lockedAccounts: number;
}

class RecentActivityItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: DASHBOARD_ACTIVITY_TYPES })
  type: (typeof DASHBOARD_ACTIVITY_TYPES)[number];

  @ApiProperty()
  clientId: string;

  @ApiProperty()
  clientName: string;

  @ApiProperty({ nullable: true })
  clientAvatar: string | null;

  @ApiProperty()
  description: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

class TopClientDto {
  @ApiProperty()
  clientId: string;

  @ApiProperty()
  clientName: string;

  @ApiProperty({ nullable: true })
  clientAvatar: string | null;

  @ApiProperty()
  completedDays: number;

  @ApiProperty()
  currentStreak: number;
}

export class AdminDashboardResponseDto {
  @ApiProperty({ type: AdminDashboardStatsDto })
  stats: AdminDashboardStatsDto;

  @ApiProperty({ type: [RecentActivityItemDto] })
  recentActivity: RecentActivityItemDto[];

  @ApiProperty({ type: [TopClientDto] })
  topClients: TopClientDto[];
}

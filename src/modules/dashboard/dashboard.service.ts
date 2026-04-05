import { ForbiddenException, Injectable } from '@nestjs/common';
import { FeedbackStatus, Prisma, RecapStatus, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type DashboardClientProfile = {
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
};

type DashboardClient = {
  id: string;
  email: string;
  profile: DashboardClientProfile | null;
};

type DashboardActivity = {
  id: string;
  type: 'recap_submitted' | 'feedback_sent' | 'progress_completed' | 'client_created';
  clientId: string;
  clientName: string;
  clientAvatar: string | null;
  description: string;
  createdAt: string;
};

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getAdminDashboard(adminId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { role: true },
    });

    if (!admin || (admin.role !== Role.ADMIN && admin.role !== Role.SUPER_ADMIN)) {
      throw new ForbiddenException('Access denied');
    }

    const clientWhere = this.buildClientWhere(adminId, admin.role);
    const { start: weekStart, end: weekEnd } = this.getCurrentWeekRange();

    const [
      activeClients,
      totalClients,
      pendingRecaps,
      pendingFeedback,
      lockedAccounts,
      recentRecaps,
      recentFeedback,
      recentProgress,
      recentClients,
      weeklyCompletedProgress,
    ] = await Promise.all([
      this.prisma.user.count({
        where: {
          ...clientWhere,
          is_active: true,
        },
      }),
      this.prisma.user.count({ where: clientWhere }),
      this.prisma.weeklyRecap.count({
        where: {
          status: RecapStatus.SUBMITTED,
          client: { is: clientWhere },
        },
      }),
      this.prisma.feedbackMedia.count({
        where: {
          status: FeedbackStatus.PENDING,
          client: { is: clientWhere },
        },
      }),
      this.prisma.user.count({
        where: {
          ...clientWhere,
          is_locked: true,
        },
      }),
      this.prisma.weeklyRecap.findMany({
        where: {
          submitted_at: { not: null },
          client: { is: clientWhere },
        },
        orderBy: { submitted_at: 'desc' },
        take: 10,
        select: {
          id: true,
          client_id: true,
          submitted_at: true,
          client: {
            select: {
              id: true,
              email: true,
              profile: {
                select: {
                  first_name: true,
                  last_name: true,
                  avatar_url: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.feedbackMedia.findMany({
        where: { client: { is: clientWhere } },
        orderBy: { created_at: 'desc' },
        take: 10,
        select: {
          id: true,
          client_id: true,
          created_at: true,
          client: {
            select: {
              id: true,
              email: true,
              profile: {
                select: {
                  first_name: true,
                  last_name: true,
                  avatar_url: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.dayProgress.findMany({
        where: {
          training_completed: true,
          client: { is: clientWhere },
        },
        orderBy: { updated_at: 'desc' },
        take: 10,
        select: {
          id: true,
          client_id: true,
          date: true,
          updated_at: true,
          client: {
            select: {
              id: true,
              email: true,
              profile: {
                select: {
                  first_name: true,
                  last_name: true,
                  avatar_url: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.user.findMany({
        where: clientWhere,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: 10,
        select: {
          id: true,
          email: true,
          created_at: true,
          profile: {
            select: {
              first_name: true,
              last_name: true,
              avatar_url: true,
            },
          },
        },
      }),
      this.prisma.dayProgress.findMany({
        where: {
          training_completed: true,
          date: {
            gte: weekStart,
            lte: weekEnd,
          },
          client: { is: clientWhere },
        },
        select: {
          client_id: true,
          client: {
            select: {
              id: true,
              email: true,
              profile: {
                select: {
                  first_name: true,
                  last_name: true,
                  avatar_url: true,
                },
              },
              streak: {
                select: {
                  current_days: true,
                },
              },
            },
          },
        },
      }),
    ]);

    // Merge the different activity sources into a single chronological feed.
    const recentActivity = [
      ...recentRecaps
        .filter((item) => item.submitted_at)
        .map((item) =>
          this.buildActivity(
            item.id,
            'recap_submitted',
            item.client_id,
            item.client,
            `${this.getClientName(item.client)} envió su recap semanal`,
            item.submitted_at as Date,
          ),
        ),
      ...recentFeedback.map((item) =>
        this.buildActivity(
          item.id,
          'feedback_sent',
          item.client_id,
          item.client,
          `${this.getClientName(item.client)} envió feedback multimedia`,
          item.created_at,
        ),
      ),
      ...recentProgress.map((item) =>
        this.buildActivity(
          item.id,
          'progress_completed',
          item.client_id,
          item.client,
          `${this.getClientName(item.client)} completó su entrenamiento del ${item.date.toISOString().split('T')[0]}`,
          item.updated_at,
        ),
      ),
      ...recentClients.map((item) =>
        this.buildActivity(
          item.id,
          'client_created',
          item.id,
          item,
          `${this.getClientName(item)} se incorporó a EXOM`,
          item.created_at,
        ),
      ),
    ]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 10);

    const topClientsById = new Map<
      string,
      {
        completedDays: number;
        client: DashboardClient & { streak: { current_days: number } | null };
      }
    >();

    for (const item of weeklyCompletedProgress) {
      const existing = topClientsById.get(item.client_id);

      if (existing) {
        existing.completedDays += 1;
        continue;
      }

      topClientsById.set(item.client_id, {
        completedDays: 1,
        client: item.client,
      });
    }

    const topClients = [...topClientsById.entries()]
      .sort((left, right) => {
        if (right[1].completedDays !== left[1].completedDays) {
          return right[1].completedDays - left[1].completedDays;
        }

        return this.getClientName(left[1].client).localeCompare(this.getClientName(right[1].client));
      })
      .slice(0, 5)
      .map(([clientId, item]) => ({
        clientId,
        clientName: this.getClientName(item.client),
        clientAvatar: item.client.profile?.avatar_url ?? null,
        completedDays: item.completedDays,
        currentStreak: item.client.streak?.current_days ?? 0,
      }));

    return {
      stats: {
        activeClients,
        totalClients,
        pendingRecaps,
        pendingFeedback,
        lockedAccounts,
      },
      recentActivity,
      topClients,
    };
  }

  private buildClientWhere(adminId: string, adminRole: Role): Prisma.UserWhereInput {
    if (adminRole === Role.SUPER_ADMIN) {
      return { role: Role.CLIENT };
    }

    return {
      role: Role.CLIENT,
      clientOf: {
        some: {
          admin_id: adminId,
          is_active: true,
        },
      },
    };
  }

  private buildActivity(
    id: string,
    type: DashboardActivity['type'],
    clientId: string,
    client: DashboardClient,
    description: string,
    createdAt: Date,
  ): DashboardActivity {
    return {
      id,
      type,
      clientId,
      clientName: this.getClientName(client),
      clientAvatar: client.profile?.avatar_url ?? null,
      description,
      createdAt: createdAt.toISOString(),
    };
  }

  private getClientName(client: DashboardClient) {
    const firstName = client.profile?.first_name?.trim();
    const lastName = client.profile?.last_name?.trim();
    const fullName = [firstName, lastName].filter(Boolean).join(' ');

    return fullName || client.email;
  }

  private getCurrentWeekRange() {
    const now = new Date();
    const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const day = weekStart.getUTCDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;

    weekStart.setUTCDate(weekStart.getUTCDate() + diffToMonday);

    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    return { start: weekStart, end: weekEnd };
  }
}
